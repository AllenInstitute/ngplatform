/**
 * The Annotations plugin's manifest: everything added to annotate a
 * dataset, in one tab with five sections: annotations with groups, values
 * and comments (./annotate.ts, listed in the annotation table in the bottom
 * dock), labels on the views for figures (./labels.ts), measurements (./measure.ts), statistics of an image in a
 * region (./statistics.ts) and label volumes drawn by hand
 * (./segmentation/).
 *
 * It was the Labels plugin: its id, its tab's id and its state's key are
 * unchanged, so links and docked tabs from then still open.
 */
import type { Manifest } from "@ngplatform/sdk";

/** The tab (its id from when it held only labels). */
export const ANNOTATIONS_PANEL = "annotations.labels";

/** The annotation table, in the bottom dock. */
export const TABLE_PANEL = "annotations.table";

/** Set while a drawing tool is on in the views. */
export const PAINTING = "annotations.painting";

export const ANNOTATIONS_MANIFEST: Manifest = {
  id: "org.ngplatform.annotations",
  name: "Annotations",
  version: "0.3.0",
  kind: "tool",
  enabledByDefault: true,
  description: "Annotations with groups, values and comments in a table; labels on the views for figures, measurements, statistics in a region, and label volumes drawn by hand.",
  guide: `Everything you add to annotate a dataset, in the **Annotations** tab (five sections), and the **Annotation table** in the bottom dock.

## Annotate
Points, lines, boxes, ellipsoids and polylines in a local annotation layer, organised as in WebKnossos and Neuroglass.
- Choose the **layer** (or **+ New layer**) and a **tool**, then Ctrl+click in a view (Ctrl+double-click ends a polyline). The new annotation is selected in the annotation table, ready for its values.
- **Groups**: named, nested; tick to show or hide one (and the groups in it), pick its colour, choose the group new annotations go to, and **Colour by** group or by a field.
- **Fields**: values each annotation has: a **list** of values (cell types, say), a **number**, **text**, or an **ontology term** (from a lookup table such as the Allen structures, or a list, OBO or JSON file). Lists and numbers are kept as Neuroglancer annotation properties; text and terms in this plugin's state.

## Annotation table
Every annotation of the scene's local annotation layers: type, name, group, values, size and comments.
- **Find**: words anywhere, or \`column:text\`, \`column=text\` (\`group=\` for none), \`column>n\`, \`-word\`; a column is its title without spaces (\`celltype:basket\`, \`size>2\`). A term is also found by the structures it is within.
- Click a heading to sort; click a row to go to the annotation and select it; edit its description, group, values and **comments** beside the table, or delete it. Pointing at an annotation in a view shows its values and comments.
- **Save CSV** writes the rows found (with coordinates); **Open CSV…** updates the annotations a CSV names and adds the others.

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
For an image and a region (a box or ellipsoid annotation, a label of a label volume drawn here, or a label of a segmentation layer such as an atlas): voxel count, volume, mean, standard deviation, minimum, maximum and median of the image inside. The finest level that fits the memory budget is read. Each result is a row of a table you can save as CSV.

## Segmentation
Label volumes drawn by hand, shown as a segmentation layer that updates as you draw.
- **New** makes an empty one on an image's grid (the same voxels and placement; 8, 16 or 32 bits); **Open** reads a NIfTI label image to edit.
- Tools: **Brush** (a sphere or a disc in the section, its radius in mm or voxels), **Erase**, **Fill 2-D** (the section) and **Fill 3-D** (bounded), **Pick** a label from a view, and **Quick select** (a box or a click). **Interpolate** fills the sections between two where a label is drawn. Brush and fills can be limited to an intensity range of the image.
- In a view, the left button draws; hold **Space** to move the view instead. Keys while drawing: \`B\` brush, \`E\` erase, \`F\` fill, \`Shift+F\` fill 3-D, \`I\` pick, \`V\` interpolate between sections, \`[\` and \`]\` brush size, \`Ctrl+Z\` and \`Ctrl+Shift+Z\` undo and redo strokes, \`Escape\` stops drawing.
- **Save** as NIfTI (.nii.gz) or an OME-Zarr folder; only the painted box, if you ask.

A label volume lives in this page until saved. It is also kept in this browser while you draw, so a reload brings it back; save it all the same.`,
  links: [
    { title: "WebKnossos volume annotation (what segmentation follows)", url: "https://docs.webknossos.org/webknossos/volume_annotation/index.html" },
    { title: "WebKnossos skeleton annotation: trees, groups, comments", url: "https://docs.webknossos.org/webknossos/skeleton_annotation/index.html" },
    { title: "Neuroglass (annotation table, values from ontologies)", url: "https://www.neuroglass.com/" },
  ],
  license: "Apache-2.0",
  activation: ["onStartup"],
  provides: { services: ["annotations.quickSelect"] },
  contributes: {
    panels: [
      { id: ANNOTATIONS_PANEL, title: "Annotations", slot: "left", order: 60 },
      { id: TABLE_PANEL, title: "Annotation table", slot: "bottom", order: 15 },
    ],
    appState: { key: "labels", version: 1 },
    contextKeys: [PAINTING],
    commands: [
      { id: "annotations.newLabelVolume", title: "New label volume on an image's grid", group: "Annotations" },
      { id: "annotations.openLabelVolume", title: "Open a NIfTI label image to edit", group: "Annotations" },
      { id: "annotations.saveLabelVolume", title: "Save the label volume", group: "Annotations" },
      { id: "annotations.tool", title: "Drawing tool", group: "Annotations", args: { type: "object", properties: { tool: { type: "string" } }, required: ["tool"] } },
      { id: "annotations.brushSize", title: "Brush size", group: "Annotations", args: { type: "object", properties: { factor: { type: "number", default: 1.25 } } } },
      { id: "annotations.interpolate", title: "Interpolate the label between drawn sections", group: "Annotations" },
      { id: "annotations.undoStroke", title: "Undo the last stroke", group: "Annotations", when: PAINTING },
      { id: "annotations.redoStroke", title: "Redo a stroke", group: "Annotations", when: PAINTING },
      { id: "annotations.stopDrawing", title: "Stop drawing", group: "Annotations", when: PAINTING },
      { id: "annotations.exportMeasurements", title: "Save measurements as CSV", group: "Annotations" },
      { id: "annotations.showTable", title: "Show the annotation table", group: "Annotations" },
    ],
    keybindings: [
      { key: "b", command: "annotations.tool", args: { tool: "brush" }, when: PAINTING },
      { key: "e", command: "annotations.tool", args: { tool: "erase" }, when: PAINTING },
      { key: "f", command: "annotations.tool", args: { tool: "fill2d" }, when: PAINTING },
      { key: "shift+f", command: "annotations.tool", args: { tool: "fill3d" }, when: PAINTING },
      { key: "i", command: "annotations.tool", args: { tool: "pick" }, when: PAINTING },
      { key: "q", command: "annotations.tool", args: { tool: "quick" }, when: PAINTING },
      { key: "v", command: "annotations.interpolate", when: PAINTING },
      { key: "]", command: "annotations.brushSize", args: { factor: 1.25 }, when: PAINTING },
      { key: "[", command: "annotations.brushSize", args: { factor: 0.8 }, when: PAINTING },
      { key: "mod+z", command: "annotations.undoStroke", when: PAINTING },
      { key: "mod+shift+z", command: "annotations.redoStroke", when: PAINTING },
      { key: "mod+y", command: "annotations.redoStroke", when: PAINTING },
      { key: "escape", command: "annotations.stopDrawing", when: PAINTING },
    ],
  },
};
