# Contributing to ngplatform

Thank you for helping. The full guide, including ways to help without
writing code, is in the docs: [`docs/contributing.md`](docs/contributing.md).

In short:

- **Problems and ideas:** open an issue; there are templates for bug reports
  and for plugin ideas.
- **Plugins:** one folder in [`plugins/`](plugins/), started from the closest
  existing one; see [`plugins/README.md`](plugins/README.md). Give it a
  `README.md` with a figure at the top, and a user page in `docs/plugins/`.
- **Before a pull request:** `npm test`, `npm run typecheck`, and for anything
  visible `npm run e2e`.
- **Docs:** Markdown in [`docs/`](docs/), built with MkDocs
  (`pip install -r docs/requirements.txt && mkdocs serve`).
