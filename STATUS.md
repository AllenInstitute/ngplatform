# Status

*As of 2026-10-31.*

## Where things stand

| Piece | State |
|---|---|
| **The platform GUI** (this release, 0.2) | Built and unit-tested. Neuroglancer shows only data; datasets, scenes, layer controls, selection, position, settings and help are in the platform's docks and dialogs. **Not yet checked by eye in a browser**: see below. |
| **Plugin system** | Host, manifest, `PlatformContext`, contract tests, author guide. One built-in plugin (zarr-vectors store facts). No downstream plugins yet, by design. |
| **Neuroglancer fork** | Branch `ngplatform` (`zarr_vectors_working` + two commits' worth of change): a viewer option to leave side panels to the host, and incremental layer restore. Not rebased onto upstream; the command registry and `setupEngine` (#1147) are not needed for this release. |
| **Filter oracle and engines, step C0** | Done, in `zarr-vectors-tools`, parked as patches in [`pending/zarr-vectors-tools/`](pending/zarr-vectors-tools/). |
| **Gate G1** | Measured; see [`docs/editor_repo_plan.md`](docs/editor_repo_plan.md) §5. |

## The workspace model

- A **workspace** is everything one link carries.
- A **scene** is one Neuroglancer state. Scene tabs sit in the top bar; the
  Scenes tab manages them (new, copy, rename, reorder, delete).
- A **dataset** is a piece of data, matched to layers by its source URL. It
  belongs to the workspace, so any scene can show it; the Datasets tab lists
  the active scene's datasets, with the workspace's others below, ready to
  add.
- A **layer** is one way a scene shows a dataset. A dataset can be shown
  through several layers ("Add another view"), which is the hook later
  filtering plugins use.

The link is `#!{"ng": <active scene>, "app": {"platform": {scenes, datasets}, …plugins}}`,
so it is still a valid Neuroglancer link for the active scene. "Copy this
scene as a plain Neuroglancer link" drops the rest.

## The GUI

| Where | What |
|---|---|
| Top bar | Open, add a dataset, Share, undo/redo, scene tabs, status, screenshot, view settings, keyboard reference, command palette (Ctrl/⌘ K) |
| Left dock | **Datasets** (show/hide, select, rename, reorder, add a view, remove from scene, delete), **Scenes**, **View** (Neuroglancer's position widget, zoom, rotation, layout, display switches), **Plugins** |
| Right dock | **Inspector** (the selected dataset: Neuroglancer's own controls for its layer type, then the Source and contributed sections), **Selection** (Neuroglancer's selection details), **Pointer** |
| Bottom dock | Activity log, Jobs, chunk Statistics, Python (placeholder) |
| Below the views | Neuroglancer's status messages |

Keys: digits 1–9 show or hide datasets, Alt+digit selects one, Shift+N adds
a dataset, Alt+PageUp/PageDown change scene, Ctrl/⌘ Z undo, Ctrl/⌘ / the
reference. Navigation keys and mouse bindings in the views are
Neuroglancer's.

Undo, redo and switching scenes restore only what changed: unchanged layers
are kept, and replaced layers keep their data sources alive until the new
ones are ready, so nothing reloads.

## How it is checked

- `npm test`: 53 unit tests (workspace model, store with a fake engine,
  commands with arguments, key bindings, `when` clauses, schemas, state
  slices, plugin host with fixture plugins, state parsing, undo history).
- `npm run typecheck`: the app together with Neuroglancer's sources.
- `node e2e/smoke.mjs`: rewritten for the new GUI, including checks that the
  views fill their area, that no Neuroglancer interface shows inside them,
  and that a layout change and its undo make no data requests. **Not run
  yet**: headless Chrome does not start in the build sandbox used for this
  release, so the first visual check is yours.

## Next

1. Review this build in a browser; fix what the review finds.
2. Run `e2e/smoke.mjs` with `CHROME` set on a machine with a GPU.
3. External plugins from a URL, with a consent dialog.
4. Then the plan's next steps: Z1 filter-ready index, `memory://` (gate G3),
   the compute runtime (Pyodide worker), and the first plugin.
