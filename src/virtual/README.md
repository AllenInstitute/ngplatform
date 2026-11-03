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

Every store has coarser levels, so a view of the whole thing loads quickly:
an image's pyramid (means of the finer level; the first voxel for labels),
a tractogram's sample level (one streamline in ten).

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

