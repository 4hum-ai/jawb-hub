#!/usr/bin/env node
// jawb Hub: the checks a listing must pass, and the listings.json jawb.app
// shows (4hum-ai/jawb ADR 0022, #165). jawb does not review or sign listed
// extensions. A listing means "these exact bytes passed these automated
// checks": nothing more.
//
//   node tools/hub.mjs check [--author <github login>] [--base <dir>] <listing.toml>...
//   node tools/hub.mjs index --out <file>        listings.json for jawb.app
//
// check, for each listed version:
//   - fetch it from its source (npm, or an https URL such as a GitHub release
//     asset) and compare sha256;
//   - unpack it (one top-level directory, as npm's `package/`, is stripped)
//     with the package rules;
//   - check the manifest the way jawbd will;
//   - look for hidden characters and never-list words;
//   - check ownership of the id: with --author (the PR's author), a new
//     listing needs proof for the id's domain, or `io.github.<author>.*`;
//     a change to an existing listing needs the author in its owners;
//   - with --base (the listings on main), a published version never changes.

import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

export class HubError extends Error {}
const fail = (m) => {
  throw new HubError(m);
};

// ---- the rules jawbd applies (core crates/extensions; ADR 0017 R5, R8, R9)
export const RUNNERS = { "scenario.validate": 18, "scenario.run": 18, "screens.capture": 19 };
export const SHAPES = ["workflow"]; // what jawbd installs today
const EFFECTS = ["none", "act", "submit", "download", "upload", "credential"];
const CAPABILITIES = ["network_domains", "secrets", "browser_sessions", "filesystem", "user_identity"];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 200;
const HIDDEN = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
// The never-list (CONTRIBUTING.md): words that send a listing to a human.
const NEVER = /\blinkedin\b|\bcoupons?\b|\bcaptcha\b|bot[- ]defen[cs]e|second[- ]factor|\btotp\b|one[- ]time (pass)?code|rate[- ]limit (bypass|evasion)/i;

export const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function validId(id) {
  return (
    typeof id === "string" &&
    id.length <= 64 &&
    id.split(".").length >= 3 &&
    id.split(".").every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))
  );
}
export const reservedId = (id) => id === "app.jawb" || id.startsWith("app.jawb.");
export const validVersion = (v) => typeof v === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) && v.length <= 32;
const validToolName = (n) => typeof n === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(n);

