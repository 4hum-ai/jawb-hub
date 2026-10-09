#!/usr/bin/env node
// The signed extensions index jawbd trusts (4hum-ai/jawb ADR 0022, #139).
// listings.json (hub.mjs index) is for display; this is the document jawbd
// verifies with its pinned index keys to tell a listed install from an
// unlisted one and to learn revocations.
//
//   node tools/signed-index.mjs build --out <dir> [--previous <index.json>]
//        [--revocations revocations.json] [--now <YYYY-MM-DDTHH:MM:SSZ>]
//   node tools/signed-index.mjs verify --dir <dir> --pub <file>...
//   node tools/signed-index.mjs verify-file --file <f> --pub <file>...
//
// build: checks every listings/*.toml the way `hub.mjs check` does, and
// writes <dir>/extensions/index.json, a copy of each listed package at
// <dir>/extensions/<id>/<version>/<id>-<version>.tgz (where `jawb extension
// install <id>` fetches it), and <dir>/plan.json with the trusted comment
// the index must be signed with. It never sees a key: CI signs with the
// minisign CLI. Against the published index (--previous) it refuses:
//   - a serial that is not higher (jawbd refuses a rollback forever);
//   - a revocation that disappeared (revocations are sticky);
//   - a listed version whose bytes changed.
// verify: the checks jawbd makes on <dir>/extensions/index.json and its
// .minisig: a prehashed signature by one of the keys, a trusted comment of
// exactly `extensions-index <serial> <expires_at>`, version 1, UTC
// timestamps, and a validity window of at most 8 days.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkListing, cmpVersion, HubError } from "./hub.mjs";

const fail = (m) => {
  throw new HubError(m);
};

export const DAYS = 7; // re-signed daily, valid for 7 days
export const MAX_VALIDITY_SECS = 8 * 86_400; // jawbd's limit (core index.rs)
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
export const utc = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const unix = (s) => Math.floor(Date.parse(s) / 1000);
export const trustedComment = (index) => `extensions-index ${index.serial} ${index.expires_at}`;
export const artifactName = (id, version) => `${id}-${version}.tgz`;

// ---- revocations.json ------------------------------------------------------------
// {"revoked": [{id, versions: "*" | [..], kind, reason, at}],
//  "revoked_sha256": [{sha256, kind, reason, at}]}
// Only kind "security" disables a package in jawbd; "licence" is recorded.
export function checkRevocations(doc) {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) fail("revocations.json is an object");
  const extra = Object.keys(doc).filter((k) => !["revoked", "revoked_sha256"].includes(k));
  if (extra.length) fail(`revocations.json: unknown key(s) ${extra.join(", ")}`);
  const revoked = doc.revoked ?? [];
  const bySha = doc.revoked_sha256 ?? [];
  if (!Array.isArray(revoked) || !Array.isArray(bySha)) fail("revocations.json: revoked and revoked_sha256 are lists");
  const common = (r, what) => {
    if (!["security", "licence"].includes(r.kind)) fail(`${what}: kind is "security" or "licence"`);
    if (typeof r.reason !== "string" || !r.reason.trim()) fail(`${what}: give a reason`);
    if (typeof r.at !== "string" || !TS.test(r.at)) fail(`${what}: at is YYYY-MM-DDTHH:MM:SSZ`);
  };
  for (const r of revoked) {
    const what = `revocation of ${r.id}`;
    const keys = Object.keys(r).filter((k) => !["id", "versions", "kind", "reason", "at"].includes(k));
    if (keys.length) fail(`${what}: unknown key(s) ${keys.join(", ")}`);
    if (typeof r.id !== "string" || !r.id) fail(`a revocation without an id: ${JSON.stringify(r)}`);
    if (!(r.versions === "*" || (Array.isArray(r.versions) && r.versions.length && r.versions.every((v) => typeof v === "string")))) {
      fail(`${what}: versions is "*" or a list of versions`);
    }
    common(r, what);
  }
  for (const r of bySha) {
    const what = `revocation of sha256 ${r.sha256}`;
    const keys = Object.keys(r).filter((k) => !["sha256", "kind", "reason", "at"].includes(k));
    if (keys.length) fail(`${what}: unknown key(s) ${keys.join(", ")}`);
    if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) fail(`${what}: sha256 is 64 lowercase hex digits`);
    common(r, what);
  }
  return { revoked, revoked_sha256: bySha };
}

const covers = (r, id, version) => r.id === id && (r.versions === "*" || r.versions.includes(version));

/** Every revocation in the published index is still there, as strong. */
export function checkSticky(previous, rev) {
  for (const old of previous.revoked ?? []) {
    const kept = rev.revoked.some(
      (n) =>
        n.id === old.id &&
        (n.kind === old.kind || n.kind === "security") &&
        (n.versions === "*" || (old.versions !== "*" && old.versions.every((v) => n.versions.includes(v)))),
    );
    if (!kept) fail(`revocations are sticky: ${old.id} ${JSON.stringify(old.versions)} (${old.kind}) is revoked in serial ${previous.serial} and missing from revocations.json`);
  }
  for (const old of previous.revoked_sha256 ?? []) {
    const kept = rev.revoked_sha256.some((n) => n.sha256 === old.sha256 && (n.kind === old.kind || n.kind === "security"));
    if (!kept) fail(`revocations are sticky: sha256 ${old.sha256} (${old.kind}) is revoked in serial ${previous.serial} and missing from revocations.json`);
  }
}

