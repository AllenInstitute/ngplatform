# Annotations

![Labels pinned to structures, in 2-D and 3-D](../../docs/images/plugins/labels.png)

Everything added to annotate a dataset, in the **Annotations** tab: four
folding sections.

- **Labels**: names on the views for figures, as an anatomy atlas draws
  them: a pin, a thin leader line, and the name beside it or lined up at the
  view's edge. Pinned to a point, a track group's centre (from the track
  filtering plugin's `trackFiltering.groups` service) or an annotation's
  description. Shown in 2-D, 3-D or both, dragged and resized in the views,
  painted into Neuroglancer's screenshots.
- **Measure**: lengths of Neuroglancer's line and polyline annotations,
  volumes (areas when flat) of boxes and ellipsoids, in physical units
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
unchanged, so links and docked tabs from then still open.

| File | What |
|---|---|
| `manifest.ts` | The tab, commands, keys (while drawing), the state slice |
| `plugin.ts` | Activation; the tab's folding sections |
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
| `segmentation/panel.ts` | The section |
| `tests/` | `npm test` runs them |

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

`ui.overlay()`, `ui.screenshotOverlay()`, `viewer.panels()`,
`viewer.onRendered()`, `viewer.cursor()`, `viewer.layerTransform()`,
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
