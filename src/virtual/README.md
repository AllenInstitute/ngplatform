# Virtual stores: local data in and out

Files on this computer are never uploaded and never loaded whole. Each one
is presented to Neuroglancer as a chunked, multiscale store made from it as
it is read: a **virtual store**. Neuroglancer reads it over HTTP like any
other source; the service worker (`src/sw.ts`) passes each request
to the page, and a worker here answers it from the file.

| Folder / file | What |
|---|---|
| `local_data.ts` | Local files and folders: picking, remembering, the URLs under `<app>/local/<id>/`, answering the service worker, files made in the page (`openFile`, derived files) |
| `images/` | Images as OME-Zarr 0.6: NIfTI and Analyze (`nifti.ts`), TIFF stacks and their own pyramids (`tiff.ts`), the store and its pyramid (`store.ts`), levels made in slabs (`slabs.ts`), the overview cache (`overview_cache.ts`), the worker (`worker.ts`) |
| `computed.ts` | Images computed as they are viewed by [chunkmirage](https://github.com/JaneliaSciComp/chunkmirage)'s browser engine (`vendor/chunkmirage`, a submodule): a pipeline of its ops over any image, served under `<app>/virtual/ngp/<pipeline>/` |
| `warp.ts` | Images resampled through a smooth map as they are viewed, for `computed.ts`: a thin-plate spline from landmark pairs, or a displacement field between affines |
| `vectors/` | Geometry as Zarr Vectors: tractograms (`trk.ts`, `tck.ts`, `trx.ts` → `streamlines.ts`), meshes and surfaces (`mesh_files.ts` → `meshes.ts`), SWC neurons and point tables (`point_files.ts` → `points.ts`), the formats (`formats.ts`) and the worker (`worker.ts`) |

## Reading in

A virtual format (`VirtualFormat`, in `src/sdk/types.ts`) names the files it
reads (a pattern and extensions), what kind of layer it makes, the source
URL for Neuroglancer, and the worker that serves its keys. The platform's
own formats are listed in `local_data.ts`; a data type plugin can add more
(`addFormats`). A store's keys are made when asked: an image's chunk
`0/c/0/3/2/1` reads only the bytes of those voxels; a tractogram is read
once, binned into spatial cells, then every key is made from that.

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
a tractogram's sample level (one streamline in ten).

## Large images: levels made in slabs, and kept within a budget

An image store (`images/nifti.ts`, which also serves TIFF, MGH and NumPy
through a NIfTI header) serves level 0 straight from the file and makes
each coarser level from the one below it. For a file of hundreds of GB
this decides whether a zoomed-out view takes a minute or an hour, and how
much disk the app takes, so it works as follows.

**Slabs** (`images/slabs.ts`). A slab of a level is one row of its chunks:
the chunk depth of z planes, the chunk height of rows, and the whole width
(cut along x into pieces of whole chunks when one slab would exceed
256 MB). A chunk of a coarser level is never made alone: the whole slab
holding it is made from the finer level's slabs under it, one at a time,
down to level 0, whose slabs are rows of the file. Strips and rows are read
across the whole width anyway, so each byte of the file is read once for
every level above it, and memory holds about one slab per level (a few
hundred MB for a 4096-pixel-wide image). The other chunks of the slab stay
in memory for the requests that follow. Before this, each coarse chunk was
made from its eight finer chunks recursively. Their rows did not fit the
64 MB cache of rows, so the first zoomed-out view of a 16 GB TIFF read
the file many times over (measured below).

**The overview cache** (`images/overview_cache.ts`). A level-k chunk is the
mean of 8^k level-0 chunks' worth of the file, so coarse levels cost the
most to make again and the least to keep. Level 1 is an eighth of the file,
level 2 a sixty-fourth. Coarse chunks are kept in the origin's private
file system (OPFS), keyed by the file's name, size and date and by the
level and chunk, within a budget:

- the budget is set in **View settings → Overviews**: by default 2 % of the
  file, at most 2 GB an image, at most 10 GB for all images, and never more
  than half of what the browser's storage has free. A 1 TB TIFF keeps 2 GB,
  a 16 GB one 330 MB. Files under 64 MB keep nothing (their levels are made
  in a moment);
- whole levels are kept coarsest first while they fit, then the next finer
  level in part, its least recently used chunks dropped first. A finer chunk
  never pushes out a coarser one. Finer levels are made again from the file
  when they are viewed;
- when the total for all images is passed, the least recently used images'
  caches go first;
- one worker writes an image's cache at a time (a Web Lock); another tab, or
  the export worker, reads it as it stands;
- Settings lists what each image keeps and clears it; the Datasets row menu
  clears one image's cache.

In-memory caches are sized from `navigator.deviceMemory`: chunks 32 MB per
GB of device memory and rows 16 MB per GB, within bounds (256 MB and 128 MB
on an 8 GB machine; Chrome reports 8 at most).

**Building the overview** (`{ overview: "build" }`, a job in the Jobs tab
with progress, which can be cancelled). One pass over level 0, slab by slab.
Each coarser level is made from the slabs of the one below as they pass,
and the levels the budget keeps are written into the cache. Memory stays at
about one slab per level. Until it is done, chunks are made on request as
above, and a cancelled build resumes from the levels already kept. The
platform offers the build when an image of 1 GB or more is first viewed
("Build the overview of this 16 GB image in the background? … at most
330 MB is kept"), and the Datasets row menu has it too (`src/ui/overview.ts`).

**A TIFF's own pyramid** (`images/tiff.ts`). Each page's SubIFDs (pyramidal
OME-TIFF, as raw2ometiff, tifffile and QuPath write it), or reduced pages
following each page (NewSubfileType 1), are read as levels: x and y halved
(or quartered), z kept. They are decoded like level 0 and not computed or
cached. Coarser levels past the file's own are made from the coarsest one.
A lone thumbnail, or reduced pages not lined up with every plane, are
skipped. JPEG-compressed levels are skipped too, since JPEG is not decoded.

**Export → OME-Zarr, every level** (`out/export_worker.ts`, `eachChunk` in
`images/nifti.ts`). The export worker writes into the chosen folder itself,
in the same one pass: each level-0 slab as it is read, each coarser slab as
it is made, every chunk gzipped, chunks of zeros left out. So no level is
made twice, and memory stays at a few slabs. The export makes every level
from the file, even those the cache holds, because the levels below them
are wanted too. The coarse levels it makes are kept in the cache when the
export worker holds it.

### How this compares with existing packages

| Package | What it does | Like ngplatform | Unlike ngplatform |
|---|---|---|---|
| tifffile's `TiffFile.aszarr()` (`ZarrTiffStore`) | A TIFF series as a Zarr store, read in place: each page's strips or tiles are its chunks, decoded when read; a pyramidal series (SubIFDs, OME levels) is a multiscale group of the file's own levels | Reads the file in place; serves the file's own pyramid as levels, found the same way (SubIFDs, reduced pages) | Its chunks are the TIFF's own strips or tiles, so a stack of one-row strips gives chunks one row high; ngplatform cuts 64³ chunks from rows. It computes no levels: a TIFF without a pyramid has one level |
| bioformats2raw → raw2ometiff (Glencoe) | Converts anything Bio-Formats reads into an OME-Zarr pyramid on disk (level 0 copied, levels downsampled in x and y), then into a pyramidal OME-TIFF | The same pyramid in the end, means of 2 × 2 blocks | A full copy plus its levels is written before anything is viewed, and the conversion reads the whole file. ngplatform writes nothing until asked, then at most the budget. Export → OME-Zarr is ngplatform's conversion, and it too reads the file once |
| ngff-zarr, ome-zarr-py | Write OME-Zarr multiscales from arrays (ngff-zarr: ITK Gaussian or bin-shrink, Dask, larger-than-memory with intermediate levels kept on disk; ome-zarr-py: its `Scaler`, x and y by default) | Same metadata (OME-Zarr), levels by halving | Conversion libraries: every level is written in full. ngplatform halves z too where voxels are near-isotropic, and averages plainly (no Gaussian) |
| kerchunk, VirtualiZarr, refkv | References: Zarr chunk keys mapped to byte ranges of the original files (HDF5, netCDF, TIFF, …), so the files are read as Zarr without a copy | Nothing copied; the original bytes are read on demand (ngplatform reads refkv archives directly, `refkv/`) | Only the file's own chunks and levels exist: no downsampling, so a file without a pyramid has no coarse view. ngplatform adds computed levels |
| chunkmirage (`vendor/chunkmirage`, `computed.ts`) | A pipeline of ops whose chunks are computed when asked for, at the level shown, each stage's chunks cached in memory (2 GB LRU); a disk cache is on its roadmap | Chunks made on request, coarse levels from finer data, a bounded cache | Its cache is per process, in memory, and kept for any stage. ngplatform's overview cache persists between visits on disk, keeps only coarse levels, coarsest first, and has a per-file budget |
| Neuroglancer's Python `LocalVolume` (on-the-fly downsampling); Igneous and tinybrain (precomputed pyramids) | `LocalVolume` serves an in-memory or memory-mapped array to Neuroglancer, each downsampled chunk computed when requested from the full array; Igneous downsample tasks make several mips from one region read once (tinybrain) | Computed on request like `LocalVolume`. A slab making every level above it on the way is Igneous's several-mips-per-task idea | `LocalVolume` keeps nothing, so each coarse request reads its whole footprint again. Igneous writes every mip in full |
| nibabel's array proxies (`img.dataobj`) | Reads only the slices asked for from the file (memory-mapped or by seeking), applying the scaling; `.nii.gz` needs decompressing from the start (indexed_gzip adds seek points) | Same in-place reading of level 0, scaling applied as read | No levels at all. ngplatform decompresses a `.nii.gz` once into OPFS (`gunzipSource`) instead of indexing it |

In short: like tifffile, kerchunk and nibabel, ngplatform reads the file
where it is, and like tifffile it uses the file's own pyramid. Unlike them,
it computes the levels a file lacks, as the converters do, but only when
they are viewed or the overview is built. It keeps only what the budget
allows, coarsest first, so a 1 TB TIFF costs a few GB of disk instead of a
converted copy. An OME-Zarr made once (Export) is still faster to view
than any of this.

Measured on a 16 GB uint16 BigTIFF (4096 × 4096 × 512, uncompressed
strips, in memory: `/dev/shm`) and the 512 MB stress TIFF, headless Chrome
on this machine: see the commit that added this section for the numbers.

## Reading out

Writers for saving data on this computer live beside the readers: NIfTI
(`.nii`, `.nii.gz`), FreeSurfer (`.mgh`, `.mgz`) and OME-Zarr for images
(`out/volume.ts`, written by `out/export_worker.ts`), TrackVis `.trk` and
MRtrix `.tck` for tractograms, OBJ, PLY and STL for meshes, CSV and GraphML
(`out/vectors.ts`). Datasets → a row's ⋯ → **Export as…** reaches them
(`src/ui/export.ts`). An image's every level is written into a folder
chunk by chunk (above).

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

