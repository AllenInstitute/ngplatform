/**
 * The Annotations plugin's manifest: everything added to annotate a
 * dataset, in one tab with three sections: labels on the views for figures
 * (./labels.ts), measurements (./measure.ts) and statistics of an image in
 * a region (./statistics.ts).  Label volumes drawn by hand, once its fourth
 * section, are the Segmentation plugin (../segmentation/).
 *
 * It was the Labels plugin: its id, its tab's id and its state's key are
 * unchanged, so links and docked tabs from then still open.
 */
import type { Manifest } from "@ngplatform/sdk";

/** The tab (its id from when it held only labels). */
export const ANNOTATIONS_PANEL = "annotations.labels";

export const ANNOTATIONS_MANIFEST: Manifest = {
  id: "org.ngplatform.annotations",
  name: "Annotations",
  version: "0.3.0",
  kind: "tool",
  enabledByDefault: true,
  description: "Labels and annotations: labels on the views for figures, measurements, and statistics in a region.",
  guide: `Everything you add to annotate a dataset, in the **Annotations** tab: three sections. Label volumes drawn by hand are in the **Segmentation** tab (the Segmentation plugin).

## Labels
Names on the views, as an anatomy atlas draws them: a pin on the structure, a thin leader line, and its name beside it or lined up at the edge of the view.
- **+ At the position**, **+ Track groups** (one per group in the Filtering tab) or **+ Annotations** (each annotation with a description).
- **Where**: beside the pin, or **At the side**; **Views**: 2-D, 3-D or both. Drag a label in a view to move it, by its corner to resize it; double-click puts it back.
- Labels are kept in the link and drawn into screenshots.

## Measure
Draw with Neuroglancer's annotation tools (**Line**, **Polyline**, **Box**, **Ellipsoid**): each button picks the tool in a *measurements* layer; click in a view to draw.
- Lines and polylines show their **length**, boxes and ellipsoids their **volume** (an area when flat), in physical units.
- **Line profile**: an image's values along a line, as a plot; **CSV** saves it.

## Statistics
For an image and a region (a box or ellipsoid annotation, a label of a label volume drawn in the Segmentation tab, or a label of a segmentation layer such as an atlas): voxel count, volume, mean, standard deviation, minimum, maximum and median of the image inside. The finest level that fits the memory budget is read. Each result is a row of a table you can save as CSV.`,
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: ANNOTATIONS_PANEL, title: "Annotations", slot: "left", order: 60 }],
    appState: { key: "labels", version: 1 },
    commands: [{ id: "annotations.exportMeasurements", title: "Save measurements as CSV", group: "Annotations" }],
  },
};
