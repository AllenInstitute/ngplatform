# Virtual stores: local data in and out

Files on this computer are never uploaded and never loaded whole. Each one
is presented to Neuroglancer as a chunked, multiscale store made from it as
it is read: a **virtual store**. Neuroglancer reads it over HTTP like any
other source; the service worker (`public/local-sw.js`) passes each request
to the page, and a worker here answers it from the file.

| Folder / file | What |
|---|---|
| `local_data.ts` | Local files and folders: picking, remembering, the URLs under `<app>/local/<id>/`, answering the service worker, files made in the page (`openFile`, derived files) |
| `images/` | Images as OME-Zarr 0.6: NIfTI and Analyze (`nifti.ts`), TIFF stacks (`tiff.ts`), the store and its pyramid (`store.ts`), the worker (`worker.ts`) |
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
