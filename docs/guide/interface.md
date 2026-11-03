# The window, tab by tab

![The window, numbered as the sections below](../images/interface-numbered.png)

The window has a top bar (1), three docks around Neuroglancer's views: left
(2), right (4) and bottom (5), and the views themselves (3). Docks can be
resized by dragging their edges and collapsed with the icon at their top
right; sizes and open tabs are remembered by your browser.

Almost everything is also a command: **Commands** (++ctrl+k++) searches them
all, and the keyboard icon lists the keyboard and mouse bindings.

## 1. Top bar

| Control | What it does |
|---|---|
| **Open** | Open from device (files or a folder on your computer), a link or a Neuroglancer state, or an example or template. Opening replaces the workspace. |
| **Add** | Add a dataset to the current scene: a URL, data on this computer, or a new annotation layer. |
| **Share** | Copy a link to the whole workspace, copy this scene as a Neuroglancer link or JSON state, or open it in this site's plain Neuroglancer page. |
| **Neuroglancer** | Open this scene in Google's Neuroglancer in a new tab. It says so when the scene holds data plain Neuroglancer cannot read (Zarr Vectors, files on this computer). |
| **Undo / Redo** | Undo any change to the workspace: layers, positions, settings, plugin state. |
| **Scene tabs** | One tab per scene. **+** adds a scene; each tab has a close button (closing the last leaves a blank scene). Rename, duplicate and delete scenes from the command palette. Each scene works as a viewer of its own: the plugin tabs (Filtering's groups, Annotations, Luxar, Volume and the rest) show that scene's own; a new scene starts with none, a duplicated one with a copy. |
| Camera icon | **Capture**: a picture of the views (magnified, borders trimmed), or a movie (a sweep through slices or time, or a turn of the 3-D view) as GIF, WebM, MP4 or PNG frames; and Neuroglancer's own screenshot dialog. Labels from the Annotations plugin are painted in. See [Capture](#capture). |
| Gear icon | View settings, reload the scene's layers, or a hard reset that reloads everything fresh. |
| Keyboard icon | The keyboard and mouse reference. |
| **Commands** | The command palette (++ctrl+k++). |

### Capture

The camera icon's menu, or the commands *Capture a picture* and *Capture a
movie*, open one dialog:

- **What**: a **Picture**; a **sweep** along a dimension (z steps through
  the slices; a dimension the views do not show, such as time, plays it),
  from, to and step in that dimension's coordinates; or a **turn of the 3-D
  view** about its own vertical axis, in a number of frames.
- **View**: all the views, or one of them (a cross-section or the 3-D view).
- **Magnification**: pixels per screen pixel. 2 doubles the width and
  height, with the same field of view (as Freeview's `-ss` magnification).
- **Trim empty borders**: crops to what differs from the background colour
  (the corners'), keeping a margin; a movie is cropped alike in every frame.
- **Format** for a movie: an animated **GIF**, **WebM** video, **MP4**
  (H.264, where the browser has an encoder: Chrome and Edge), or **PNG
  frames** in a zip or written into a folder you choose (Chrome and Edge).
  **Frames a second** sets the speed.
- **Wait for data**: each frame is taken once everything in view has loaded,
  or after this many seconds (the activity log says how many frames were
  taken early), so a movie's frames are complete and consistent.

The job runs in **Jobs** (bottom dock), where it can be cancelled. The view
is put back as it was afterwards, and a capture adds nothing to undo.
Labels from the Labels plugin are painted into every frame.

## 2. Left dock

| Tab | What it holds |
|---|---|
| **Datasets** | What the scene shows: one row per dataset with its visibility, load state and source. A dataset shown through several layers (a tractogram and its track groups, say) lists them beneath it. Selecting a row shows its controls in the Layer tab. Datasets that other scenes show are listed below, ready to add. |
| **Filtering** | The Track filtering plugin: TrackVis-style track groups. See [Track filtering](../plugins/track-filtering.md). |
| **Annotations** | The Annotations plugin: labels (named pins and callouts for figures), measurements, statistics in a region, and label volumes drawn by hand. See [Annotations](../plugins/annotations.md). |
| **Registration** | When the Registration plugin is on: move a layer by hand or by landmarks, and save the transform or the moved image. See [Registration](../plugins/registration.md). |
| **Auth** | The services the workspace's data needs a sign-in for (for example a private Google Cloud bucket), with who is signed in. |
| **Plugins** | Every plugin, with a switch, a one-line description and a *Read more* guide. **Add** loads a plugin from your computer or a URL. See [Plugins](../plugins/index.md). |

## 3. The views

Neuroglancer's own views, unchanged: cross-sections and the 3-D view, in
whichever layout the scene uses. The position (in the scene's units) is at
the top left; click it to type a position. Each panel has buttons to make
it fill the view or to open it in a new window, and the 3-D panel has
switches along its bottom: **Sections**, and **Volume** when the Volume
rendering plugin is on.

Neuroglancer's mouse controls apply: drag to pan, scroll to move through
sections, ++ctrl++ + scroll to zoom, drag in 3-D to rotate, and
++shift++ + drag to rotate a cross-section to any angle.

## 4. Right dock: Layer

The selected dataset's controls, as Neuroglancer's own layer tabs at full
height. A header names the dataset and, when it is shown through several
layers, lets you pick which one.

| Tab | What it holds |
|---|---|
| **Source** | Where the data comes from, its parts (subsources), and its **transform**: the matrix that places it in the scene, editable. |
| **Render** | How it is drawn: resolution, opacity, blending; for images the **Colour map** and the shader (contrast, with a histogram); for segmentations the **Lookup table**; for surfaces the **Surface** controls. |
| **Segments** | For segmentations: search segments by id, label or property, show and hide them, colours. |
| **Annotations** | For annotation layers: the tools that draw points, lines, boxes, ellipsoids and polylines, and the list of annotations. |
| **Schema** | For annotation layers: the properties each annotation carries. |

### Colour maps

An image layer's **Render → Shader → Colour map** writes the shader for a
colour map, keeping the contrast (the `normalized` range and its histogram):
grayscale, heat, jet, GE colour, NIH, PET, binary colour, hot, cool, viridis,
magma, inferno, plasma, cividis, turbo, cubehelix and a diverging red-blue.

- **Heat** works as Freeview's: the contrast's range is *min* to *max* of the
  value's magnitude, and **mid** (a fraction of the way) is where red turns
  to yellow. Below min nothing is drawn, so the image underneath shows;
  between min and mid the colour fades in. For signed data (float, signed
  integers) negative values are drawn in blue to cyan. **opaque** draws
  black below min instead.
- **Binary colour** draws one colour (chosen beside it) wherever the value
  is above the contrast's minimum; **shade** darkens it with the value.
- GE colour, NIH and PET approximate the scales of those names.
- Editing the code makes the map **Custom**; choosing Custom changes
  nothing, so a shader of your own is kept.

### Lookup tables

A segmentation layer's **Render → Colour → Lookup table** names and colours
its labels from an atlas's table: FreeSurfer (all labels, Desikan-Killiany,
Destrieux, Yeo networks), Harvard-Oxford, Schaefer 2018 (100 to 1000
parcels, 7 or 17 networks), and the Allen Mouse CCFv3 (2017) structures,
which are fetched from the Allen Institute when chosen. **File…** loads a
table from your computer: FreeSurfer's format (`index name R G B A`),
FSLeyes and ITK-SNAP tables, FSL atlas XML, the Allen structure graph
(JSON), or a plain `index name` list (colours are made up). The colours
become the layer's segment colours; the names show in the Segments tab
(search them, list them by label), and under the mouse. Both travel with the
link, a table from your computer included. **None** takes them off again.
Where each table comes from, and its licence:
[`data/lookup-tables/`](https://github.com/AllenInstitute/ngplatform/tree/main/data/lookup-tables).

### Outlines

A segmentation layer's **Render → 2-D views → Draw** shows its segments
**Filled** or as **Outlines** in the 2-D views, each in its own colour
(its lookup table's, or the colour from its id), at any angle and zoom.
Outlines are drawn by an image layer added just above the segmentation,
"*name* outlines", which reads the same labels; the segmentation's own 2-D
opacity is set to 0 meanwhile (its meshes are untouched), and **Filled**
removes the outline layer and gives the opacity back. The outline layer's
**Render** tab sets the line width in screen pixels (`outline_width`), the
lines' opacity, and an optional faint fill (`fill_opacity`). It follows the
segmentation's colours and its shown segments by itself.

Limits: a boundary lying exactly on the face of a data chunk is not drawn
(the outline has gaps there), and with more than 4,096 coloured or shown
segments the outlines use the hashed colours or show every segment.

### Surfaces

![A FreeSurfer subject: thickness on the left white surface over its binary curvature, the right in curvature alone, and the white surfaces' outlines on the sections](../images/surfaces.png)

A cortical surface is drawn as Freeview draws it: filled and lit in the 3-D
view, as its outline where it crosses each 2-D view (white yellow, pial red),
and coloured by the values on its vertices. A FreeSurfer surface opened from
your computer brings the files beside it: the morphometry in `surf/`
(`lh.curv`, `lh.sulc`, `lh.thickness`, `lh.area`, `lh.volume` and the rest of
FreeSurfer's curvature-format files), overlays as `.mgh`/`.mgz` with one value
per vertex, the parcellations in `../label/` (`lh.aparc.annot`,
`lh.aparc.a2009s.annot`, `lh.BA_exvivo.annot`), and the `.label` files there,
put together as one parcellation named `labels` (a vertex in several labels
takes the smallest, so V1 shows inside cortex). A GIFTI surface brings the
same hemisphere's `.shape.gii`, `.func.gii` and `.label.gii` files beside it.
Only files with the surface's vertex count are used. A Zarr Vectors surface
store written by zarr-vectors-tools (`zvtools convert` of a FreeSurfer
subject or GIFTI files) works the same, its parcellations' names and colours
coming from the store.

A surface with curvature opens showing it in two greys, Freeview's binary
curvature (sulci dark, gyri light). Its layer's **Render → Surface** section
holds Freeview's surface controls:

| Control | What it does |
|---|---|
| **Surface** | Which of the hemisphere's surfaces is drawn: white, pial, inflated, sphere, orig, smoothwm (those in the folder; for a store, those it keeps as `coords_*`). They share their vertices, so the values stay. |
| **Colour** | Under the overlay: **Binary curvature** (from `curv`, else `sulc`) or the layer's own colour. |
| **Overlay** | A value drawn in colour where it passes the threshold: thickness, sulcal depth, an overlay. Maps the store holds but does not show at first are listed with "(load)". |
| **Colour map** | **Heat** as Freeview's (red to yellow from the threshold to the top, blue to cyan for negative values), or jet, viridis and the other maps, from the threshold to the top. |
| **Parcellation** | An `.annot`, the labels or a GIFTI label file in its own colours, over the rest. |
| **2-D outlines** | Coloured by the values too, rather than in the layer's colour. |
| **Under the mouse** | The values of the vertex under the mouse, and its parcel's name. |

The overlay's **threshold** and **top**, and the parcellation's opacity, are
sliders among the shader's controls below: dragging them is immediate.
The controls write the layer's shader, so the choices are saved with the
workspace and travel in a link; editing the shader by hand keeps working,
as `prop_<name>()` gives a value on the vertex and `lut_<name>(code)` a
parcellation's colour.

Limits: Freeview's overlay settings beyond threshold and top (mid point,
truncate, inverse, custom colour scales), label outlines, and several
overlays at once are not there.

## 5. Bottom dock

| Tab | What it holds |
|---|---|
| **Activity** | A log of what the workspace did, newest first: datasets added, plugins started, errors. |
| **Jobs** | Long tasks from plugins (filters, statistics, saving), with progress and a cancel button. |
| **Chunk statistics** | Neuroglancer's chunk statistics: what is being downloaded, from where, and how fast. |
| **Python** | A Python console running in the page (Pyodide). `ngp` drives the workspace; `await ngp.show(array, voxel_size=…)` shows a numpy array as a layer; `ngp.show_points(xyz, values=…)`, `ngp.show_lines(lines)` and `ngp.show_mesh(vertices, faces)` show points, streamlines and meshes made in Python (as Zarr Vectors, so Track filtering works on them), and `ngp.annotate(points=…, lines=…, boxes=…, ellipsoids=…)` adds an annotation layer. |
