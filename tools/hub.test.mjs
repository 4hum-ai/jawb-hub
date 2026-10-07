// node --test tools/*.test.mjs: the hub checks, offline. A loopback server
// stands in for the npm registry and for a release-asset URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  checkListing,
  checkOwnership,
  checkPackage,
  idDomain,
  listingsJson,
  parseListing,
  sha,
  untar,
  validId,
} from "./hub.mjs";

// ---- a package --------------------------------------------------------------
const MANIFEST = (id = "com.example.hello", version = "1.0.0", extra = "") => `[extension]
id = "${id}"
version = "${version}"
shape = "workflow"
purpose = "Say hello to a local site and write a report"
publisher = "Example"
min_api_level = 21

[matches]
origins = ["http://localhost:*"]

[capabilities]
browser_sessions = ["incognito"]
filesystem = "write:hello"

[capabilities.why]
browser_sessions = "A fresh incognito tab per run"
filesystem = "The report goes under ./hello"

[limits]
max_steps_per_run = 50
max_run_seconds = 120

[[tools]]
name = "run"
description = "Run the hello scenario and write a report"
effect = "act"
max_effect = "act"
runner = "scenario.run"
input_schema = "schemas/run.input.json"
output_schema = "schemas/run.output.json"
${extra}`;
const SCHEMA = '{"type":"object"}';

