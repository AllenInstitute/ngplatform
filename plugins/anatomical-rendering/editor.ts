/**
 * A colourmap editor over the image's histogram: the preset's stops where this image's values put
 * them (the host resolves its window and histogram matching), a handful of control points to drag
 * (left and right moves them, warping the stops between their neighbours; up and down their
 * opacity), a colour for each (double-click), points added (Ctrl-click) and removed (right-click).
 * Kept per image, so each sample can be tuned for itself.
 *
 * From the top: the histogram (log counts) with the opacity curve and its points over it; a strip
 * of the image's own grey values (black at its lowest value, white at its highest), which moves
 * with the histogram; and the colourmap as a bar (its colours, a checker where it is clear), which
 * moves with the map. Each is moved and compressed in place:
 * - the colourmap: drag its bar to move it, drag an end of the bar to compress or stretch it (the
 *   other end stays), or turn the wheel over it;
 * - the histogram: drag it (where there is no point) to slide it under the map, Shift-drag or turn
 *   the wheel over it to compress or stretch it about the pointer; its blue triangles warp it.
 * Ctrl-wheel zooms the view (nothing else changes) and a double-click on empty space fits it to
 * the map or to the whole histogram, in turn. The wheel compresses only once the editor has been
 * clicked, so scrolling the panel past it changes nothing. With the keyboard: ← and → move the
 * map, + and − compress it, 0 fits the view.
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

/** A point of the histogram's warp: the image's value `from` goes to `to` on the colourmap's axis. */
export interface WarpPoint {
  from: number;
  to: number;
}

/** A sample's tuning: the stops as edited (data values), the map's shift (data units) and compression, and the histogram's warp. */
export interface Tuning {
  stops?: DataStop[];
  shift: number;
  scale: number;
  warp?: WarpPoint[];
}

/** The map as the editor places it: its stops before shift and compression, the middle it is compressed about, the shift and the compression. */
export interface MapPlacement {
  base: DataStop[];
  centre: number;
  shift: number;
  scale: number;
}

/** An image value on the colourmap's axis: piecewise linear through the warp's points; past them, at the slope of the whole warp (first to last point). */
export function warpForward(v: number, warp: WarpPoint[] | undefined): number {
  if (!warp || warp.length === 0) return v;
  const w = [...warp].sort((a, b) => a.from - b.from);
  const first = w[0], last = w[w.length - 1];
  const slope = w.length > 1 && last.from > first.from && last.to > first.to ? (last.to - first.to) / (last.from - first.from) : 1;
  if (v <= first.from) return first.to + (v - first.from) * slope;
  for (let i = 1; i < w.length; ++i)
    if (v <= w[i].from) return w[i - 1].to + ((v - w[i - 1].from) * (w[i].to - w[i - 1].to)) / (w[i].from - w[i - 1].from || 1);
  return last.to + (v - last.from) * slope;
}

/** The image value that goes to `x` on the colourmap's axis (warpForward's inverse). */
export function warpInverse(x: number, warp: WarpPoint[] | undefined): number {
  return warpForward(x, warp?.map((p) => ({ from: p.to, to: p.from })));
}

/** The histogram slid along the colourmap's axis by `by`. */
export function slideWarp(warp: WarpPoint[], by: number): WarpPoint[] {
  return warp.map((p) => ({ from: p.from, to: p.to + by }));
}

/** The histogram compressed (factor < 1) or stretched about `about` on the colourmap's axis. */
export function compressWarp(warp: WarpPoint[], about: number, factor: number): WarpPoint[] {
  return warp.map((p) => ({ from: p.from, to: about + (p.to - about) * factor }));
}

