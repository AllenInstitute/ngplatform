/**
 * A colourmap editor over the image's histogram: the preset's stops where this image's values put
 * them (the host resolves its window and histogram matching), a handful of control points to drag
 * (left and right moves them, warping the stops between their neighbours; up and down their
 * opacity), a colour for each (double-click), points added (Ctrl-click) and removed (right-click),
 * and the whole map shifted and compressed about its middle. Kept per image, so each sample can be
 * tuned for itself.
 */
import { el } from "@ngplatform/sdk/dom";

export interface DataStop {
  value: number;
  color: number[];
  opacity: number;
  tissue?: string;
  specular?: number | null;
  roughness?: number | null;
}

/** A sample's tuning: the stops as edited (data values), and the map's shift (data units) and compression. */
export interface Tuning {
  stops?: DataStop[];
  shift: number;
  scale: number;
}

/** The stops' indices to give handles: where the tissue changes, its ends, and enough between for at most `max`. */
export function controlPoints(stops: DataStop[], max = 14): number[] {
  if (stops.length <= max) return stops.map((_, i) => i);
  const keep = new Set<number>([0, stops.length - 1]);
  for (let i = 1; i < stops.length; ++i) {
    if (stops[i].tissue !== stops[i - 1].tissue) {
      keep.add(i - 1);
      keep.add(i);
    }
    // Where opacity turns (a knee in the curve).
    if (i < stops.length - 1) {
      const a = stops[i].opacity - stops[i - 1].opacity, b = stops[i + 1].opacity - stops[i].opacity;
      if (Math.abs(a - b) > 0.15) keep.add(i);
    }
  }
  let out = [...keep].sort((a, b) => a - b);
  while (out.length > max) {
    // Drop the point whose neighbours are closest together.
    let best = 1, gap = Infinity;
    for (let k = 1; k < out.length - 1; ++k) {
      const g = stops[out[k + 1]].value - stops[out[k - 1]].value;
      if (g < gap) [best, gap] = [k, g];
    }
    out.splice(best, 1);
  }
  if (out.length < Math.min(max, 6)) {
    const step = (stops.length - 1) / (Math.min(max, 6) - 1);
    out = [...new Set([...out, ...Array.from({ length: Math.min(max, 6) }, (_, k) => Math.round(k * step))])].sort((a, b) => a - b);
  }
  return out;
}

/** The stops with the control point `k` (an index into stops) moved to `value`: those between its neighbouring control points follow, piecewise linearly. */
export function warp(stops: DataStop[], points: number[], k: number, value: number): DataStop[] {
  const j = points.indexOf(k);
  const lo = j > 0 ? stops[points[j - 1]].value : -Infinity, hi = j < points.length - 1 ? stops[points[j + 1]].value : Infinity;
  const v = Math.min(Math.max(value, lo + 1e-6), hi - 1e-6);
  const old = stops[k].value;
  return stops.map((s, i) => {
    if (i === k) return { ...s, value: v };
    if (j > 0 && i > points[j - 1] && i < k) return { ...s, value: lo + ((s.value - lo) * (v - lo)) / (old - lo || 1) };
    if (j < points.length - 1 && i > k && i < points[j + 1]) return { ...s, value: hi - ((hi - s.value) * (hi - v)) / (hi - old || 1) };
    if (j === 0 && i < k) return { ...s, value: s.value + (v - old) };
    if (j === points.length - 1 && i > k) return { ...s, value: s.value + (v - old) };
    return s;
  });
}

/** The stops with control point k's opacity (or colour) set: the stops between its neighbours change in proportion, most near it. */
export function reshape(stops: DataStop[], points: number[], k: number, change: { opacity?: number; color?: number[] }): DataStop[] {
  const j = points.indexOf(k);
  const a = j > 0 ? points[j - 1] : k, b = j < points.length - 1 ? points[j + 1] : k;
  const s0 = stops[k];
  return stops.map((s, i) => {
    if (i < a || i > b) return s;
    const w = i === k ? 1 : i < k ? (s.value - stops[a].value) / (s0.value - stops[a].value || 1) : (stops[b].value - s.value) / (stops[b].value - s0.value || 1);
    const out = { ...s };
    if (change.opacity !== undefined) out.opacity = Math.min(1, Math.max(0, s.opacity + w * (change.opacity - s0.opacity)));
    if (change.color) out.color = s.color.map((c, n) => Math.min(1, Math.max(0, c + w * (change.color![n] - s0.color[n]))));
    return out;
  });
}

