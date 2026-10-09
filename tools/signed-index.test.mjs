// node --test tools/*.test.mjs: the signed index (#139), offline. A test key
// signs here the way CI signs with the minisign CLI (prehashed, with the
// trusted comment `extensions-index <serial> <expires_at>`).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubError, sha } from "./hub.mjs";
import { artifactName, buildIndex, checkBody, checkRevocations, trustedComment, verify, verifyIndex } from "./signed-index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- a minisign test key (Ed25519 over BLAKE2b-512, the "ED" kind) -----------------
function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const id = crypto.randomBytes(8);
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, id, pub: `untrusted comment: test key\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n` };
}
function sign(k, data, trusted) {
  const sig = crypto.sign(null, crypto.createHash("blake2b512").update(data).digest(), k.privateKey);
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), k.privateKey);
  return `untrusted comment: test\n${Buffer.concat([Buffer.from("ED"), k.id, sig]).toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

// ---- a checked listing, as hub.mjs checkListing returns it ---------------------------
const MANIFEST = "[extension]\nid = \"com.example.hello\"\n";
function result(id, versions) {
  return {
    ok: true,
    listing: { id, owners: ["github:alice"], homepage: "https://example.com" },
    versions: versions.map((version) => {
      const bytes = Buffer.from(`package ${id} ${version}`);
      return {
        version,
        source: { kind: "url", url: `https://example.com/${version}.tgz` },
        artifact_sha256: sha(bytes),
        manifest_sha256: sha(Buffer.from(`${MANIFEST}${version}`)),
        size: bytes.length,
        bytes,
        manifest: { extension: { id, version, shape: "workflow", purpose: `Hello ${version}`, publisher: "Example", min_api_level: 21 } },
      };
    }),
  };
}
const NOW = new Date("2026-10-09T06:00:00Z");

test("zero listings still give a valid index, valid for 7 days", () => {
  const { index, packages } = buildIndex({ results: [], now: NOW });
  assert.deepEqual(index, {
    v: 1,
    serial: Math.floor(NOW.getTime() / 1000),
    issued_at: "2026-10-09T06:00:00Z",
    expires_at: "2026-10-16T06:00:00Z",
    extensions: [],
    revoked: [],
    revoked_sha256: [],
  });
  assert.deepEqual(packages, []);
});

test("a listed entry carries the two digests jawbd compares, and a copy of the package", () => {
  const { index, packages } = buildIndex({ results: [result("com.example.hello", ["1.0.0", "1.1.0"])], now: NOW });
  const e = index.extensions[0];
  assert.equal(e.trust, "listed");
  assert.equal(e.latest, "1.1.0");
  assert.equal(e.publisher, "Example");
  assert.deepEqual(Object.keys(e.versions[0]).sort(), ["artifact", "artifact_sha256", "manifest_sha256", "min_api_level", "published_at", "size", "version"]);
  assert.equal(e.versions[0].artifact, artifactName("com.example.hello", "1.0.0"));
  // The artifact name passes the CLI's filter (letters, digits, . - _).
  assert.match(e.versions[0].artifact, /^[A-Za-z0-9._-]+$/);
  assert.deepEqual(
    packages.map((p) => p.key),
    ["extensions/com.example.hello/1.0.0/com.example.hello-1.0.0.tgz", "extensions/com.example.hello/1.1.0/com.example.hello-1.1.0.tgz"],
  );
  assert.equal(sha(packages[0].bytes), e.versions[0].artifact_sha256);
});

test("round trip: signed with the exact trusted comment, the index verifies as jawbd checks it", () => {
  const k = keygen();
  const { index } = buildIndex({ results: [result("com.example.hello", ["1.0.0"])], now: NOW });
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  const tc = trustedComment(index);
  assert.equal(tc, `extensions-index ${index.serial} 2026-10-16T06:00:00Z`);
  const r = verifyIndex([k.pub], bytes, sign(k, bytes, tc));
  assert.equal(r.index.serial, index.serial);
  assert.equal(r.trusted, tc);
  // Another comment, another key, or other bytes: refused.
  assert.throws(() => verifyIndex([k.pub], bytes, sign(k, bytes, `extensions-index ${index.serial + 1} ${index.expires_at}`)), /does not match the index/);
  assert.throws(() => verifyIndex([keygen().pub], bytes, sign(k, bytes, tc)), /does not verify/);
  assert.throws(() => verifyIndex([k.pub], Buffer.concat([bytes, Buffer.from(" ")]), sign(k, bytes, tc)), /does not verify/);
  // A placeholder key is never tried.
  assert.throws(() => verifyIndex(["untrusted comment: PLACEHOLDER\nPLACEHOLDER\n"], bytes, sign(k, bytes, tc)), /no real keys/);
});