// ---- the listing file -------------------------------------------------------
export function parseListing(text, file = "listing") {
  let doc;
  try {
    doc = parseToml(text);
  } catch (e) {
    fail(`${file}: not valid TOML: ${e.message}`);
  }
  const unknown = Object.keys(doc).filter((k) => !["listing", "versions"].includes(k));
  if (unknown.length) fail(`${file}: unknown table(s) ${unknown.join(", ")} (a listing has [listing] and [[versions]])`);
  const l = doc.listing ?? fail(`${file}: no [listing] table`);
  for (const k of Object.keys(l)) {
    if (!["id", "owners", "homepage", "contact"].includes(k)) fail(`${file}: unknown key listing.${k}`);
  }
  if (!validId(l.id)) fail(`${file}: listing.id \`${l.id}\` is not a reverse-DNS id (com.example.tool, io.github.<user>.<name>)`);
  if (reservedId(l.id)) fail(`${file}: app.jawb.* is jawb's own namespace`);
  if (path.basename(file) !== `${l.id}.toml` && file !== "listing") fail(`${file}: the file must be named ${l.id}.toml`);
  if (!Array.isArray(l.owners) || !l.owners.length || !l.owners.every((o) => /^github:[A-Za-z0-9-]{1,39}$/.test(o))) {
    fail(`${file}: listing.owners is a list of "github:<login>"`);
  }
  if (typeof l.homepage !== "string" || !/^https:\/\/[^\s]+$/.test(l.homepage)) fail(`${file}: listing.homepage is an https URL`);
  if (l.contact !== undefined && (typeof l.contact !== "string" || !/^(https:\/\/|mailto:)[^\s]+$/.test(l.contact))) {
    fail(`${file}: listing.contact is an https or mailto URL`);
  }
  const versions = doc.versions ?? fail(`${file}: no [[versions]] entry`);
  if (!Array.isArray(versions) || !versions.length) fail(`${file}: at least one [[versions]] entry`);
  const seen = new Set();
  for (const v of versions) {
    for (const k of Object.keys(v)) {
      if (!["version", "source", "artifact_sha256"].includes(k)) fail(`${file}: unknown key versions.${k}`);
    }
    if (!validVersion(v.version)) fail(`${file}: version \`${v.version}\` is not X.Y.Z`);
    if (seen.has(v.version)) fail(`${file}: version ${v.version} is listed twice`);
    seen.add(v.version);
    if (!/^[0-9a-f]{64}$/.test(v.artifact_sha256 ?? "")) fail(`${file}: ${v.version}: artifact_sha256 is 64 lowercase hex digits`);
    const s = v.source ?? fail(`${file}: ${v.version}: no source`);
    if (s.kind === "npm") {
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(s.package ?? "")) fail(`${file}: ${v.version}: source.package is an npm package name`);
      if (s.version !== v.version) fail(`${file}: ${v.version}: source.version must equal the listed version`);
      const extra = Object.keys(s).filter((k) => !["kind", "package", "version"].includes(k));
      if (extra.length) fail(`${file}: ${v.version}: unknown source key(s) ${extra.join(", ")}`);
    } else if (s.kind === "url") {
      const loopback = process.env.HUB_ALLOW_LOOPBACK_HTTP === "1" && /^http:\/\/127\.0\.0\.1:\d+\/[^\s?#]+\.(tar\.gz|tgz)$/.test(s.url ?? "");
      if (!loopback && !/^https:\/\/[^\s?#]+\.(tar\.gz|tgz)$/.test(s.url ?? "")) fail(`${file}: ${v.version}: source.url is an https URL of a .tar.gz or .tgz (a GitHub release asset, for example)`);
      const extra = Object.keys(s).filter((k) => !["kind", "url"].includes(k));
      if (extra.length) fail(`${file}: ${v.version}: unknown source key(s) ${extra.join(", ")}`);
    } else {
      fail(`${file}: ${v.version}: source.kind is "npm" or "url"`);
    }
  }
  return { id: l.id, owners: l.owners, homepage: l.homepage, contact: l.contact ?? null, versions };
}

// ---- sources --------------------------------------------------------------------
export async function fetchBytes(url, max = MAX_BYTES) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) fail(`GET ${url}: HTTP ${r.status}`);
  const declared = Number(r.headers.get("content-length") ?? 0);
  if (declared > max) fail(`GET ${url}: ${declared} bytes, more than ${max}`);
  // Read with a cap, so a hostile source cannot exhaust the runner.
  const chunks = [];
  let n = 0;
  for await (const c of r.body) {
    n += c.length;
    if (n > max) fail(`GET ${url}: more than ${max} bytes`);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

export async function fetchSource(source, env = process.env) {
  if (source.kind === "url") {
    const allowHttp = env.HUB_ALLOW_LOOPBACK_HTTP === "1" && /^http:\/\/127\.0\.0\.1:\d+\//.test(source.url);
    if (!allowHttp && !source.url.startsWith("https://")) fail(`${source.url}: https only`);
    return fetchBytes(source.url);
  }
  const registry = (env.HUB_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "");
  const meta = JSON.parse((await fetchBytes(`${registry}/${source.package.replace("/", "%2f")}`, 32 * 1024 * 1024)).toString());
  const v = meta.versions?.[source.version] ?? fail(`npm ${source.package}@${source.version}: no such version`);
  const scripts = Object.keys(v.scripts ?? {}).filter((k) => /^(pre|post)?install$|^prepare$/.test(k));
  if (scripts.length) fail(`npm ${source.package}@${source.version}: has ${scripts.join(", ")} scripts; jawb never runs them, so a package must not need them`);
  const tar = await fetchBytes(v.dist.tarball);
  if (v.dist.integrity) {
    const [alg, b64] = v.dist.integrity.split("-");
    const got = crypto.createHash(alg).update(tar).digest("base64");
    if (got !== b64) fail(`npm ${source.package}@${source.version}: the tarball does not match npm's integrity`);
  }
  return tar;
}

// ---- unpacking (ustar, pax and GNU long names; one top directory stripped) ---
export function untar(tgz) {
  let tar;
  try {
    tar = zlib.gunzipSync(tgz, { maxOutputLength: 4 * MAX_BYTES });
  } catch (e) {
    fail(`not a gzip file: ${e.message}`);
  }
  const files = new Map();
  let off = 0;
  let longName = null;
  let paxPath = null;
  let entries = 0;
  const str = (b) => b.toString("utf8").replace(/\0.*$/s, "");
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (++entries > MAX_ENTRIES * 2) fail(`more than ${MAX_ENTRIES} entries`);
    if (type === "g") continue;
    if (type === "x") {
      for (const rec of data.toString("utf8").split("\n")) {
        const m = rec.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === "L") {
      longName = str(data);
      continue;
    }
    const prefix = str(h.subarray(345, 500));
    let name = paxPath ?? longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    paxPath = null;
    longName = null;
    if (type === "5") continue;
    if (type !== "0") fail(`\`${name}\` is not a regular file (type ${type}); a package holds regular files only`);
    name = name.replace(/^\.\//, "");
    if (name.startsWith("/") || name.split("/").includes("..")) fail(`\`${name}\`: absolute paths and .. are refused`);
    if (files.has(name)) fail(`\`${name}\` appears twice`);
    files.set(name, Buffer.from(data));
  }
  if (!files.has("extension.toml")) {
    const tops = new Set([...files.keys()].map((p) => p.split("/")[0]));
    if (tops.size !== 1) fail("no extension.toml at the root, and not exactly one top-level directory");
    const top = [...tops][0] + "/";
    const stripped = new Map();
    for (const [p, b] of files) stripped.set(p.slice(top.length), b);
    return stripped;
  }
  return files;
}

const allowedPath = (p) =>
  ["extension.toml", "README.md", "LICENSE", "package.json"].includes(p) || /^schemas\/[A-Za-z0-9._-]+\.json$/.test(p);

// ---- the package checks ---------------------------------------------------------
export function checkPackage(files, listing, version) {
  const problems = [];
  const p = (m) => problems.push(m);
  if (files.size > MAX_ENTRIES) p(`more than ${MAX_ENTRIES} files`);
  let total = 0;
  for (const [f, b] of files) {
    total += b.length;
    if (!allowedPath(f)) p(`\`${f}\` may not be in a workflow package (extension.toml, schemas/*.json, README.md, LICENSE, package.json)`);
  }
  if (total > MAX_BYTES) p("the package is over 5 MB unpacked");
  const raw = files.get("extension.toml");
  if (!raw) return { problems: [...problems, "no extension.toml"], manifest: null };
  if (raw.includes(13)) p("extension.toml has CRLF line endings");
  let m;
  try {
    m = parseToml(raw.toString("utf8"));
  } catch (e) {
    return { problems: [...problems, `extension.toml is not valid TOML: ${e.message}`], manifest: null };
  }
  const e = m.extension ?? {};
  if (e.id !== listing.id) p(`extension.toml id \`${e.id}\` is not the listing's \`${listing.id}\``);
  if (e.version !== version) p(`extension.toml version \`${e.version}\` is not the listed ${version}`);
  if (!SHAPES.includes(e.shape)) p(`shape \`${e.shape}\`: jawb installs ${SHAPES.join(", ")} extensions today`);
  if (!Number.isInteger(e.min_api_level) || e.min_api_level < 1) p("[extension] min_api_level is a positive integer");
  for (const k of ["purpose", "publisher"]) {
    if (typeof e[k] !== "string" || !e[k].trim()) p(`[extension] ${k} is required`);
    else if (HIDDEN.test(e[k])) p(`[extension] ${k} holds invisible or bidi characters`);
  }
  const caps = m.capabilities ?? {};
  for (const c of CAPABILITIES) {
    const v = caps[c];
    const empty = v === undefined || v === "none" || (Array.isArray(v) && !v.length) || v === false;
    if (!empty && !caps.why?.[c]) p(`[capabilities.why] needs a reason for \`${c}\``);
  }
  if (!m.limits?.max_steps_per_run || !m.limits?.max_run_seconds) p("[limits] max_steps_per_run and max_run_seconds are required for a workflow");
  const tools = Array.isArray(m.tools) ? m.tools : [];
  if (!tools.length) p("at least one [[tools]] entry");
  const names = new Set();
  const texts = [e.purpose ?? "", files.get("README.md")?.toString("utf8") ?? ""];
  for (const t of tools) {
    if (!validToolName(t.name)) p(`tool \`${t.name}\`: a local name, one label [a-z][a-z0-9_-]*, at most 32 bytes (its full name is ${listing.id}.<name>)`);
    if (names.has(t.name)) p(`tool \`${t.name}\` is declared twice`);
    names.add(t.name);
    const level = RUNNERS[t.runner];
    if (level === undefined) p(`tool \`${t.name}\`: runner \`${t.runner}\` is not one jawb ships (${Object.keys(RUNNERS).join(", ")})`);
    else if (e.min_api_level < level) p(`tool \`${t.name}\`: runner \`${t.runner}\` needs min_api_level ${level} or higher`);
    if (!EFFECTS.includes(t.max_effect)) p(`tool \`${t.name}\`: max_effect is one of ${EFFECTS.join(", ")}`);
    if (typeof t.description !== "string" || !t.description.trim() || t.description.length > 1024) p(`tool \`${t.name}\`: description is 1 to 1024 characters`);
    else if (HIDDEN.test(t.description)) p(`tool \`${t.name}\`: description holds invisible or bidi characters`);
    texts.push(t.description ?? "");
    for (const k of ["input_schema", "output_schema"]) {
      if (!files.has(t[k])) p(`tool \`${t.name}\`: ${k} \`${t[k]}\` is not in the package`);
    }
  }
  for (const [f, b] of files) {
    if (f.startsWith("schemas/")) {
      try {
        JSON.parse(b.toString("utf8"));
      } catch {
        p(`\`${f}\` is not valid JSON`);
      }
    }
  }
  if (HIDDEN.test(texts[1])) p("README.md holds invisible or bidi characters");
  const never = texts.find((t) => NEVER.test(t));
  if (never) p(`mentions something on jawb's never-list (\`${never.match(NEVER)[0]}\`): a maintainer has to look at it`);
  return { problems, manifest: m };
}

// ---- ownership --------------------------------------------------------------------
/** The domain an id names: every label but the last, reversed. */
export const idDomain = (id) => id.split(".").slice(0, -1).reverse().join(".");

export async function proofFor(domain, { fetchText = defaultFetchText, resolveTxt = dns.resolveTxt } = {}) {
  const found = new Set();
  try {
    const t = await fetchText(`https://${domain}/.well-known/jawb-hub.txt`);
    for (const line of t.split(/\r?\n/)) if (/^github:[A-Za-z0-9-]+$/.test(line.trim())) found.add(line.trim().toLowerCase());
  } catch {
    /* not there */
  }
  try {
    for (const rec of await resolveTxt(`_jawb-hub.${domain}`)) {
      const v = rec.join("").trim();
      if (/^github:[A-Za-z0-9-]+$/.test(v)) found.add(v.toLowerCase());
    }
  } catch {
    /* not there */
  }
  return found;
}

async function defaultFetchText(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.text()).slice(0, 64 * 1024);
}

export async function checkOwnership(listing, author, base, deps) {
  const who = `github:${author}`.toLowerCase();
  if (base) {
    if (!base.owners.map((o) => o.toLowerCase()).includes(who)) {
      return [`${author} is not an owner of ${listing.id} (owners on main: ${base.owners.join(", ")})`];
    }
    return [];
  }
  if (!listing.owners.map((o) => o.toLowerCase()).includes(who)) return [`a new listing must name its author (${who}) in owners`];
  const gh = listing.id.match(/^io\.github\.([a-z0-9-]+)\./);
  if (gh) {
    return gh[1] === author.toLowerCase() ? [] : [`io.github.${gh[1]}.* belongs to the GitHub account ${gh[1]}, not ${author}`];
  }
  const domain = idDomain(listing.id);
  const proof = await proofFor(domain, deps);
  return proof.has(who)
    ? []
    : [`no proof that ${author} controls ${domain}: publish \`${who}\` in https://${domain}/.well-known/jawb-hub.txt, or a DNS TXT record \`_jawb-hub.${domain}\` with that value`];
}

// ---- one listing ----------------------------------------------------------------
export async function checkListing(file, { author, baseDir, env, deps } = {}) {
  const problems = [];
  let listing;
  try {
    listing = parseListing(fs.readFileSync(file, "utf8"), file);
  } catch (e) {
    if (e instanceof HubError) return { file, ok: false, problems: [e.message] };
    throw e;
  }
  const basePath = baseDir ? path.join(baseDir, path.basename(file)) : null;
  const base = basePath && fs.existsSync(basePath) ? parseListing(fs.readFileSync(basePath, "utf8"), basePath) : null;
  if (base) {
    for (const bv of base.versions) {
      const now = listing.versions.find((v) => v.version === bv.version);
      if (!now) problems.push(`${bv.version} is published and cannot be removed (ask for a revocation instead)`);
      else if (now.artifact_sha256 !== bv.artifact_sha256 || JSON.stringify(now.source) !== JSON.stringify(bv.source)) {
        problems.push(`${bv.version} is published; its source and sha256 never change (add a new version)`);
      }
    }
  }
  if (author) problems.push(...(await checkOwnership(listing, author, base, deps)));
  const versions = [];
  for (const v of listing.versions) {
    try {
      const bytes = await fetchSource(v.source, env);
      const got = sha(bytes);
      if (got !== v.artifact_sha256) {
        problems.push(`${v.version}: the source's sha256 is ${got}, the listing says ${v.artifact_sha256}`);
        continue;
      }
      const r = checkPackage(untar(bytes), listing, v.version);
      problems.push(...r.problems.map((m) => `${v.version}: ${m}`));
      if (!r.problems.length) versions.push({ ...v, manifest: r.manifest });
    } catch (e) {
      if (!(e instanceof HubError) && !(e instanceof TypeError)) throw e;
      problems.push(`${v.version}: ${e.message}`);
    }
  }
  return { file, ok: problems.length === 0, problems, listing, versions };
}

// ---- listings.json for jawb.app ----------------------------------------------------
const cmpVersion = (a, b) => {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return 1; // 1.0.0 > 1.0.0-rc
    if (pb[i] === undefined) return -1;
    if (typeof pa[i] === typeof pb[i]) return pa[i] < pb[i] ? -1 : 1;
    return typeof pa[i] === "number" ? -1 : 1;
  }
  return 0;
};

export function listingsJson(results, now = new Date()) {
  const listings = results
    .filter((r) => r.listing && r.versions.length)
    .map((r) => {
      const vs = [...r.versions].sort((a, b) => cmpVersion(a.version, b.version));
      const latest = vs[vs.length - 1];
      const m = latest.manifest;
      return {
        id: r.listing.id,
        publisher: m.extension.publisher,
        purpose: m.extension.purpose,
        shape: m.extension.shape,
        homepage: r.listing.homepage,
        owners: r.listing.owners,
        latest: latest.version,
        min_api_level: m.extension.min_api_level,
        tools: m.tools.map((t) => ({ name: `${r.listing.id}.${t.name}`, description: t.description, max_effect: t.max_effect })),
        versions: vs.map((v) => ({ version: v.version, source: v.source, artifact_sha256: v.artifact_sha256 })),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    v: 1,
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    notice:
      "Listed means these exact bytes passed jawb Hub's automated checks. It is not a review, a signature or a warranty; jawb does not vouch for the code. See TERMS.md.",
    listings,
  };
}

// ---- command line ------------------------------------------------------------------
async function main(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--author") args.author = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (!args.cmd) args.cmd = a;
    else args.files.push(a);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (args.cmd === "check") {
    if (!args.files.length) fail("check needs listing files");
    let bad = 0;
    for (const f of args.files) {
      if (!fs.existsSync(f)) {
        console.log(`- ${f}: removed (a removal is a maintainer decision, not an automated one)`);
        bad++;
        continue;
      }
      const r = await checkListing(f, { author: args.author, baseDir: args.base });
      console.log(r.ok ? `ok ${f}` : `FAIL ${f}\n${r.problems.map((p) => `  - ${p}`).join("\n")}`);
      if (!r.ok) bad++;
    }
    return bad ? 1 : 0;
  }
  if (args.cmd === "index") {
    const dir = path.join(here, "..", "listings");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).map((f) => path.join(dir, f));
    const results = [];
    for (const f of files) {
      const r = await checkListing(f, {});
      if (!r.ok) console.error(`::warning::${f} no longer passes and is left out:\n${r.problems.join("\n")}`);
      results.push(r);
    }
    const out = listingsJson(results);
    const target = args.out ?? fail("index needs --out <file>");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
    console.log(`${out.listings.length} listing(s) -> ${target}`);
    return 0;
  }
  fail("usage: hub.mjs check [--author <login>] [--base <dir>] <listing.toml>... | index --out <file>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (!(e instanceof HubError)) throw e;
      console.error(`hub: ${e.message}`);
      process.exit(2);
    },
  );
}
