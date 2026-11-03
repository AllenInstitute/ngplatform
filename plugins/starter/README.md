# Starter

An empty tool plugin to copy. It is not listed in `plugins/index.ts`, so
the app does not load it; list it there to try it as it is.

| File | What |
|---|---|
| `manifest.ts` | Its id, name, tab, command and state, known before its code loads |
| `plugin.ts` | A tab listing the scene's layers, drawn again when they or the state change; a counter kept in the scene's state (in the link, undoable, each scene's own); a command that says hello |
| `tests/` | `npm test` runs them |

To begin a plugin of your own: copy this folder to `plugins/<name>/`,
change the ids (`org.example.starter`, `starter.panel`, `starter.hello`,
the state key `starter`) and names, list it in `plugins/index.ts`, and see
[`../README.md`](../README.md) for what `ctx` offers. The same plugin as one
JavaScript file, loadable without building, is
[`examples/plugins/starter.mjs`](../../examples/plugins/starter.mjs); in
Python, [`examples/plugins/starter.py`](../../examples/plugins/starter.py).
