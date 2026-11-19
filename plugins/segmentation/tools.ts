/**
 * The tools, as WebKnossos's tool bar has them: Move (the views as
 * Neuroglancer moves them), and the tools that draw with the left button.
 * Pure: which tools there are, their keys, cycling through them, and the
 * brush's size steps.
 */

export type Tool = "move" | "brush" | "erase" | "lasso" | "fill" | "pick" | "quick" | "ai";

export interface ToolInfo {
  id: Tool;
  /** Drawing by hand (and threshold selection), or segmenting with a model. */
  group: "draw" | "ai";
  title: string;
  /** The key that picks it (while a label volume is edited). */
  key: string;
  hint: string;
}

export const TOOLS: ToolInfo[] = [
  { id: "move", group: "draw", title: "Move", key: "M", hint: "Move the views: the left button drags, the wheel steps through sections, as Neuroglancer does" },
  { id: "brush", group: "draw", title: "Brush", key: "B", hint: "Paint the active segment; Alt+wheel or [ and ] change the size" },
  { id: "erase", group: "draw", title: "Erase", key: "E", hint: "Paint 0; Alt+wheel or [ and ] change the size" },
  { id: "lasso", group: "draw", title: "Lasso", key: "L", hint: "Draw a closed outline in a 2-D view: inside it is painted with the active segment (or erased), in that section" },
  { id: "fill", group: "draw", title: "Fill", key: "F", hint: "Fill the region clicked with the active segment, in its section (2-D) or a box round it (3-D)" },
  { id: "pick", group: "draw", title: "Pick segment", key: "I", hint: "The segment clicked becomes the active one" },
  { id: "quick", group: "draw", title: "Quick select", key: "Q", hint: "Drag a box round a structure in a 2-D view, or click it: by threshold" },
  { id: "ai", group: "ai", title: "AI segment", key: "A", hint: "Segment with a model: a box or clicks in a 2-D view; a section, a section tracked through the volume, or 3-D at once" },
];

/** Whether a tool proposes a mask from a box or clicks (quick select, or a model's). */
export const selects = (tool: Tool): boolean => tool === "quick" || tool === "ai";

/** Whether a tool takes the left button in the views. */
export const draws = (tool: Tool): boolean => tool !== "move";

/** Whether a tool has a brush (a size, an outline in the views). */
export const brushes = (tool: Tool): boolean => tool === "brush" || tool === "erase";

/** The tool `step` places after (or, negative, before) this one, round the bar (W and Shift+W). */
export function cycle(tool: Tool, step: number): Tool {
  const i = TOOLS.findIndex((t) => t.id === tool);
  const n = TOOLS.length;
  return TOOLS[(((i + step) % n) + n) % n].id;
}

/** Smallest and largest brush radius, in its unit. */
export const MIN_RADIUS = 0.01;
export const MAX_RADIUS = 1000;

/**
 * The brush's radius after `notches` steps of the wheel (or [ and ]): each a
 * quarter larger or smaller, kept to three significant figures; in voxels,
 * whole voxels from 1 up, always moving by at least one.
 */
export function stepRadius(radius: number, notches: number, unit: "mm" | "µm" | "voxels"): number {
  if (notches === 0) return radius;
  if (unit === "voxels") {
    let r = radius;
    for (let i = 0; i < Math.abs(notches); ++i) r = notches > 0 ? Math.max(r + 1, Math.round(r * 1.25)) : Math.min(r - 1, Math.round(r * 0.8));
    return Math.max(1, Math.min(MAX_RADIUS, r));
  }
  const r = radius * 1.25 ** notches;
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Number(r.toPrecision(3))));
}
