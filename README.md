# ngplatform

A research workspace around [Neuroglancer](https://github.com/google/neuroglancer):
paste a Neuroglancer link, a state or a data URL; organise data into
datasets and scenes; share the workspace as a link; extend it with plugins.

The viewer is for looking: the views, the position in their top left and
each panel's layout buttons in its top right, as in standard Neuroglancer.
Managing data happens around it: **Datasets** and **Scenes** on the left,
the selected dataset's **Layer** controls (Neuroglancer's own tabs) on the
right, settings, screenshots and the keyboard reference in the top bar.
Plugins add tabs on the left and formats to the viewer, and are switched on
and off in the **Plugins** tab.

Where things stand, and what comes next: [`STATUS.md`](STATUS.md). Writing a
plugin: [`docs/plugins.md`](docs/plugins.md). The plan:
[`docs/editor_repo_plan.md`](docs/editor_repo_plan.md). The app, deployed from
the `gh-pages` branch: https://andrew-keenlyside.github.io/ngplatform/ (and
review builds under `/preview/`).

It builds against google/neuroglancer `master` plus three small embedding
changes proposed upstream (`Andrew-Keenlyside/neuroglancer`, branch
`ngplatform-upstream`): workers an application can supply, side panels it
can host, and incremental layer restore. Zarr Vectors support is not in
Neuroglancer: it is a Neuroglancer plugin,
[`packages/neuroglancer-zarr-vectors`](packages/neuroglancer-zarr-vectors/),
which any application embedding Neuroglancer can add, and which the
platform loads as a data type plugin. How plugins are installed and switched:
[`docs/plugins.md`](docs/plugins.md).

## Develop

```bash
git clone -b ngplatform-upstream https://github.com/Andrew-Keenlyside/neuroglancer ../neuroglancer   # next to this repo
(cd ../neuroglancer && npm ci)
npm install
npm run dev           # http://localhost:5173
npm test              # unit tests: the app, then the zarr-vectors plugin
npm run typecheck     # the app and the plugin, with Neuroglancer's sources
npm run build         # dist/, a static site: serve it from any path
```

`npm install` links the fork's source (`file:../neuroglancer`), which runs
its `prepare` script: it builds `lib/` and rewrites the fork's `package.json`
to point there. To work on the fork and the app together, undo that in the
fork with `node build_tools/postpack.ts && rm -rf lib`; the app then builds
from the fork's TypeScript directly, and fork edits show up on the next
build.

The examples stream public data (the default is the HCP-1065 tractogram);
nothing is bundled with the app.

## Test in a browser

```bash
npm run build && (cd dist && python3 -m http.server 4174 &)
CHROME=/usr/bin/google-chrome node e2e/smoke.mjs http://localhost:4174/
```

Use a server that answers missing files with 404. Vite's preview server
answers with `index.html`, which the zarr-vectors reader's probes take for
data. With `CHROME` set the smoke test uses that browser and the machine's
GPU; without it, Playwright's Chromium with SwiftShader, whose WebGL cannot
draw Neuroglancer's views, so the checks that need drawing are skipped.

## Layout

| Path | What |
|---|---|
| `src/engine/` | The only code that touches Neuroglancer: `neuroglancer.ts` (every import), `engine.ts` (the engine with no interface of its own, and the widgets it lends the docks), `plugins.ts` and `workers/` (data type plugins: their main-thread and worker halves, loaded when switched on) |
| `packages/neuroglancer-zarr-vectors/` | The Zarr Vectors data source as a Neuroglancer plugin: its own package, tests and fixtures, no dependency on the platform |
| `src/core/` | Pure logic, unit-tested: the workspace model (scenes, datasets), state I/O, undo history, commands, key bindings, `when` clauses, schemas, state slices |
| `src/platform/` | Services: the workspace store, the plugin host, jobs, registries |
| `src/sdk/` | The plugin API: `PlatformContext` and the manifest |
| `src/ui/` | The shell, docks, panels, dialogs and styles |
| `src/plugins/` | The plugin catalogue, and the Track filtering tool plugin |
| `src/builtins/` | Built-in examples |
| `e2e/smoke.mjs` | Browser smoke test |

## Known limits

- The fork's zarr-vectors reader finds no `zarr.json` through `gs://` URLs.
  Use `https://storage.googleapis.com/...`.
- Over `https://storage.googleapis.com/`, one listing probe is refused
  cross-origin and logs a console error. The layer loads regardless.
