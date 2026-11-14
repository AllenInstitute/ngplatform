/**
 * Labels with leader lines in the 3-D view: every point annotation with a
 * description, in the scene's visible annotation layers (those kept in the
 * state), named at the view's left and right sides with a thin line to its
 * point, placed so none overlap (./placement.ts).  Drawn on a canvas over
 * the view, and painted into screenshots, since a figure wants them.
 *
 * Points hidden behind tissue are not greyed: telling would need the 3-D
 * view's depth read back from the GPU each frame.
 */
import type { Json, LayerTransform, PlatformContext } from "@ngplatform/sdk";
import { type LabelPoint, placeLabels } from "./placement.js";

const FONT = `500 12px "Source Sans 3", system-ui, sans-serif`;
const LABEL_HEIGHT = 18;
const ROW = LABEL_HEIGHT + 4;
const PAD_X = 4;
const INSET = 8;

/** A labelled point: its text and global position. */
export interface LabelledPoint {
  text: string;
  position: number[];
}

/** The space of the state's `dimensions`. */
interface Space {
  names: string[];
  scales: number[];
  units: string[];
}

const mmOf = (scale: number, unit: string) => (unit === "m" ? scale * 1e3 : scale);

/**
 * An annotation layer's coordinates to global ones, through its transform
 * (as the Annotations plugin places them); taken as global when no
 * transform is known.
 */
export function toGlobal(t: LayerTransform | undefined, space: Space, rank: number): (p: ArrayLike<number>) => number[] {
  if (t === undefined || t.rank !== rank || t.matrix.length !== (rank + 1) * (rank + 1)) return (p) => space.names.map((_, i) => (i < p.length ? p[i] : NaN));
  const m = t.matrix;
  const target = t.output.names.map((n) => space.names.indexOf(n));
  const ratio = t.output.names.map((_, r) => (target[r] < 0 ? 1 : mmOf(t.output.scales[r], t.output.units[r]) / mmOf(space.scales[target[r]], space.units[target[r]])));
  const scale = (c: number, r: number) => (t.input.scales[c] > 0 && t.output.scales[r] > 0 ? t.input.scales[c] / t.output.scales[r] : 1);
  return (p) => {
    const out = space.names.map(() => NaN);
    for (let r = 0; r < rank; ++r) {
      const g = target[r];
      if (g < 0) continue;
      let v = m[rank * (rank + 1) + r];
      for (let c = 0; c < rank; ++c) v += m[c * (rank + 1) + r] * scale(c, r) * p[c];
      out[g] = v * ratio[r];
    }
    return out;
  };
}

/** The point annotations with a description in a state's visible annotation layers. */
export function describedPoints(layers: readonly Json[]): { layer: string; text: string; point: number[] }[] {
  const out: { layer: string; text: string; point: number[] }[] = [];
  for (const layer of layers) {
    if (layer.type !== "annotation" || layer.visible === false || layer.archived === true || !Array.isArray(layer.annotations)) continue;
    for (const a of layer.annotations as Json[]) {
      const text = typeof a.description === "string" ? a.description.trim() : "";
      if (a.type !== "point" || text === "" || !Array.isArray(a.point)) continue;
      out.push({ layer: String(layer.name), text: text.split("\n")[0], point: a.point as number[] });
    }
  }
  return out;
}

/** What a frame's labels are, laid out in a view (CSS pixels from its top left). */
interface Laid {
  text: string;
  x: number;
  y: number;
  side: "left" | "right";
  labelY: number;
}

export class PointLabels {
  readonly canvas: HTMLCanvasElement;
  private points: LabelledPoint[] = [];
  private known = "";
  private widths = new Map<string, number>();
  private laid: Laid[] = [];
  private size = { width: 0, height: 0 };

