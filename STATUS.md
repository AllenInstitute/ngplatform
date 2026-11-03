# Status

*As of 2026-11-03. The night's work, below, is on `main`; new work goes to `working` first.*

## Where things stand

| Piece | State |
|---|---|
| **The platform GUI** | Neuroglancer's views with its position and panel controls, as standard Neuroglancer. Scenes are tabs in the top bar (each with a close button; closing the last leaves a blank scene; rename, reorder); Datasets on the left (Add: a URL, data on this computer, or a new annotation layer); the selected layer's inspector on the right, the platform's own (Source, Render, Segments, Annotations, Schema) with Neuroglancer's shader and histogram editors as components. An **Open in Neuroglancer** button opens the scene in Google's Neuroglancer (saying when it holds Zarr Vectors or local data, which that cannot read); Share also copies links or opens this site's plain `neuroglancer.html`, which reads Zarr Vectors. Open: Open from device (the system file picker), a link or state, and Examples and templates (Blank viewer first). A Python console (Pyodide) with `ngp`, the workspace; `await ngp.show(array, voxel_size=…, origin=…, labels=…)` shows a numpy array as an image or segmentation layer (a NIfTI made in the page, read as virtual Zarr). Settings menu: view settings, reload layers, hard reset. On/off controls are tick boxes, as in Neuroglancer; plugins have pill switches. Half-width windows keep the camera and settings icons and resizable docks. |
| **Data on this computer** | Open from device or Add → Local: a folder (OME-Zarr, zarr-vectors, precomputed, NIfTI or tractogram files, or a folder of them) or a file (NIfTI, a .trk, .tck or .trx tractogram, an .obj, .stl or .ply mesh), read in place through a service worker (`src/sw.ts`) that asks the page for each file, ranges and all, and answers folder listings as a web server's index page. Remembered in Chrome and Edge; links to it work in that browser while the tab is open. |
| **Virtual Zarr** (local data) | A NIfTI file (`.nii`, `.nii.gz`, or a `.hdr`/`.img` pair, Analyze 7.5 too; NIfTI-1 or -2, either byte order) opens as a chunked, multiscale OME-Zarr 0.6 image made from it as it is read (`src/platform/virtual_zarr/`, in a worker): the sform (else qform) as an affine to x, y, z; time or components as a first axis; scl_slope applied; coarser levels the mean of the finer (labels: the first voxel). A `.nii` is read only where viewed; a `.nii.gz` is decompressed once, on the first chunk, and the decompressed copy kept in the browser's private file system (OPFS, the six most recently used) for later visits. Measured on a 512 × 512 × 400 int16 file (200 MB): header 2 ms, a full-resolution chunk 20 ms, the coarsest level (the whole file read once) 1.9 s. TIFF stacks (`.tif`, `.tiff`; classic or BigTIFF, either byte order, strips or tiles, none/LZW/deflate/PackBits with the horizontal predictor, 8 to 64-bit samples, or 8-bit RGB and RGBA) are served by the same store, the pages as z planes, decoded as read; OME-TIFF and ImageJ hyperstacks give channels or time points and pixel sizes; thumbnails and pyramid pages are skipped. Each image's metadata carries an OME display window (0.5–99.5th percentile of its middle plane), which the app applies as the layer's contrast. Colour images (RGB and RGBA TIFFs, NIfTI RGB24 and RGBA32) are served packed, one uint32 a voxel with a nearest-voxel pyramid, marked in their metadata; the app gives such a layer a shader that shows the colours. |
| **Virtual zarr-vectors** (Zarr Vectors plugin) | Meshes and surfaces on this computer (`.obj` by object, `.stl`, `.ply`, GIFTI, FreeSurfer `lh.pial` and the like, anatomical surfaces moved into scanner RAS as zarr-vectors-tools does) open as a zarr-vectors 0.9.3 mesh store in one cell (faces in the file's winding, one fragment and face group per object, ids from 1, `coordinate_offset`), checked through the plugin's own mesh path and zarr-vectors-py's validator. A tractogram on this computer (TrackVis `.trk`, MRtrix `.tck`, `.trx`, stored or deflated, float16 too) opens as a zarr-vectors 0.9.2 streamline store made from it (`plugins/zarr-vectors/src/virtual/`, in a worker): read once and binned into cells (about ten across the header's extent), then every key made when asked: fragments, bridges, manifests, columns (length, points, the file's properties), per-point values, and a coarse level (one streamline in ten) for large files. RAS+ mm as nibabel reads them. Checked against the plugin's reader, zarr-vectors-py's level-3 validation and `zvtools convert`'s store. 200,000 streamlines (168 MB): open 3.4 s; a sphere's exact group 0.45 s. SWC neurons open as a skeleton store (one object per tree, nodes depth-first from the root, radius and type per node; nodes, cable length and branch points per tree; micrometres; a folder of SWC files as one store too, each neuron's file a property: 30 neurons, 7 through a sphere in 0.5 s) and point tables (`.csv`, `.tsv`, `.xyz`) as points with their numeric columns, each point an object up to 250,000 so Track filtering selects them (5,000 cells: 374 in a sphere, exact, in 0.04 s), and past that drawn from cells about eight across (300,000 points: 60 cells) but not grouped (the panel says so); skeletons and grouped points in one cell, read back exactly by the plugin's reader and by zarr-vectors-py's `read_graph`/`read_points`. Data type plugins declare such files (`virtualFormats`); zarr-vectors-tools has a byte-identical Python twin of each (`zvtools virtual serve`). |
| **Plugins** | One folder each in `plugins/`, listed in `plugins/index.ts`; a one-line description and a Read more guide each in the Plugins tab. Plugins from this computer (a JavaScript tool module, or a Python file run in the console's Python) load and reload there; so do tool plugins from a URL (a `manifest.json` or module over https), after a consent sheet that shows the manifest before any of its code runs. See `plugins/README.md`. |
| **Zarr Vectors** (data type, on) | Reads format 0.9.0 to 0.9.4 into a segmentation layer: points, streamlines, skeletons, graphs, meshes. |
| **Track filtering** (tool, on) | TrackVis-style groups over any dataset that is not an image: zarr-vectors stores (local `.trk` included), precomputed segmentations (a region keeps the segments with a voxel in it, read in a worker at the finest scale with at most 2 M voxels in the box; MICrONS: 247 cells in 1.6 s) annotation layers (points inside, lines crossing, boxes and ellipsoids overlapping) and precomputed annotations, by their spatial index (the hemibrain's synapses: 372 in a 2 µm sphere in 7.7 s). Datasets in a menu; Show all objects off once there are groups; regions are sliders, and on streamlines and skeletons a region can ask for either end or both ends of a track in it (TrackVis's endpoint modes); `.trk` saved in batches straight to the file; a group's density map (streamlines per 1 mm voxel) shown as a heat-map layer and saved as NIfTI; statistics per group (count, each attribute's mean, SD, median and range) in the panel and as CSV; groups written into a local store's own `groups`. Groups belong to the dataset they filter (by its source), so another scene's data does not inherit them. |
| **Volume rendering** (tool, off) | "Volume" beside "Sections" in Neuroglancer's 3-D panel: an OME-Zarr image (NIfTI from this computer included; uint8, or other types windowed to 0..255) or a precomputed one (raw or JPEG, sharded or not) drawn as a solid in the same view (the `draw3d` hook), depth-tested with tracts and annotations, the octant facing the camera cut away and Neuroglancer's sections shown on its faces. Detail is automatic (follows the zoom) or a chosen level; a level over 384 voxels a side is drawn as a 256-voxel box around the position, which follows it (MICrONS' EM: a 2 µm box in 12 s). |
| **Labels** (tool, on) | Labels pinned to points, track groups or annotations; beside the pin or lined up at the view's sides with leader lines; 2-D, 3-D or both; dragged and resized in the views; painted into screenshots. |
| **Registration** (tool, off) | Moving by hand as Freeview's Transform Volume (rotate, translate, scale, flip; sliders and typed values; about the volume's centre or the cursor; Restore to original). Landmark pairs (Alt+F, Alt+M) fitted as translation, rigid, similarity or affine, with residuals. Transform files in and out: FreeSurfer LTA (with both volumes' geometry; VOX to VOX read), ITK / ANTs, plain 4 × 4. Save image: NIfTI or OME-Zarr, resampled (nearest, trilinear, cubic B-spline as FreeSurfer's; own grid or another image's) or header only, in a worker (the finest level within 512 MB). |
| **Examples** | S-21-46 on SRB 2026a (the default: BRIDGE's anatomically constrained tractogram of the 50 µm HiP-CT brain S-21-46 in MNI space, 3.3 M streamlines as zarr-vectors, on SRB 2026a, the HiP-CT template of ten brains at 100 µm in MNI 2009b space; both from Andrew's public GCS bucket), HCP-1065 on SRB 2026a, and MICrONS minnie65 (EM and v1300 segmentation). The HiP-CT samples Ha1, Hb1, i74 and I80 are not referenced by the app or bundled with it. |
| **Neuroglancer** | google/neuroglancer `master` plus commits on `Andrew-Keenlyside/neuroglancer` branch `ngplatform-upstream`: application-supplied workers, host-owned side panels, incremental layer restore, GCS listing, a one-byte GET where a bucket's CORS blocks HEAD (without it no chunk of the HCP store loaded), switches beside Sections and sections clipped to a box, a screenshot overlay, and resolution histograms laid out by resolution (every level keeps its place; the target line moves). |
| **Filter oracle and engines, step C0** | In `zarr-vectors-tools`, on its branch `working`. |

## New (2026-11-02 to 03)

| Area | What |
|---|---|
| **Local data (`src/virtual/`)** | One core module for reading local files in and writing them out (README there). New formats: FreeSurfer `.mgz`/`.mgh`, NumPy `.npy`, LAS and LAZ point clouds, Parquet point tables, GraphML and edge-list graphs (with the node table beside them), TIFF's floating-point predictor and 16-bit RGB; a 4-D NIfTI whose fourth axis is short and not time (spherical harmonics, tensors) keeps it whole in each chunk; a FreeSurfer subject folder opens as its T1, aparc+aseg and white/pial surfaces; images named as labels (aseg, aparc, dseg, labels) open as segmentations. Files and folders can be dropped anywhere on the window. Large tractograms and point clouds get nested coarse levels. |
| **Export as…** | For any local dataset (Datasets → ⋯): images to NIfTI, `.mgz`/`.mgh` or OME-Zarr (the whole image at a level, a 256-voxel box around the position at any level, or every level written into a folder chunk by chunk at any size); tractograms to `.trk`/`.tck`; meshes to OBJ/PLY/STL; points to CSV; graphs to GraphML. Checked against nibabel and FreeSurfer. |
| **Views** | Anatomy the right way up, as Freeview shows it (radiological by default for mm/µm data; Settings → Which way up the views are), needing the fork's `setNamedPanelOrientation`; four panels with the 3-D view bottom right; x, y, z shown in that order for zyx OME-Zarr; the 3-D view keeps turning after a drag (momentum). |
| **History** | The ⋯ beside undo/redo: every change with what it was and when, undone ones greyed, go back or forward to any. Plugin bookkeeping and Neuroglancer's own rewriting of sources are not undo steps. |
| **Display** | Lookup tables (FreeSurfer, Schaefer, Harvard-Oxford bundled; Allen fetched; any file), 17 colour maps, segmentation outlines, surfaces as outlines on the slices in Freeview's colours, Capture (GIF, WebM, MP4, PNG frames, magnified pictures). |
| **Track filtering** | Groups drawn from their own whole streamlines (they had shown only their regions), a sample level first. Disk regions (TrackVis's) with an angle limit; mask regions (a label volume, or an image above a threshold). |
| **Surfaces** | Values on a surface's vertices from the files beside it (curv, sulc, thickness, `.mgh` overlays, GIFTI, `.annot`, `.label`), filled lit surfaces in 3-D, and Render → Surface: switch white/pial/inflated/sphere, overlay with threshold, parcellation colours, values under the mouse. |
| **Plugins** | Registration (apply to all visible volumes, straighten with landmarks, save without cropping, `.mgz` out, `.xfm`, `register.dat`, FSL and ANTs `.mat` in, cubic B-spline as FreeSurfer's, OME-Zarr at full resolution in blocks however large); Orientations (ODF glyphs, tensor ellipsoids ray-cast, peaks, direction colour; tensor levels as log-Euclidean means, a NIfTI read in place too; off by default); Annotations (an annotation table with groups, values from lists or ontologies, comments, search and CSV; Labels, Measure, Statistics); Segmentation (WebKnossos-like tools); Luxar rendering (Zarr Vectors lines, points and meshes, and images as Gaussian splats, in 2-D and 3-D; only a layer's chosen segments, a few of them read whole by id at full resolution, the others at the layer's notSelectedAlpha; track filtering's groups in their colours, handed over to their own stores without a gap; bloom); Filters (mean, median, Gaussian, Frangi on the fly); Collections (RFC-8 draft: a Collections tab beside the scenes, its images placed in the coordinate system chosen, an image whose chain of transforms holds a displacement field (RFC-5) resampled through it as it is viewed, collections found above the data); Time series (the time course of the voxel under the mouse, pins and region means in a 4-D NIfTI or OME-Zarr with t (global, or the layer's local t'), a coarse read while the mouse moves over a long series, playing through time with no undo steps, CSV, and stepping through a CIFTI time series on a surface with the time course of the vertex under the mouse and pinned vertices; off by default); OME coordinate systems in the Source tab; volume rendering with sharp sections on the cut. |
| **Docs** | MkDocs site for Read the Docs (`mkdocs.yml`, `docs/`), plugin pages, contributing guide, issue templates. |

## Scenes, datasets and the link

- The **link** in the address bar is the whole workspace: every scene and
  every dataset. It is also a plain Neuroglancer link to the scene on show.
- A **scene** is one view of the data: which datasets, drawn how, from
  where, in what layout. Scenes are the tabs in the top bar.
  Each scene keeps its own plugin state (groups, labels, styles), as if it
  were a viewer of its own.
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

S-21-46 (the default, 3.3 M streamlines, 420 M vertices in 23 × 21 × 20 mm
cells, raw and unsharded), in the browser: the corpus callosum box is exact
(52,731 streamlines) in 22 s from a cold start, the three example groups in
70 s; its 3.3 M rows of segment properties (length, orientation, tortuosity,
vertex count) load in the background, about 290 MB of JavaScript heap.

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

- `npm test`: 170 unit tests (3 of them need `NET=1`) (workspace model, store with a fake engine,
  commands with arguments, key bindings, `when` clauses, schemas, state
  slices, plugin host and switches, the catalogue, the filter computation,
  region geometry, track-group logic, .trk files, groups written into a
  store, sign-in, OME-Zarr transforms, tissue and background, the volume's
  display coordinates, label layout, registration fits and transform
  files, state parsing, undo history, TIFF stacks (nine tifffile fixtures:
  every voxel, every codec, hyperstack order, sizes), NIfTI read as virtual Zarr: every
  chunk against the file, the pyramid, and placement as Neuroglancer and
  the volume view read it; precomputed chunk ids, minishard indexes and
  sharded scales; regions on segmentations and annotations; `NET=1` adds
  live reads of MICrONS and the hemibrain's synapses), then the Zarr Vectors plugin's 231 tests (with
  the .trk, .tck and .trx readers against nibabel and trx-python, mesh files, SWC and point tables, and the virtual stores read back by the
  plugin's own reader; codecs, layouts including 0.9.4's dense index,
  pyramids, meshes, objects, worker imports) against upstream Neuroglancer.
- `npm run typecheck`: the app and the plugin, with Neuroglancer's sources.
- `npm run e2e` (`tests/e2e/smoke.mjs`): the GUI in headless Chrome, including checks that
  the views fill their area, that only the position and panel controls show
  inside them, the inspector's tabs, that undo makes no data requests,
  scene tabs, that the track groups get exact counts, that a NIfTI opened
  as local data is served as OME-Zarr with the file's voxels and opens as a
  layer, and that a phone-width window does not scroll sideways. All 28 pass (2026-11-02, locally
  and on the live site; Chrome with SwiftShader: `CHROME=/opt/google/chrome/chrome SWIFTSHADER=1`; the
  `/usr/bin` symlink hides Chrome's own SwiftShader driver from the script and the page never loads). Under
  SwiftShader the first shader compile after the heavy HCP scene can hold
  the page for over a minute, so the local NIfTI is given three. Where
  NVIDIA's driver is installed but the GPU cannot be opened (this build
  sandbox), the script points Chrome's Vulkan loader at its own SwiftShader;
  otherwise Chrome hangs at start.

## Next

1. Review this build in a browser; fix what the review finds.
2. Run `tests/e2e/smoke.mjs` with `CHROME` set on a machine with a GPU.
3. Track filtering, next: mask regions (a painted or thresholded volume)
   and disk regions with an angle limit.
4. Virtual stores, next: very large meshes split into cells.  See TODO.md for the full work plan.
5. Then the plan's other steps: Z1 filter-ready index; `memory://` beyond
   images (meshes, points and annotations made in the page).
