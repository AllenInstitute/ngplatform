# Changelog

What changed in each version of ngplatform, newest first. A version is a
tag `vX.Y.Z` on `main` with the same version in `package.json`; how to
make one is in [docs/contributing.md](docs/contributing.md#releases).
Settings › About shows the version, the commit and the date of the build
you are using.

## Unreleased

The production polish: the work of an audit of every panel and plugin
(`plans/`), from the crashes up to the release process.

### Fixes that lost data or crashed (Phase 0 and 1)

- The app starts when a plugin fails to load (marked failed in Plugins),
  reloads once for a stale chunk after a redeploy, and reports uncaught
  errors in Activity with their stack; Settings › Developer saves the log.
- Links from other releases: a newer workspace or plugin state is reported,
  not read as if current.
- Sheets stack: a dialog opened from a sheet returns to it; Escape closes
  the top one only.
- Shared image readers: Zarr v2 / OME-Zarr 0.4 (Fortran-order chunk keys
  fixed), size-1 time and channel axes, fill values in the array's type.
- Render service: stills as jobs, views and movies checked before
  rendering, out of GPU memory frees the session, idle sessions closed.
- Segmentation: saving again into a folder no longer brings back erased
  labels. Luxar, Track filtering and Zarr Vectors: late answers ignored,
  undo steps joined, cell caches within their limits.

### One style (Phase 2)

- Type, spacing, control heights and colours as tokens; every control in
  IBM Plex Sans; square corners; `--faint` at 4.5:1 contrast.
- Every panel built from the SDK's shared parts (toggle, checkbox, info,
  slider, empty state, status line, cards), drawn once and updated in
  place.
- Neuroglancer's own controls restyled with the same tokens.
- The docs, the user guide and its figures on the new layout.

### Scale (Phase 3)

- Render service: one GPU budget with admission, a job queue, streamed
  downloads; channel and time point chosen for volumes.
- Track filtering: a million streamlines through a region change, cancelled
  superseded tests, region answers within 192 MB.
- Layers panel: one dataset's change redraws its row only.
- Segmentation: 100,000 segments keep the state small; saves compressed in
  a worker and written as made.
- Zarr Vectors, precomputed meshes and Luxar: shared byte budgets, cancelled
  reads, retries with backoff, one WebGL context for every layer.
- Exports outside Chrome and Edge capped at 1 GB with the reason; a long
  workspace link shared as a file.
- Runners and hosts: requests given up after a deadline, with the
  computer's name.

### Accessibility (Phase 4)

- Sheets are modal dialogs: focus kept inside, given back to what opened
  them. Menus, dock tabs, the Settings sections, the Tools picker and
  Registration's tabs move with the arrow keys; dock resizers and the
  view split move with them too.
- The command palette is a combobox for screen readers; error toasts are
  alerts and stay while hovered; Share is named on narrow screens.
- Reduced motion: transitions, the progress bar and the 3-D views' glide
  (Neuroglancer's and Luxar's) stop.
- OME Collections' graph grouped by coordinate system, readable at 100
  members and usable by keyboard; the Atlas tree by keyboard, and Show
  all keeps the 3-D meshes.
- `npm run ui:audit` checks names, roles, tab order and alt text.

### Checks (Phase 5A)

- CI on pull requests and by hand only: typecheck, both test suites, the
  runner's tests, the build and a bundle-size budget.
- The browser smoke test waits on the app's state and serves its own data
  and runner; UI modules have unit tests in a DOM.
- Docks open on the tab last chosen; a menu closes on an Escape pressed at
  once.

### Security and release (Phase 5B)

- A Content Security Policy in the built page: no inline script, no
  `<object>`, no `<base>`; what it allows and why is in
  [docs/dev/security.md](docs/dev/security.md).
- The console's `window.viewer`, `window.engine` and `window.workbench`
  only from the dev server or with `?debug` in the address.
- A plugin from a URL says plainly what it can reach before it runs.
- Settings › About: the version, the build's commit and date, the
  Neuroglancer commit, each runner's version. A runner older than the app
  needs is reported, with what to do.
- IBM Plex served with the app instead of from Google Fonts; Pyodide's
  scripts checked with Subresource Integrity.
- The app opens offline once it has been opened online: the service worker
  keeps the page and its startup code.
- A loading screen while the startup code downloads.
- A deploy workflow (by hand), this changelog, `npm run lint` (ESLint),
  `npm run check:neuroglancer` for the Neuroglancer pin.

### Loading big chunks (performance step 2, Neuroglancer fork)

- Downloads are limited by the size of the chunks in flight as well as their
  number: on a 50 Mbit/s link a quarter of an SRB 2026a view (192³ chunks)
  shows after 8 s instead of 26 s, and the view fills in steps instead of all
  at once at the end. Small-chunk stores load as before; on a fast link the
  limit rises by itself. Settings › View › Loading: "Data downloading at
  once".