// ---- the index body ------------------------------------------------------------------
/**
 * Build the index from checked listings (results of hub.mjs checkListing).
 * Returns {index, packages: [{key, bytes}]}.
 */
export function buildIndex({ results, previous = null, revocations = {}, now = new Date() }) {
  const rev = checkRevocations(revocations);
  if (previous) {
    checkBody(previous);
    checkSticky(previous, rev);
  }
  const issued_at = utc(now);
  const expires_at = utc(new Date(now.getTime() + DAYS * 86_400_000));
  // Higher than the published serial, and never reset by a missing copy.
  const serial = Math.max((previous?.serial ?? 0) + 1, Math.floor(now.getTime() / 1000));
  const prevById = new Map((previous?.extensions ?? []).map((e) => [e.id, e]));
  const isRevoked = (id, v) =>
    rev.revoked.some((r) => r.kind === "security" && covers(r, id, v.version)) ||
    rev.revoked_sha256.some((r) => r.kind === "security" && r.sha256 === v.artifact_sha256);
  const packages = [];
  const extensions = [];
  for (const r of results.filter((x) => x.listing && x.versions?.length)) {
    const id = r.listing.id;
    const prev = prevById.get(id);
    const vs = [...r.versions].sort((a, b) => cmpVersion(a.version, b.version));
    const versions = vs.map((v) => {
      const was = prev?.versions?.find((p) => p.version === v.version);
      if (was && (was.artifact_sha256 !== v.artifact_sha256 || was.manifest_sha256 !== v.manifest_sha256)) {
        fail(`${id} ${v.version} is listed in serial ${previous.serial} with other bytes; a listed version never changes (add a new version)`);
      }
      const artifact = artifactName(id, v.version);
      packages.push({ key: `extensions/${id}/${v.version}/${artifact}`, bytes: v.bytes });
      return {
        version: v.version,
        min_api_level: v.manifest.extension.min_api_level,
        artifact,
        artifact_sha256: v.artifact_sha256,
        manifest_sha256: v.manifest_sha256,
        size: v.size,
        published_at: was?.published_at ?? issued_at,
      };
    });
    const live = vs.filter((v) => !isRevoked(id, v));
    const head = (live.length ? live : vs)[(live.length ? live : vs).length - 1].manifest.extension;
    extensions.push({
      id,
      publisher: head.publisher,
      shape: head.shape,
      purpose: head.purpose,
      latest: live.length ? live[live.length - 1].version : null,
      trust: "listed",
      versions,
    });
  }
  extensions.sort((a, b) => (a.id < b.id ? -1 : 1));
  const index = { v: 1, serial, issued_at, expires_at, extensions, revoked: rev.revoked, revoked_sha256: rev.revoked_sha256 };
  checkBody(index);
  if (previous && index.serial <= previous.serial) fail(`serial ${index.serial} is not higher than the published ${previous.serial}`);
  return { index, packages };
}

/** The body rules jawbd applies (core crates/extensions/src/index.rs). */
export function checkBody(index) {
  if (index?.v !== 1) fail(`the index has version ${index?.v}; jawbd reads version 1`);
  if (!Number.isSafeInteger(index.serial) || index.serial < 1) fail("serial is a positive integer");
  if (!TS.test(index.issued_at ?? "") || !TS.test(index.expires_at ?? "")) fail("issued_at and expires_at are YYYY-MM-DDTHH:MM:SSZ");
  const span = unix(index.expires_at) - unix(index.issued_at);
  if (!(span > 0 && span <= MAX_VALIDITY_SECS)) fail(`the index is valid from ${index.issued_at} to ${index.expires_at}; at most 8 days`);
  return index;
}

// ---- minisign, verify side (Ed25519 over BLAKE2b-512: prehashed "ED") ------------------
/** Verify with one minisign public key's text; returns the trusted comment. */
export function verify(pubText, data, sigText) {
  const pub = Buffer.from(pubText.trim().split(/\r?\n/).pop(), "base64");
  if (pub.length !== 42 || pub.subarray(0, 2).toString() !== "Ed") fail("not a minisign public key");
  const lines = sigText.split(/\r?\n/);
  const sig = Buffer.from(lines[1] ?? "", "base64");
  if (sig.length !== 74 || sig.subarray(0, 2).toString() !== "ED") fail("not a prehashed (ED) minisign signature");
  if (!sig.subarray(2, 10).equals(pub.subarray(2, 10))) fail("signed by another key");
  if (!(lines[2] ?? "").startsWith("trusted comment: ")) fail("no trusted comment");
  const trusted = lines[2].slice("trusted comment: ".length);
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const h = crypto.createHash("blake2b512").update(data).digest();
  if (!crypto.verify(null, h, key, sig.subarray(10))) fail("bad signature");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (!crypto.verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), key, global)) fail("bad trusted-comment signature");
  return trusted;
}

