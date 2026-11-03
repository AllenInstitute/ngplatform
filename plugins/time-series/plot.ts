/**
 * The time course plot: series against time, 2 px lines, recessive axes
 * with a few round ticks, the current time marked, and a crosshair reading
 * out every series at the time under the pointer.  A click picks that time.
 * Plain SVG, sized to its container.
 */

const NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** About `count` round tick values covering [lo, hi]. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw * (1 - 1e-9)) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** The range of the series' finite values, with a little room; [0, 1] when there are none. */
export function valueRange(series: ArrayLike<number>[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (let i = 0; i < s.length; ++i) {
      const v = s[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi === lo) return [lo - 1, hi + 1];
  const pad = 0.05 * (hi - lo);
  return [lo - pad, hi + pad];
}

/** An SVG path through the points, broken where a value is missing. */
export function linePath(xs: ArrayLike<number>, ys: ArrayLike<number>, sx: (x: number) => number, sy: (y: number) => number): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < xs.length; ++i) {
    if (!Number.isFinite(ys[i])) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(ys[i]).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** A number for a tick or readout: a few significant digits. */
export function fmt(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return "–";
  if (v !== 0 && (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-3)) return v.toExponential(2);
  return Number(v.toPrecision(digits)).toString();
}

export interface PlotSeries {
  label: string;
  values: ArrayLike<number>;
  colour: string;
}

export interface PlotData {
  /** Each time point's time, in the unit shown. */
  times: ArrayLike<number>;
  unit: string;
  series: PlotSeries[];
  /** After each value on the y axis and in the readout ("%"), if anything. */
  valueUnit?: string;
}

export class Plot {
  readonly element = document.createElement("div");
  private readonly root = svg("svg", { class: "ts-plot", role: "img" });
  private readonly readout = document.createElement("div");
  private data: PlotData = { times: [], unit: "", series: [] };
  private current = -1;
  private marker: SVGLineElement | undefined;
  private width = 0;
  private height = 0;
  private sx: (x: number) => number = () => 0;
  private readonly resize = new ResizeObserver(() => this.layout());

  /** `pick`: a time point clicked in the plot. */
  constructor(private readonly pick: (index: number) => void) {
    this.element.className = "ts-plot-wrap";
    this.readout.className = "ts-readout";
    this.readout.textContent = " ";
    this.element.append(this.root, this.readout);
    this.resize.observe(this.element);
  }

  dispose(): void {
    this.resize.disconnect();
  }

  set(data: PlotData): void {
    this.data = data;
    this.draw();
  }

  /** Marks time point `index` as the one shown. */
  setCurrent(index: number): void {
    this.current = index;
    this.placeMarker();
  }

  private layout(): void {
    const box = this.root.getBoundingClientRect();
    const width = Math.round(box.width);
    const height = Math.round(box.height);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.draw();
  }

  private placeMarker(): void {
    const { times } = this.data;
    const m = this.marker;
    if (m === undefined) return;
    const i = this.current;
    if (!(i >= 0 && i < times.length)) {
      m.setAttribute("visibility", "hidden");
      return;
    }
    const x = this.sx(times[i]).toFixed(1);
    m.setAttribute("x1", x);
    m.setAttribute("x2", x);
    m.setAttribute("visibility", "visible");
  }

  private draw(): void {
    const { width, height } = this;
    const root = this.root;
    root.replaceChildren();
    this.marker = undefined;
    if (width < 40 || height < 40) return;
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const { times, unit, series, valueUnit = "" } = this.data;
    const pad = { left: 52, right: 10, top: 8, bottom: 22 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const [lo, hi] = valueRange(series.map((s) => s.values));
    const x0 = times[0] ?? 0;
    const x1 = times.length > 1 ? times[times.length - 1] : x0 + 1;
    const sx = (x: number) => pad.left + ((x - x0) / (x1 - x0 || 1)) * w;
    const sy = (y: number) => pad.top + (1 - (y - lo) / (hi - lo)) * h;
    this.sx = sx;
    root.setAttribute("aria-label", `${series.map((s) => s.label).join(", ") || "Nothing"} against time`);
    for (const t of ticks(lo, hi, Math.max(3, Math.floor(h / 30)))) {
      root.append(svg("line", { x1: pad.left, x2: pad.left + w, y1: sy(t), y2: sy(t), class: "ts-grid" }));
      const label = svg("text", { x: pad.left - 5, y: sy(t) + 3, class: "ts-tick", "text-anchor": "end" });
      label.textContent = `${fmt(t)}${valueUnit}`;
      root.append(label);
    }
    if (times.length > 0) {
      for (const t of ticks(x0, x1, Math.max(2, Math.floor(w / 80)))) {
        const label = svg("text", { x: sx(t), y: pad.top + h + 14, class: "ts-tick", "text-anchor": "middle" });
        label.textContent = fmt(t);
        root.append(label);
      }
    }
    root.append(svg("line", { x1: pad.left, x2: pad.left + w, y1: pad.top + h, y2: pad.top + h, class: "ts-axis" }));
    // The x axis's unit, under the y axis's ticks, clear of the time ticks.
    const unitLabel = svg("text", { x: pad.left - 8, y: pad.top + h + 14, class: "ts-tick", "text-anchor": "end" });
    unitLabel.textContent = unit ? `t (${unit})` : "t";
    root.append(unitLabel);
    this.marker = svg("line", { y1: pad.top, y2: pad.top + h, class: "ts-now", visibility: "hidden" });
    root.append(this.marker);
    for (const s of series) {
      root.append(svg("path", { d: linePath(times, s.values, sx, sy), class: "ts-line", stroke: s.colour }));
    }
    const cross = svg("line", { y1: pad.top, y2: pad.top + h, class: "ts-cross", visibility: "hidden" });
    const dots = series.map((s) => svg("circle", { r: 3.5, class: "ts-dot", fill: s.colour, visibility: "hidden" }));
    root.append(cross, ...dots);
    // The hover target is the whole plot area, wider than the lines.
    const hit = svg("rect", { x: pad.left, y: pad.top, width: w, height: h, fill: "transparent", class: "ts-hit" });
    root.append(hit);
    const indexAt = (e: MouseEvent) => {
      const box = root.getBoundingClientRect();
      const x = ((e.clientX - box.left) / box.width) * width;
      const t = x0 + ((x - pad.left) / w) * (x1 - x0);
      let best = 0;
      for (let i = 1; i < times.length; ++i) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
      return best;
    };
    hit.addEventListener("pointermove", (e) => {
      if (times.length === 0) return;
      const i = indexAt(e);
      const x = sx(times[i]);
      cross.setAttribute("x1", String(x));
      cross.setAttribute("x2", String(x));
      cross.setAttribute("visibility", "visible");
      series.forEach((s, k) => {
        const v = s.values[i];
        dots[k].setAttribute("visibility", Number.isFinite(v) ? "visible" : "hidden");
        if (Number.isFinite(v)) {
          dots[k].setAttribute("cx", String(x));
          dots[k].setAttribute("cy", String(sy(v)));
        }
      });
      const time = `${fmt(times[i])}${unit ? ` ${unit}` : ""} (${i})`;
      this.readout.replaceChildren(
        time,
        ...series.flatMap((s) => {
          const swatch = document.createElement("span");
          swatch.className = "ts-swatch";
          swatch.style.background = s.colour;
          return ["  ", swatch, ` ${s.label} ${fmt(s.values[i])}${valueUnit}`];
        }),
      );
    });
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      for (const d of dots) d.setAttribute("visibility", "hidden");
      this.readout.textContent = " ";
    });
    hit.addEventListener("click", (e) => {
      if (times.length > 0) this.pick(indexAt(e));
    });
    this.placeMarker();
  }
}
