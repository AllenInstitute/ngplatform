# ngplatform

A research workspace around [Neuroglancer](https://github.com/google/neuroglancer):
paste a Neuroglancer link, a state or a data URL; organise data into
datasets and scenes; share the workspace as a link; extend it with plugins.

Neuroglancer is the rendering engine and nothing else: the views show only
data. Everything Neuroglancer offers around them (the layer list, each
layer's controls, selection details, position, settings, help, statistics,
status messages) is reached through the platform's own interface, which
mounts Neuroglancer's widgets in its docks where they exist.

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
platform loads in `src/engine/plugins.ts`.

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

The bundled example is generated, not committed. Either take it from the
deployed site, or build it:

```bash
git archive origin/gh-pages examples | tar -x -C public/
python scripts/make_excerpt.py path/to/store.zarrvectors   # needs zarr-vectors-py and -tools
```

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
| `src/engine/` | The only code that touches Neuroglancer: `neuroglancer.ts` (every import), `engine.ts` (the engine with no interface of its own, and the widgets it lends the docks), `plugins.ts` and `workers/` (Neuroglancer plugins: their main-thread and worker halves) |
| `packages/neuroglancer-zarr-vectors/` | The Zarr Vectors data source as a Neuroglancer plugin: its own package, tests and fixtures, no dependency on the platform |
| `src/core/` | Pure logic, unit-tested: the workspace model (scenes, datasets), state I/O, undo history, commands, key bindings, `when` clauses, schemas, state slices |
| `src/platform/` | Services: the workspace store, the plugin host, jobs, registries |
| `src/sdk/` | The plugin API: `PlatformContext` and the manifest |
| `src/ui/` | The shell, docks, panels, dialogs and styles |
| `src/builtins/` | Built-in contributions: examples, the Source section, zarr-vectors store facts (as a plugin) |
| `e2e/smoke.mjs` | Browser smoke test |

## Known limits

- The fork's zarr-vectors reader finds no `zarr.json` through `gs://` URLs.
  Use `https://storage.googleapis.com/...`.
- Over `https://storage.googleapis.com/`, one listing probe is refused
  cross-origin and logs a console error. The layer loads regardless.