/** Where the histogram's warp is held: the image values at these fractions of the counts between lo and hi. */
export function histogramHandles(hist: { lo: number; hi: number; counts: number[] }, lo: number, hi: number, qs = [0.1, 0.3, 0.5, 0.7, 0.9]): number[] {
  const n = hist.counts.length, w = (hist.hi - hist.lo) / n;
  const bins = hist.counts.map((c, i) => ({ v: hist.lo + (i + 0.5) * w, c })).filter((b) => b.v >= lo && b.v <= hi);
  const total = bins.reduce((a, b) => a + b.c, 0);
  if (!total) return qs.map((q) => lo + q * (hi - lo));
  let acc = 0, k = 0;
  const out: number[] = [];
  for (const b of bins) {
    acc += b.c;
    while (k < qs.length && acc / total >= qs[k]) {
      out.push(b.v);
      ++k;
    }
  }
  while (out.length < qs.length) out.push(hi);
  return out.map((v, i) => (i > 0 && v <= out[i - 1] ? out[i - 1] + (hi - lo) * 1e-3 : v));
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

/** The values of the map's visible part (opacity above 1%), first and last; the whole map where none is. */
export function visibleEnds(stops: DataStop[]): [number, number] {
  const vis = stops.filter((s) => s.opacity > 0.01);
  const use = vis.length ? vis : stops;
  return use.length ? [use[0].value, use[use.length - 1].value] : [0, 1];
}

/** The compression that keeps the map's scale within this many times either way of its preset's. */
const SCALE_LIMIT = 40;
const clampScale = (s: number) => Math.min(SCALE_LIMIT, Math.max(1 / SCALE_LIMIT, s));

/** The map's shift and compression with one end of its visible part (0: the low end) dragged to `to`, the other end where it is. */
export function stretchMap(m: MapPlacement, end: 0 | 1, to: number): { shift: number; scale: number } {
  const [a, b] = visibleEnds(m.base);
  if (b <= a) return { shift: m.shift, scale: m.scale };
  const place = (v: number) => m.centre + (v - m.centre) * m.scale + m.shift;
  const [A, B] = [place(a), place(b)];
  // The end may not pass the other: at least a 50th of the map's width apart.
  const min = ((B - A) / m.scale) * (1 / SCALE_LIMIT);
  if (end === 1) {
    const scale = clampScale((Math.max(to, A + min) - A) / (b - a));
    return { scale, shift: A - m.centre - (a - m.centre) * scale };
  }
  const scale = clampScale((B - Math.min(to, B - min)) / (b - a));
  return { scale, shift: B - m.centre - (b - m.centre) * scale };
}

/** The map's shift and compression with the map compressed (factor < 1) or stretched about `about`. */
export function compressMap(m: MapPlacement, about: number, factor: number): { shift: number; scale: number } {
  const scale = clampScale(m.scale * factor);
  const f = scale / m.scale;
  return { scale, shift: (m.centre + m.shift - about) * f + about - m.centre };
}

/**
 * The values the editor shows: the map's visible part and, with `all`, the whole histogram, else
 * the histogram's bulk (1% to 99.5% of its counts, leaving out a lone bin that holds most of them:
 * the background outside a scan's field), a margin either side; all on the colourmap's axis.
 */
export function fitView(map: DataStop[], hist: { lo: number; hi: number; counts: number[] } | undefined, warp: WarpPoint[], all: boolean): [number, number] {
  let [a, b] = map.length ? visibleEnds(map) : [Infinity, -Infinity];
  if (hist && hist.counts.length) {
    const n = hist.counts.length, w = (hist.hi - hist.lo) / n;
    let lo = hist.lo, hi = hist.hi;
    if (!all) {
      const counts = [...hist.counts];
      const sorted = [...counts].sort((x, y) => y - x);
      if (sorted.length > 1 && sorted[0] > 4 * sorted[1]) counts[counts.indexOf(sorted[0])] = 0;
      const total = counts.reduce((x, y) => x + y, 0);
      if (total > 0) {
        let acc = 0, i0 = -1, i1 = n - 1;
        for (let i = 0; i < n; ++i) {
          acc += counts[i];
          if (i0 < 0 && acc >= 0.01 * total) i0 = i;
          if (acc >= 0.995 * total) {
            i1 = i;
            break;
          }
        }
        lo = hist.lo + Math.max(0, i0) * w;
        hi = hist.lo + (i1 + 1) * w;
      }
    }
    a = Math.min(a, warpForward(lo, warp));
    b = Math.max(b, warpForward(hi, warp));
  }
  if (!(b > a)) return Number.isFinite(a) ? [a - 1, a + 1] : [0, 1];
  const pad = (b - a) * 0.05;
  return [a - pad, b + pad];
}

/** A colour token of the app's stylesheet as the canvas reads it (`fallback` outside a styled page: tests). */
function token(e: Element, name: string, fallback: string): string {
  const v = typeof getComputedStyle === "function" ? getComputedStyle(e).getPropertyValue(name).trim() : "";
  return v || fallback;
}

const hex = (c: number[]) => "#" + c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/** A material colour as the bar shows it: brightened as light and exposure brighten it in the render. */
const shown = (c: number[]) => c.map((k) => Math.min(1, k * 1.6));

/** The canvas's height (CSS pixels) and its parts' rows. */
const HEIGHT = 176;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 122;
const GREY = [128, 138] as const;
const BAR = [144, 166] as const;
/** How near (CSS pixels) the pointer must be to take a point, a triangle or an end of the bar. */
const NEAR = 8;

type Drag =
  | { kind: "point"; k: number }
  | { kind: "warp"; i: number }
  | { kind: "map"; from: number; start: MapPlacement }
  | { kind: "end"; end: 0 | 1; start: MapPlacement }
  | { kind: "map-squeeze"; x0: number; about: number; start: MapPlacement }
  | { kind: "slide"; from: number; start: WarpPoint[] }
  | { kind: "squeeze"; x0: number; about: number; start: WarpPoint[] };

/** What the editor reports: each change while it is made (`final` false: shown and rendered, not kept) and once when it is done. */
export interface EditorEvents {
  /** The stops as edited, before the map's shift and compression. */
  stops(base: DataStop[], final: boolean): void;
  /** The map moved or compressed. */
  map(shift: number, scale: number, final: boolean): void;
  /** The histogram slid, compressed or warped under the map. */
  warp(warp: WarpPoint[], final: boolean): void;
}

export class ColourmapEditor {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private m: MapPlacement = { base: [], centre: 0, shift: 0, scale: 1 };
  /** The map placed: the stops shown. */
  private stops: DataStop[] = [];
  private points: number[] = [];
  private view: [number, number] | undefined;
  private fitAll = false;
  private key: string | undefined;
  private counts: number[] = [];
  private hlo = 0;
  private hhi = 1;
  private warpPoints: WarpPoint[] = [];
  private drag: Drag | undefined;
  /** Whether the drag has moved anything: a click alone (giving the editor the keyboard) keeps nothing. */
  private moved = false;
  /** A change by the wheel, kept once the wheel rests. */
  private wheelDone: ReturnType<typeof setTimeout> | undefined;
  private width = 420;

  constructor(private events: EditorEvents) {
    this.canvas = el("canvas", {
      class: "ar-editor",
      width: "420",
      height: String(HEIGHT),
      tabindex: "0",
      role: "img",
      "aria-label": "Colourmap over the image's histogram. Left and right arrows move the map, plus and minus compress it, 0 fits the view.",
    }) as HTMLCanvasElement;
    const hint = el(
      "div",
      { class: "ar-editor-hint" },
      "Drag the colour bar to move the map, its ends to compress it. Drag the histogram to slide it, Shift-drag to compress it. Ctrl-wheel zooms; double-click fits.",
    );
    this.element = el("div", { class: "ar-editor-box" }, this.canvas, hint);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", () => this.up());
    this.canvas.addEventListener("pointercancel", () => this.up());
    this.canvas.addEventListener("dblclick", (e) => this.doubleClick(e));
    this.canvas.addEventListener("contextmenu", (e) => this.remove(e));
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.canvas.addEventListener("keydown", (e) => this.key_(e));
    if (typeof ResizeObserver === "function") new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  /** Whether a change is being made (the page should not set the editor meanwhile). */
  get dragging(): boolean {
    return this.drag !== undefined || this.wheelDone !== undefined;
  }

  /**
   * The histogram (counts over [lo, hi], the bins' outer edges), the map and the histogram's warp to
   * show. The view is fitted when `key` (the image and preset) changes, else kept, so the map and the
   * histogram are seen to move as they are tuned.
   */
  set(hist: { lo: number; hi: number; counts: number[] } | undefined, map: MapPlacement, warp: WarpPoint[] = [], key = ""): void {
    if (this.dragging) return;
    this.warpPoints = warp.map((p) => ({ ...p }));
    this.m = { ...map, base: map.base.map((s) => ({ ...s })) };
    this.place();
    this.points = controlPoints(this.stops);
    if (hist) [this.counts, this.hlo, this.hhi] = [hist.counts, hist.lo, hist.hi];
    if (key !== this.key || this.view === undefined) {
      this.key = key;
      this.fitAll = false;
      this.fit();
    }
    this.draw();
  }

  private place(): void {
    this.stops = shifted(this.m.base, this.m.shift, this.m.scale, this.m.centre);
  }

  private hist(): { lo: number; hi: number; counts: number[] } | undefined {
    return this.counts.length ? { lo: this.hlo, hi: this.hhi, counts: this.counts } : undefined;
  }

  private fit(): void {
    this.view = fitView(this.stops, this.hist(), this.warpPoints, this.fitAll);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    if (!w) return;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    this.width = w;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(HEIGHT * dpr);
    this.draw();
  }

  private x(v: number): number {
    const [a, b] = this.view ?? [0, 1];
    return ((v - a) / (b - a || 1)) * this.width;
  }
  private v(x: number): number {
    const [a, b] = this.view ?? [0, 1];
    return a + (x / this.width) * (b - a);
  }
  private y(o: number): number {
    return PLOT_TOP + (1 - o) * (PLOT_BOTTOM - PLOT_TOP);
  }

  draw(): void {
    const g = this.canvas.getContext?.("2d");
    if (!g) return;
    const W = this.width;
    const c = this.canvas;
    const dpr = this.canvas.width / W || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = token(c, "--ink-1", "#0c0c0c");
    g.fillRect(0, 0, W, HEIGHT);
    const hist = this.hist();
    if (hist) {
      // The image's histogram (log counts, its tallest bar left out of the scale when it holds most
      // of the image: the background), through its warp: where each value falls on the map's axis.
      const n = hist.counts.length;
      const sorted = [...hist.counts].sort((a, b) => b - a);
      const top = Math.log1p(sorted.length > 1 && sorted[0] > 4 * sorted[1] ? sorted[1] : sorted[0]) || 1;
      g.fillStyle = token(c, "--plot", "#777");
      for (let i = 0; i < n; ++i) {
        const v0 = hist.lo + ((hist.hi - hist.lo) * i) / n, v1 = hist.lo + ((hist.hi - hist.lo) * (i + 1)) / n;
        const x0 = this.x(warpForward(v0, this.warpPoints)), x1 = this.x(warpForward(v1, this.warpPoints));
        if (x1 < 0 || x0 > W) continue;
        const h = Math.min(1, Math.log1p(hist.counts[i]) / top) * (PLOT_BOTTOM - PLOT_TOP);
        g.fillRect(x0, PLOT_BOTTOM - h, Math.max(1, x1 - x0), h);
      }
      // The image's own grey values, black to white over its range (nothing past it): the strip moves with the histogram.
      for (let x = 0; x < W; ++x) {
        const t = (warpInverse(this.v(x + 0.5), this.warpPoints) - hist.lo) / (hist.hi - hist.lo || 1);
        if (t < 0 || t > 1) continue;
        const k = Math.round(t * 255);
        g.fillStyle = `rgb(${k},${k},${k})`;
        g.fillRect(x, GREY[0], 1, GREY[1] - GREY[0]);
      }
    }
    // The colourmap as a bar: its colours, over a checker by their opacity (the checker where it is clear).
    const [bt, bb] = BAR;
    for (let x = 0; x < W; ++x) {
      const s = this.at(this.v(x + 0.5));
      for (let y = bt, row = 0; y < bb; y += 5, ++row) {
        const light = ((Math.floor(x / 5) + row) & 1) === 0;
        const back = light ? 0.24 : 0.12;
        const a = Math.min(1, s.opacity * 2);
        g.fillStyle = hex(shown(s.color).map((k) => back + (k - back) * a));
        g.fillRect(x, y, 1, Math.min(5, bb - y));
      }
    }
    // The bar's ends, to drag: the map's visible part.
    const [A, B] = visibleEnds(this.stops).map((v) => this.x(v));
    g.strokeStyle = token(c, "--text-strong", "#fff");
    g.lineWidth = 2;
    for (const [x, d] of [[A, 1], [B, -1]] as const) {
      g.beginPath();
      g.moveTo(x + 4 * d, bt - 3);
      g.lineTo(x, bt - 3);
      g.lineTo(x, bb + 3);
      g.lineTo(x + 4 * d, bb + 3);
      g.stroke();
    }
    // The opacity curve.
    g.strokeStyle = token(c, "--text", "#dedede");
    g.lineWidth = 1.5;
    g.beginPath();
    this.stops.forEach((s, i) => (i ? g.lineTo(this.x(s.value), this.y(s.opacity)) : g.moveTo(this.x(s.value), this.y(s.opacity))));
    g.stroke();
    // The histogram's warp handles: triangles at its foot, dragged left and right.
    g.fillStyle = token(c, "--dec-z", "#4f88dc");
    for (const p of this.warpPoints) {
      const x = this.x(p.to), y = PLOT_BOTTOM;
      g.beginPath();
      g.moveTo(x, y - 7);
      g.lineTo(x - 5, y + 2);
      g.lineTo(x + 5, y + 2);
      g.closePath();
      g.fill();
    }
    for (const k of this.points) {
      const s = this.stops[k];
      g.fillStyle = hex(shown(s.color));
      g.strokeStyle = token(c, "--text-strong", "#fff");
      g.lineWidth = 1.5;
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

  /** The pointer in CSS pixels of the canvas. */
  private pos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / (r.width || 1)) * this.width, ((e.clientY - r.top) / (r.height || 1)) * HEIGHT];
  }

  private nearPoint(x: number, y: number): number | undefined {
    let best: number | undefined, d = NEAR + 1;
    for (const k of this.points) {
      const dd = Math.hypot(this.x(this.stops[k].value) - x, this.y(this.stops[k].opacity) - y);
      if (dd < d) [best, d] = [k, dd];
    }
    return best;
  }

  /** What is under the pointer: a point, a warp triangle, an end of the bar, the bar, or the histogram. */
  private under(x: number, y: number): { kind: "point"; k: number } | { kind: "warp"; i: number } | { kind: "end"; end: 0 | 1 } | { kind: "bar" } | { kind: "histogram" } {
    if (y >= BAR[0] - 4) {
      const [A, B] = visibleEnds(this.stops).map((v) => this.x(v));
      const dA = Math.abs(x - A), dB = Math.abs(x - B);
      if (Math.min(dA, dB) <= NEAR) return { kind: "end", end: dA <= dB ? 0 : 1 };
      return { kind: "bar" };
    }
    const k = this.nearPoint(x, y);
    if (k !== undefined) return { kind: "point", k };
    if (y >= PLOT_BOTTOM - 10 && y <= GREY[0]) {
      let best = -1, d = NEAR;
      this.warpPoints.forEach((p, i) => {
        const dd = Math.abs(this.x(p.to) - x);
        if (dd < d) [best, d] = [i, dd];
      });
      if (best >= 0) return { kind: "warp", i: best };
    }
    return { kind: "histogram" };
  }

  /** The histogram's warp to slide or compress: its handles, else two points at the view's ends (the identity). */
  private warpToMove(): WarpPoint[] {
    if (this.warpPoints.length >= 2) return this.warpPoints.map((p) => ({ ...p }));
    const [a, b] = this.view ?? [0, 1];
    return [{ from: warpInverse(a, this.warpPoints), to: a }, { from: warpInverse(b, this.warpPoints), to: b }];
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.canvas.focus?.();
    const [x, y] = this.pos(e);
    const at = this.under(x, y);
    const start = { ...this.m };
    this.moved = false;
    if (at.kind === "point") this.drag = { kind: "point", k: at.k };
    else if (at.kind === "warp") this.drag = { kind: "warp", i: at.i };
    else if (at.kind === "end") this.drag = { kind: "end", end: at.end, start };
    else if (at.kind === "bar") this.drag = e.shiftKey ? { kind: "map-squeeze", x0: x, about: this.v(x), start } : { kind: "map", from: this.v(x), start };
    else if (e.ctrlKey || e.metaKey) {
      this.addPoint(this.v(x));
      return;
    } else {
      const start = this.warpToMove();
      this.drag = e.shiftKey ? { kind: "squeeze", x0: x, about: this.v(x), start } : { kind: "slide", from: this.v(x), start };
    }
    this.canvas.setPointerCapture?.(e.pointerId);
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.pos(e);
    const d = this.drag;
    if (d === undefined) {
      const at = this.under(x, y);
      this.canvas.style.cursor = at.kind === "point" ? "move" : at.kind === "warp" || at.kind === "end" ? "ew-resize" : "grab";
      return;
    }
    this.moved = true;
    if (d.kind === "point") {
      this.stops = warp(this.stops, this.points, d.k, this.v(x));
      const o = Math.min(1, Math.max(0, 1 - (y - PLOT_TOP) / (PLOT_BOTTOM - PLOT_TOP)));
      this.stops = reshape(this.stops, this.points, d.k, { opacity: o });
      this.m.base = this.unplaced(this.stops);
      this.draw();
      this.events.stops(this.m.base.map((s) => ({ ...s })), false);
    } else if (d.kind === "warp") {
      const i = d.i, w = this.warpPoints;
      const lo = i > 0 ? w[i - 1].to : -Infinity, hi = i < w.length - 1 ? w[i + 1].to : Infinity;
      const span = (this.view ?? [0, 1])[1] - (this.view ?? [0, 1])[0];
      w[i] = { ...w[i], to: Math.min(Math.max(this.v(x), lo + span * 1e-3), hi - span * 1e-3) };
      this.draw();
      this.events.warp(this.warpPoints.map((p) => ({ ...p })), false);
    } else if (d.kind === "slide" || d.kind === "squeeze") {
      this.warpPoints = d.kind === "slide" ? slideWarp(d.start, this.v(x) - d.from) : compressWarp(d.start, d.about, Math.exp((x - d.x0) / 120));
      this.draw();
      this.events.warp(this.warpPoints.map((p) => ({ ...p })), false);
    } else {
      const next =
        d.kind === "map" ? { shift: d.start.shift + this.v(x) - d.from, scale: d.start.scale }
        : d.kind === "end" ? stretchMap(d.start, d.end, this.v(x))
        : compressMap(d.start, d.about, Math.exp((x - d.x0) / 120));
      this.moveMap(next.shift, next.scale, false);
    }
  }

  private up(): void {
    const d = this.drag;
    this.drag = undefined;
    if (d === undefined || !this.moved) return;
    if (d.kind === "point") this.events.stops(this.m.base.map((s) => ({ ...s })), true);
    else if (d.kind === "warp" || d.kind === "slide" || d.kind === "squeeze") this.events.warp(this.warpPoints.map((p) => ({ ...p })), true);
    else this.events.map(this.m.shift, this.m.scale, true);
  }

  private moveMap(shift: number, scale: number, final: boolean): void {
    this.m = { ...this.m, shift, scale };
    this.place();
    this.draw();
    this.events.map(shift, scale, final);
  }

  /** The stops shown, back before the map's shift and compression. */
  private unplaced(stops: DataStop[]): DataStop[] {
    const { centre, shift, scale } = this.m;
    return stops.map((s) => ({ ...s, value: centre + (s.value - shift - centre) / (scale || 1) }));
  }

  /** The wheel: Ctrl zooms the view about the pointer; else, once the editor has the keyboard, it compresses the map (over its bar) or the histogram. */
  private wheel(e: WheelEvent): void {
    const [x, y] = this.pos(e);
    const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    const f = Math.exp(Math.max(-0.5, Math.min(0.5, delta * 0.0015)));
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const about = this.v(x), [a, b] = this.view ?? [0, 1];
      this.view = [about + (a - about) * f, about + (b - about) * f];
      this.draw();
      return;
    }
    if (typeof document !== "undefined" && document.activeElement !== this.canvas) return;
    e.preventDefault();
    const about = this.v(x);
    // Wheel down narrows.
    const factor = 1 / f;
    let commit: () => void;
    if (y >= BAR[0] - 4) {
      const next = compressMap(this.m, about, factor);
      this.moveMap(next.shift, next.scale, false);
      commit = () => this.events.map(this.m.shift, this.m.scale, true);
    } else {
      this.warpPoints = compressWarp(this.warpToMove(), about, factor);
      this.draw();
      this.events.warp(this.warpPoints.map((p) => ({ ...p })), false);
      commit = () => this.events.warp(this.warpPoints.map((p) => ({ ...p })), true);
    }
    clearTimeout(this.wheelDone);
    this.wheelDone = setTimeout(() => {
      this.wheelDone = undefined;
      commit();
    }, 350);
  }

  private key_(e: KeyboardEvent): void {
    const [a, b] = this.view ?? [0, 1];
    const [A, B] = visibleEnds(this.stops);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const by = (e.key === "ArrowLeft" ? -1 : 1) * (b - a) * (e.shiftKey ? 0.1 : 0.01);
      this.moveMap(this.m.shift + by, this.m.scale, true);
    } else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
      const next = compressMap(this.m, (A + B) / 2, e.key === "+" || e.key === "=" ? 0.95 : 1 / 0.95);
      this.moveMap(next.shift, next.scale, true);
    } else if (e.key === "0") {
      this.fit();
      this.draw();
    } else return;
    e.preventDefault();
  }

  private doubleClick(e: MouseEvent): void {
    const [x, y] = this.pos(e);
    const k = y < BAR[0] - 4 ? this.nearPoint(x, y) : undefined;
    if (k !== undefined) return this.recolour(k);
    // Empty space: the view fitted to the map, or to the whole histogram, in turn.
    this.fitAll = !this.fitAll;
    this.fit();
    this.draw();
  }

  private addPoint(v: number): void {
    // A new point here, with the map's colour and opacity where it goes.
    const c = this.at(v);
    const i = this.stops.findIndex((s) => s.value > v);
    const at = i < 0 ? this.stops.length : i;
    const near = this.stops[Math.min(at, this.stops.length - 1)];
    this.stops.splice(at, 0, { ...near, value: v, color: c.color, opacity: c.opacity });
    this.points = [...new Set([...this.points.map((p) => (p >= at ? p + 1 : p)), at])].sort((a, b) => a - b);
    this.changed();
  }

  private recolour(k: number): void {
    const input = el("input", { type: "color", value: hex(this.stops[k].color) }) as HTMLInputElement;
    input.oninput = () => {
      this.stops = reshape(this.stops, this.points, k, { color: unhex(input.value) });
      this.changed();
    };
    input.click();
  }

  private remove(e: MouseEvent): void {
    const [x, y] = this.pos(e);
    const k = y < BAR[0] - 4 ? this.nearPoint(x, y) : undefined;
    if (k === undefined) return;
    e.preventDefault();
    if (this.stops.length <= 2) return;
    this.stops.splice(k, 1);
    this.points = this.points.filter((p) => p !== k).map((p) => (p > k ? p - 1 : p));
    this.changed();
  }

  private changed(): void {
    this.m.base = this.unplaced(this.stops);
    this.draw();
    this.events.stops(this.m.base.map((s) => ({ ...s })), true);
  }
}
