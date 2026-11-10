/**
 * Quick select's proposed mask, shown over the 2-D views before it is
 * painted (as WebKnossos previews it): the voxels selected tinted in the
 * active segment's colour, their outline drawn solid.  Enter (or Accept on
 * the tool bar) paints it; Escape (or Cancel) drops it.
 *
 * The mask is drawn on a canvas over the views, each 2-D view showing the
 * mask's section it cuts (the section along the voxel axis nearest the
 * view's normal, at the view's position): the section is a small image, a
 * pixel a voxel, placed with the screen's affine map of its voxels (from
 * the view's own projection), so it follows panning, zooming and rotation.
 *
 * A model method's clicks show too, in the views showing their section:
 * a green dot with + for what is wanted, a red one with − for what is not.
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { type Placement, toGlobal, toVoxel } from "../annotations/geometry.js";
import { type Vec3, voxelIndex } from "./kernels.js";
import type { Mask } from "./quick_select.js";

/** A section of a mask: `width` × `height` pixels along voxel axes `u` and `w`, 0 outside, 1 inside, 2 on its outline. */
export interface MaskSection {
  u: number;
  w: number;
  width: number;
  height: number;
  data: Uint8Array;
}

/** The section of a mask at voxel `index` along `axis`; undefined when the mask does not reach it or selects nothing there. */
export function maskSection(mask: Mask, axis: number, index: number): MaskSection | undefined {
  const at = index - mask.lo[axis];
  if (at < 0 || at >= mask.size[axis]) return undefined;
  const [u, w] = [0, 1, 2].filter((k) => k !== axis);
  const width = mask.size[u];
  const height = mask.size[w];
  const stride = [1, mask.size[0], mask.size[0] * mask.size[1]];
  const get = (i: number, j: number) => (i < 0 || j < 0 || i >= width || j >= height ? 0 : mask.data[i * stride[u] + j * stride[w] + at * stride[axis]]);
  const data = new Uint8Array(width * height);
  let any = false;
  for (let j = 0; j < height; ++j) {
    for (let i = 0; i < width; ++i) {
      if (!get(i, j)) continue;
      any = true;
      data[i + width * j] = get(i - 1, j) && get(i + 1, j) && get(i, j - 1) && get(i, j + 1) ? 1 : 2;
    }
  }
  return any ? { u, w, width, height, data } : undefined;
}

/** How many voxels a mask selects. */
export function maskCount(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; ++i) if (mask.data[i]) ++n;
  return n;
}

/** Clicks given to quick select in one section (along `axis`, at `index`): wanted or not. */
export interface PromptPoints {
  axis: number;
  index: number;
  points: { at: Vec3; positive: boolean }[];
}

export interface PreviewSource {
  /** The mask proposed (if any), the clicks given (if any), the grid they are on, and the colour to show the mask in; undefined for none. */
  preview(): { mask?: Mask; points?: PromptPoints; placement: Placement; colour: string } | undefined;
}

export class PreviewOverlay {
  private readonly overlay: { element: HTMLElement; dispose(): void };
  private readonly canvas: HTMLCanvasElement;
  private readonly offs: Disposer[] = [];
  /** The last mask drawn into `images`, and its sections' images by axis and index. */
  private drawn: { mask: Mask; colour: string } | undefined;
  private readonly images = new Map<string, HTMLCanvasElement | null>();

  constructor(
    private readonly ctx: PlatformContext,
    private readonly source: PreviewSource,
  ) {
    this.overlay = ctx.ui.overlay();
    this.canvas = document.createElement("canvas");
    this.canvas.className = "sg-preview";
    this.canvas.hidden = true;
    this.overlay.element.append(this.canvas);
    this.offs.push(ctx.viewer.onRendered(() => this.draw()));
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.overlay.dispose();
  }

