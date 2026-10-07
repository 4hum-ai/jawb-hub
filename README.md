# jawb Hub

Community extensions for [jawb](https://jawb.app), the browser for AI
agents. Publishers list their extensions here by pull request, automated
checks run on every listing, and [jawb.app/extensions](https://jawb.app/extensions)
shows what passed.

> **What "listed" means.** These exact bytes passed jawb Hub's automated
> checks. It is not a review, a signature or a warranty: jawb does not vouch
> for the code. You decide whether to install an extension, and jawb asks
> you to approve what it may do. Read [TERMS.md](TERMS.md).

## How it works

1. **You host your extension.** Publish a release `.tar.gz` (for example a
   GitHub release asset) or an npm package. Your code can stay in your own
   repository, under your own licence. jawb never builds or signs it.
2. **You list it here** with one file, `listings/<id>.toml`, in a pull
   request.
3. **The checks run.** CI fetches your package from its source and checks
   its sha256, the package rules, the manifest, hidden characters and the
   never-list. It also checks that you own the id (below). The pull request
   shows the result. GitHub may hold a first-time contributor's run until a
   maintainer lets it start; that is not a review.
4. **A maintainer merges a green pull request.** No one reviews your code.
   The listing then appears on jawb.app. The listing data is published at
   `https://4hum-ai.github.io/jawb-hub/listings.json` and refreshed daily: a
   listing whose source disappears or changes drops out.

**Preview.** jawb installs only its own built-in extensions today. Until
jawb can install listed extensions (4hum-ai/jawb#163), try one by
downloading and unpacking it, then running
`jawb extension load --dev <directory>`. The developer docs are at
[jawb.app/docs/extensions](https://jawb.app/docs/extensions).

## The listing file

`listings/com.example.hello.toml`:

```toml
[listing]
id = "com.example.hello"            # the extension's id, as in its extension.toml
owners = ["github:alice"]           # who may change this listing
homepage = "https://example.com/hello"
contact = "mailto:security@example.com"   # optional; where security reports go

[[versions]]
version = "1.0.0"
artifact_sha256 = "<sha256 of the exact .tar.gz>"
source = { kind = "url", url = "https://github.com/alice/hello/releases/download/v1.0.0/com.example.hello-1.0.0.tar.gz" }

[[versions]]
version = "1.1.0"
artifact_sha256 = "<sha256 of the npm tarball>"
source = { kind = "npm", package = "@example/jawb-hello", version = "1.1.0" }
```

- **One file per extension.** Add a `[[versions]]` entry for each release.
  A listed version never changes and is never removed: publish a new
  version instead, or ask for a revocation.
- **Sources** are `npm` (jawb never runs install scripts, so your package
  must not need them) or an https `url` of a `.tar.gz`. Both must stay
  available.
- **`artifact_sha256`** is the sha256 of the exact file:
  `sha256sum file.tar.gz`, or for npm, `npm pack --json` and then a sha256
  of the `.tgz` it writes.

## The package

A workflow extension, as jawb installs today, is:

```
extension.toml        the manifest (https://jawb.app/docs/extensions)
schemas/*.json        tool input and output schemas
README.md
LICENSE               optional
package.json          npm packages only; ignored by jawb
```

You can put these files in one top-level directory, as npm's `package/`
does. Nothing else may be in the package.

The checks that apply:
- **id:** reverse-DNS (`com.example.hello`). `app.jawb.*` is jawb's own.
- **Tool names:** local (`run`); the full name is `<id>.run`.
- **Runners:** one jawb ships (`scenario.validate`, `scenario.run`,
  `screens.capture`), with `min_api_level` high enough for it.
- **Grants:** every grant has a reason in `[capabilities.why]`.
- **Text:** no hidden or bidi characters in anything a model reads.
- **Never-list:** nothing on it (TERMS.md).

## Owning an id

- **`io.github.<you>.<name>`:** your GitHub account is the proof. Open the
  pull request as `<you>`.
- **A domain id (`com.example.hello` → `example.com`):** publish one of
  these. The domain is every label of the id but the last, reversed, so
  `com.example.team.tool` names `team.example.com`.
  - `https://example.com/.well-known/jawb-hub.txt` with the line
    `github:<your login>`, or
  - a DNS TXT record `_jawb-hub.example.com` with the value
    `github:<your login>`.
- **After the first listing,** any owner in `owners` may add versions or
  owners.

## Run the checks yourself

```bash
npm ci
node tools/hub.mjs check --author <your github login> listings/com.example.hello.toml
node --test tools/*.test.mjs
```

## Report an extension

Use the "Report an extension" issue form. For anything sensitive, use a
private vulnerability report (Security tab). See [SECURITY.md](SECURITY.md).
