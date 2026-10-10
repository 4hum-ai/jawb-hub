# Manifest reference: `extension.toml`

Every extension has one `extension.toml` at the root of its package. jawb
parses it **fail-closed**: an unknown key, an unknown section or a reserved
one is refused with a named error, and nothing is installed. A newer field
never gets silently ignored by an older jawb. Instead, `min_api_level` makes
the older jawb refuse the package up front.

This page describes what jawb accepts today: **workflow** extensions, which
run one of jawb's runners with your grants and your input schema. Code
extensions, with activation rules and hooks, are being designed (see
"What is coming" at the end).

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
package.json     npm packages only; jawb ignores it
```

The files may sit in one top-level directory (npm's `package/` does this).
At most 5 MB and 200 files, regular files only, LF line endings.

## What is coming

- **Code extensions.** Your own code, run by jawb, with activation rules
  (for example "on these URLs"), hook registration and one supported stack.
  This is under design: ADR 0023 in
  [4hum-ai/jawb](https://github.com/4hum-ai/jawb), issue #166. It is not
  available yet, and this page will describe it once it ships.