/** The first of `pubs` (key file texts) that verifies, or a failure. */
export function verifyAny(pubs, data, sigText) {
  const errors = [];
  for (const p of pubs.filter((t) => !t.includes("PLACEHOLDER"))) {
    try {
      return { trusted: verify(p, data, sigText), pub: p };
    } catch (e) {
      if (!(e instanceof HubError)) throw e;
      errors.push(e.message);
    }
  }
  fail(`the signature does not verify against any index key (${errors.join("; ") || "no real keys"})`);
}

/** What jawbd checks on a signed index: the signature, the comment, the body. */
export function verifyIndex(pubs, bytes, sigText) {
  const { trusted, pub } = verifyAny(pubs, bytes, sigText);
  let index;
  try {
    index = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    fail(`the index is not JSON: ${e.message}`);
  }
  checkBody(index);
  if (trusted !== trustedComment(index)) fail(`the trusted comment \`${trusted}\` does not match the index (\`${trustedComment(index)}\`)`);
  return { index, trusted, keyId: Buffer.from(pub.trim().split(/\r?\n/).pop(), "base64").subarray(2, 10).reverse().toString("hex").toUpperCase() };
}

// ---- command line ------------------------------------------------------------------
async function main(argv) {
  const o = { pubs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "--dir") o.dir = argv[++i];
    else if (a === "--previous") o.previous = argv[++i];
    else if (a === "--revocations") o.revocations = argv[++i];
    else if (a === "--now") o.now = argv[++i];
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--pub") o.pubs.push(fs.readFileSync(argv[++i], "utf8"));
    else if (!o.cmd) o.cmd = a;
    else fail(`unknown argument ${a}`);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (o.cmd === "build") {
    const out = o.dir ?? fail("build needs --out <dir>");
    const dir = path.join(here, "..", "listings");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).map((f) => path.join(dir, f));
    const results = [];
    for (const f of files) {
      const r = await checkListing(f, {});
      if (!r.ok) console.error(`::warning::${path.basename(f)} no longer passes and is left out of the index:\n${r.problems.join("\n")}`);
      results.push(r);
    }
    const now = o.now ? (TS.test(o.now) ? new Date(o.now) : fail("--now is YYYY-MM-DDTHH:MM:SSZ")) : new Date();
    const { index, packages } = buildIndex({
      results,
      previous: o.previous ? JSON.parse(fs.readFileSync(o.previous, "utf8")) : null,
      revocations: o.revocations ? JSON.parse(fs.readFileSync(o.revocations, "utf8")) : {},
      now,
    });
    const write = (rel, data) => {
      const f = path.join(out, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, data);
    };
    write("extensions/index.json", JSON.stringify(index, null, 2) + "\n");
    for (const p of packages) write(p.key, p.bytes);
    const plan = {
      serial: index.serial,
      issued_at: index.issued_at,
      expires_at: index.expires_at,
      trusted_comment: trustedComment(index),
      listed: index.extensions.length,
      revoked: index.revoked.length,
      revoked_sha256: index.revoked_sha256.length,
      packages: packages.map((p) => p.key),
    };
    write("plan.json", JSON.stringify(plan, null, 2) + "\n");
    console.log(JSON.stringify(plan));
    return 0;
  }
  if (o.cmd === "verify") {
    const dir = o.dir ?? fail("verify needs --dir <dir>");
    if (!o.pubs.length) fail("verify needs --pub <index.pub>");
    const bytes = fs.readFileSync(path.join(dir, "extensions", "index.json"));
    const sig = fs.readFileSync(path.join(dir, "extensions", "index.json.minisig"), "utf8");
    const r = verifyIndex(o.pubs, bytes, sig);
    console.log(JSON.stringify({ ok: true, serial: r.index.serial, expires_at: r.index.expires_at, trusted_comment: r.trusted, key_id: r.keyId }));
    return 0;
  }
  if (o.cmd === "verify-file") {
    const f = o.file ?? fail("verify-file needs --file <file>");
    if (!o.pubs.length) fail("verify-file needs --pub <key file>");
    const { trusted } = verifyAny(o.pubs, fs.readFileSync(f), fs.readFileSync(`${f}.minisig`, "utf8"));
    console.log(`verified ${path.basename(f)}: ${trusted}`);
    return 0;
  }
  fail("usage: signed-index.mjs build --out <dir> [--previous f] [--revocations f] [--now ts] | verify --dir <dir> --pub <f>... | verify-file --file <f> --pub <f>...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (!(e instanceof HubError)) throw e;
      console.error(`signed-index: ${e.message}`);
      process.exit(2);
    },
  );
}
