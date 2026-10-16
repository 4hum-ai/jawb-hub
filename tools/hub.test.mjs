// node --test tools/*.test.mjs: the hub checks, offline. A loopback server
// stands in for the npm registry and for a release-asset URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseToml } from "smol-toml";
import {
  checkListing,
  checkOwnership,
  checkPackage,
  expandHookEvent,
  idDomain,
  listingsJson,
  parseListing,
  sha,
  untar,
  validDistPath,
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
  for (const [name, v] of Object.entries(files)) {
    // A string or Buffer is a regular file; { type } is any other entry
    // (5 directory, 2 symlink, 1 hard link).
    const type = typeof v === "object" && !Buffer.isBuffer(v) ? v.type : "0";
    const data = type === "0" ? Buffer.from(v) : Buffer.alloc(0);
    blocks.push(header(top + name, data.length, type), data, pad(data.length));
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

// ---- code packages (ADR 0023 phase 1c, 4hum-ai/jawb#195) ---------------------
// The manifest is core's own fixture for an exec extension
// (crates/extensions/src/manifest.rs `tests::CODE`). No fixture files are
// shared between jawbd and the Hub yet, so the Hub keeps a copy, and the
// cases below mirror core's `exec_tools_need_runtime_level_35_and_node_22`,
// `dist_paths`, `exec_bundles_unpack_and_load_from_a_directory` and
// `code_packages_check_their_bundle_and_package_json`.
const CODE = (extra = "") => `
[extension]
id = "com.example.code"
version = "0.1.0"
shape = "workflow"
purpose = "Summarise a page with the extension's own code"
publisher = "Example"
min_api_level = 35

[matches]
origins = ["http://localhost:*"]

[capabilities]
browser_sessions = ["incognito"]

[capabilities.why]
browser_sessions = "A fresh incognito tab per call"

[limits]
max_steps_per_run = 20
max_run_seconds = 30

[runtime]
node = ">=22"
entry = "dist/extension.mjs"

[[tools]]
name = "summarise"
description = "Summarise a page"
effect = "act"
max_effect = "act"
runner = "exec"
input_schema = "schemas/in.json"
output_schema = "schemas/out.json"
${extra}`;
const CODE_FILES = (manifest = CODE(), extra = {}) => ({
  "extension.toml": manifest,
  "README.md": "# Code\n",
  "schemas/in.json": SCHEMA,
  "schemas/out.json": SCHEMA,
  "dist/extension.mjs": "export function activate() {}\n",
  ...extra,
});
const codeListing = { id: "com.example.code" };
const asMap = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
const codeProblems = (manifest, extra = {}, drop = []) => {
  const files = asMap(CODE_FILES(manifest, extra));
  for (const d of drop) files.delete(d);
  return checkPackage(files, codeListing, "0.1.0").problems.join("\n");
};
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

test("dist paths follow jawbd's valid_dist_path", () => {
  for (const ok of ["dist/extension.mjs", "dist/a/b/c.js", "dist/data.json", "dist/m.wasm"]) assert.ok(validDistPath(ok), ok);
  for (const bad of ["dist/", "dist/x.node", "dist/node_modules/x.js", "dist/.hidden.js", "dist/x.exe", "dist/x.sh", "src/x.mjs", "dist/a b.js", "dist/a/b/c/d/e/f/g/h/i.js"]) {
    assert.ok(!validDistPath(bad), bad);
  }
});

test("a code package with a dist/ bundle and an inert package.json passes", () => {
  const extra = {
    "dist/lib/util.js": "export const x = 1;\n",
    "dist/m.wasm": "\0asm\x01\0\0\0",
    "dist/data.json": "{}",
    "package.json": '{"name":"x","type":"module","scripts":{"build":"esbuild src/extension.ts"}}',
    LICENSE: "MIT\n",
  };
  assert.deepEqual(checkPackage(asMap(CODE_FILES(CODE(), extra)), codeListing, "0.1.0").problems, []);
  // Through the unpacker, with directory entries and npm's wrapper.
  const files = untar(
    tgz({ "": { type: "5" }, "dist/": { type: "5" }, "dist/lib/": { type: "5" }, "schemas/": { type: "5" }, ...CODE_FILES(CODE(), extra) }, { top: "package/" }),
  );
  assert.ok(files.has("dist/lib/util.js") && files.has("dist/m.wasm"));
  assert.deepEqual(checkPackage(files, codeListing, "0.1.0").problems, []);
});

test("a code package is refused for what jawbd refuses, and named", () => {
  const cases = [
    // The bundle.
    [CODE(), { "dist/node_modules/left-pad/index.js": "//" }, [], /node_modules is refused/],
    [CODE(), { "node_modules/left-pad/index.js": "//" }, [], /node_modules is refused/],
    [CODE(), { "dist/addon.node": "x" }, [], /native addons \(\.node\) are refused/],
    [CODE(), { "addon.node": "x" }, [], /native addons/],
    [CODE(), { "dist/run.sh": "#!/bin/sh" }, [], /may not be in dist\//],
    [CODE(), { "dist/.hidden.js": "//" }, [], /may not be in dist\//],
    [CODE(), { "src/extension.ts": "//" }, [], /may not be in a package/],
    [CODE(), { "bin/tool": "x" }, [], /may not be in a package/],
    [CODE(), { "dist/tool.js": ELF }, [], /native executable/],
    [CODE(), { "dist/tool.wasm": Buffer.from([0x4d, 0x5a, 0x90, 0]) }, [], /native executable/],
    // package.json is inert data.
    [CODE(), { "package.json": '{"scripts":{"postinstall":"node x"}}' }, [], /`postinstall` script/],
    [CODE(), { "package.json": '{"scripts":{"prepare":"tsc"}}' }, [], /`prepare` script/],
    [CODE(), { "package.json": "{not json" }, [], /package.json is not JSON/],
    // [runtime].
    [CODE(), {}, ["dist/extension.mjs"], /entry `dist\/extension.mjs` is not in the package/],
    [CODE().replace('entry = "dist/extension.mjs"', 'entry = "extension.mjs"'), { "extension.mjs": "x" }, [], /not a bundle under dist\//],
    [CODE().replace('entry = "dist/extension.mjs"', 'entry = "dist/x.json"'), { "dist/x.json": "{}" }, [], /not a bundle under dist\//],
    [CODE().replace('entry = "dist/extension.mjs"', 'entry = "dist/../x.mjs"'), {}, [], /not a bundle under dist\//],
    [CODE().replace('node = ">=22"', 'node = ">=20"'), {}, [], /Node 20; it must be >=22/],
    [CODE().replace('node = ">=22"', 'node = "^22"'), {}, [], /not a Node range/],
    [CODE().replace('node = ">=22"', 'node = ">=22.1.2.3"'), {}, [], /not a Node range/],
    [CODE().replace('[runtime]\nnode = ">=22"\nentry = "dist/extension.mjs"\n', ""), {}, [], /needs \[runtime\]/],
    [CODE().replace('runner = "exec"', 'runner = "scenario.run"'), {}, [], /\[runtime\] is only for extensions with an exec tool/],
    [CODE().replace("[runtime]\n", "[runtime]\nextra = 1\n"), {}, [], /unknown key\(s\) in \[runtime\]: extra/],
    [CODE().replace("min_api_level = 35", "min_api_level = 34"), {}, [], /runner `exec` needs min_api_level 35/],
    // Sections jawbd refuses.
    [CODE("\n[foo]\nx = 1\n"), {}, [], /unknown section \[foo\]/],
    [CODE('\n[[triggers]]\non = "x"\n'), {}, [], /\[triggers\] is reserved/],
  ];
  for (const [m, extra, drop, want] of cases) {
    assert.match(codeProblems(m, extra, drop), want, want.source);
  }
  // `>= 24.1.0` is a range jawb understands.
  assert.equal(codeProblems(CODE().replace('node = ">=22"', 'node = ">= 24.1.0"')), "");
  // A workflow with no exec tool may not carry a bundle.
  const wf = asMap({ ...FILES(), "dist/x.mjs": "" });
  assert.match(checkPackage(wf, { id: "com.example.hello" }, "1.0.0").problems.join(), /no exec tool/);
});

test("the unpacker refuses symlinks, links, stray directories and odd paths", () => {
  const files = CODE_FILES();
  for (const [extra, want] of [
    [{ "dist/link.js": { type: "2" } }, /not a regular file.*symlinks/],
    [{ "dist/hard.js": { type: "1" } }, /not a regular file/],
    [{ "node_modules/": { type: "5" } }, /unexpected directory `node_modules\/`/],
    [{ "dist/node_modules/": { type: "5" } }, /unexpected directory/],
    [{ "other/": { type: "5" } }, /unexpected directory/],
    [{ "dist\\x.js": "x" }, /not a plain relative path/],
    [{ "dist//x.js": "x" }, /not a plain relative path/],
    [{ "dist/./x.js": "x" }, /not a plain relative path/],
  ]) {
    assert.throws(() => untar(tgz({ ...files, ...extra })), want, Object.keys(extra)[0]);
  }
  // The same inside npm's wrapper.
  assert.throws(() => untar(tgz({ ...files, "dist/link.js": { type: "2" } }, { top: "package/" })), /symlinks/);
  assert.throws(() => untar(tgz({ ...files, "node_modules/": { type: "5" } }, { top: "package/" })), /unexpected directory/);
});

// ---- activation and hooks (ADR 0023 sections 5 and 6) ---------------------
const HOOKS = `
[activation]
urls = ["http://localhost:*/pull/*", "http://localhost:*/**"]
sessions = ["incognito"]

[[hooks]]
on = "nav.open.after"
where = { ok = true }
input = ["tab", "url", "status"]

[[hooks]]
on = "act.*.after"
input = ["tab", "verb"]
`;
const ACTIVATION = '[activation]\nurls = ["http://localhost:*/pull/*", "http://localhost:*/**"]\nsessions = ["incognito"]\n';

test("hook events expand in the verb position only", () => {
  assert.deepEqual(expandHookEvent("nav.open.after"), ["nav.open.after"]);
  assert.equal(expandHookEvent("act.*.after").length, 11);
  assert.ok(expandHookEvent("act.*.after").includes("act.dialog-accept.after"));
  assert.deepEqual(expandHookEvent("nav.*.after"), ["nav.open.after", "nav.navigate.after", "nav.history.after", "nav.reload.after"]);
  for (const bad of ["*", "*.open.after", "act.click.*", "act.*.before", "tab.*.after"]) assert.equal(expandHookEvent(bad), null, bad);
});

test("[activation] and [[hooks]] are checked, and refused until jawbd installs them (#198)", () => {
  // A well-formed declaration is refused for one reason only: no jawbd yet.
  assert.equal(
    codeProblems(CODE(HOOKS)),
    "[activation] and [[hooks]] are ADR 0023 phase 3 (4hum-ai/jawb#198): no released jawbd installs them yet, so the Hub cannot list them",
  );
  for (const [extra, want] of [
    [HOOKS.replace('on = "nav.open.after"', 'on = "nav.open.before"'), /\.before gate point is for \[\[rules\]\] only/],
    [HOOKS.replace('on = "nav.open.after"', 'on = "daemon.started"'), /daemon\.\* events are never given/],
    [HOOKS.replace('on = "nav.open.after"', 'on = "*.open.after"'), /names a catalogue event|wildcard may stand only for the verb/],
    [HOOKS.replace('on = "nav.open.after"', 'on = "act.click.after"'), /act.click.after has another hook/],
    [HOOKS.replace('on = "act.*.after"', 'on = "nav.*.after"'), /nav.open.after has another hook/],
    [HOOKS.replace('"http://localhost:*/pull/*"', '"https://github.com/*/*/pull/*"'), /outside \[matches\] origins/],
    [HOOKS.replace('"http://localhost:*/pull/*"', '"localhost/pull"'), /not an origin pattern/],
    [HOOKS.replace('sessions = ["incognito"]', 'sessions = ["profile:work"]'), /`profile:work` is not granted/],
    [HOOKS.replace("where = { ok = true }", "where = { ok = { gt = 1 } }"), /equality or membership/],
    [HOOKS.replace(ACTIVATION, ""), /\[\[hooks\]\] needs \[activation\]/],
  ]) {
    assert.match(codeProblems(CODE(extra)), want, want.source);
  }
  // Hooks are for code.
  const wf = asMap(FILES(MANIFEST("com.example.hello", "1.0.0", HOOKS)));
  assert.match(checkPackage(wf, { id: "com.example.hello" }, "1.0.0").problems.join(), /for extensions with an exec tool/);
});

test("listings.json shows code, its runtime, and hooks expanded for jawb.app", async () => {
  // End to end: a code package from a release URL passes and is listed.
  const pkg = tgz(CODE_FILES(CODE(), { "package.json": '{"name":"code","private":true}' }), { top: "code-0.1.0/" });
  routes.set("/code-0.1.0.tgz", pkg);
  const f = listingFile(
    tmp("code"),
    "com.example.code",
    LISTING("com.example.code", [{ version: "0.1.0", sha: sha(pkg), source: `{ kind = "url", url = "${base}/code-0.1.0.tgz" }` }]),
  );
  const r = await checkListing(f, { env: env() });
  assert.deepEqual(r.problems, []);
  const l = listingsJson([r]).listings[0];
  assert.equal(l.code, true);
  assert.deepEqual(l.runtime, { node: ">=22", entry: "dist/extension.mjs" });
  assert.equal(l.tools[0].runner, "exec");
  assert.equal(l.activation, null);
  assert.deepEqual(l.hooks, []);

  // A version with hooks (once jawbd installs them) shows each one expanded.
  const manifest = parseToml(CODE(HOOKS));
  const h = listingsJson([{ ...r, versions: [{ ...r.versions[0], manifest }] }]).listings[0];
  assert.deepEqual(h.activation, { urls: ["http://localhost:*/pull/*", "http://localhost:*/**"], sessions: ["incognito"] });
  assert.equal(h.hooks.length, 2);
  assert.deepEqual(h.hooks[0], { on: "nav.open.after", events: ["nav.open.after"], where: { ok: true }, input: ["tab", "url", "status"] });
  assert.equal(h.hooks[1].on, "act.*.after");
  assert.deepEqual(h.hooks[1].events, expandHookEvent("act.*.after"));
  assert.ok(h.hooks[1].events.includes("act.click.after"));

  // A workflow listing says it is not code.
  const plain = listingsJson([{ ...r, versions: [{ ...r.versions[0], manifest: parseToml(MANIFEST()) }] }]).listings[0];
  assert.equal(plain.code, false);
  assert.equal(plain.runtime, null);
});
