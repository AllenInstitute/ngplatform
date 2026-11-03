# Time series

![The time course of the voxel under the mouse, two pinned voxels and a region's mean in a synthetic 4-D brain](../../docs/images/plugins/time-series.png)

A tool plugin (off by default) for images with a time axis: the **Time
series** tab in the bottom dock plots the values of the voxel under the
mouse at every time point, keeps pinned voxels and the mean over a region
(a box or ellipsoid in an annotation layer) beside it, marks the time the
views show, plays and steps through time, and saves the plotted series as
CSV; for a CIFTI time series beside a surface, the same for the vertex
under the mouse and pinned vertices. After FSLeyes' time series panel,
Freeview's time course and napari's time slider.

User guide: [docs/plugins/time-series.md](../../docs/plugins/time-series.md)
(and the manifest's `guide`, shown in the Plugins tab).

## Files

| File | What it does |
|---|---|
| `manifest.ts` | Id, the bottom-dock panel, commands (pin, play, save CSV) and keys, the user guide. |
| `plugin.ts` | The panel: the image, transport, pins and regions, the legend; the voxel under the mouse; playing; CSV. |
| `space.ts` | Positions (global, and a layer's local dimensions after them: `Place`) to a layer's source coordinates and back, in any number of dimensions (`LayerMap`). |
| `series.ts` | The time axis as the views show it (its global dimension, start, step and unit), the voxel at a position, stepping, colours, percent change, CSV. |
| `surface.ts` | Time series on surfaces: a Zarr Vectors layer's store, the series its surface header lists (`time_series`), their time axis; the mouse in the store's coordinates, 4 mm in its units, the nearest-vertex answer. |
| `region.ts` | Boxes and ellipsoids from annotation layers; the image voxels whose centres are inside one. |
| `reader.ts` | `SeriesReader`: an OME-Zarr image's levels read along time at some voxels, averaged (the finest, or a coarse read while the mouse moves: `movingPlan`); a byte-bounded chunk cache. |
| `worker.ts`, `client.ts` | The reader in a worker. |
| `plot.ts` | The SVG plot: ticks, lines broken at missing values (a coarse series dashed and joined across them), the current time, a crosshair readout, click to pick a time. |
| `tests/` | `time_series.test.ts`; `fixtures/tiny.nii.gz` (6 × 5 × 4 voxels × 12 time points, from `fixtures/generate.py` with nibabel). |

## How it works

- **Which images.** Image layers whose source has a dimension in seconds
  (or named `t`) and is OME-Zarr: a 4-D NIfTI opened from this computer
  (served in place as OME-Zarr 0.6 with `t` first, in the header's time
  unit, one step every `pixdim[4]`, see `src/virtual/images/nifti.ts`), or
  an OME-Zarr image (0.4, 0.5 or 0.6, Zarr v2 or v3) with an axis of type
  `time` or named `t`.
- **Where the mouse is in the image.** The pointer's global position goes
  through the inverse of the layer's transform (`ViewerApi.layerTransform`:
  the linear part is a ratio of physical lengths, the translation in
  multiples of the output scales) to the source's coordinates, which for
  OME-Zarr are voxel indices with centres at whole numbers. So a layer
  moved by Registration reads where it shows.
- **Which time point the views show.** The same map along the time
  dimension: the time point whose voxel holds the position's `t` (bounds
  from −0.5, so a position halfway between two time points, as Neuroglancer
  starts, shows the later one, as Neuroglancer draws it). Moving to a time
  point sets `t` to its centre. Times shown are the global coordinate times
  its scale, in the store's unit (seconds for NIfTI).
- **Time as a local dimension.** When the layer shows time as a local
  dimension (`t'`, out of the global ones, as Orientations does with a
  component axis), each layer has its own position along it. The map then
  runs between the global dimensions followed by the layer's local ones
  (`Place` in `space.ts`, from `ViewerApi.localPosition`) and the source:
  the time point shown is the one at the layer's local position, and
  moving to a time point sets that (`ViewerApi.setLocalPosition`), not the
  global position.
- **Reading.** The worker reads the finest level, chunk by chunk along
  time at the chunk holding the voxel (a NIfTI read in place has one time
  point per chunk; stored transposed, read in stored order as the volume
  view does), decoded to float32 and kept in a 256 MB cache shared by every
  image, so neighbouring voxels and pins in the same chunks read nothing
  again. A region's voxels are grouped by chunk and averaged per time point
  (missing values left out). The pointer is read 80 ms after it stops; a
  newer voxel cancels the older read.
- **Coarse reads while the mouse moves.** When one voxel's full read of
  the finest level would decode more than 32 MB (a long series in large
  chunks: 1200 time points of 64³ float32 chunks is 1.26 GB), the voxel
  under a moving mouse is read cheaply first: the finest values if every
  chunk they need is in the cache already, else `movingPlan` (`reader.ts`):
  the densest sampling of time, and at it the finest level, whose read
  fits in 32 MB, keeping at least 16 time points (one time chunk in 2, 4,
  8… along time, the others left out; a coarser level only where its chunks
  hold fewer voxels, a level being read at the voxel whose centre is
  nearest). Only coarser levels with every time point are used; their
  place in the finest level's voxels comes from the datasets' scales and
  translations (else from the shapes). The plot draws such a series dashed,
  joined across the time points not read, says "coarse (…) until the
  finest values are read" at its top right, and the legend says
  "(coarse: …)". When the mouse rests 400 ms on a voxel, its finest
  values are read (after any coarse read running), with the progress
  shown. A NIfTI read in place has chunks of 64³ at every level, so a
  coarser level is no cheaper there and the coarse read is a sample of
  time points.
- **Playing.** Each time point shown moves the position with
  `setPosition(…, { quiet: true })`: the workspace store
  (`WorkspaceStore.quietly`) amends the current undo step with it rather
  than adding one, so playing makes no undo steps, at any rate; the user's
  next key, click or scroll settles it first. The first, previous, next and
  last buttons and clicks on the plot are ordinary moves, an undo step
  each.
- **CIFTI time series on surfaces.** A GIFTI surface opened from this
  computer with a `.dtseries.nii` beside it has a map `<stem>_t` (as well
  as `<stem>_mean` and `<stem>_sd`) holding the values at one time point,
  listed in its store's `headers/surface` under `time_series` (time points,
  start, step, unit; `src/virtual/vectors/surfaces.ts`, `CiftiSeries` in
  `cifti.ts`). Such a series is offered in the Image menu
  ("layer: wave_t (file)"); the transport then steps through it: each time
  point is sent to the surface's store (`WorkspaceApi.local.send`, the
  store's `message`), then `ViewerApi.reloadData(store)` has Neuroglancer
  read the surface's values again. The surface shows them when `<stem>_t`
  is its overlay (Render → Surface, or the panel's button, through
  `viewer.setSurfaceOverlay`). The time point is kept in the plugin's state
  (`surfaceTimes`, by store and series) once stepping settles, not while
  playing: in the link, so the store (which starts at 0) is sent it again
  when the workspace opens, and an undo shows the one before.
