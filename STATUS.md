# Status

*As of 2026-10-31.*

## Where things stand

| Piece | State |
|---|---|
| **The platform GUI** (0.3) | The viewer is for looking: views, position (top left) and each panel's layout buttons (top right), as standard Neuroglancer. Datasets and Scenes on the left; the selected dataset's Layer controls (Neuroglancer's own tabs, full height) on the right; settings, screenshot and keyboard reference in the top bar. **Not yet checked by eye in a browser by me**; yours is the first visual check. |
| **Plugins** | Built into the app, listed in `src/plugins/catalogue.ts`, switched on and off in the Plugins tab (reloads with the same link). Two kinds: *data type* (a format) and *tool* (a left-dock tab). Requirements between plugins are enforced. See `docs/plugins.md`. |
| **Zarr Vectors** (data type plugin) | `packages/neuroglancer-zarr-vectors`: reads format 0.9.0 to 0.9.4, including 0.9.4's dense object index. Its Neuroglancer modules and worker code load only when it is on. A public `reader` entry for tools. Fixed: a byte range longer than 8 MiB (a large level-0 cell) was read short, from both ends. 177 tests against upstream Neuroglancer. |
| **Example data** | HCP-1065 (public population tractogram) only, with three track groups. The HiP-CT samples (Ha1, Hb1, i74, I80) are not referenced by the app or bundled with it. |
| **Track filtering** (tool plugin, requires Zarr Vectors) | TrackVis-style track groups: each group keeps the objects through its regions (spheres and boxes; AND, OR, NOT) with attributes in range, and is a layer of its own, in its own colour, switched on and off here or in the Datasets tab. One group is edited at a time; regions are annotations in the views (Alt-drag to move) kept in step with the panel. Region tests run in a worker on level 0, reading only the chunks a region touches; a coarse level previews while a region moves. |
| **Volume view** (tool plugin) | In place of Neuroglancer's 3-D panel (its 2-D views stay): a solid brain ray-marched in WebGL2 from a coarse level held as one 3-D texture, the octant facing the camera cut away at the position, its three faces showing sections resampled from finer levels in a worker (coarse first, then sharper), and the visible track groups drawn through the cut, depth-tested against the brain. Reads OME-Zarr 0.4 to 0.6 (zarr v3, sharded), several stores merged by voxel size, placed through an image's coordinate transforms (BigBrain's linear affine to MNI). Default: BigBrain (your OME-Zarr release on the BigBrain FTP) under HCP-1065. Structure after Open the Mind (BigBrain Hackathon 2026), reimplemented client-side; none of its code is used (it is CC BY-NC). **Shaders not compiled here** (no browser; the sandbox would not run glslang): the view says so in its status line if they fail. |
| **Auth** | A left-dock tab: services the workspace needs a sign-in for, with who is signed in; middleauth built in (tokens kept where Neuroglancer keeps them); plugins add providers. |
| **Neuroglancer** | google/neuroglancer `master` (c8c4d139, 2026-10-28) plus four commits on `Andrew-Keenlyside/neuroglancer` branch `ngplatform-upstream`: (1) application-supplied workers, (2) host-owned side panels, (3) incremental layer restore, (4) a fix so `https://storage.googleapis.com` URLs can be listed (GCS answers with an XML namespace upstream rejected; without it a zarr-vectors store over https has no segment properties). |
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

## Track filtering on HCP-1065, measured

Level 0 is 102 M vertices in 31 × 32 × 34 mm cells, stored raw (no
compression) and sharded. Measured from this machine, in Node, with the
worker's code (reads and tests):

| Region | Level | Read | Cold | Warm (cached chunks) | Objects |
|---|---|---|---|---|---|
| Left CST, sphere r 6 mm in the internal capsule | 1 (preview, 10% sample) | 7 MB | 1.5 s | 0.04 s | 900 |
| | 0 (exact) | 71 MB | 3.6 s | 0.04–0.05 s | 9,599 |
| Corpus callosum, 4 × 70 × 16 mm midline box | 1 (preview) | 15 MB | 1.3 s | 0.06 s | 2,628 |
| | 0 (exact) | 150 MB | 5.2 s | 0.11 s | 25,734 |

So the first exact answer in a new area takes seconds (the download), and
moving a region around an area already read is exact at 10–20 updates a
second. The worker keeps up to 320 MB of decoded geometry (about 17 bytes a
vertex).

What would make the first answer fast too is in the store, not the viewer:
smaller level-0 cells, compressed vertices, or a per-fragment bounding-box
column (so a region reads only the fragments near it). Any of these is an
offline rewrite of the store (`zvtools index`, the plan's Z1).

### Saving a group as .trk

"Save .trk" in the group editor writes the group's streamlines, whole, as a
TrackVis v2 file on a 1 mm RAS grid from the store's bounds (so every group
of a dataset shares one header). The worker reads the group's object
manifests, then each chunk the group passes through once, only the group's
rows, 16 chunks at a time, and stitches each streamline in walk order:

| Group | Streamlines | Points | Chunks | Read | Write | File |
|---|---|---|---|---|---|---|
| Left CST (both spheres), all streamlines | 2,913 | 763,398 | 15 | 2.7 s | 8 ms | 8.7 MB |
| Same, level 1 sample | 313 | 82,369 | 13 | 2.2 s | 14 ms | 0.9 MB |
| 10,000 objects spread over the brain (worst case) | 10,000 | 1.94 M | 106 | 12.7 s | | |

Reading the same 10,000 one object at a time took about five minutes (33
objects a second), which is what the bulk read replaces.

## The volume view on BigBrain, measured (Node, from this machine)

BigBrain's levels in MNI are 1.32, 0.53, 0.26 and 0.13 mm (its linear
affine scales the histology by about 1.3). The solid is the 0.53 mm level
(9 MB compressed, 329 × 286 × 371): 3.8–7 s in Node with the pure-JS zstd
decoder (browsers decode with WebAssembly). A 0.26 mm section across the
brain is about 40 of the 200 µm store's 128³ chunks (6.5–9 s cold in Node;
nearby positions reuse them). 0.13 mm sections are about 50 MB a face.

## How it is checked

- `npm test`: 97 unit tests (workspace model, store with a fake engine,
  commands with arguments, key bindings, `when` clauses, schemas, state
  slices, plugin host and switches, the catalogue, the filter computation,
  region geometry, track-group logic, .trk files, sign-in, OME-Zarr transforms (against BigBrain's metadata),
  state parsing, undo history), then the Zarr Vectors plugin's 182 tests
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
4. Track filtering, next: endpoint modes (either or both ends in a region),
   mask regions (a painted or thresholded volume), statistics per group, and
   density maps.
5. Then the plan's other steps: Z1 filter-ready index, `memory://` (gate G3).
