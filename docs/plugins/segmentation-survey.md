# Drawing labels: what WebKnossos offers, and what we build

A short survey of volume annotation (labelling voxels by hand and with
help) in [WebKnossos](https://docs.webknossos.org/webknossos/volume_annotation/index.html),
the reference for this kind of work on large volumes, and what the
[Segmentation](segmentation.md) plugin builds now and later. Surveyed November 2026 from the WebKnossos user documentation.

## What WebKnossos offers

**Drawing tools** ([Tools](https://docs.webknossos.org/webknossos/volume_annotation/tools.html)):

- **Brush**: paints a disc in the section shown; drawing round an object in
  one stroke fills its inside. Size by Shift + wheel, with small, medium and
  large presets.
- **Trace** (lasso): draws an outline, filled when closed; precise with a
  [pen tablet](https://docs.webknossos.org/webknossos/volume_annotation/pen_tablets.html).
- **Eraser**: the brush and trace tools painting nothing.
- **Overwrite modes**: *overwrite everything*, or *only overwrite empty
  areas* (for erasing: only the current segment); Ctrl held switches
  between them for the stroke.
- **Fill**: fills the region of the clicked label up to other labels or the
  view's edge, in 2-D (the section) or 3-D (in a small box round the click,
  or a bounding box drawn). It reads labels only, not image intensities.
- **Segment picker**: the label under the pointer becomes the active one
  (also from the context menu).
- **Quick select**: draw a rectangle round a structure, or click it. In
  *threshold* mode it thresholds from the selection's centre; in *AI* mode
  a model (Segment Anything style) segments it, over a chosen number of
  sections. A preview is accepted with Enter or dropped with Escape.
- **Interpolation** between sections: label an object in one section, skip
  a few, label it again, press **V**: the sections between are filled
  (heuristic; to be checked).
- **Segments list and statistics**
  ([list](https://docs.webknossos.org/webknossos/volume_annotation/segments_list.html),
  [statistics](https://docs.webknossos.org/webknossos/volume_annotation/segments_statistics.html)):
  segments named and grouped, their volume and bounding box, exported as
  CSV.
- **Import and export**
  ([volume annotations](https://docs.webknossos.org/webknossos/volume_annotation/import_export.html)):
  as WKW / Zarr layers, through the UI or the Python library.

**Proofreading** an automatic segmentation
([proofreading tool](https://docs.webknossos.org/webknossos/proofreading/proofreading_tool.html),
[merger mode](https://docs.webknossos.org/webknossos/proofreading/merger_mode.html),
[split segments](https://docs.webknossos.org/webknossos/proofreading/split_segments_toolkit.html)):
segments are agglomerates of supervoxels joined in a graph; *merge* adds an
edge between two, *split* cuts edges between two (a min-cut), and meshes
reload after each edit. Voxels are not changed, only the mapping; it needs
a good over-segmentation and its graph.

**AI jobs and training** ([AI segmentations](https://docs.webknossos.org/webknossos/automation/ai_segmentation.html),
[model training](https://docs.webknossos.org/webknossos/automation/ai_training.html),
[jobs](https://docs.webknossos.org/webknossos/automation/jobs.html)):
pretrained models (neurons; mitochondria, by MitoNet; somata and nuclei)
and models trained on one's own annotations run as server jobs over a
dataset or a bounding box, writing a new dataset; a test on a small box
first is advised. Runs on webknossos.org only.

## What we build now, and later

The label volume is held in the page in 64³ chunks made only where
something is painted, and shown by Neuroglancer as a segmentation layer
reading it as an OME-Zarr store served from the page; after a stroke
Neuroglancer reads its chunks again (see the plugin's README).

| WebKnossos | Here | When |
|---|---|---|
| Tool bar over the views; Move as the default tool; tools by key (B, E, L, F, I, Q; W to cycle) | The same tool bar and keys while a layer is edited; Move (`M`, `Escape`) leaves the views to Neuroglancer | Now |
| Brush, its size (Shift + wheel) | **Brush**: a ball, or its disc in the section; radius in voxels, mm or µm (round in space on any voxels); **Alt + wheel** (Neuroglancer's Shift + wheel steps ten sections), `[` and `]`, the bar's − and + | Now |
| A new volume layer, empty or over an existing segmentation | **New segmentation layer** on an image's or a segmentation's grid, at a level; or a **copy** of a segmentation's labels at a level to edit (WebKnossos edits a fallback segmentation in place; here a copy, up to 512 M voxels, its labels exact to 32 bits) | Now |
| Eraser | **Erase**: any label, or only the active one | Now |
| Overwrite modes | **Paint over**: any label, or unlabelled only | Now |
| Fill 2-D / 3-D by labels | **Fill 2-D** (the section) and **Fill 3-D** (a box a set reach round the click), by the label clicked | Now |
| — (WebKnossos fills ignore the image) | Fills and the brush limited to an **intensity range** of an image (as ITK-SNAP's and Freeview's thresholds) | Now |
| Segment picker | **Pick segment** (`I`) | Now |
| Create new segment ID (C) | **New segment** (`C`): one more than the largest id used | Now |
| Quick select, threshold | **Quick select** with a box (Otsu's threshold, the side the box's middle is on, its connected part) or a click (a tolerance round the value) | Now |
| Quick select, AI (SAM) | The same tool takes other methods through the `segmentation.quickSelect` service: a method gets the prompt and the image's values round it on the label grid, and returns a mask. A Segment Anything method served elsewhere (or in the page with ONNX Runtime Web) can plug in without changing the tool | Later |
| Preview, Enter / Escape | Quick select's mask shows over the 2-D views (tinted, outlined) until **Enter** paints it or **Escape** drops it; **At once** paints straight away | Now |
| Undo / redo | **Undo**, **Redo** (`Ctrl+Z`, `Ctrl+Y` while a layer is edited): strokes (within a memory budget) and the workspace's changes as one history, whichever came last | Now |
| Trace (lasso) | **Lasso** (`L`): an outline drawn in a 2-D view, closed when the button is let go, its inside painted (or erased) in that section, as **Paint over** and the intensity range allow | Now |
| Interpolation between sections (V) | **Interpolate** (++v++): shape-based (signed distances, weighted by nearness) through the sections between drawn sections of the active segment (over any segment, or empty voxels only, as **Paint over** says), across the view last drawn in | Now |
| 3-D flood fill to relabel a segment (fixing splits and merges by hand) | **Merge** (a segment into the active one) and **Delete**, everywhere | Now |
| Segments list: active segment, names, colours, visibility, go to; statistics, CSV | **Segments** list: the active one marked, names, colours, voxels and volume, shown or hidden, **Go to**; Annotations' **Statistics** section (an image's values in a segment) with CSV | Now |
| Import / export | **Open** a NIfTI label image; **Save** as NIfTI (.nii.gz, label intent) or OME-Zarr (only painted chunks written), optionally only the painted box | Now |
| Pen tablet | Pointer events would give pressure; not yet used | Later |
| Proofreading: merge and split agglomerates | Needs a supervoxel graph and an editable mapping: for CAVE / graphene segmentations Neuroglancer already has its own merge and split tools; for others, later | Later |
| AI jobs, training | Out of scope for the browser: jobs belong to a server (a plugin that sends a box and an image to one, and opens the result as a layer, fits the platform's jobs and auth) | Later |

### Large data

A label volume on a whole-brain grid (SRB 2026a at 100 µm is 1970 ×
2330 × 1890 voxels) costs only its painted chunks in memory. Saving as
OME-Zarr writes only those chunks; NIfTI must hold every voxel, so for a
large grid save the painted box. For data too large for the page (a
HiP-CT scan at full resolution), the plan is a **sparse edit layer over
the source**: strokes kept as chunks of a Zarr array on the same grid as
the source (absent chunks meaning "no edit"), saved into a folder on this
computer as they are made, and merged with the source (an existing
segmentation, or nothing) only when exported, at the resolution asked for.
Coarse levels would then be made from the edits alone, as they are here.
