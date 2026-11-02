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

## These docs

The docs are Markdown in `docs/`, built with MkDocs:

```bash
pip install -r docs/requirements.txt
mkdocs serve       # http://127.0.0.1:8000
```