function tgz(files, { top = "", paxGlobal = false } = {}) {
  const blocks = [];
  const header = (name, size, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  if (paxGlobal) {
    const rec = Buffer.from("52 comment=0123456789abcdef0123456789abcdef01234567\n");
    blocks.push(header("pax_global_header", rec.length, "g"), rec, pad(rec.length));
  }
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    blocks.push(header(top + name, data.length), data, pad(data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const FILES = (manifest = MANIFEST()) => ({
  "extension.toml": manifest,
  "README.md": "# Hello\n",
  "schemas/run.input.json": SCHEMA,
  "schemas/run.output.json": SCHEMA,
});

// ---- the loopback server ----------------------------------------------------
let server;
let base;
const routes = new Map();
before(async () => {
  // Tests only: the listing format and the fetch accept this loopback server.
  process.env.HUB_ALLOW_LOOPBACK_HTTP = "1";
  server = http.createServer((req, res) => {
    const body = routes.get(req.url);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const env = () => ({ HUB_ALLOW_LOOPBACK_HTTP: "1", HUB_NPM_REGISTRY: base });
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `hub-${n}-`));
function listingFile(dir, id, body) {
  const f = path.join(dir, `${id}.toml`);
  fs.writeFileSync(f, body);
  return f;
}
const LISTING = (id, versions, owners = '["github:alice"]') => `[listing]
id = "${id}"
owners = ${owners}
homepage = "https://example.com/hello"
${versions
  .map(
    (v) => `
[[versions]]
version = "${v.version}"
artifact_sha256 = "${v.sha}"
source = ${v.source}
`,
  )
  .join("")}`;

// ---- tests ------------------------------------------------------------------
test("ids are reverse-DNS, and app.jawb.* is not for listings", () => {
  for (const ok of ["com.example.hello", "io.github.alice.tool"]) assert.ok(validId(ok), ok);
  for (const bad of ["example.hello", "Com.example.x", "com.exa-.x", "a"]) assert.ok(!validId(bad), bad);
  assert.equal(idDomain("com.example.team.tool"), "team.example.com");
  assert.throws(() => parseListing(LISTING("app.jawb.evil", [{ version: "1.0.0", sha: "0".repeat(64), source: '{ kind = "url", url = "https://x.example/a.tgz" }' }])), /jawb's own/);
});

test("the listing format is strict", () => {
  const good = LISTING("com.example.hello", [{ version: "1.0.0", sha: "a".repeat(64), source: '{ kind = "npm", package = "@example/hello", version = "1.0.0" }' }]);
  assert.equal(parseListing(good).id, "com.example.hello");
  for (const [bad, want] of [
    [good.replace("homepage", "home"), /unknown key listing.home/],
    [good.replace('version = "1.0.0" }', 'version = "2.0.0" }'), /must equal the listed version/],
    [good.replace("a".repeat(64), "zz"), /64 lowercase hex/],
    [good.replace('kind = "npm"', 'kind = "git"'), /"npm" or "url"/],
    [good.replace('["github:alice"]', '["alice"]'), /github:<login>/],
    [good + "\n[extra]\n", /unknown table/],
  ]) {
    assert.throws(() => parseListing(bad), want);
  }
});

test("npm tarballs and GitHub archives unpack with their top directory stripped", () => {
  const npm = untar(tgz({ ...FILES(), "package.json": "{}" }, { top: "package/" }));
  assert.ok(npm.has("extension.toml") && npm.has("package.json"));
  const gh = untar(tgz(FILES(), { top: "hello-0123abc/", paxGlobal: true }));
  assert.ok(gh.has("schemas/run.input.json"));
  assert.throws(() => untar(tgz({ "a/extension.toml": "x", "b/x": "y" })), /exactly one top-level/);
  assert.throws(() => untar(tgz({ "../extension.toml": "x" })), /\.\./);
});

test("the package checks name what is wrong", () => {
  const listing = { id: "com.example.hello" };
  const files = (m, extra = {}) => new Map(Object.entries({ ...FILES(m), ...extra }).map(([k, v]) => [k, Buffer.from(v)]));
  assert.deepEqual(checkPackage(files(MANIFEST()), listing, "1.0.0").problems, []);
  const cases = [
    [MANIFEST().replace('name = "run"', 'name = "hello.run"'), /local name/],
    [MANIFEST().replace('runner = "scenario.run"', 'runner = "shell"'), /not one jawb ships/],
    [MANIFEST().replace("min_api_level = 21", "min_api_level = 18").replace('runner = "scenario.run"', 'runner = "screens.capture"'), /needs min_api_level 19/],
    [MANIFEST().replace('filesystem = "The report goes under ./hello"\n', ""), /reason for `filesystem`/],
    [MANIFEST().replace("Say hello", "Say\u200b hello"), /invisible or bidi/],
    [MANIFEST().replace("Say hello to a local site", "Find LinkedIn profiles"), /never-list/],
    [MANIFEST().replace('shape = "workflow"', 'shape = "site-tools"'), /installs workflow/],
    [MANIFEST("com.example.other"), /not the listing's/],
  ];
  for (const [m, want] of cases) {
    const ps = checkPackage(files(m), listing, "1.0.0").problems.join("\n");
    assert.match(ps, want, m.slice(0, 60));
  }
  assert.match(checkPackage(files(MANIFEST(), { "run.sh": "echo" }), listing, "1.0.0").problems.join(), /may not be in/);
});

test("ownership: io.github.<user> is that user's; a domain needs proof; an existing listing needs an owner", async () => {
  const L = (id, owners = ["github:alice"]) => ({ id, owners });
  const deps = (lines = [], txt = []) => ({
    fetchText: async () => lines.join("\n"),
    resolveTxt: async () => txt.map((t) => [t]),
  });
  assert.deepEqual(await checkOwnership(L("io.github.alice.tool"), "alice", null, deps()), []);
  assert.match((await checkOwnership(L("io.github.bob.tool"), "alice", null, deps())).join(), /belongs to the GitHub account bob/);
  assert.match((await checkOwnership(L("com.example.tool"), "alice", null, deps())).join(), /no proof that alice controls example.com/);
  assert.deepEqual(await checkOwnership(L("com.example.tool"), "alice", null, deps(["github:alice"])), []);
  assert.deepEqual(await checkOwnership(L("com.example.tool"), "alice", null, deps([], ["github:alice"])), []);
  assert.match((await checkOwnership(L("com.example.tool", ["github:carol"]), "alice", null, deps(["github:alice"]))).join(), /must name its author/);
  assert.match((await checkOwnership(L("com.example.tool"), "mallory", L("com.example.tool"), deps())).join(), /not an owner/);
  assert.deepEqual(await checkOwnership(L("com.example.tool"), "alice", L("com.example.tool"), deps()), []);
});

test("a listing is checked end to end from a URL and from npm, and published versions never change", async () => {
  const pkg = tgz(FILES());
  const npmPkg = tgz({ ...FILES(MANIFEST("com.example.hello", "1.1.0")), "package.json": "{}" }, { top: "package/" });
  routes.set("/hello-1.0.0.tgz", pkg);
  routes.set("/tarballs/hello-1.1.0.tgz", npmPkg);
  routes.set(
    "/@example%2fhello",
    JSON.stringify({ versions: { "1.1.0": { dist: { tarball: `${base}/tarballs/hello-1.1.0.tgz` } } } }),
  );
  const dir = tmp("ok");
  const f = listingFile(
    dir,
    "com.example.hello",
    LISTING("com.example.hello", [
      { version: "1.0.0", sha: sha(pkg), source: `{ kind = "url", url = "${base}/hello-1.0.0.tgz" }` },
      { version: "1.1.0", sha: sha(npmPkg), source: '{ kind = "npm", package = "@example/hello", version = "1.1.0" }' },
    ]),
  );
  const r = await checkListing(f, { env: env() });
  assert.deepEqual(r.problems, []);
  assert.equal(r.versions.length, 2);
  const out = listingsJson([r], new Date("2026-10-07T00:00:00Z"));
  assert.equal(out.listings[0].latest, "1.1.0");
  assert.deepEqual(out.listings[0].tools.map((t) => t.name), ["com.example.hello.run"]);
  assert.match(out.notice, /not a review, a signature or a warranty/);

  // A wrong sha256 is named.
  const bad = listingFile(tmp("sha"), "com.example.hello", LISTING("com.example.hello", [
    { version: "1.0.0", sha: "0".repeat(64), source: `{ kind = "url", url = "${base}/hello-1.0.0.tgz" }` },
  ]));
  assert.match((await checkListing(bad, { env: env() })).problems.join(), /sha256 is/);

  // Against main: a published version may not change or go.
  const changed = listingFile(tmp("chg"), "com.example.hello", LISTING("com.example.hello", [
    { version: "1.0.0", sha: sha(npmPkg), source: `{ kind = "url", url = "${base}/hello-1.0.0.tgz" }` },
  ]));
  const ps = (await checkListing(changed, { env: env(), baseDir: dir })).problems.join("\n");
  assert.match(ps, /1.0.0 is published; its source and sha256 never change/);
  assert.match(ps, /1.1.0 is published and cannot be removed/);

  // npm install scripts are refused: jawb never runs them.
  routes.set(
    "/@example%2fhello",
    JSON.stringify({ versions: { "1.1.0": { scripts: { postinstall: "node x" }, dist: { tarball: `${base}/tarballs/hello-1.1.0.tgz` } } } }),
  );
  const npmOnly = listingFile(tmp("npm"), "com.example.hello", LISTING("com.example.hello", [
    { version: "1.1.0", sha: sha(npmPkg), source: '{ kind = "npm", package = "@example/hello", version = "1.1.0" }' },
  ]));
  assert.match((await checkListing(npmOnly, { env: env() })).problems.join(), /postinstall/);
});

test("every example package passes the listing checks, and the example listing parses", () => {
  const ex = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "examples");
  const read = (dir, rel = "") => {
    const out = new Map();
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) for (const [k, v] of read(dir, r)) out.set(k, v);
      else out.set(r, fs.readFileSync(path.join(dir, r)));
    }
    return out;
  };
  const dirs = fs.readdirSync(ex, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(dirs.length >= 1);
  for (const d of dirs) {
    // A template repository keeps its package in extension/.
    const files = read(path.join(ex, d.name, "extension"));
    const id = files.get("extension.toml").toString().match(/^id = "(.*)"/m)[1];
    const version = files.get("extension.toml").toString().match(/^version = "(.*)"/m)[1];
    assert.deepEqual(checkPackage(files, { id }, version).problems, [], d.name);
  }
  assert.equal(parseListing(fs.readFileSync(path.join(ex, "listing.example.toml"), "utf8")).id, "com.example.hello");
});
