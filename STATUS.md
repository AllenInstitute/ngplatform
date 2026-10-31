# Status

*As of 2026-10-31.*

## Where things stand

| Piece | State |
|---|---|
| **The platform GUI** (0.3) | The viewer is for looking: views, position (top left) and each panel's layout buttons (top right), as standard Neuroglancer. Datasets and Scenes on the left; the selected dataset's Layer controls (Neuroglancer's own tabs, full height) on the right; settings, screenshot and keyboard reference in the top bar. **Not yet checked by eye in a browser by me**; yours is the first visual check. |
| **Plugins** | Built into the app, listed in `src/plugins/catalogue.ts`, switched on and off in the Plugins tab (reloads with the same link). Two kinds: *data type* (a format) and *tool* (a left-dock tab). Requirements between plugins are enforced. See `docs/plugins.md`. |
| **Zarr Vectors** (data type plugin) | `packages/neuroglancer-zarr-vectors`: reads format 0.9.0 to 0.9.4, including 0.9.4's dense object index. Its Neuroglancer modules and worker code load only when it is on. 176 tests against upstream Neuroglancer. |
| **Track filtering** (tool plugin, requires Zarr Vectors) | Filters a Zarr Vectors dataset's objects by attribute ranges (histograms, two-handled sliders) and groups, counts what passes, shows the passing objects in their own view, exports CSV. The filter is in the link; the passing set is recomputed from it. |
| **Neuroglancer** | google/neuroglancer `master` (c8c4d139, 2026-10-28) plus three commits on `Andrew-Keenlyside/neuroglancer` branch `ngplatform-upstream`: (1) application-supplied workers, (2) host-owned side panels, (3) incremental layer restore. |
| **Filter oracle and engines, step C0** | Done, in `zarr-vectors-tools`, parked as patches in [`pending/zarr-vectors-tools/`](pending/zarr-vectors-tools/). |
| **Gate G1** | Measured; see [`docs/editor_repo_plan.md`](docs/editor_repo_plan.md) §5. |

## Scenes, datasets and the link

- The **link** in the address bar is the whole workspace: every scene and
  every dataset. It is also a plain Neuroglancer link to the scene on show.
- A **scene** is one view of the data: which datasets, drawn how, from
  where, in what layout. Scene tabs sit in the top bar; the Scenes tab
  manages them.
- A **dataset** is a piece of data, matched to layers by its source URL. It
  belongs to the workspace, so any scene can show it.
- A **layer** is one way a scene shows a dataset; a dataset can have several
  (Track filtering adds one for its result).

## How it is checked

- `npm test`: 68 unit tests (workspace model, store with a fake engine,
  commands with arguments, key bindings, `when` clauses, schemas, state
  slices, plugin host and switches, the catalogue, the filter computation,
  state parsing, undo history), then the Zarr Vectors plugin's 176 tests
  (codecs, layouts including 0.9.4's dense index, pyramids, meshes, objects,
  worker imports) against upstream Neuroglancer.
- `npm run typecheck`: the app and the plugin, with Neuroglancer's sources.
- `node e2e/smoke.mjs`: rewritten for the new GUI, including checks that the
  views fill their area, that only the position and panel controls show
  inside them, that a layout change and its undo make no data requests, and
  that the plugins and the filtering tab work. **Not run
  yet**: headless Chrome does not start in the build sandbox used for this
  release, so the first visual check is yours.

## Next

1. Review this build in a browser; fix what the review finds.
2. Run `e2e/smoke.mjs` with `CHROME` set on a machine with a GPU.
3. External plugins from a URL, with a consent dialog.
4. Track filtering, next: region filters (sphere, box, slab) on level-0
   geometry, chunk by chunk (the filter plan's P2), which needs the compute
   runtime (a worker; Pyodide or TypeScript per gate G1).
5. Then the plan's other steps: Z1 filter-ready index, `memory://` (gate G3).