- While a 2-D view moves it asks for one level coarser, and a download that
  is mostly done is finished rather than cancelled: a fast pan over
  S-21-46 makes 75 requests instead of 332 (7% cancelled instead of 58%) and
  shows 93% of the view during the move instead of 60%. On by default;
  Settings › View › Loading: "Download a coarser level while moving".
- Sub-chunks of one shard needed together are read with one request.
- At most six decode workers, and a worker that decoded a very large chunk
  is replaced, so its memory is given back.

### Anatomical rendering as an object in the 3-D view

- The rendered image is an object in the 3-D view, drawn in this browser
  with every frame's camera: it turns, pans and zooms with the view at once
  (no picture stuck to the screen while the camera moves), and other layers
  go behind and in front of it by its depth.
- Its light is path-traced into it in this browser over a few seconds after
  the light, preset or cuts change, and stays fixed to it as the view turns;
  the host's stills and movies are lit the same way.
- Quality › "Path-traced picture when still" (off by default) shows the
  host's full-detail picture of the view when the camera rests.
- At rest, the object is path-traced where it is, in this browser, as the
  render computer path-traces (it starts speckled and clears within a second
  or two), and is drawn quickly again as soon as the camera moves.
- Quality › Object: how much of the image the object holds (64 million
  voxels by default, up to 512).
- Camera planes (Crops) stay where they are set, several of them, each set
  again from the view by its camera button.
- Rendering in this browser reads `gs://` images (it asked for a `gs://`
  address, which a browser cannot fetch: "Failed to fetch"), and the
  colourmap editor (histogram, stops, shift and compression, window) works
  there too, from the level of the image it holds.
- Anatomical rendering renders in this browser by default; a render
  computer is chosen in its Remote card. A browser without WebGPU still
  draws and path-traces the object (WebGL), with a note, not an error.
- The light held in the object comes in as its paths gather, so it is never
  blotchy while it is worked out.

### The Layers panel: a card per dataset

- Each dataset in the scene is a card: its row, and, opened, the card grown
  to hold its settings in one box with the row (the selected dataset's in
  green). Its source (URL, details, transform) is part of the card, at its
  top; below it the layer's tabs (Rendering, as Display is now called,
  Annotations, Segments, Schema, as its type has them). Selecting a dataset
  opens its card; its arrow opens and closes it, and several may be open.
  The selected layer's controls no longer sit under the list.
- The Tools dock shows its tools as tabs (kept together by kind), in
  place of the menu that picked one.
- On/off switches are round again (a round knob in a round track); the
  other controls stay square.
- The 3-D view starts radiological for anatomy, as the cross-sections do:
  from the front, superior up, the patient's right on the screen's left
  (neurological: from behind). Reset the rotation goes back to it.
- The top bar's Neuroglancer button is back: this scene in Neuroglancer,
  in a new tab.
- The colourmap editor: the colourmap (a bar under the histogram) and
  the histogram are each dragged to move them and compressed in place
  (the bar's ends, Shift-drag, or the wheel), not with sliders only; a
  black-to-white strip of the image's own grey values under the
  histogram; the view stays put while you tune (Ctrl-wheel zooms,
  double-click fits); each drag one step to undo. In this browser the
  image is read over all its values for rendering, as the render
  computer reads it: the densest tissue was cut off at the 99.5th
  percentile, so presets fell partly past the histogram's end. The
  histogram's bins are centred on their values.
- Every preset is offered when rendering in this browser too: the HiP-CT
  organs (kidney, heart, lung, liver and the rest), their colours placed
  through each scan's tissue histogram as the render computer places them,
  with the photographs they come from.
- The presets have contrast: the organ presets spread their lightness over
  each organ's own tissue values (most organs had shown their tissue in one
  colour), hues as photographed; the brain, histology and translucent
  presets run from dark to light. New **General** presets suit any scan:
  greyscale (black to white), greyscale inverted (white to black), anatomy,
  thermal, viridis, soft tissue and bone, and glass. The Preset box groups
  them: General, HiP-CT organs, by modality, from a file.
- Brain presets show grey and white matter apart: each class of the preset
  is matched to the same class of the scan (found from the scan's own
  tissue), not one histogram to another, which put most of some brains'
  white matter in grey matter's colours. The HiP-CT brain, MR T1, BigBrain
  and HiP-CT organ brains, on the computer and in this browser alike.
- Brain presets show the tissue's whole spread, not two tones: lightness
  from a contrast-limited equalisation of the tissue's histogram, hue along
  the photographed shades, the dense tail in the vessels' hue; and cuts
  are shaded as cut tissue (less surface shading, no inset, more exposure),
  so deep nuclei, the internal capsule, cerebellar folia and the cortical
  ribbon all show on a cut.
