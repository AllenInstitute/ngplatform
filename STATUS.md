# Status

*As of 2026-11-02.*

## Where things stand

| Piece | State |
|---|---|
| **The platform GUI** | Neuroglancer's views with its position and panel controls, as standard Neuroglancer. Scenes are tabs in the top bar (each with a close button; closing the last leaves a blank scene; rename, reorder); Datasets on the left (Add: a URL, data on this computer, or a new annotation layer); the selected layer's inspector on the right, the platform's own (Source, Render, Segments, Annotations, Schema) with Neuroglancer's shader and histogram editors as components. An **Open in Neuroglancer** button opens the scene in Google's Neuroglancer (saying when it holds Zarr Vectors or local data, which that cannot read); Share also copies links or opens this site's plain `neuroglancer.html`, which reads Zarr Vectors. Open: Open from device (the system file picker), a link or state, and Examples and templates (Blank viewer first). A Python console (Pyodide) with `ngp`, the workspace. Settings menu: view settings, reload layers, hard reset. On/off controls are tick boxes, as in Neuroglancer; plugins have pill switches. Half-width windows keep the camera and settings icons and resizable docks. |
| **Data on this computer** | Open from device or Add → Local: a folder (OME-Zarr, zarr-vectors, precomputed, NIfTI or .trk files, or a folder of them) or a file (NIfTI, TrackVis .trk), read in place through a service worker (`public/local-sw.js`) that asks the page for each file, ranges and all, and answers folder listings as a web server's index page. Remembered in Chrome and Edge; links to it work in that browser while the tab is open. |
| **Virtual Zarr** (local data) | A NIfTI file (`.nii`, `.nii.gz`; NIfTI-1 or -2, either byte order) opens as a chunked, multiscale OME-Zarr 0.6 image made from it as it is read (`src/platform/virtual_zarr/`, in a worker): the sform (else qform) as an affine to x, y, z; time or components as a first axis; scl_slope applied; coarser levels the mean of the finer (labels: the first voxel). A `.nii` is read only where viewed; a `.nii.gz` is decompressed once, on the first chunk. Measured on a 512 × 512 × 400 int16 file (200 MB): header 2 ms, a full-resolution chunk 20 ms, the coarsest level (the whole file read once) 1.9 s. |
| **Virtual zarr-vectors** (Zarr Vectors plugin) | A TrackVis `.trk` on this computer opens as a zarr-vectors 0.9.2 streamline store made from it (`plugins/zarr-vectors/src/virtual/`, in a worker): read once and binned into cells (about ten across the header's extent), then every key made when asked: fragments, bridges, manifests, columns (length, points, the file's properties), per-point values, and a coarse level (one streamline in ten) for large files. RAS+ mm as nibabel reads them. Checked against the plugin's reader, zarr-vectors-py's level-3 validation and `zvtools convert`'s store. 200,000 streamlines (168 MB): open 3.4 s; a sphere's exact group 0.45 s. Data type plugins declare such files (`virtualFormats`); `.tck`, `.trx` and meshes are next. |
| **Plugins** | One folder each in `plugins/`, listed in `plugins/index.ts`; a one-line description and a Read more guide each in the Plugins tab. Plugins from this computer (a JavaScript tool module, or a Python file run in the console's Python) load and reload there. See `plugins/README.md`. |
| **Zarr Vectors** (data type, on) | Reads format 0.9.0 to 0.9.4 into a segmentation layer: points, streamlines, skeletons, graphs, meshes. |
| **Track filtering** (tool, on) | TrackVis-style groups over any dataset that is not an image: zarr-vectors stores (local `.trk` included), precomputed segmentations (a region keeps the segments with a voxel in it, read in a worker at the finest scale with at most 2 M voxels in the box; MICrONS: 247 cells in 1.6 s) and annotation layers (points inside, lines crossing, boxes and ellipsoids overlapping). Datasets in a menu; Show all objects off once there are groups; regions are sliders; `.trk` saved in batches straight to the file; groups written into a local store's own `groups`. |
| **Volume rendering** (tool, off) | "Volume" beside "Sections" in Neuroglancer's 3-D panel: an OME-Zarr or precomputed image (raw or JPEG, sharded or not; uint8) drawn as a solid in the same view (the `draw3d` hook), depth-tested with tracts and annotations, the octant facing the camera cut away and Neuroglancer's sections shown on its faces. Detail is automatic (follows the zoom) or a chosen level; a level over 384 voxels a side is drawn as a 256-voxel box around the position, which follows it (MICrONS' EM: a 2 µm box in 12 s). |
| **Labels** (tool, on) | Labels pinned to points, track groups or annotations; beside the pin or lined up at the view's sides with leader lines; 2-D, 3-D or both; dragged and resized in the views; painted into screenshots. |
| **Registration** (tool, off) | Landmark pairs (Alt+F, Alt+M) fitted as translation, rigid, similarity or affine, with residuals; applied as the layer's transform; plain 4 × 4, ITK / ANTs and LTA files in and out. |
| **Examples** | HCP-1065 on the MNI152 2009a template (the default; the template served from this site's `data/`), and MICrONS minnie65 (EM and v1300 segmentation). The HiP-CT samples (Ha1, Hb1, i74, I80) are not referenced by the app or bundled with it. |
| **Neuroglancer** | google/neuroglancer `master` plus commits on `Andrew-Keenlyside/neuroglancer` branch `ngplatform-upstream`: application-supplied workers, host-owned side panels, incremental layer restore, GCS listing, a one-byte GET where a bucket's CORS blocks HEAD (without it no chunk of the HCP store loaded), switches beside Sections and sections clipped to a box, a screenshot overlay, and resolution histograms laid out by resolution (every level keeps its place; the target line moves). |
| **Filter oracle and engines, step C0** | In `zarr-vectors-tools`, on its branch `working`. |

## Scenes, datasets and the link

- The **link** in the address bar is the whole workspace: every scene and
  every dataset. It is also a plain Neuroglancer link to the scene on show.
- A **scene** is one view of the data: which datasets, drawn how, from
  where, in what layout. Scenes are the tabs in the top bar.
- A **dataset** is a piece of data, matched to layers by its source URL. It
  belongs to the workspace, so any scene can show it.
- A **layer** is one way a scene shows a dataset; a dataset can have several
  (Track filtering adds one for each group).

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

## How it is checked

- `npm test`: 150 unit tests (workspace model, store with a fake engine,
  commands with arguments, key bindings, `when` clauses, schemas, state
  slices, plugin host and switches, the catalogue, the filter computation,
  region geometry, track-group logic, .trk files, groups written into a
  store, sign-in, OME-Zarr transforms, tissue and background, the volume's
  display coordinates, label layout, registration fits and transform
  files, state parsing, undo history, NIfTI read as virtual Zarr: every
  chunk against the file, the pyramid, and placement as Neuroglancer and
  the volume view read it; precomputed chunk ids, minishard indexes and
  sharded scales; regions on segmentations and annotations; `NET=1` adds
  live reads of MICrONS), then the Zarr Vectors plugin's 195 tests (with
  the .trk reader against nibabel and the virtual store read back by the
  plugin's own reader; codecs, layouts including 0.9.4's dense index,
  pyramids, meshes, objects, worker imports) against upstream Neuroglancer.
- `npm run typecheck`: the app and the plugin, with Neuroglancer's sources.
- `npm run e2e` (`tests/e2e/smoke.mjs`): the GUI in headless Chrome, including checks that
  the views fill their area, that only the position and panel controls show
  inside them, the inspector's tabs, that undo makes no data requests,
  scene tabs, that the track groups get exact counts, that a NIfTI opened
  as local data is served as OME-Zarr with the file's voxels and opens as a
  layer, and that a phone-width window does not scroll sideways. All pass (2026-11-01, Chrome
  with SwiftShader: `CHROME=/usr/bin/google-chrome SWIFTSHADER=1`). Where
  NVIDIA's driver is installed but the GPU cannot be opened (this build
  sandbox), the script points Chrome's Vulkan loader at its own SwiftShader;
  otherwise Chrome hangs at start.

## Next

1. Review this build in a browser; fix what the review finds.
2. Run `tests/e2e/smoke.mjs` with `CHROME` set on a machine with a GPU.
3. External plugins from a URL, with a consent dialog.
4. Track filtering, next: endpoint modes (either or both ends in a region),
   mask regions (a painted or thresholded volume), statistics per group, and
   density maps.
5. Virtual stores, next: `.tck` and `.trx` (the same store as `.trk`);
   meshes (`.obj`, `.stl`, `.ply`, GIFTI) and points/skeletons (`.swc`) as
   zarr-vectors; precomputed annotations as zarr-vectors, for filtering;
   TIFF stacks as OME-Zarr; NIfTI in the volume view (it reads uint8 and
   no transpose codec yet).  See TODO.md for the full work plan.
6. Then the plan's other steps: Z1 filter-ready index, `memory://` (gate G3).
