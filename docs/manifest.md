# Manifest reference: `extension.toml`

Every extension has one `extension.toml` at the root of its package. jawb
parses it **fail-closed**: an unknown key, an unknown section or a reserved
one is refused with a named error, and nothing is installed. A newer field
never gets silently ignored by an older jawb. Instead, `min_api_level` makes
the older jawb refuse the package up front.

This page describes what the Hub lists: **workflow** extensions, which run
one of jawb's runners with your grants and your input schema, and **code
extensions** (API level 35), whose tool runs your own JavaScript bundle on
Node.js (see "Code extensions" below).

## `[extension]`

| Key | Required | Rule |
|---|---|---|
| `id` | yes | A reverse-DNS name, like a mobile app bundle id: a domain you control, reversed, then the name (`com.example.site-check`), or `io.github.<your login>.<name>`. It has at least three labels of `[a-z0-9-]`, and each label starts and ends with a letter or digit. At most 64 bytes. `app.jawb.*` is jawb's own. |
| `version` | yes | `MAJOR.MINOR.PATCH`, with an optional `-prerelease`. A listed version never changes. |
| `shape` | yes | `workflow`. The shapes `site-tools` and `api-tools` are parsed but not installed yet; `policy-pack` and `reader` are reserved. |
| `purpose` | yes | One sentence: the single thing it does. People read it when they approve the install. No invisible or bidi characters. |
| `publisher` | yes | Your name or your organisation's, at most 64 bytes. No invisible or bidi characters. |
| `min_api_level` | yes | The lowest jawb API level it needs. Use the level that added the runner you name (below). jawb refuses the package at a lower level instead of half-running it. |

## `[matches]`

| Key | Rule |
|---|---|
| `origins` | The sites the extension may open or act on: `scheme://host[:port]`. `*` stands for any port (`http://localhost:*`), and `*.` for the leftmost host label (`https://*.example.com`). Patterns have no paths. jawb refuses anything outside them (`outside_matches`), including after a redirect. |

## `[capabilities]`

Every grant that is not empty needs a one-line reason in
`[capabilities.why]`, under the same key. The reasons are shown when someone
installs your extension.

| Key | Default | Meaning |
|---|---|---|
| `browser_sessions` | none | `"incognito"` and/or `"profile:<name>"`, as a string or a list. Incognito tabs share no cookies or sign-ins. A profile carries the user's sign-ins, so ask for one only if you need it. |
| `secrets` | `[]` | Names of vault secrets the extension may fill (`fill_secret` steps). jawb fills the value itself; the extension never sees it. |
| `filesystem` | `"none"` | `"write:<relative dir>"`: the runner writes its report and files only under that directory, relative to where the user runs `jawb`. |
| `network_domains` | `[]` | Reserved for API-tool extensions. |
| `user_identity` | `false` | Reserved. |

```toml
[capabilities]
browser_sessions = ["incognito"]
filesystem = "write:site-screens"

[capabilities.why]
browser_sessions = "Each page opens in a fresh incognito tab, with no sign-ins"
filesystem = "Screenshots and the report go under ./site-screens"
```

## `[limits]`

| Key | Required | Meaning |
|---|---|---|
| `max_steps_per_run` | yes | The most `/v1` requests one tool call may make (at most 10000). jawb stops the run there (`run_limit`). |
| `max_run_seconds` | yes | The longest one tool call may take (at most 86400). |

## `[[tools]]`

One entry per tool. A tool's **full name** is `<extension id>.<name>`
(`com.example.site-check.capture`). Users and agents can call it by any
shorter ending that is unique on their machine (`site-check.capture`).

| Key | Rule |
|---|---|
| `name` | The local name: one label, `[a-z][a-z0-9_-]*`, at most 32 bytes, unique in this extension. |
| `description` | 1 to 1024 characters. An agent reads it to decide when to call the tool: say what it does and what it returns, plainly. No invisible or bidi characters, and no instructions to the model. |
| `runner` | One of jawb's runners, below. |
| `effect` | What the tool normally does: `none`, `act`, `submit`, `download`, `upload` or `credential`. |
| `max_effect` | The ceiling. jawb refuses any action above it (`exceeds_max_effect`). Purchase-like actions are always held for a human whatever you declare, and an extension can never approve anything. |
| `input_schema` | `schemas/<name>.json`: what the tool accepts. jawb validates every call against it before the run starts. |
| `output_schema` | `schemas/<name>.json`: what it returns. |