- **A vertex's time course.** When a surface's series is chosen, the
  pointer's global position (`ViewerApi.cursor`: in the 3-D view the point
  picked on the mesh, in a 2-D view the point on the section) goes through
  the inverse of the surface layer's transform (`LayerMap`, as for images)
  to the store's coordinates: the file's less `coordinate_offset`, which
  the layer's default transform adds back, so a moved layer is read where
  it shows. The store is asked for the vertex nearest that point within
  4 mm (`{ series, nearest, within }`, `storeDistance` turning millimetres
  into the source's units; a grid over the vertices answers it,
  `src/virtual/vectors/vertex_grid.ts`), then for that vertex's values at
  every time point (`{ series, vertex }`: its column of the CIFTI file).
  An answer to an older lookup is dropped. Off the surface the last vertex
  stays (so it can be pinned from the panel). A vertex pin keeps the
  store, the series and the vertex number (the surface file's), and is
  read again the same way when the link is opened. A vertex the file has
  no column for (the medial wall) gets NaN at every time point: the legend
  says "no values" and nothing is plotted or saved for it.
- **State.** Pins (voxel indices, or an annotation layer and annotation id
  for a region) and the chosen image are in the plugin's state, in the
  link; their values are read again when it is opened. A region pin is
  read again when its annotation or its layer's transform changes. The
  rate, loop and percent-change switches are per-user settings.
- **Colours.** The series under the mouse is drawn in the docks' text
  colour; pins take eight categorical colours (stepped for a dark ground)
  in a fixed order, the first free one, and keep it; there are no more pins
  than colours.

## Checked

- `tests/time_series.test.ts`: the nibabel fixture read through the
  virtual NIfTI store (values exact at every time point, means, voxels
  outside, cancelling); an OME-Zarr 0.4 Zarr v2 store with four time points
  a chunk and partial edge chunks; positions to voxels and time points,
  with a time offset and a turned layer; regions (box, ellipsoid, the
  limit); CSV, stepping, colours, ticks.
- In the browser (headless Chrome, a 64 × 64 × 30 × 100 synthetic NIfTI,
  TR 2 s): the values plotted and saved equal nibabel's at the voxel
  under the mouse, and Neuroglancer's own value at the mouse at that time
  (also at a position halfway between time points); a box's mean equals
  nibabel's mean over the voxels inside; playing and stepping move `t`.
  An OME-Zarr 0.4 image served over http (t, z, y, x in µm; Zarr v2,
  blosc zstd, five time points a chunk) plots the values written and
  Neuroglancer's own at the mouse. The same NIfTI with `t` made local
  (`t'`): the time point shown is the layer's local position, the value at
  the mouse equals Neuroglancer's and nibabel's, Next and Play move the
  local position, and four ticks of playing at 1/s add no undo step.
  A long NIfTI (64 × 64 × 48 × 200 int16, 157 MB a voxel decoded): the
  moving mouse plots one time point in 8, dashed and marked coarse; at
  rest the finest values replace it, equal to nibabel's at every time
  point; moving within the chunks read plots the finest at once.
  A 2562-vertex sphere (GIFTI) with a 24-time-point CIFTI series beside it
  (nibabel; a wave around the sphere, the vertices below z = −40 mm left
  out): the series is offered in the Image menu, with `wave_t` as the
  overlay the colours turn a quarter round after six Next clicks, the
  store's `wave_t` equals the file's row at each time point checked, and
  stepping and playing add no undo step.
  `plugins/zarr-vectors/src/virtual/cifti.spec.ts`: the nearest vertex
  message (each vertex of the 12-vertex fixture found from a point near
  it, in the store's coordinates; none beyond `within`) and each vertex's
  values at every time point equal nibabel's (NaN on the medial wall),
  read from the file a column at a time and after the series was read
  whole. `vertex_grid.spec.ts`: the grid against a search of every vertex
  (points in a box, on a sphere, on a plane, outside the box, with a
  limit); on a 160 000-vertex sphere it is made in about 45 ms and a
  lookup takes a few microseconds.
  In the browser (the same sphere and series): hovering vertices in the
  3-D view plots the nearest vertex to the picked point (checked against
  nibabel's coordinates), and the saved CSV equals nibabel's values at
  each pinned vertex (worst difference 5e-7); a vertex below z = −40 mm
  says it has no values; Pin and Alt+P keep vertices in the state; Next
  moves the time marker; in a 2-D view the vertex at the outline is found;
  after moving the layer 20 mm, the vertex shown under the mouse is still
  the one plotted.

## Not done

- **Vertices' coarse reads and regions.** A vertex's column is read whole
  (a few kilobytes even for 1200 time points), so there is no coarse read;
  there is no region mean on a surface (a parcel's mean from a `.dlabel`
  would be the natural one).
- **The other hemisphere.** A CIFTI file holds both hemispheres; each
  surface's store serves its own, so the right one's vertices are plotted
  only when its surface is open with the file beside it.
