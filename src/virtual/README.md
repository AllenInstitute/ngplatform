# Virtual stores: local data in and out

Files on this computer are never uploaded and never loaded whole. Each one
is presented to Neuroglancer as a chunked, multiscale store made from it as
it is read: a **virtual store**. Neuroglancer reads it over HTTP like any
other source; the service worker (`src/sw.ts`) passes each request
to the page, and a worker here answers it from the file.

| Folder / file | What |
|---|---|
| `local_data.ts` | Local files and folders: picking, remembering, the URLs under `<app>/local/<id>/`, answering the service worker, files made in the page (`openFile`, derived files) |
| `images/` | Images as OME-Zarr 0.6: NIfTI and Analyze (`nifti.ts`), TIFF stacks (`tiff.ts`), the store and its pyramid (`store.ts`), the worker (`worker.ts`) |
| `computed.ts` | Images computed as they are viewed by [chunkmirage](https://github.com/JaneliaSciComp/chunkmirage)'s browser engine (`vendor/chunkmirage`, a submodule): a pipeline of its ops over any image, served under `<app>/virtual/ngp/<pipeline>/` |
| `warp.ts` | Images resampled through a smooth map as they are viewed, for `computed.ts`: a thin-plate spline from landmark pairs, or a displacement field between affines |
| `vectors/` | Geometry as Zarr Vectors: tractograms (`trk.ts`, `tck.ts`, `trx.ts` → `tractograms.ts` → `streamlines.ts`, kept in a spill: `spill.ts`), meshes and surfaces (`mesh_files.ts` → `meshes.ts`, or for a large mesh `mesh_cells.ts` with levels from `mesh_levels.ts`), SWC neurons and point tables (`point_files.ts` → `points.ts`), the formats (`formats.ts`) and the worker (`worker.ts`) |

## Reading in

A virtual format (`VirtualFormat`, in `src/sdk/types.ts`) names the files it
reads (a pattern and extensions), what kind of layer it makes, the source
URL for Neuroglancer, and the worker that serves its keys. The platform's
own formats are listed in `local_data.ts`; a data type plugin can add more
(`addFormats`). A store's keys are made when asked: an image's chunk
`0/c/0/3/2/1` reads only the bytes of those voxels; a tractogram is read
once, binned into spatial cells kept in a spill file, then every key is
made from those (see [Large tractograms](#large-tractograms-what-is-kept)).

A format can name files beside its file that its store reads too
(`related`): a FreeSurfer or GIFTI surface's morphometry, overlays,
annotations and labels (`vectors/surfaces.ts`, read by
`vectors/surface_values.ts`), served as the mesh store's vertex
attributes with a `headers/surface` group. Local data finds them once, by
name, and hands them to the worker with each request, unread; the store
reads a few bytes of each to check its vertex count, and a file's values
when they are first asked for.

A CIFTI time series (`.dtseries.nii`) beside a GIFTI surface gives three
maps: its mean and standard deviation over time (`<stem>_mean`,
`<stem>_sd`) and its values at one time point (`<stem>_t`), listed in the
header's `time_series` (time points, start, step, unit). The page chooses
that time point with a message to the store (`WorkspaceApi.local.send`,
which local data passes to the format's worker as a `"message"` request,
answered by `VirtualStore.message`), then has the viewer read the values
again (`ViewerApi.reloadData`); the Time series plugin's transport does
both. The hemisphere's part of the file is read once, when a time point is
first asked for, and kept by time point (up to 1 GB).

Two more messages serve a vertex's time course. `{ series, nearest:
[x, y, z], within }` answers the vertex nearest a point in the store's
coordinates (as `0/vertices` holds them: the file's less
`coordinate_offset`, which is the layer's source space), and its distance,
or `vertex: null` when none is within `within`; a grid over the vertices
(`vectors/vertex_grid.ts`, made at the first such message) keeps a lookup
on a 160 000-vertex surface to microseconds. `{ series, vertex }` answers
that vertex's values at every time point (a `Float32Array`, NaN on the
medial wall): its column of the file, read alone, or from the time points
already read.

Every store has coarser levels, so a view of the whole thing loads quickly:
an image's pyramid (means of the finer level; the first voxel for labels),
a tractogram's sample levels (about one streamline in 10, 100, 1000 …), a
large mesh's simplified levels.

A store that takes a while to make (a first pass over a large file)
answers its keys `503` ("still reading the file, N% read") after 45 s
(`OPENING_WAIT_MS` in `src/sdk/virtual.ts`), which Neuroglancer's reads
and the Zarr Vectors reader ask again; so a pass longer than the five
minutes a browser gives a service worker's answer does not fail the layer.

## Large tractograms: what is kept

A tractogram (`vectors/tractograms.ts`; `.trk`, `.tck`, `.trx`) is read
once, in batches, in the vectors worker. That pass bins every streamline
into spatial cells and writes, as it goes, into a **spill**
(`vectors/spill.ts`):

- each cell's fragments (a one-word header: the streamline, as a step from
  the cell's last one, and the point count; then the points as float32, and
  the per-point values), and its bridges to the next cell (direction and
  the two rows, two or three words);
- each level's manifests (varint cell and fragment numbers per streamline,
  one segment per 16 384 streamlines);
- the per-streamline columns (length, point count, the file's properties),
  one segment per 65 536 streamlines.

A large file's spill is a file in the browser's private storage (OPFS),
written through a synchronous access handle (in 8 MB writes, the file grown
512 MB at a time); a small file's (under 256 MB) is in memory. The spill
lives while the store does: it is deleted when the file changes or its tab
closes (a spill left by a closed tab is deleted the next time one is made).
It is about 1.3 to 1.5 times the file's size: a copy of level 0's points
plus their fragments, bridges and manifests. The levels' cells are 2, 4, 8
… times level 0's; level 0's cell is a round number of millimetres giving
about ten cells across the space, smaller for a large file, so a cell holds
about 4 MB of points (`cellSize`).

Memory keeps an index: per cell its segments, rows, fragments, bounds and
bridge directions; per 16 384 streamlines where their manifests are; per
16 streamlines where they start in the file (`CHECKPOINT`). For 20 million
streamlines that is about 25 MB. Cells are decoded from the spill when a
key asks for them, and the decoded cells last used are kept up to a budget:
1/32 of the device's memory (`navigator.deviceMemory`), between 64 and
512 MB, or what View settings sets (the vectors worker gets it as a
`settings` message, `setVectorCacheMegabytes` in `vectors/formats.ts`).

The sample levels keep streamline `id` while a hash of the id is below
2³²/10ᵏ (`sampleDepth`), so they are decided from the id alone as the file
streams past, each level is a subset of the one before, and the choice is
uniform over the streamlines like zarr-vectors-tools' `random` sparsity
strategy (though not the same ids, and about rather than exactly one in
ten). Levels are made while a level keeps about 2 000 streamlines, up to
level 4. zarr-vectors-tools' `virtual serve` twin keeps every 10th id
instead.

Whole streamlines by id (`message({ curves: { level, ids } })`, which Track
filtering uses for a group's own store and for saving) are read from the
file itself, not from the cells: a `.trk` or `.tck` from the checkpoint
before each id, a TRX (stored, not deflated) from its `offsets` and
`positions` arrays in place. Reading a cell in place instead was measured
and not chosen: a cell's streamlines are spread through the file, so
reading one 2.7 MB cell of a 584 MB `.trk` in place read 513 MB of it
(about 190 ms against 7 ms from the spill), and that grows with the file.

Past what the browser can hold, opening fails with a message naming the
local runner ("Open through the local runner (Jobs → This computer)"):
when the origin's free storage is less than the spill needs, or when the
storage refuses to grow (a private window keeps OPFS in memory, with less
room). `NeedsRunner` (`kind: "runner"`) in `vectors/spill.ts` is the hook
for the page to offer the hand-off.

## Large meshes

A mesh file with more than a million triangles (other than a surface with
values beside it) is served in cells with coarser levels
(`vectors/mesh_levels.ts`, `vectors/mesh_cells.ts`). Each face goes to the
cell holding its centroid. Each cell keeps, per object, the vertices its
faces use there, so a vertex on a border is stored in each cell that uses
it, at the same position. Level k's cells are 2^k times level 0's. Coarser
levels are made by vertex clustering with quadric representatives, each
from the one before with bins twice as large, until a level has 131 000
faces or fewer. This runs in a worker of its own
(`vectors/mesh_levels_worker.ts`), on the whole mesh before it is split, so
cells meet without cracks. Kept in memory: every level's cells, about the
file's triangles and vertices again plus about 40% for the coarser levels
(250 MB for 10 M triangles). A 10 M-triangle PLY opens in about 6 s.
Surfaces with values beside them stay one cell, as before.

## Reading out

Writers for saving data on this computer live beside the readers: today
NIfTI (`images/` and the Registration plugin's `volume_io.ts`) and TrackVis
`.trk` (Track filtering). An **Export as** for every local dataset, and
writing large data chunk by chunk into a folder, are on the work plan
(`TODO.md`, A5).

## Files made in the page

`LocalData.openFile(file)` serves a file made in the page (a density map, a
numpy array from the Python console) like a local file, for this visit.
With `derived = true` the file is a view of a dataset that exists elsewhere
(a track group's own streamlines): it is not listed, and a layer showing it
beside that dataset still counts as that dataset (`DERIVED_LOCAL` in
`src/core/workspace.ts`).

## Computed images (chunkmirage)

Images computed from others (filters, thresholds, Python of one's own) are
chunkmirage's: its browser engine (`vendor/chunkmirage/web/src/engine.ts`,
pinned as a git submodule) runs a pipeline of its ops (`gaussian`,
`uniform`, `dog`, `threshold`, `morphology`, `python`, ...) over an image
read from a URL or from this computer, and serves the result as OME-Zarr
0.5. `computed.ts` puts the pipeline in the URL,
`<app>/virtual/ngp/<deflated JSON, base64url>/`, so a link carries it and
any tab of the app answers it; the service worker (`src/sw.ts`) relays each
request to the tab in use (chunkmirage's `relay`), which starts the engine
the first time and passes the request on to it. Chunks are computed at the
level the viewer shows, in Pyodide workers when ops need Python, and
dropped when the viewer stops waiting. Plugins reach it as
`workspace.computed` (the Filters tab).

A pipeline can instead carry a `warp` (`warp.ts`, computed by the page, not
by chunkmirage's ops): the source resampled through a smooth map of places,
on the source's own grid and levels, as float32. Each chunk maps a lattice
of its voxels through the map to find the box of the source it needs,
reads only that (`Engine.read`), then samples each voxel there
(trilinear; 0 outside the source). Two kinds:

- `{kind: "tps", fixed, moving}`: a thin-plate spline through landmark
  pairs (mm), each output place taken to its place in the source. The
  Registration plugin's "Warp through the pairs".
- `absolute: true` on a `field`: a coordinate field (OME-NGFF 0.6's
  `coordinates`), its values the places themselves (q → C(q)); not
  inverted.
- `{kind: "fields", parts: [...]}`: several `field` warps applied one
  after another (`ChainWarp`): each part reads the box its places need,
  its places being where the parts before it took the chunk.
- `{kind: "field", url, before, after, invert, components}`: a
  displacement field (OME-NGFF 0.6's `displacements`: an OME-Zarr
  multiscale group at `url`, its displacement axis before z, y, x). An
  output place p (mm; x, y, z) goes through the affines `before` (4 × 4,
  row-major, mm), then q → q + D(q), D the field looked up at q
  (trilinear, the edge's value past it), then the affines `after`. With
  `invert`, the field's inverse instead: the x with x + D(x) = q, by
  iteration. The field's components are opened as engine views (the
  displacement axis pinned) and each chunk reads only the box of the field
  its places look up (widened by the largest displacement in it when
  inverting). `components` names the axes of the vector's components in
  order (by default the field's spatial axes); displacements are in the
  field's spatial unit. The Collections plugin uses it for images whose
  chain of transforms holds a field.

A `python` op runs the code it carries: from a link made elsewhere, only
code the platform marks as its own (`ownPython`, whatever its `#halo`) or
code this browser has allowed (`allow`, kept in localStorage by its hash)
runs; the rest is answered 403.

`images/filters.ts` (the `.vfilter` files of earlier versions of the
Filters tab) still reads the filtered layers of old links.