  constructor(private readonly ctx: PlatformContext) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "view-aids-labels";
  }

  /** Reads the labelled points again when a layer or the dimensions changed. */
  private read(): void {
    const generation = this.ctx.viewer.layersGeneration?.();
    const dimensions = this.ctx.viewer.statePart?.("dimensions");
    const key = JSON.stringify([generation ?? Math.random(), dimensions ?? null]);
    if (key === this.known) return;
    this.known = key;
    const ng = this.ctx.viewer.getState() as { layers?: Json[]; dimensions?: Record<string, [number, string]> };
    const entries = Object.entries(ng.dimensions ?? {});
    const space: Space = { names: entries.map(([n]) => n), scales: entries.map(([, [s]]) => s), units: entries.map(([, [, u]]) => u) };
    const transforms = new Map<string, (p: ArrayLike<number>) => number[]>();
    this.points = describedPoints(ng.layers ?? []).map(({ layer, text, point }) => {
      const key = `${layer}|${point.length}`;
      let map = transforms.get(key);
      if (map === undefined) {
        map = toGlobal(this.ctx.viewer.layerTransform(layer), space, point.length);
        transforms.set(key, map);
      }
      return { text, position: map(point) };
    });
  }

  /** The labels' widths, measured once each. */
  private width(text: string): number {
    let w = this.widths.get(text);
    if (w === undefined) {
      const context = this.canvas.getContext("2d");
      if (context === null) return text.length * 6;
      context.font = FONT;
      w = context.measureText(text).width + 2 * PAD_X;
      this.widths.set(text, w);
    }
    return w;
  }

  /**
   * Lays the labels out over the 3-D panel (`project`: its projection) and
   * draws them; `reserve` keeps the top (Neuroglancer's axis names), the
   * right side's top (the cube) and the bottom (the switches) clear.
   */
  update(project: (p: number[]) => { x: number; y: number; depth: number } | undefined, width: number, height: number, reserve: { top: number; rightTop: number; bottom: number }): void {
    this.read();
    const shown: (LabelPoint & { text: string })[] = [];
    for (const p of this.points) {
      const at = project(p.position);
      if (at === undefined || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
      if (at.x < 0 || at.y < 0 || at.x > width || at.y > height || Math.abs(at.depth) > 1) continue;
      shown.push({ ...at, text: p.text, width: Math.min(this.width(p.text), Math.max(60, width * 0.4)) });
    }
    const placed = width < 160 || height < 80 ? [] : placeLabels(shown, { width, height }, { height: ROW, inset: INSET, top: reserve.top + LABEL_HEIGHT / 2, bottom: height - reserve.bottom - LABEL_HEIGHT / 2, rightTop: reserve.rightTop + LABEL_HEIGHT / 2 });
    const was = this.laid.length;
    this.laid = placed.map(({ index, side, y }) => ({ text: shown[index].text, x: shown[index].x, y: shown[index].y, side, labelY: y }));
    this.size = { width, height };
    // Nothing drawn before or now: the canvas is clear already.
    if (was === 0 && this.laid.length === 0) return;
    const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const context = this.canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, w, h);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(context);
  }

  clear(): void {
    this.laid = [];
    this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draws the labels as last laid out, in the view's CSS pixels (the context set to them). */
  draw(context: CanvasRenderingContext2D): void {
    const maxWidth = Math.max(60, this.size.width * 0.4);
    context.font = FONT;
    context.textBaseline = "middle";
    for (const label of this.laid) {
      let text = label.text;
      let w = this.width(text);
      while (w > maxWidth && text.length > 2) {
        text = text.slice(0, -2) + "…";
        w = context.measureText(text).width + 2 * PAD_X;
      }
      const left = label.side === "left" ? INSET : this.size.width - INSET - w;
      const top = label.labelY - LABEL_HEIGHT / 2;
      const endX = label.side === "left" ? left + w : left;
      // The leader line, then the dot on the point, then the label.
      context.strokeStyle = "rgba(208, 208, 208, 0.85)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(label.x, label.y);
      context.lineTo(endX, label.labelY);
      context.stroke();
      context.beginPath();
      context.arc(label.x, label.y, 2.5, 0, 2 * Math.PI);
      context.fillStyle = "#e6e6e6";
      context.fill();
      context.strokeStyle = "#000";
      context.stroke();
      context.fillStyle = "rgba(0, 0, 0, 0.6)";
      context.fillRect(left, top, w, LABEL_HEIGHT);
      context.fillStyle = "#e6e6e6";
      context.fillText(text, left + PAD_X, label.labelY + 0.5);
    }
  }

  /** Paints the labels into a screenshot of Neuroglancer's canvas (its pixels), where the view is `panel`. */
  paint(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, panel: DOMRect): void {
    if (this.laid.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, rect.width);
    context.save();
    context.translate((panel.left - rect.left) * scale, (panel.top - rect.top) * scale);
    context.scale(scale, scale);
    this.draw(context);
    context.restore();
  }
}