  /** Draws the mask again (after it changed, or the views moved). */
  draw(): void {
    const shown = this.source.preview();
    if (shown === undefined && this.canvas.hidden) return;
    const base = this.overlay.element.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const c = this.canvas;
    const width = Math.round(base.width * ratio);
    const height = Math.round(base.height * ratio);
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
      c.style.width = `${base.width}px`;
      c.style.height = `${base.height}px`;
    }
    const g = c.getContext("2d");
    if (g === null) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, width, height);
    c.hidden = shown === undefined;
    if (shown === undefined) {
      this.drawn = undefined;
      this.images.clear();
      return;
    }
    if (this.drawn?.mask !== shown.mask || this.drawn?.colour !== shown.colour) {
      this.drawn = shown.mask && { mask: shown.mask, colour: shown.colour };
      this.images.clear();
    }
    const position = (this.ctx.viewer.getState() as { position?: number[] }).position;
    if (position === undefined) return;
    const { mask, placement, points } = shown;
    const centre = mask ? (mask.lo.map((v, k) => v + (mask.size[k] - 1) / 2) as Vec3) : points?.points[0]?.at;
    if (centre === undefined) return;
    for (const panel of this.ctx.viewer.panels()) {
      if (panel.kind !== "2d") continue;
      const project = (v: Vec3) => panel.project(toGlobal(placement, v, position));
      // The voxel axis across the view: the one whose step moves the depth most.
      const p0 = project(centre);
      if (p0 === undefined) continue;
      const depth = [0, 1, 2].map((k) => {
        const p = project(centre.map((v, i) => (i === k ? v + 1 : v)) as Vec3);
        return p === undefined ? 0 : Math.abs(p.depth - p0.depth);
      });
      const axis = depth.indexOf(Math.max(...depth));
      const index = voxelIndex(toVoxel(placement, position)[axis]);
      const r = panel.element.getBoundingClientRect();
      if (points !== undefined && points.axis === axis && points.index === index) this.drawPoints(g, ratio, r.left - base.left, r.top - base.top, r, points, project);
      if (mask === undefined) continue;
      const image = this.image(mask, axis, index, shown.colour);
      if (image === null) continue;
      const [u, w] = [0, 1, 2].filter((k) => k !== axis);
      // The section's corner, and a voxel's step along u and w, on the screen.
      const corner = [0, 0, 0] as Vec3;
      corner[axis] = index;
      corner[u] = mask.lo[u] - 0.5;
      corner[w] = mask.lo[w] - 0.5;
      const o = project(corner);
      const pu = project(corner.map((v, i) => (i === u ? v + 1 : v)) as Vec3);
      const pw = project(corner.map((v, i) => (i === w ? v + 1 : v)) as Vec3);
      if (o === undefined || pu === undefined || pw === undefined) continue;
      g.save();
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.beginPath();
      g.rect(r.left - base.left, r.top - base.top, r.width, r.height);
      g.clip();
      g.setTransform(ratio * (pu.x - o.x), ratio * (pu.y - o.y), ratio * (pw.x - o.x), ratio * (pw.y - o.y), ratio * (o.x + r.left - base.left), ratio * (o.y + r.top - base.top));
      g.imageSmoothingEnabled = false;
      g.drawImage(image, 0, 0);
      g.restore();
    }
  }

  /** Clicks as dots over a view (offset `x`, `y` in the overlay): the app's "on" colour with + wanted, its error colour with − not. */
  private drawPoints(g: CanvasRenderingContext2D, ratio: number, x: number, y: number, r: DOMRect, points: PromptPoints, project: (v: Vec3) => { x: number; y: number } | undefined): void {
    const wanted = token("--on", "#3f9f48");
    const unwanted = token("--err", "#e0716b");
    const edge = token("--text-strong", "#fff");
    g.save();
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.beginPath();
    g.rect(x, y, r.width, r.height);
    g.clip();
    for (const p of points.points) {
      const s = project(p.at);
      if (s === undefined) continue;
      const cx = x + s.x;
      const cy = y + s.y;
      g.beginPath();
      g.arc(cx, cy, 6, 0, 2 * Math.PI);
      g.fillStyle = p.positive ? wanted : unwanted;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = edge;
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 3, cy);
      g.lineTo(cx + 3, cy);
      if (p.positive) {
        g.moveTo(cx, cy - 3);
        g.lineTo(cx, cy + 3);
      }
      g.stroke();
    }
    g.restore();
  }

  /** A section's image, a pixel a voxel: tinted inside, solid on the outline; null where the mask has nothing. */
  private image(mask: Mask, axis: number, index: number, colour: string): HTMLCanvasElement | null {
    const key = `${axis}/${index}`;
    let image = this.images.get(key);
    if (image !== undefined) return image;
    const section = maskSection(mask, axis, index);
    image = null;
    if (section !== undefined) {
      image = document.createElement("canvas");
      image.width = section.width;
      image.height = section.height;
      const g = image.getContext("2d")!;
      const pixels = g.createImageData(section.width, section.height);
      const [r, gr, b] = rgb(colour);
      for (let i = 0; i < section.data.length; ++i) {
        const v = section.data[i];
        if (v === 0) continue;
        pixels.data.set([r, gr, b, v === 2 ? 255 : 110], 4 * i);
      }
      g.putImageData(pixels, 0, 0);
    }
    this.images.set(key, image);
    return image;
  }
}

/** A #rrggbb colour as numbers. */
/** One of the app's colour tokens as the page has it (`fallback` before its stylesheet is there): a canvas cannot read CSS variables. */
function token(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function rgb(colour: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(colour);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 209, 102];
}