test("the serial never goes down, and a listed version never changes bytes", () => {
  const first = buildIndex({ results: [result("com.example.hello", ["1.0.0"])], now: NOW }).index;
  // A clock behind the published serial still gives a higher one.
  const earlier = buildIndex({ results: [result("com.example.hello", ["1.0.0"])], previous: first, now: new Date("2026-10-01T00:00:00Z") }).index;
  assert.equal(earlier.serial, first.serial + 1);
  assert.equal(earlier.extensions[0].versions[0].published_at, first.extensions[0].versions[0].published_at);
  const changed = result("com.example.hello", ["1.0.0"]);
  changed.versions[0].artifact_sha256 = "f".repeat(64);
  assert.throws(() => buildIndex({ results: [changed], previous: first, now: NOW }), /never changes/);
});

test("revocations are checked, sticky, and keep a revoked version from being latest", () => {
  const rev = {
    revoked: [{ id: "com.example.hello", versions: ["1.1.0"], kind: "security", reason: "steals cookies", at: "2026-10-09T05:00:00Z" }],
    revoked_sha256: [{ sha256: "a".repeat(64), kind: "security", reason: "malware", at: "2026-10-09T05:00:00Z" }],
  };
  const { index } = buildIndex({ results: [result("com.example.hello", ["1.0.0", "1.1.0"])], revocations: rev, now: NOW });
  assert.equal(index.extensions[0].latest, "1.0.0");
  assert.deepEqual(index.revoked, rev.revoked);
  assert.deepEqual(index.revoked_sha256, rev.revoked_sha256);
  // Dropping or weakening one is refused.
  assert.throws(() => buildIndex({ results: [], previous: index, revocations: { revoked: rev.revoked }, now: NOW }), /sticky: sha256/);
  assert.throws(
    () => buildIndex({ results: [], previous: index, revocations: { ...rev, revoked: [{ ...rev.revoked[0], kind: "licence" }] }, now: NOW }),
    /sticky: com.example.hello/,
  );
  // Widening one is fine.
  buildIndex({ results: [], previous: index, revocations: { ...rev, revoked: [{ ...rev.revoked[0], versions: "*" }] }, now: NOW });
  for (const bad of [{ extra: 1 }, { revoked: [{ id: "x", versions: [], kind: "security", reason: "r", at: "2026-10-09T05:00:00Z" }] }, { revoked_sha256: [{ sha256: "A".repeat(64), kind: "security", reason: "r", at: "2026-10-09T05:00:00Z" }] }, { revoked_sha256: [{ sha256: "a".repeat(64), kind: "bad", reason: "r", at: "2026-10-09T05:00:00Z" }] }]) {
    assert.throws(() => checkRevocations(bad), HubError, JSON.stringify(bad));
  }
});

test("the body rules match jawbd's: version 1, UTC timestamps, at most 8 days", () => {
  const ok = { v: 1, serial: 1, issued_at: "2026-10-09T00:00:00Z", expires_at: "2026-10-17T00:00:00Z" };
  checkBody(ok);
  assert.throws(() => checkBody({ ...ok, v: 2 }), /version 1/);
  assert.throws(() => checkBody({ ...ok, expires_at: "2026-10-17T00:00:01Z" }), /at most 8 days/);
  assert.throws(() => checkBody({ ...ok, expires_at: "2026-10-09T00:00:00Z" }), /at most 8 days/);
  assert.throws(() => checkBody({ ...ok, issued_at: "2026-10-09T00:00:00.000Z" }), /YYYY/);
});

test("the committed index keys are real and are the ones jawbd pins", () => {
  const now = fs.readFileSync(path.join(HERE, "..", "keys", "index.pub"), "utf8");
  const next = fs.readFileSync(path.join(HERE, "..", "keys", "index-next.pub"), "utf8");
  assert.match(now, /^untrusted comment: minisign public key D1E6E76341C6B51E\n/);
  assert.match(next, /^untrusted comment: minisign public key C21B4924533441ED\n/);
  // verify() refuses a signature by another key before checking it: both decode.
  for (const p of [now, next]) assert.throws(() => verify(p, Buffer.from("x"), sign(keygen(), Buffer.from("x"), "t")), /another key/);
});
