# Changelog

What changed in each version of ngplatform, newest first. A version is a
tag `vX.Y.Z` on `main` with the same version in `package.json`; how to
make one is in [docs/contributing.md](docs/contributing.md#releases).
Settings › About shows the version, the commit and the date of the build
you are using.

## Unreleased

The production polish: the work of an audit of every panel and plugin
(`plans/`), from the crashes up to the release process.

### Tools column, per-image anatomical rendering, a true view cube

- Tools is a second column beside Layers (folds to its tabs, drags to
  width). Panels with several cards have Collapse all / Expand all at the
  top. Clicking a selected layer folds its row again.
- Anatomical rendering follows the layer selected in Layers: its own
  Render on / Render off, preset, window, colourmap and density. Up to five
  images render together as one volume, the finest drawn where they
  overlap (an overview with its VOIs, placed by their transforms); cuts and
  crops apply to all of them. The Images list, the Centre and view buttons
  are gone (the view cube does that); Remote is the last card, closed.
- The view cube is drawn in perspective, as the 3-D view is, without the
  extra tilt, so its faces match the view.
- Luxar places images by their source transforms.

### Crops and light per image, quarter turns, gliding columns

- Anatomical rendering's crops, camera planes and axis planes belong to
  the image selected; **All layers** beside one cuts every image switched
  on. Images drawn together are both there where they overlap (their
  opacities add), so cutting the overview leaves a volume of interest
  whole. Older links' crops apply to all layers.
- Lighting: **Soft**, **Strong** and **Studio** styles, now in the browser
  too; the key light from the **Front** or **Back** (turning with the
  camera) or a direction fixed in the scene (**Fix it in the scene**).
- Quarter-turn buttons under the view cube (left, right, up, down,
  clockwise, anticlockwise). **Labels** off also hides the names beside
  shapes in the views (the zoom boxes').
- The left columns ease open and shut, the views gliding with them.
- Luxar on a large point store (Zarr Vectors with many small cells) reads
  its cells in groups and no longer freezes the browser; and while Luxar
  draws a Zarr Vectors layer, Neuroglancer no longer reads it as well.
- Anatomical rendering draws a Zarr Vectors point cloud on its own (a cell
  atlas) in this browser: each point a small lit, path-traced sphere in
  its group's colour as the layer colours it; no render computer needed.
- Point clouds, Zarr Vectors layers and a segmentation's chosen segments'
  meshes each have a Render on / off switch, as images do, and are drawn
  in this browser together with the images switched on (meshes as
  surfaces in their segment colours).
- Points and surfaces are drawn at their size: a grid of each voxel's
  distance to the nearest point (fitted to the points, up to 128 M
  voxels) draws a point a voxel in radius and a surface as a shell about a
  voxel thick, where blobs three voxels wide made dendrites and cells
  look bulky; opaque by default.
- A segmentation's meshes are traced as real surfaces in this browser, not voxelised. The BVH is built in a worker with the render computer's algorithm and layout, and is tested against it bit for bit. Dendrites keep their mesh's own thickness, are lit with shadows, are cut by planes, and are drawn with images such as EM. They are path-traced with the volumes: they shadow each other and the volume, take light bounced off them into the held light, and thin branches are blended by how much of a pixel they cover. `npm run e2e:geometry` checks the shader's traversal against the CPU's on a GPU.
- Points and lines are traced too:
  - point clouds as spheres (a quarter of their spacing in radius);
  - streamlines, skeletons and SWC as tubes (the store's radii, else a sixth of a segment).

  Each layer has a Size in the Rendering card. Lines no longer need a render computer.
- Geometry layers have a Surface material in the Rendering card: Opacity (see-through surfaces, path-traced as such), Roughness, Specular and Emission. A change redraws without building again.
- Quality › Geometry sets how many triangles, spheres and tubes this browser reads and traces (2 million unless set, up to 8 million), shared by the geometry layers on; the ABC atlas's finer level can now be read.
- The voxel grid that stood in for points and meshes in this browser is gone; geometry layers no longer take a share of the images' voxels.
- Geometry in this browser takes half the GPU memory (about 55 MB a million triangles, spheres or tubes): vertices shared between triangles and tubes, and a 4-wide BVH with 8-bit boxes.
- **Save still** works in this browser too: the view path-traced at the Output card's size and twice its samples, the geometry read at four times its budget for it, saved as a PNG (transparent where nothing is met). Movies still need a render computer.
- A large segment's mesh is read finer near the camera and coarser away from it, within the same budget: its chunks chosen across the store's levels once the camera rests somewhere new.
- Choosing which groups of a points or lines layer show, or their colours, takes effect at once: every group is kept in the geometry, and nothing is read or built again.
- `npm run e2e:golden` draws one scene (a volume and a mesh) in this browser and on the render computer's CUDA, and compares their depths pixel by pixel (allowing for the computer's float16 depth) and how the light falls across each object (rank correlation of the two pictures' brightness).
- Cut objects are closed: where a cut or crop goes through a traced object, a flat face in its colour closes it (Close cut objects, on by default; off leaves it open). Meshes are wound outward when built so the tracers can tell inside from out.
- Movies in this browser: Render movie and Render rotation path-trace every frame here and save an MP4 (WebCodecs H.264), the camera moving as on a render computer. The MP4 encoder is shared with the capture tool as `@ngplatform/sdk/video`.
- Detail by distance also for Zarr Vectors mesh stores with several levels, and for levels whose chunks do not nest.
- Zarr Vectors: format 0.10.0 stores are read (their metadata moved onto the Zarr Vectors convention; the data is 0.9.4's), and volume meshes (0.10's `element`: tetrahedra, pyramids, wedges, hexahedra; zarr-vectors-py#61) are drawn as their surface, in Neuroglancer's views and in both path tracers, exact across chunks: the faces only one cell has, wound outward, each drawn once. The render computer's reader (runner/ngplatform_render/vectors.py) reads 0.10 metadata too, and splits polygon faces into triangles where it had taken every three indices as one (quads came out scrambled).
- Interface: quiet surfaces instead of all black, so the parts read as parts: the views stay black, the bars and docks a step lighter, each card (and a dataset's open settings) a step lighter again with a slight shadow, its head lighter still, and fields dark wells inside them; menus and sheets above all of it. In the light theme a white chrome with light grey cards and white fields in them. Cards in the side columns (and a dataset's open settings) sit 6 px in from the column's edges, their content on its usual edge. The error red is a step lighter to stay legible on them. (DESIGN.md has the new rule.)
- Segmentation: **Grow**, **Shrink** and **Smooth** the active segment (dilate, erode, and a Gaussian of σ), by a distance in millimetres, in 3-D or in the section in view; under the segment list and in the command palette, one undo each. Done in tiles, so a segment of any size (on a 0.1 mm volume, a 24 mm structure grown by 1 mm in about a second).
- Plan for 3-D AI segmentation (`plans/ai-3d-segmentation.md`): a MobileSAM volume protocol built on Spread, and nnInteractive on the render computer, after SAM-Med3D and MedSAM2 underperformed on SRB 2026a.
- Segmentation: the AI models' files (SAM-Med3D, MedSAM2) are published on Hugging Face ([akeenlyside/ngplatform-models](https://huggingface.co/akeenlyside/ngplatform-models), Apache-2.0 as the models) and download from there on first use; localStorage `ngplatform.sammed3d.url` / `ngplatform.medsam2.url` still point elsewhere.
- Open no longer closes the scenes open: a link, a state or an example opens as new scenes beside them (into an empty workspace, in its place), with its plugins' state and datasets; a state of several scenes adds them all. **Beside the open scenes** (on by default) in the Open sheet, or **Replace** when pasting a link, replaces the workspace as before.
- The repository clones on every system: the Zarr Vectors test store no longer has the columns `length` and `Length` side by side (a case-insensitive file system, as on macOS and Windows, kept only one, which broke forks); the case-only collision is tested in memory instead. A test (`tests/repo_paths.test.ts`) fails on paths that differ only in case, names Windows refuses, paths over 180 characters and files over 100 MB. The unused test store `pyr_zstd` is gone.
- Segmentation: the tool bar's tools are in two groups, **Draw** (Move, Brush, Erase, Lasso, Fill, Pick segment, Quick select by threshold) and **AI segmentation**: the new **AI segment** tool (++a++), which runs a model in the page (SAM-Med3D, MedSAM2 or MobileSAM, chosen on the bar or in the panel). Quick select keeps the threshold method.
- Segmentation: **AI 3-D (SAM-Med3D)**, AI segment's default model, segments a structure in 3-D at once from a box or a click in a 2-D view, in a 19 cm cube at 1.5 mm, and refines it with more clicks in any section. SAM-Med3D-turbo (Apache-2.0) runs in the page as two ONNX graphs (tools/sammed3d/ makes them and checks them against PyTorch). It does well when the cube is centred on the structure, so draw the box on a slice through the structure's middle (on an abdominal CT, mean Dice 0.65 over 15 organs so, against 0.71 for SAM-Med3D's own pipeline). The model files (202 MB) download from Hugging Face on first use.
- Segmentation: **AI 3-D (MedSAM2)**, a quick select method that segments a section from a box or clicks and, with Spread (Track), follows it through the volume as MedSAM2 follows an organ through a scan. MedSAM2 (Apache-2.0) runs in the page as four ONNX graphs on ONNX Runtime Web (tools/medsam2/ makes them and checks each against MedSAM2's PyTorch; the tracker matches MedSAM2's own to a voxel in tens of thousands). The model files (86 MB) download from Hugging Face on first use. Quick select methods may now give `propagate`, which Spread uses.
- ngplatform on your computer (docs/guide/local-app.md): `pip install ngplatform`, then `ngplatform [FILE …]` opens the app in a window of its own (Chrome, Chromium or Edge in app mode), served by its runner at `http://127.0.0.1:8766/app/` with the CUDA renderer when `ngplatform[gpu]` is installed; the files named open as layers. It follows the deployed site: each build now writes `build.json` and `files.json`, and `ngplatform` downloads a newer deployed build (each file checked) for its next start, or now with `ngplatform update`, unless that build needs a newer runner (`RUNNER_API`). The Python package is now named `ngplatform` and versioned with the app; the Deploy workflow builds its wheel from the deployed build.
- The browser path tracer's batches of GPU work are kept short and sent one at a time, and a lost WebGL context is said as such. Debugging switches: `localStorage ngplatform.gputiming` logs each batch's GPU time, `ngplatform.gpucut` leaves parts of the trace out; `npm run e2e:gpu-timing` times the surface traversal alone (it uses the hardware GPU: not on a GPU that drives a display you are using).
- With WebGPU, an image with geometry layers (EM and its cells, say) gets its path-traced picture at rest from the WebGPU tracer, with the surfaces in it.
- Surfaces less than opaque are drawn whole: blended front to back while the view moves (they showed as a dither of specks), and path-traced at their opacity without rays dropping through them by chance.
- A segmentation's segments are read and built one by one: choosing another reads only it, switching one off takes it out at once, and the levels are shared out so small cells come finer. Hovering a traced cell shows its segment, and a double-click selects it, as with Neuroglancer's own meshes.
- The anatomical renderer draws a scene whose first layer is hidden in Neuroglancer; the layer shown in the views is rendered when none is switched.
- A Zarr Vectors layer can be coloured by any of its attributes again, for example a gene: the attribute search box was hidden by a style that hid every empty element in a stack, inputs included.
- Annotation layers have Point size and Line width sliders (Display), in
  fractions of a pixel; skeleton line widths and label sizes take
  fractions too.

### One left column, views first

- The Tools dock on the right is gone: the tools that are on are a section
  of the left column, below Layers and Plugins, behind a divider that drags
  (or moves with the arrow keys). The views take the width the dock took.
  The section is there only while a tool is on (and listed for the data
  selected), folds to its row of tabs, and opens with its column when a
  tool is turned on.
- The status line (the collapsed Activity dock) takes items on its right:
  plugins add one with `ctx.ui.statusItem(element, { order })`.

### One look, Neuroglancer's chrome included

- The views are a black stage: a new scene, an example or a blank viewer
  draws the margin around the sections near black, and an image's or a
  segmentation's bounding box in a dim grey rather than yellow; links keep
  what they carry. Panel frames are 1 px grey (the focused one light grey),
  the axis labels and the scale bar are captions in the readouts' face.
  Neuroglancer's axis lines keep their red, green and blue.
- Greyscale in Neuroglancer's materials: black panels divided by 1 px
  lines, white at fixed opacities, one hue (Neuroglancer's error red) for
  errors and what deletes. What is chosen or on is inverted, white with
  black words; switches that are on are white, no longer green. The focus
  is a 1 px white outline. The Layers panel numbers its layers as
  Neuroglancer does.
- Values are readouts (`readout()` in `@ngplatform/sdk/dom`): Source Code
  Pro, tabular digits, the unit quiet. A layer's source in the Layers panel
  is a compact line (the store's name, where it is beneath) with copy and
  edit buttons, the whole address in the box while editing.
- What is selected in a list is outlined in 1 px of the text's colour, its
  words strong, no fill and no bar down the left; the item the keyboard is
  on in a menu, and the palette's highlighted command, are inverted. One
  floating style (`float-surface`) for menus, the palette, toasts and tips;
  motion tokens, none with reduced motion; one 16 px icon set in place of
  characters (×, ▸, ✓); selected text, scrollbars and number fields in the
  app's greys.

### The review's fixes

- The left column on one inset: everything 12 px in from either side, one
  step of 12 px for what is nested (a dataset's settings and views, a
  card's body); cards and the plugins there are open at their sides.
- A layer's row tags its kind (`image`, `segmentation`, `vectors`) in the
  muted mono face; labels in the inspector wrap rather than being cut.
- The contrast control: its colour bar drawn in CSS from the colour map and
  range (Neuroglancer draws it in the views' canvas, which the left column
  is not over), the bounds as readouts, Min-Max, 1-99% and 5-95% as one
  segmented control with the preset that set the range inverted.
- A resolution histogram not drawn says so in the theme's words, the
  target's line kept off them.
- No title over the tools' tabs; the palette names each group once, above
  its commands, in sentence case; links and menu items that open a new tab
  end in the external-link icon instead of ↗.
- The status line: "Undo history for this link restored" on opening a link
  whose history was kept; messages that are not errors fade from the line
  after a few seconds; the level chip stays in every layout, the 3-D view
  alone included; the pointer's position after the position bar has units.
- At phone width nothing scrolls sideways: Open is its icon, GitHub is in
  the Help menu, the scene's tab shrinks, and the level chip stays whole.

### A light theme

- Settings › View › Theme: **Dark** (the default), **Light** or **Match
  system**, kept in this browser (not in links) and set before the page is
  first drawn; the palette's **Theme: switch between dark and light** and
  **Black views in the light theme: on or off** change it too. The light theme mirrors
  the dark one: white panels, black type at fixed strengths (each at least
  4.8:1 on its surface), black for what is chosen, the error red a step
  darker (#c53929).
- In the light theme the views are white (the section margin the lightest
  grey), shown in this browser only: never written into the workspace or
  the link, and the dark theme shows the scene's own backgrounds again.
  **Black views in the light theme** (off by default) keeps them black.
- What is drawn over the views follows the views' ground, not the theme:
  in-view handles and their card, the orientation cube, point labels,
  bookmarks and switches, Neuroglancer's axis labels and panel frames.
  Plugins drawing over the views read the colours with `viewInk()` from
  `@ngplatform/sdk/dom`.
- Neuroglancer's own panels shown in the app (its tabs, the key reference,
  dropdowns, completions, tool chips) and the shader editor are covered in
  both: the editor's syntax in greys, told apart by weight and opacity.
- `npm run ui:audit` takes `UI_AUDIT_THEME=light` and `UI_AUDIT_BLACK_VIEWS=1`.

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

### View aids in the 3-D view

- A new plugin, on by default, after Siemens' Cinematic Anatomy: an
  orientation cube in the 3-D view's top right (lettered R/L, A/P, S/I for
  anatomical data, else by axis; click a face, edge or corner to look from
  there; Realign to the nearest standard view), labels at the view's sides
  with leader lines for point annotations that have a description (painted
  into captures), a Graphics switch that hides the axis lines, the box, the
  scale bar and the aids and puts back what was on, and camera bookmarks in
  a strip of thumbnails along the view's bottom edge (fly to one, rename,
  replace, delete, Play), kept in the scene. Every action is in the command
  palette. See docs/plugins/view-aids.md.
- Plugins can ask for a small picture of the 3-D view (`viewer.thumbnail`;
  with `"3d"`, of the 3-D view only, whatever the layout, once what it
  shows has loaded): a bookmark made in a four-panel layout, or just after
  the view changed, has its picture; with no 3-D view, its name alone.
- The orientation cube is drawn turned a little more than the view (12°
  to the side and from above), so face-on it still reads as a cube; its
  edges, thin, carry the axis colours.
- On a 3-D panel narrower than 560 px the switches beside Sections (Cube,
  Labels, Graphics, Zoom boxes, any plugin's) fold into one View menu, so
  the row never wraps.

### Scale navigator for nested images

- A new plugin, on by default, for image layers that lie inside one
  another, as a HiP-CT overview and its zooms do: the status line shows the
  layers holding the position, coarse to fine with their voxel sizes
  (click one to frame it), and the level of the selected layer's pyramid
  Neuroglancer draws at this zoom (`level 4/7 · 323 µm`, read from what it
  drew; worked out and marked ≈ when no section draws the layer). The
  views show a grey box, with its name and voxel size, where each finer
  layer lies; clicking it frames that layer. Alt+↑ and Alt+↓ step to the
  coarser and the finer layer. See docs/plugins/scale-navigator.md.
- Plugins can read a layer's box, voxel size and pyramid levels
  (`viewer.layerBounds`) and the level drawn (`viewer.renderedLevel`);
  shapes in the views can have a caption, be links (`onClick`) and hide
  when small (`minSize`); switches beside Sections take an `order`.

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
- Tools are no longer recommended for the data (the Layers panel's Tools
  for this data, its toasts and their setting are gone); a workspace that
  uses a tool that is off still says so.
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
- Luxar and Anatomical rendering colour a Zarr Vectors layer as the layer
  is coloured (its Vertex colour): by a group, in the store's colours or a
  palette's, the groups not chosen hidden; or by an attribute through the
  layer's colour map between its low and high, outside hidden if asked.
  The store's default (a cell atlas's coarsest tier) counts too. Luxar's
  Colour *As the layer*; the render computer reads only the attributes the
  colouring needs and re-colours a view without reading again.
- Anatomical rendering of a Zarr Vectors layer alone (points, lines or a
  surface in a scene with no image), on a render computer: the layer is
  the scene, in an empty volume about it.
- 3-D views of a store whose coarsest level is sparse (the ABC atlas's 913
  cells) load evenly: a region under an empty coarsest cell is refined
  like any other, where it stayed at the near-empty stand-in (dense
  patches beside holes); a sparse stand-in no longer sets its region's
  estimated size, and thousands of chunks are chosen in a heap.

- Cloud Storage is read through its JSON API in the browser (volume view,
  precomputed reads, collections, orientations, time series, plugin
  offers), so buckets without CORS settings read as they do in Neuroglancer.

### Tools in the views

- Plugins put shapes with handles in Neuroglancer's 2-D and 3-D views
  (`ctx.views`: points, spheres, boxes, planes): a cross-section shows
  where it cuts each, the 3-D view a wireframe. Click one to select it;
  drag its centre to move it, a box's corners and faces or a sphere's
  knobs to size it, a plane's ring to turn it; Alt+scroll scales, arrow
  keys nudge, Escape lets go. A small card over the view's corner, shown
  only while a shape is selected, holds its exact values and actions.
  Drawn over the views with their own canvas, so captures leave them out;
  Neuroglancer's own mouse use is untouched off the handles.
- Track filtering: regions are dragged and sized in any view, their card
  sets AND, OR or NOT, what tracks must do, exact numbers, and deletes; a
  new region starts where the mouse last was in a view, selected.
- Anatomical rendering: crop boxes have corner and face handles, camera
  planes a centre that moves them along their normal and a ring that
  turns them, axis planes a centre; a new camera plane starts at the
  tissue's centre, facing the camera, selected.
- Registration: **Place pairs**, clicks in the views alternating fixed
  and moving landmarks (as BigWarp); landmarks show as numbered points
  that drag. A landmark's card is headed *Pair 1* and shows both points
  and the pair's error after the fit as readouts.
- Registration moves the layer in the views: its box in each 2-D view
  drags to translate it in the section's plane, a ring about the *Rotate
  around* point turns it about the section's normal, and the corners scale
  it (Shift: alike); the same transform the sliders set, one undo step a
  drag. Selected, its card gives the rotation, translation and scale as
  readouts, with Flip and Restore. The panel leads with the moving layer,
  the landmarks (pair count, Place pairs, Save LTA) and Edit in views; the
  sliders are in the Transform section, closed at first.
- Shapes in the views can be frames (`kind: "frame"`: a box turned any
  way, with a ring about a pivot and corner knobs, its drags reported as a
  move, a turn or a scale) and have a card heading apart from their label
  (`title`). The card floats on the overlay grey, 8 px right of the axis
  labels, its values as rows of readouts.

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
