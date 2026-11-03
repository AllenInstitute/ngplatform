/**
 * The tools, as WebKnossos's tool bar has them: Move (the views as
 * Neuroglancer moves them), and the tools that draw with the left button.
 * Pure: which tools there are, their keys, cycling through them, and the
 * brush's size steps.
 */

export type Tool = "move" | "brush" | "erase" | "fill" | "pick" | "quick";

export interface ToolInfo {
  id: Tool;
  title: string;
  /** The key that picks it (while a label volume is edited). */
  key: string;
  hint: string;
}

export const TOOLS: ToolInfo[] = [
  { id: "move", title: "Move", key: "M", hint: "Move the views: the left button drags, the wheel steps through sections, as Neuroglancer does" },
  { id: "brush", title: "Brush", key: "B", hint: "Paint the active segment; Alt+wheel or [ and ] change the size" },
  { id: "erase", title: "Erase", key: "E", hint: "Paint 0; Alt+wheel or [ and ] change the size" },
  { id: "fill", title: "Fill", key: "F", hint: "Fill the region clicked with the active segment, in its section (2-D) or a box round it (3-D)" },
  { id: "pick", title: "Pick segment", key: "I", hint: "The segment clicked becomes the active one" },
  { id: "quick", title: "Quick select", key: "Q", hint: "Drag a box round a structure in a 2-D view, or click it" },
];

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