### Runners

| Runner | Since API level | What it does | Its input |
|---|---|---|---|
| `scenario.validate` | 18 | Checks a scenario and opens no page. | `scenario` |
| `scenario.run` | 18 | Runs a scenario's criteria and writes `report.md` and `report.json` with a verdict per criterion. | `scenario`, `profile`, `incognito`, `out_dir`, `stop_on_first_fail`, `step_timeout_ms` |
| `screens.capture` | 19 | Screenshots pages at each viewport and colour scheme. | `base_url`, `pages`, `viewports`, `schemes`, `name`, `out_dir`, `step_timeout_ms` |
| `exec` | 35 | Runs your own bundle (see "Code extensions"). | What your `input_schema` allows |

The runner reads those input fields. Your `input_schema` decides which of
them a caller may send, and with what values. **Narrowing the schema is how
a workflow extension makes a runner its own.** For example, pin `base_url`
to your site with `enum`, or limit `pages` to the paths you publish. The
scenario format is documented at
[jawb.app/docs/extensions](https://jawb.app/docs/extensions).

### The schema subset

Schemas use only these JSON Schema keywords: `type`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, `minimum`,
`maximum`, `minLength`, `maxLength`, `description` and `default`. Any other
keyword (`$ref`, `pattern`, `oneOf`, …) is refused at install. Set
`"additionalProperties": false` on objects, so callers cannot slip in fields
you did not plan for.

## Reserved sections

These are refused today, so the format never has to break to add them:
`[[triggers]]`, `[storage]`, `[[artifacts]]`, `[[prompts]]`, `[test]`,
`[[rules]]`, `[reader]` and `[plugin]`.

## The package

A `.tar.gz` holding exactly:

```
extension.toml
schemas/*.json
README.md
LICENSE          optional
package.json     optional; inert data, jawb never runs its scripts
dist/**          code extensions only: *.mjs, *.js, *.json, *.wasm
```

The files may sit in one top-level directory (npm's `package/` does this).
At most 5 MB and 200 entries, regular files only, LF line endings. The only
directories are `schemas/` and `dist/` (with subdirectories in `dist/`).

## Code extensions

A code extension has a tool with `runner = "exec"` (API level 35, so
`min_api_level = 35` or higher) and a `[runtime]` section:

```toml
[runtime]
node = ">=22"                  # >=MAJOR[.MINOR[.PATCH]], 22 or higher
entry = "dist/extension.mjs"   # a .mjs or .js file under dist/, in the package

[[tools]]
name = "summarise"
runner = "exec"
# description, effect, max_effect, input_schema, output_schema as above
```

The code runs on Node.js with the user's full access, so jawb installs it
only on an approval the operating system verifies, and jawb.app marks it.
[Code extensions](https://jawb.app/docs/extensions#code-extensions) on
jawb.app describes the API. jawb never runs `npm install`, so build one
bundle that carries its own dependencies (esbuild, Rollup or tsup). The Hub
refuses a package, as jawb does, that:

- holds `node_modules`, a `.node` addon, or any other executable (a file
  that is a native program is refused whatever its name);
- holds a symlink, a hard link or a device;
- holds anything outside the layout above, such as `src/` or a `.sh` file,
  or a `dist/` path that is hidden or more than 8 levels deep;
- declares an npm lifecycle script in `package.json` (`preinstall`,
  `install`, `postinstall`, `prepare`, `prepublish`, `preprepare`,
  `postprepare`); a `build` script is fine;
- has no `[runtime]`, a `node` range that allows Node 20 or lower, or an
  `entry` that is missing or outside `dist/`;
- has `dist/` or `[runtime]` but no `exec` tool.

`listings.json` marks a code extension with `code: true` and its `runtime`.

## What is coming

- **Hooks.** Code extensions reacting to what happens in jawb, with
  `[activation]` (which URLs and sessions) and `[[hooks]]` (which events),
  from ADR 0023 phase 3, issue #198 in
  [4hum-ai/jawb](https://github.com/4hum-ai/jawb). The Hub already checks
  them, and `listings.json` will show them with every wildcard event
  expanded, but it refuses them until a jawb release installs them.
