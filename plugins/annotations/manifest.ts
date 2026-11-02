/**
 * The Annotations plugin's manifest: everything added to annotate a
 * dataset, in one tab with four sections: labels on the views for figures
 * (./labels.ts), measurements (./measure.ts), statistics of an image in a
 * region (./statistics.ts) and label volumes drawn by hand
 * (./segmentation/).
 *
 * It was the Labels plugin: its id, its tab's id and its state's key are
 * unchanged, so links and docked tabs from then still open.
 */
import type { Manifest } from "@ngplatform/sdk";

/** The tab (its id from when it held only labels). */
export const ANNOTATIONS_PANEL = "annotations.labels";

/** Set while a drawing tool is on in the views. */
export const PAINTING = "annotations.painting";

export const ANNOTATIONS_MANIFEST: Manifest = {
  id: "org.ngplatform.annotations",
  name: "Annotations",
  version: "0.2.0",
  kind: "tool",
  enabledByDefault: true,
  description: "Labels and annotations: labels on the views for figures, measurements, statistics in a region, and label volumes drawn by hand.",
  guide: `Everything you add to annotate a dataset, in the **Annotations** tab: four sections.

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
For an image and a region (a box or ellipsoid annotation, or a label of a label volume): voxel count, volume, mean, standard deviation, minimum, maximum and median of the image inside. The finest level that fits the memory budget is read. Each result is a row of a table you can save as CSV.

## Segmentation
Label volumes drawn by hand, shown as a segmentation layer that updates as you draw.
- **New** makes an empty one on an image's grid (the same voxels and placement; 8, 16 or 32 bits); **Open** reads a NIfTI label image to edit.
- Tools: **Brush** (a sphere or a disc in the section, its radius in mm or voxels), **Erase**, **Fill 2-D** (the section) and **Fill 3-D** (bounded), **Pick** a label from a view, and **Quick select** (a box or a click). Brush and fills can be limited to an intensity range of the image.
- In a view, the left button draws; hold **Space** to move the view instead. Keys while drawing: \`B\` brush, \`E\` erase, \`F\` fill, \`Shift+F\` fill 3-D, \`I\` pick, \`[\` and \`]\` brush size, \`Ctrl+Z\` and \`Ctrl+Shift+Z\` undo and redo strokes, \`Escape\` stops drawing.
- **Save** as NIfTI (.nii.gz) or an OME-Zarr folder; only the painted box, if you ask.

A label volume lives in this page until saved: save it before closing the page.`,
  links: [{ title: "WebKnossos volume annotation (what this follows)", url: "https://docs.webknossos.org/webknossos/volume_annotation/index.html" }],
  license: "Apache-2.0",
  activation: ["onStartup"],
  contributes: {
    panels: [{ id: ANNOTATIONS_PANEL, title: "Annotations", slot: "left", order: 60 }],
    appState: { key: "labels", version: 1 },
    contextKeys: [PAINTING],
    commands: [
      { id: "annotations.newLabelVolume", title: "New label volume on an image's grid", group: "Annotations" },
      { id: "annotations.openLabelVolume", title: "Open a NIfTI label image to edit", group: "Annotations" },
      { id: "annotations.saveLabelVolume", title: "Save the label volume", group: "Annotations" },
      { id: "annotations.tool", title: "Drawing tool", group: "Annotations", args: { type: "object", properties: { tool: { type: "string" } }, required: ["tool"] } },
      { id: "annotations.brushSize", title: "Brush size", group: "Annotations", args: { type: "object", properties: { factor: { type: "number", default: 1.25 } } } },
      { id: "annotations.undoStroke", title: "Undo the last stroke", group: "Annotations", when: PAINTING },
      { id: "annotations.redoStroke", title: "Redo a stroke", group: "Annotations", when: PAINTING },
      { id: "annotations.stopDrawing", title: "Stop drawing", group: "Annotations", when: PAINTING },
      { id: "annotations.exportMeasurements", title: "Save measurements as CSV", group: "Annotations" },
    ],
    keybindings: [
      { key: "b", command: "annotations.tool", args: { tool: "brush" }, when: PAINTING },
      { key: "e", command: "annotations.tool", args: { tool: "erase" }, when: PAINTING },
      { key: "f", command: "annotations.tool", args: { tool: "fill2d" }, when: PAINTING },
      { key: "shift+f", command: "annotations.tool", args: { tool: "fill3d" }, when: PAINTING },
      { key: "i", command: "annotations.tool", args: { tool: "pick" }, when: PAINTING },
      { key: "q", command: "annotations.tool", args: { tool: "quick" }, when: PAINTING },
      { key: "]", command: "annotations.brushSize", args: { factor: 1.25 }, when: PAINTING },
      { key: "[", command: "annotations.brushSize", args: { factor: 0.8 }, when: PAINTING },
      { key: "mod+z", command: "annotations.undoStroke", when: PAINTING },
      { key: "mod+shift+z", command: "annotations.redoStroke", when: PAINTING },
      { key: "mod+y", command: "annotations.redoStroke", when: PAINTING },
      { key: "escape", command: "annotations.stopDrawing", when: PAINTING },
    ],
  },
};
