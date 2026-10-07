# Build and list your first extension

In about fifteen minutes you build a jawb extension that screenshots your
own site's pages at phone and desktop sizes, in light and dark. Then you
try it locally, release it, and list it on jawb Hub. You need:

- `jawb` and `jawbd` at API level 21 or later (`jawb --json status` shows
  `api_level`), with Chrome or Chromium installed;
- a GitHub account, and a repository for your extension.

A jawb extension today is a **workflow**: a manifest that runs one of jawb's
runners with grants you declare and an input schema you write. It contains
no code, and every step it takes is an ordinary jawb command under jawb's
checks. Code extensions are coming (see the [manifest reference](manifest.md)).

## 1. Start from the template

Copy [`examples/site-screens/`](../examples/site-screens) into a new
repository, including its `.github/workflows/release.yml`. The package
itself lives in `extension/`. jawb loads and packs only that folder, so the
rest of your repository (`.git`, CI, notes) stays out of it.

```
site-screens/                    your repository
  extension/                     the package
    extension.toml
    schemas/capture.input.json
    schemas/capture.output.json
    README.md
  .github/workflows/release.yml
  README.md
```

## 2. Make it yours

In `extension/extension.toml`:

1. **`id`.** Set it to `io.github.<your login>.site-screens`, or, if you
   own a domain, its reverse-DNS form such as `com.example.site-screens`.
   The id is how jawb Hub knows the listing is yours (step 6).
2. **`publisher`.** Set your name.
3. **`[matches] origins`.** Set your site's origin, such as
   `https://www.example.com`. The extension can open nothing else.
4. **`purpose` and the tool `description`.** Name your site. People read
   `purpose` when they approve the install, and an agent reads the
   description to decide when to call the tool.

In `extension/schemas/capture.input.json`, set `base_url`'s `enum` to the same
origin. This pins the runner to your site: a caller cannot point it
anywhere else, and jawb rejects such a call before anything runs.

Every grant has a reason in `[capabilities.why]`. Keep them true and short:
they are shown at install. The [manifest reference](manifest.md) lists
every key.

## 3. Try it locally

Load the directory as a development extension. It is unsigned and labelled
`dev`, and you approve it like any install:

```bash
jawb extension load --dev ./extension
```

jawb shows what the extension may do, its origins, sessions and files, and
asks you to type `install`. Then call its tool:

```bash
jawb tools
jawb tool call site-screens.capture --input '{"base_url": "https://www.example.com", "pages": ["/", "/pricing"]}'
```

The tool's full name is `io.github.<you>.site-screens.capture`, but any
unique ending works, as above. The screenshots and `report.md` land in
`./site-screens/screens/`. Try a page outside your origin, or another
`base_url`. jawb refuses before opening anything (exit 2). That refusal is
the manifest doing its job.

When you change the files, load the directory again. When you are done:
`jawb extension remove <id>`.

## 4. Check it the way jawb Hub will

```bash
git clone https://github.com/4hum-ai/jawb-hub && cd jawb-hub && npm ci --ignore-scripts
```

After step 5 you can run the full listing check on your listing file. To
check the package before that, `jawbd lint-extension ./extension`
runs jawb's own manifest checks without installing anything.

## 5. Release it

Push your repository, then tag a version that matches `version` in
`extension/extension.toml`:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow packs `extension/` (`extension.toml`, `README.md`,
`schemas/`, and `LICENSE` if present) into `<id>-0.1.0.tar.gz`, and attaches the file to a
GitHub release. Its run summary prints the sha256 and the listing entry for
step 6. A released version must never change. To fix something, raise the
version and release again.

## 6. Prove the id is yours

- **`io.github.<you>.*`:** nothing to do. You open the pull request as
  `<you>`.
- **A domain id:** publish your GitHub login on the domain the id names.
  For `com.example.site-screens`, that is `example.com`:
  - `https://example.com/.well-known/jawb-hub.txt` containing the line
    `github:<your login>`, or
  - a DNS TXT record `_jawb-hub.example.com` with the value
    `github:<your login>`.

## 7. List it on jawb Hub

Fork [jawb-hub](https://github.com/4hum-ai/jawb-hub), and add
`listings/<id>.toml` with the entry from step 5:

```toml
[listing]
id = "io.github.your-login.site-screens"
owners = ["github:your-login"]
homepage = "https://github.com/your-login/site-screens"

[[versions]]
version = "0.1.0"
artifact_sha256 = "<from the release summary>"
source = { kind = "url", url = "https://github.com/your-login/site-screens/releases/download/v0.1.0/io.github.your-login.site-screens-0.1.0.tar.gz" }
```

Run the checks locally with
`node tools/hub.mjs check --author <your login> listings/<id>.toml`, then
open a pull request and tick the boxes in its template (they include the
[listing terms](../TERMS.md)). The "Listing checks" job fetches your
release, compares the sha256 and checks the package and your id. A
maintainer merges a green pull request without reviewing your code, and
your extension appears on [jawb.app/extensions](https://jawb.app/extensions).

Releasing 0.2.0 later is one more `[[versions]]` entry in the same file.

## What people see

- **On jawb.app:** your `purpose`, publisher, latest version and tool names,
  with the notice that a listing is not a review.
- **At install:** where it comes from, and what it may do with your reasons.
  jawb asks again whenever an update wants more.

jawb installs only its built-in extensions today. Until it can install
listed ones (#163 in 4hum-ai/jawb), people try yours with
`jawb extension load --dev` after downloading and unpacking the release.
