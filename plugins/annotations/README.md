# Annotations

![Labels pinned to structures, in 2-D and 3-D](../../docs/images/plugins/labels.png)

Everything added to annotate a dataset, in the **Annotations** tab: three
folding sections. Label volumes drawn by hand, once its fourth section, are
the [Segmentation plugin](../segmentation/README.md).

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
  median inside a box, an ellipsoid, a label of a label volume drawn in the
  Segmentation tab, or a label of any readable segmentation layer (an atlas), read at the finest level
  that fits a memory budget (as Registration's save picks a level). Label
  volumes drawn in the Segmentation tab come from that plugin's
  `segmentation.labelVolumes` service.

It was the Labels plugin: the id (`org.ngplatform.annotations`), the tab's
id (`annotations.labels`) and the state's key (`labels`, version 1) are
unchanged, so links and docked tabs from then still open.

| File | What |
|---|---|
| `manifest.ts` | The tab, commands, the state slice |
| `plugin.ts` | Activation; the tab's folding sections |
| `labels.ts` | Labels: layout (beside the pin, or callouts at the sides), the overlay, screenshots, the section |
| `geometry.ts` | Placing a grid of voxels or an annotation layer in the global space through its layer's transform; lengths in mm; a 2-D view's pixel back to a position |
| `measure.ts`, `measure_panel.ts`, `plot.ts` | Measurements and profiles (pure), the section, the profile plot |
| `statistics.ts`, `statistics_panel.ts` | Regions and summaries (pure, run in the worker), the section |
| `voxel_worker.ts`, `voxels.ts` | A worker reading images (through the volume view's reader): levels, values at points, blocks on another grid, statistics in a region |
| `scene.ts`, `ui.ts`, `style.ts` | Shared helpers (also used by the Segmentation plugin) |
| `tests/` | `npm test` runs them |

## What it uses from the platform

`ui.overlay()`, `ui.screenshotOverlay()`, `viewer.panels()`,
`viewer.onRendered()`, `viewer.cursor()`, `viewer.layerTransform()`,
`viewer.patchState()`, `services` (`segmentation.labelVolumes`, when the
Segmentation plugin is on), `jobs`, `settings`.

The worker (`voxel_worker.ts`) reads through the volume view's reader
(`../volume-view/volume_reader.ts`); the Segmentation plugin uses it too.
