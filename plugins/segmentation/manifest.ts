/**
 * The Segmentation plugin's manifest: label volumes drawn by hand, as
 * WebKnossos's volume annotation, in a tab of their own with a tool bar
 * over the views.  It was the last section of the Annotations tab.
 */
import type { Manifest } from "@ngplatform/sdk";

export const SEGMENTATION_PANEL = "segmentation.panel";

/** Set while a label volume is edited: its tool bar shows, and the tools' keys work. */
export const EDITING = "segmentation.editing";
/** Set while a tool that draws (not Move) is on. */
export const DRAWING = "segmentation.drawing";
/** Set while the brush or the eraser is the tool. */
export const BRUSHING = "segmentation.brushing";

const tool = (key: string, id: string) => ({ key, command: "segmentation.tool", args: { tool: id }, when: EDITING });

export const SEGMENTATION_MANIFEST: Manifest = {
  id: "org.ngplatform.segmentation",
  name: "Segmentation",
  version: "0.1.0",
  kind: "tool",
  enabledByDefault: true,
  description: "Label volumes drawn by hand, as in WebKnossos: a new segmentation layer on an image's grid or a copy of a segmentation, a tool bar over the views (brush, erase, fill, pick, quick select), a segment list, undo, saving as NIfTI or OME-Zarr.",
  guide: `Label volumes drawn by hand, in the **Segmentation** tab, shown as a segmentation layer that updates as you draw.

## A new segmentation layer
- **On the grid of** an image, at one of its levels (the same voxels and placement), empty; 8, 16 or 32 bits.
- Or on the grid of a **segmentation** layer, as a copy of its labels to edit (the original is hidden; it is not changed).
- **Open NIfTI…** reads a label image from this computer to edit.

## The tool bar
While a label volume is edited, a tool bar shows at the top of the views:
- **Move** (\`M\`): the views as usual. **Brush** (\`B\`) and **Erase** (\`E\`): the left button paints the active segment, or 0; a ring shows the brush; **Alt+wheel** or \`[\` \`]\` change its size. **Fill** (\`F\`): the region clicked, in its section (2-D) or in a box round it (3-D, \`Shift+F\`). **Pick segment** (\`I\`). **Quick select** (\`Q\`): drag a box round a structure, or click it.
- \`W\` and \`Shift+W\` step through the tools; hold **Space** to move the view with the left button while a drawing tool is on; \`Escape\` goes back to Move.
- **New segment** (\`C\`), the active segment's colour and name; **Undo** and **Redo** (\`Ctrl+Z\`, \`Ctrl+Y\`: strokes and workspace changes as one history); **Interpolate** (\`V\`) fills the sections between two where the segment is drawn; **Save**.

## Segments
Each segment's colour, name, voxels and volume; the active one is marked. Click one to paint with it; the eye shows or hides it; **Go to** moves the views to it; **Merge** gives its voxels to the active segment; **Delete** erases it. All undoable.

## Saving
NIfTI (.nii.gz) or an OME-Zarr folder (only painted chunks written), the whole grid or only the painted box. A label volume lives in this page until saved; it is also kept in this browser while you draw, so a reload brings it back.`,
  links: [{ title: "WebKnossos volume annotation (what this follows)", url: "https://docs.webknossos.org/webknossos/volume_annotation/index.html" }],
  license: "Apache-2.0",
  activation: ["onStartup"],
  provides: { services: ["segmentation.quickSelect", "segmentation.labelVolumes"] },
  contributes: {
    panels: [{ id: SEGMENTATION_PANEL, title: "Segmentation", slot: "left", order: 61 }],
    contextKeys: [EDITING, DRAWING, BRUSHING],
    commands: [
      { id: "segmentation.newLayer", title: "New segmentation layer", group: "Segmentation" },
      { id: "segmentation.openNifti", title: "Open a NIfTI label image to edit", group: "Segmentation" },
      { id: "segmentation.save", title: "Save the label volume", group: "Segmentation" },
      { id: "segmentation.tool", title: "Segmentation tool", group: "Segmentation", args: { type: "object", properties: { tool: { type: "string" }, fill3d: { type: "boolean" } }, required: ["tool"] } },
      { id: "segmentation.cycleTool", title: "Next segmentation tool", group: "Segmentation", args: { type: "object", properties: { step: { type: "number", default: 1 } } }, when: EDITING },
      { id: "segmentation.brushSize", title: "Brush size", group: "Segmentation", args: { type: "object", properties: { notches: { type: "number", default: 1 } } } },
      { id: "segmentation.newSegment", title: "New segment", group: "Segmentation", when: EDITING },
      { id: "segmentation.interpolate", title: "Interpolate the segment between drawn sections", group: "Segmentation", when: EDITING },
      { id: "segmentation.undo", title: "Undo the last stroke or workspace change, whichever came last", group: "Segmentation", when: EDITING },
      { id: "segmentation.redo", title: "Redo a stroke or workspace change, in the order undone", group: "Segmentation", when: EDITING },
      { id: "segmentation.stopEditing", title: "Stop editing the label volume (hide the tool bar)", group: "Segmentation", when: EDITING },
    ],
    keybindings: [
      tool("m", "move"),
      tool("b", "brush"),
      tool("e", "erase"),
      { key: "f", command: "segmentation.tool", args: { tool: "fill", fill3d: false }, when: EDITING },
      { key: "shift+f", command: "segmentation.tool", args: { tool: "fill", fill3d: true }, when: EDITING },
      tool("i", "pick"),
      tool("q", "quick"),
      { key: "escape", command: "segmentation.tool", args: { tool: "move" }, when: DRAWING },
      { key: "w", command: "segmentation.cycleTool", args: { step: 1 }, when: EDITING },
      { key: "shift+w", command: "segmentation.cycleTool", args: { step: -1 }, when: EDITING },
      { key: "c", command: "segmentation.newSegment", when: EDITING },
      { key: "v", command: "segmentation.interpolate", when: EDITING },
      { key: "]", command: "segmentation.brushSize", args: { notches: 1 }, when: BRUSHING },
      { key: "[", command: "segmentation.brushSize", args: { notches: -1 }, when: BRUSHING },
      { key: "mod+z", command: "segmentation.undo", when: EDITING },
      { key: "mod+y", command: "segmentation.redo", when: EDITING },
      { key: "mod+shift+z", command: "segmentation.redo", when: EDITING },
    ],
  },
};
