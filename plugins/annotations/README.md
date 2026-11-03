# Annotations

![Labels pinned to structures, in 2-D and 3-D](../../docs/images/plugins/labels.png)

Everything added to annotate a dataset, in the **Annotations** tab (five
folding sections), and the **Annotation table** in the bottom dock.

- **Annotate**: points, lines, boxes, ellipsoids and polylines in local
  annotation layers, organised as WebKnossos and Neuroglass organise them,
  for one user: named, nested **groups** (shown or hidden, coloured),
  **fields** (a list of values, a number, text, or a term of an ontology),
  and **comments**. The **annotation table** lists every annotation of the
  scene's local annotation layers with its group, values, size and comments:
  found by a query, sorted, gone to, edited and deleted from the table,
  saved as CSV and read back.
- **Labels**: names on the views for figures, as an anatomy atlas draws
  them: a pin, a thin leader line, and the name beside it or lined up at the
  view's edge. Pinned to a point, a track group's centre (from the track
  filtering plugin's `trackFiltering.groups` service) or an annotation's
  description. Shown in 2-D, 3-D or both, dragged and resized in the views,
  painted into Neuroglancer's screenshots.
- **Measure**: lengths of Neuroglancer's line and polyline annotations,
  volumes (areas when flat, as a box or ellipsoid drawn in one section is)
  of boxes and ellipsoids, in physical units
  through each layer's transform; an image's profile along a line, plotted
  and saved as CSV. Drawing is Neuroglancer's own annotation tools, in a
  `measurements` layer this section makes.
- **Statistics**: an image's voxel count, volume, mean, SD, min, max and
  median inside a box, an ellipsoid, a label drawn here or a label of any
  readable segmentation layer (an atlas), read at the finest level
  that fits a memory budget (as Registration's save picks a level).
- **Segmentation**: label volumes drawn by hand (brush, eraser, 2-D and 3-D
  fills, pick, quick select, interpolation between sections, intensity
  limits, undo), saved as NIfTI or
  OME-Zarr. See [the survey](../../docs/plugins/segmentation-survey.md)
  for how it compares with WebKnossos and what comes next.

![Drawing labels on SRB 2026a](../../docs/images/plugins/annotations-segmentation.png)

It was the Labels plugin: the id (`org.ngplatform.annotations`), the tab's
id (`annotations.labels`) and the state's key (`labels`, version 1) are
unchanged, so links and docked tabs from then still open. The slice holds
the labels (`labels`) and the Annotate section's record (`annotate`).

| File | What |
|---|---|
| `manifest.ts` | The tab and the annotation table, commands, keys (while drawing), the state slice |
| `plugin.ts` | Activation; the tab's folding sections |
| `values.ts` | Fields and their values: which are annotation properties, which the plugin keeps (pure) |
| `groups.ts` | Groups: the tree, the `group` property, the shader that hides and colours (pure) |
| `ontology.ts` | Term lists: plain, OBO, JSON, a lookup table; finding a term (pure) |
| `table.ts` | The table's rows, queries, sorting, CSV out and in (pure) |
| `annotate.ts` | The scene's annotation layers and the plugin's record of them: writing both, tools, selection, new annotations, the tooltip |
| `annotate_panel.ts`, `table_panel.ts` | The Annotate section; the annotation table and its editor |
| `labels.ts` | Labels: layout (beside the pin, or callouts at the sides), the overlay, screenshots, the section |
| `geometry.ts` | Placing a grid of voxels or an annotation layer in the global space through its layer's transform; lengths in mm; a 2-D view's pixel back to a position |
| `measure.ts`, `measure_panel.ts`, `plot.ts` | Measurements and profiles (pure), the section, the profile plot |
| `statistics.ts`, `statistics_panel.ts` | Regions and summaries (pure, run in the worker), the section |
| `voxel_worker.ts`, `voxels.ts` | A worker reading images (through the volume view's reader): levels, values at points, blocks on another grid, statistics in a region |
| `scene.ts`, `ui.ts`, `style.ts` | Shared helpers |
| `segmentation/label_volume.ts` | The label volume held in the page: chunks, its pyramid, the OME-Zarr store it answers |
| `segmentation/store_format.ts` | Serving those stores to Neuroglancer through local data (loaded with the catalogue) |
| `segmentation/session.ts` | A volume being drawn: its layer, history, colours, the image that limits the tools |
| `segmentation/kernels.ts`, `history.ts` | Brush, fills and their limits, interpolation between sections (signed distances); strokes, undo and redo (pure) |
| `segmentation/painter.ts` | The mouse in the views: drawing, the brush ring, the quick-select box |
| `segmentation/quick_select.ts` | The quick select interface, the threshold method, the registry other plugins add to |
| `segmentation/save.ts` | NIfTI and OME-Zarr out, the painted box |
| `segmentation/keep.ts` | Volumes kept in the browser (OPFS) while drawn, brought back after a reload |
| `segmentation/panel.ts` | The section |
| `tests/` | `npm test` runs them |

![The annotation table, groups and fields, coloured by cell type](../../docs/images/plugins/annotations-table.png)

## Where annotations, values, groups and comments are kept

Annotations stay Neuroglancer's: each local annotation layer holds them in
the state (`annotations`), and the table reads and writes that list. What
the plugin adds is kept where Neuroglancer can keep it:

| What | Where | As |
|---|---|---|
| A **list** field (cell types…) | the layer's `annotationProperties`, each annotation's `props` | an enum property: `uint8` (or `uint16` past 254 values), 0 for none, 1, 2, … for the values, the values as `enum_labels` |
| A **number** field | the same | a `float32` property; 0 when not set |
| The **group** | the same, property `group` | a `uint16` enum: 0 for none, then each group's number, labelled with its path (`Cortex / Layer 5`); its `default` is the group new annotations go to |
| **Text** and **ontology** fields | the plugin's state (`annotate.layers[<layer>].values[<id>]`) | text; a term as `{id, name}` |
| **Comments** | the plugin's state (`…comments[<id>]`) | `{time, text}`, time in ISO 8601 (UTC) |
| Fields' titles and kinds, the group tree (parents, colours, hidden), the colouring | the plugin's state (`…fields`, `…groups`, `…colourBy`) | |
| Hidden groups, colours by group or value | the layer's `shader` | made here, marked by its first line, rewritten when they change |

So Neuroglancer's own panels show a list's value and the group by name, and
its shaders can use them (`prop_cell_type()`, `prop_group()`). Properties a
layer had already (from Neuroglancer, or another program) are fields too:
an enum as a list, a number as a number, a colour shown only. New
annotations take the properties' defaults, which is how a new annotation
goes to the chosen group without being written again. Changing a field's
list keeps each annotation's value by name.

The plugin's state is the scene's (each scene keeps its own slice), keyed by
layer name: renaming a layer in Neuroglancer leaves its text values and
comments behind. Values and comments of annotations deleted are dropped the
next time the layer is written. Track filtering's regions layer (`<dataset>
regions`, written from its groups) is listed and can be gone to, commented
and deleted, not edited.

An ontology field names a lookup table (`lut://…`, read when first needed:
the Allen structures are fetched from the Allen Institute) or keeps the
terms of a file with it, in the link (up to 5,000 terms). A term found by a
query is also found by the names of the structures it is within.

### The table's queries

Words a row must all match: plain text anywhere; `column:text` (contains),
`column=text` (is; `column=` is empty), `column!=text`, `column>n`,
`column<n`, `>=`, `<=`; `-word` for rows that do not match; quotes round
text with spaces. A column is named by its title without spaces or case
(`celltype`, `group`, `size`, `comments`, `type`, `layer`, `id`). `size`
compares millimetres, mm² or mm³; `comments>0` finds annotations with
comments.

### CSV

Columns: `layer, id, type, description, group, <each field>, size, unit,
comments, point, point_a, point_b, center, radii, points`. Coordinates are
the layer's own, space-separated (`points`: points separated by `;`);
comments are a line each, `time text`. Reading a CSV: a row whose layer and
id the scene has updates that annotation (description, group, values; new
comments are added); any other row with a type and coordinates is added, to
its layer when the scene has it, else to the layer chosen. Groups are made
from their paths (` / ` between groups), columns without a field become one
(a number when every value is one, a list otherwise), and lists gain the
values they lack.

### Selection and new annotations

A new annotation drawn in a layer (one id more than the state had) is
selected and the table shown. An annotation pinned in Neuroglancer's
selection (Ctrl+right-click) is selected in the table, and one selected in
the table is pinned there (in the state's `selection`, quietly: it is not an
undo step). The tooltip reads the annotation under the pointer from
Neuroglancer's layer values (`viewer.cursor().values[layer].annotationId`).

## How a label volume reaches Neuroglancer

The volume is held in the page in 64³ chunks, made only where something is
painted (a mask on a whole-brain grid costs what is drawn on it). It answers
as an OME-Zarr store: Zarr v3, raw little-endian chunks, a pyramid whose
coarser levels are made from the level below when asked for (a coarse voxel
takes the first label of the eight under it, so thin strokes still show;
it is placed at their centre, so a stroke one section thick shows in that
section when zoomed out) and kept until a stroke changes them.

Neuroglancer reads it as it reads a file on this computer:

1. The catalogue entry (`plugins/index.ts`) declares a virtual format,
   `*.ngplabels`, whose "worker" is an object in the page
   (`store_format.ts`). Local data hands it every key under such a file.
2. A new volume registers itself under a unique file name and opens an
   empty file of that name with `workspace.local.open`; the dataset's
   source is `zarr3://<app>/local/<id>/<name>.ngplabels/`.
3. After each stroke (a few times a second while it lasts, once when it
   ends) the plugin calls `viewer.reloadData(url)`: Neuroglancer drops
   every chunk it holds from the store and asks for those on screen again,
   which the page answers from memory at once. Metadata is kept.

Painting runs in the page; a dab limited to an image's range first reads
the image's values on the label grid (chunk-sized blocks, cached) from the
worker, so a stroke's dabs are queued in order and keep the settings they
started with.

### The 2-D and 3-D views

In a 2-D view the point under the pointer is found from the view's own
projection (`ViewPanelInfo.project`, inverted near the position, so it is
exact and immediate); its depth gradient gives the section's normal in the
volume's voxels, so a disc brush and a 2-D fill take the section shown. In
the 3-D view the brush paints a ball at Neuroglancer's picked point (on a
section or a surface).

### Kept in the browser

While a volume is drawn, its painted chunks and description are written to
the browser's origin private file system (`segmentation/keep.ts`), a moment
after strokes stop. The store's file is opened as a *derived* local file, so
its layer is a dataset known by its name rather than by the visit's URL:
after a reload, a layer whose volume is not in the page is pointed at the
kept copy (served under a new URL) in place, and the workspace keeps one
dataset. Volumes kept but not in the scene are offered under **New**.
**Close** forgets the copy.

### Large data

Today's limits: a label volume costs 256 KB (8-bit) to 1 MB (32-bit) per
painted chunk; undo keeps up to 512 MB of chunk copies; a fill stops at
64 M voxels; opening a NIfTI reads it whole (up to 512 M voxels); NIfTI
saves are capped at 2 GB, so for a large grid save the painted box or as
OME-Zarr (painted chunks only).

The plan for data too large for the page is a **sparse edit layer over the
source**: strokes kept as chunks of a Zarr array on the source's grid
(absent chunks meaning "no edit"), written to a folder on this computer as
they are made (with `workspace.local.write`), shown over the source as they
are now, and merged with it (an existing segmentation, or nothing) only on
export, at the resolution asked for. The store and its pyramid already work
chunk by chunk, so the change is where the chunks live, not how they are
drawn.

## What it uses from the platform

`ui.overlay()`, `ui.screenshotOverlay()`, `ui.showPanel()`, `ui.form()`,
`viewer.panels()`, `viewer.lookupTables` (ontologies),
`viewer.onRendered()`, `viewer.cursor()` (and the annotation under the
pointer), `viewer.layerTransform()`,
`viewer.patchState()`, `workspace.local.open/close`, `services`
(`annotations.quickSelect`, which it provides), `jobs`, `settings`.

**Added to the SDK for it:** `viewer.reloadData(url)` (`src/sdk/types.ts`,
`src/ui/apis.ts`): Neuroglancer invalidates every chunk source in its chunk
manager whose key names the URL (each held for two seconds, so the worker's
answer never finds it let go). No Neuroglancer change was needed.

A finer reload would re-read only the chunks a stroke changed (today every
chunk of the store on screen is read again; from memory, so it is quick, but
a large view flickers for a frame). That needs a per-chunk invalidation in
Neuroglancer's chunk worker, which the fork does not have yet: a small
`ChunkSource.invalidateChunks(keys)` RPC beside `invalidateCache`.

It also uses the volume view's reader (`../volume-view/volume_reader.ts`,
which gained `rawRegion` and `rawPoints`) and Registration's writers
(`../registration/volume_io.ts`, whose OME-Zarr metadata writer is now
shared).

## Adding a quick select method

```ts
import type { QuickSelectService } from "../annotations/segmentation/quick_select.js";

const qs = await ctx.services.get<QuickSelectService>("annotations.quickSelect");
ctx.subscriptions.push(
  qs.register({
    id: "sam",
    title: "Segment Anything",
    prompts: ["box", "point"],
    // request.image: the image's values round the prompt on the label grid;
    // return a mask on that grid (1 = selected).
    async run(request, signal) { /* … */ return { lo: request.image.lo, size: request.image.size, data }; },
  }),
);
```
