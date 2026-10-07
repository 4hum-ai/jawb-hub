# site-screens (template)

A jawb workflow extension that screenshots your own site's pages at phone and
desktop sizes, in light and dark, in one tool call. It runs jawb's
`screens.capture` runner, pinned to one site by its input schema.

Use it as a starting point: see the tutorial in
[jawb-hub/docs](https://github.com/4hum-ai/jawb-hub/tree/main/docs).

```
jawb tool call site-screens.capture --input '{"base_url": "https://example.com", "pages": ["/", "/pricing"]}'
```

It may open only `https://example.com`, in incognito tabs, and write only
under `./site-screens`. It never clicks, fills or submits.
