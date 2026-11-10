# Contributing

ngplatform is meant to be built by the people who use it. There are many
ways in, and most do not need any code.

## Without code

- **Notes on a plugin's page.** Every plugin page ends with *Notes from
  users*: add a tip, a workflow, a problem or a figure. The pencil icon at
  the top of a page opens it for editing on GitHub.
- **Report a problem** or **suggest a plugin** with the issue templates on
  [GitHub](https://github.com/AllenInstitute/ngplatform/issues/new/choose).
- **Share an example**: a public dataset and a view of it that shows
  something well can become one of the examples in **Open**.

## With code

```bash
git clone -b ngplatform-upstream https://github.com/Andrew-Keenlyside/neuroglancer ../neuroglancer
(cd ../neuroglancer && npm ci && node build_tools/postpack.ts && rm -rf lib)
git clone https://github.com/AllenInstitute/ngplatform && cd ngplatform
npm install
npm run dev        # http://localhost:5173
npm test           # the platform and every plugin
npm run typecheck
npm run e2e        # the GUI in headless Chrome, against a served build
```

- **A new plugin** is a folder in `plugins/`; start from the closest
  existing one. See the [plugin guide](https://github.com/AllenInstitute/ngplatform/blob/main/plugins/README.md).
  Give it a `README.md` with a figure at the top, and a page here (from the
  [template](plugins/template.md)).
- **Plugins import the platform only as `@ngplatform/sdk`**, so they keep
  working as the platform changes underneath.
- **Tests:** each plugin has a `tests/` folder run by `npm test`. Run the
  tests, the type check and, for anything visible, the e2e smoke test
  before opening a pull request.
- **Style:** match the code around you. Comments say why, in plain words.

## Checks and CI

CI runs as seldom as it usefully can: on every pull request, and by hand
from the Actions tab. It never runs on a push, so pushing work in progress
costs nothing (`[skip ci]` in its message is not needed). Each run has two
jobs ([`.github/workflows/ci.yml`](https://github.com/AllenInstitute/ngplatform/blob/main/.github/workflows/ci.yml)):

- **app:** `npm ci`, then `npm run typecheck` (the app and the zarr-vectors
  plugin), `npm test` (the platform's tests, then zarr-vectors'), the
  build, and `npm run budget`, which fails when the JavaScript the page
  loads at startup, or the largest file the build makes, grows past its
  limit (in `tests/e2e/bundle_budget.mjs`).
- **runner:** the runner's and render service's tests, `python -m pytest
  runner/tests`, with `pip install "./runner[test]"`. On CI's CPU the tests
  that need CuPy and a GPU, torch or zarr-vectors-tools skip.

Tests of the UI modules run in a DOM (jsdom): a test file opts in with a
first line of `// @vitest-environment dom`; every other test runs in Node.

The browser smoke test is run by hand before a pull request that changes
anything visible; it needs no network, as it serves its own data and a
fake runner:

```bash
npm run build
python3 -m http.server 4231 --bind 127.0.0.1 --directory dist &
CHROME=/path/to/chrome SWIFTSHADER=1 npm run e2e -- http://127.0.0.1:4231/
```

## These docs

The docs are Markdown in `docs/`, built with MkDocs:

```bash
pip install -r docs/requirements.txt
mkdocs serve       # http://127.0.0.1:8000
```
