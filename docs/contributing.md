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
git clone https://github.com/AllenInstitute/ngplatform && cd ngplatform
git clone https://github.com/Andrew-Keenlyside/neuroglancer ../neuroglancer
git -C ../neuroglancer checkout "$(node -p 'require("./package.json").neuroglancer.commit')"
(cd ../neuroglancer && npm ci && node build_tools/postpack.ts && rm -rf lib)
npm install
npm run dev        # http://localhost:5173
npm test           # the platform and every plugin
npm run typecheck
npm run lint       # ESLint (eslint.config.js)
npm run e2e        # the GUI in headless Chrome, against a served build
```

### The Neuroglancer it is built against

`package.json` depends on `file:../neuroglancer`: a checkout of the fork
beside this one. Which commit is pinned in `package.json`
(`neuroglancer.commit`); CI checks out that commit (its `FORK_SHA` names
the same one) and so does the deploy. `npm run check:neuroglancer` says
whether your checkout is at the pin, and every `vite build` warns when it is
not, or has uncommitted changes: the build would then differ from the one
CI and the deploy make. Settings › About shows the commit a build used.

Move the pin deliberately, in `package.json` and `FORK_SHA` together, with
the e2e smoke test passing; [the casts into Neuroglancer's
internals](dev/neuroglancer-casts.md) are where a new Neuroglancer breaks
things the type checker cannot see.

The other dependencies are pinned to exact versions, and `package-lock.json`
is committed.

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

## Releases

A release is a version of the app on GitHub Pages that people can name.

- **Versions** follow `MAJOR.MINOR.PATCH`, in `package.json`. While the
  version starts with 0, MINOR goes up for new features and changes people
  will notice, PATCH for fixes. A change that breaks saved workspaces or
  links people have shared is noted as such in the changelog.
- **Tags** are `v` and the version (`v0.3.0`), on a commit on `main`
  whose `package.json` has that version. A tag is never moved; a fix is a
  new version.
- **The changelog** ([CHANGELOG.md](https://github.com/AllenInstitute/ngplatform/blob/main/CHANGELOG.md))
  collects what changed under *Unreleased* as the work is merged, in
  plain words for the people who use the app.

To make one:

1. On `main`, with the checks passing (tests, typecheck, lint, the e2e
   smoke test against a build), set the version in `package.json` (and
   `package-lock.json`: `npm version 0.3.0 --no-git-tag-version`).
2. In `CHANGELOG.md`, turn *Unreleased* into `## 0.3.0 — <date>` and start
   a new, empty *Unreleased* above it.
3. Commit (`Version 0.3.0`), tag (`git tag -a v0.3.0 -m "Version 0.3.0"`)
   and push the commit and the tag.
4. In the Actions tab, run **Deploy** with the tag. It checks that the tag
   and `package.json` agree and that the Neuroglancer pin is checked out,
   runs the tests, type check and lint, builds, and replaces the
   `gh-pages` branch's contents with the build. Tabs open on the old build
   reload once when they next need a file it replaced.

The runner has its own version (`runner/pyproject.toml` and
`ngplatform_runner/__init__.py`). When the app starts to need something a
runner gained, raise `MIN_RUNNER_VERSION` in `src/platform/runner.ts` to
that runner's version: older runners are then reported in Activity and
Settings › About, with what to do.

## These docs

The docs are Markdown in `docs/`, built with MkDocs:

```bash
pip install -r docs/requirements.txt
mkdocs serve       # http://127.0.0.1:8000
```
