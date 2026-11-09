# Starter (TypeScript)

An empty tool plugin to copy. It is not listed in `plugins/index.ts`, so
the app does not load it; list it there to try it as it is.

| File | What |
|---|---|
| `manifest.ts` | Its id, name, panel (a tool, in the Tools dock under its group), command and state, known before its code loads |
| `plugin.ts` | A panel built from the SDK's parts: a Layers card (an empty state with **Open data…**, the list, a copy button whose status line reports only progress and errors) and a Counter card kept in the scene's state (in the link, undoable, each scene's own); drawn once and updated in place; a command that says hello |
| `starter.mjs` | The same plugin as one JavaScript file, for Plugins → **Add** without building the app |
| `tests/` | `npm test` runs them: the plugin's functions, a panel test (the panel drawn into the SDK's stand-in document, `@ngplatform/sdk/testing`) and a disposal test, to copy |

To begin a plugin of your own: copy this folder to `plugins/<name>/`,
change the ids (`org.example.starter`, `starter.panel`, `starter.hello`,
the state key `starter`), names and Tools group, list it in
`plugins/index.ts`, and see [`../README.md`](../README.md) for what `ctx`
offers and how a panel is built. The same plugin as one
JavaScript file, loadable without building (Plugins → **Add**), is
[`starter.mjs`](starter.mjs); in Python, [`../starter_py`](../starter_py).