/** The stops shifted (data units) and compressed (scale < 1 narrows) about `centre`. */
export function shifted(stops: DataStop[], shift: number, scale: number, centre: number): DataStop[] {
  if (shift === 0 && scale === 1) return stops;
  return stops.map((s) => ({ ...s, value: centre + (s.value - centre) * scale + shift }));
}

const hex = (c: number[]) => "#" + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export class ColourmapEditor {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private stops: DataStop[] = [];
  private points: number[] = [];
  private range: [number, number] = [0, 1];
  private counts: number[] = [];
  private hlo = 0;
  private hhi = 1;
  private drag: number | undefined;

  /** onChange: the stops as edited (data values), after each change. */
  constructor(private onChange: (stops: DataStop[]) => void) {
    this.canvas = el("canvas", { width: "420", height: "150", style: "width: 100%; cursor: crosshair; border: 1px solid #555; border-radius: 3px" }) as HTMLCanvasElement;
    this.element = el("div", {}, this.canvas);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", () => (this.drag = undefined));
    this.canvas.addEventListener("dblclick", (e) => this.recolour(e));
    this.canvas.addEventListener("contextmenu", (e) => this.remove(e));
  }

  /** Whether a point is being dragged (the page should not set the stops meanwhile). */
  get dragging(): boolean {
    return this.drag !== undefined;
  }

  /** The histogram (counts over [lo, hi]) and the stops (data values) to show. */
  set(hist: { lo: number; hi: number; counts: number[] } | undefined, stops: DataStop[]): void {
    if (this.dragging) return;
    this.stops = stops.map((s) => ({ ...s }));
    this.points = controlPoints(this.stops);
    if (hist) [this.counts, this.hlo, this.hhi] = [hist.counts, hist.lo, hist.hi];
    // Show from a little below the first stop that is not transparent to a little past the last stop.
    const vis = this.stops.filter((s) => s.opacity > 0.01);
    const a = (vis[0] ?? this.stops[0])?.value ?? this.hlo, b = this.stops[this.stops.length - 1]?.value ?? this.hhi;
    const pad = (b - a) * 0.12 || 1;
    this.range = [a - pad, b + pad];
    this.draw();
  }

  private x(v: number): number {
    return ((v - this.range[0]) / (this.range[1] - this.range[0])) * this.canvas.width;
  }
  private v(x: number): number {
    return this.range[0] + (x / this.canvas.width) * (this.range[1] - this.range[0]);
  }
  private y(o: number): number {
    return 10 + (1 - o) * (this.canvas.height - 40);
  }

  draw(): void {
    const g = this.canvas.getContext("2d")!;
    const W = this.canvas.width, H = this.canvas.height;
    g.fillStyle = "#1e1e1e";
    g.fillRect(0, 0, W, H);
    // The image's histogram (log counts), grey.
    if (this.counts.length) {
      const n = this.counts.length, top = Math.log1p(Math.max(...this.counts));
      g.fillStyle = "#5a5a5a";
      for (let i = 0; i < n; ++i) {
        const v0 = this.hlo + ((this.hhi - this.hlo) * i) / n, v1 = this.hlo + ((this.hhi - this.hlo) * (i + 1)) / n;
        const x0 = this.x(v0), x1 = this.x(v1);
        if (x1 < 0 || x0 > W) continue;
        const h = (Math.log1p(this.counts[i]) / top) * (H - 40);
        g.fillRect(x0, H - 30 - h, Math.max(1, x1 - x0), h);
      }
    }
    // The colourmap as a strip, and the opacity curve.
    for (let x = 0; x < W; ++x) {
      const c = this.at(this.v(x));
      g.fillStyle = hex(c.color.map((k) => Math.min(1, k * 1.6)));
      g.fillRect(x, H - 24, 1, 18);
    }
    g.strokeStyle = "#e8e8e8";
    g.lineWidth = 1.5;
    g.beginPath();
    this.stops.forEach((s, i) => (i ? g.lineTo(this.x(s.value), this.y(s.opacity)) : g.moveTo(this.x(s.value), this.y(s.opacity))));
    g.stroke();
    for (const k of this.points) {
      const s = this.stops[k];
      g.fillStyle = hex(s.color.map((c) => Math.min(1, c * 1.6)));
      g.strokeStyle = "#fff";
      g.beginPath();
      g.arc(this.x(s.value), this.y(s.opacity), 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }

  private at(v: number): { color: number[]; opacity: number } {
    const s = this.stops;
    if (!s.length) return { color: [0, 0, 0], opacity: 0 };
    if (v <= s[0].value) return { color: s[0].color, opacity: s[0].opacity };
    for (let i = 1; i < s.length; ++i)
      if (v <= s[i].value) {
        const t = (v - s[i - 1].value) / (s[i].value - s[i - 1].value || 1);
        return { color: s[i].color.map((c, n) => s[i - 1].color[n] + t * (c - s[i - 1].color[n])), opacity: s[i - 1].opacity + t * (s[i].opacity - s[i - 1].opacity) };
      }
    const l = s[s.length - 1];
    return { color: l.color, opacity: l.opacity };
  }

  private pos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.canvas.width, ((e.clientY - r.top) / r.height) * this.canvas.height];
  }

  private near(e: MouseEvent): number | undefined {
    const [x, y] = this.pos(e);
    let best: number | undefined, d = 9;
    for (const k of this.points) {
      const dd = Math.hypot(this.x(this.stops[k].value) - x, this.y(this.stops[k].opacity) - y);
      if (dd < d) [best, d] = [k, dd];
    }
    return best;
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const k = this.near(e);
    if (k !== undefined) {
      this.drag = k;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // A new point here, with the map's colour and opacity where it goes.
      const [x] = this.pos(e);
      const v = this.v(x), c = this.at(v);
      const i = this.stops.findIndex((s) => s.value > v);
      const at = i < 0 ? this.stops.length : i;
      const near = this.stops[Math.min(at, this.stops.length - 1)];
      this.stops.splice(at, 0, { ...near, value: v, color: c.color, opacity: c.opacity });
      this.points = [...new Set([...this.points.map((p) => (p >= at ? p + 1 : p)), at])].sort((a, b) => a - b);
      this.changed();
    }
  }

  private move(e: PointerEvent): void {
    if (this.drag === undefined) return;
    const [x, y] = this.pos(e);
    const k = this.drag;
    this.stops = warp(this.stops, this.points, k, this.v(x));
    const o = Math.min(1, Math.max(0, 1 - (y - 10) / (this.canvas.height - 40)));
    this.stops = reshape(this.stops, this.points, k, { opacity: o });
    this.changed();
  }

  private recolour(e: MouseEvent): void {
    const k = this.near(e);
    if (k === undefined) return;
    const input = el("input", { type: "color", value: hex(this.stops[k].color) }) as HTMLInputElement;
    input.oninput = () => {
      this.stops = reshape(this.stops, this.points, k, { color: unhex(input.value) });
      this.changed();
    };
    input.click();
  }

  private remove(e: MouseEvent): void {
    const k = this.near(e);
    if (k === undefined) return;
    e.preventDefault();
    if (this.stops.length <= 2) return;
    this.stops.splice(k, 1);
    this.points = this.points.filter((p) => p !== k).map((p) => (p > k ? p - 1 : p));
    this.changed();
  }

  private changed(): void {
    this.draw();
    this.onChange(this.stops.map((s) => ({ ...s })));
  }
}