- The HiP-CT organ presets are made the same way: lightness from the
  organ's own tissue histogram, hue along the photographed tissues, the
  dense tail (valves, capsule, calcification, lens) in its own hue, and
  cuts shaded as cut tissue; kidney pyramids, liver lobules, splenic
  nodules, placental cotyledons and testicular septa show on a cut.
- Surfaces show their tissue's colour, not the partial volume's: the
  partial-volume tail holds its colour while it fades, and a preset's
  inset now applies only where a collision lies in a surface's partial
  volume (never inside tissue, so cuts keep their colours), on the
  computer and in this browser alike. Brain exteriors are no longer
  nearly black.
- Percentile presets (HiP-CT brain, the default; Translucent tissue; MR
  T1; histology) on a specimen in a mounting medium take percentiles of the
  tissue alone and are clear outside it, so an organ in its jar is no
  longer rendered as a block of medium; scans without a medium are placed
  as before.
- An empty scene is an empty viewer, with no card over it; **+** beside
  Data (and Add data… in an empty list) opens the Open sheet rather than a
  menu. A new annotation layer is in the palette.

### A quieter look

- Neuroglancer's black and neutral greys with a light-grey accent: what is
  selected (a bar down the left and a tint), the primary button, tick
  boxes, sliders, the chosen tab, progress and the focus ring. Green only
  for an on/off switch that is on; red and amber appear as words and an
  edge (a delete is grey with red words until the pointer is on it).
- Source Sans 3 and Source Code Pro (Adobe, SIL OFL) in place of IBM Plex,
  set at one x-height; numbers, units and captions in the UI font with
  tabular figures, monospace only for addresses, paths, code and logs.
- Fields are black wells, cards a raised head with no outline, menus,
  tips, toasts and sheets a step lighter than what they float over; hover
  and pressed are white layers; the chosen tab is underlined.
- One heading style in a panel, in sentence case; type, spacing (a 4 px
  grid) and pointer targets (at least 24 px) as tokens.
- A dataset's row: an eye shows or hides it, and its state follows its
  name only when it is not ready (a turning ring loading, a red triangle
  failed).

- Zarr Vectors layers (points, lines, meshes) are coloured by their
  segments, by a group the vertex belongs to, or by an attribute, in the
  Display tab's Vertex colour section: a store's taxonomy (its tiers, the
  groups' names from its AnnData header, the store's colours or a
  palette) with the groups shown chosen from a searchable list; any of a
  store's attributes (a gene panel's hundreds: type to search, loaded
  when chosen) through a colour map between a low and a high control,
  outside them hidden if asked. A store with a taxonomy opens coloured by
  its coarsest tier; one with more attributes than load at once says so
  and loads that tier's.
- Objects (on a render computer; the first step of
  `plans/path-traced-geometry.md`): a precomputed segmentation's chosen
  segments drawn as their meshes, path traced as exact geometry, and the
  image within them at the finest stored level within a voxel budget, with
  no bounding box: only the pages the meshes pass through or enclose are
  read, each voxel kept by the parity of a ray's crossings, and held as
  bricks found through a page table. Surfaces from clear to opaque, the
  image within on or off, tinted by the segment's colour. The Objects
  card; the meshes' reader (multi-resolution Draco, sharded or not, and
  legacy) and a BVH built on the GPU.
- Anatomical rendering reads Neuroglancer precomputed images too (the
  MICrONS EM, `precomputed://gs://iarpa_microns/minnie/minnie65/em`), in
  this browser and on the render computer: raw or JPEG chunks, sharded or
  not, a scale within the budget.
- Rendering's window ends, cut and plane offsets and box edges render live
  (the object at low resolution) while their sliders are dragged, as the
  colourmap, density and light already did; one undo step when let go.

- Cloud Storage is read through its JSON API in the browser (volume view,
  precomputed reads, collections, orientations, time series, plugin
  offers), so buckets without CORS settings read as they do in Neuroglancer.

## 0.2.0 — 2026-10-31

The platform around Neuroglancer: datasets, scenes and plugins around a
viewer that shows only data. Deployed to GitHub Pages up to `3c48aba`
(8 November 2026).

- The shell: Open, Share, undo and redo, the command palette, docks and
  sheets; workspaces kept in the browser and shared as links.
- Data type plugins (Zarr Vectors, with GraphML, Parquet, Arrow, LAS/LAZ,
  CIFTI and EM meshes) and tool plugins (Anatomical rendering, Track
  filtering, Luxar, Registration, Filters, Orientations, Time series, Atlas,
  Segmentation, Annotations, OME Collections), on and off in Plugins.
- Google sign-in with several accounts and sign-in rules per bucket.
- The runner on this computer and others over SSH: jobs, serving local
  files, the render service.
- Python in the page (Pyodide), plugins from a file or a URL.

## 0.1.0 — 2026-10-30

The first platform shell around Neuroglancer: open, share, undo, commands
and docks.
