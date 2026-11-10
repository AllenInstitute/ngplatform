/**
 * The time course plot: series against time, 2 px lines, recessive axes
 * with a few round ticks, the current time marked, and a crosshair reading
 * out every series at the time under the pointer.  A click picks that time.
 * Plain SVG, sized to its container.
 */
import { svgEl } from "@ngplatform/sdk/dom";
import { ticks } from "@ngplatform/sdk/format";

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

/**
 * An SVG path through the points, broken where a value is missing; with
 * `bridge`, joined across them (a series read at some time points only).
 */
export function linePath(xs: ArrayLike<number>, ys: ArrayLike<number>, sx: (x: number) => number, sy: (y: number) => number, bridge = false): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < xs.length; ++i) {
    if (!Number.isFinite(ys[i])) {
      if (!bridge) pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(ys[i]).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/**
 * An SVG path around a band, mean ± sd at each point: one closed shape for
 * each run of time points where both are numbers.
 */
export function bandPath(xs: ArrayLike<number>, mean: ArrayLike<number>, sd: ArrayLike<number>, sx: (x: number) => number, sy: (y: number) => number): string {
  let d = "";
  let run: number[] = [];
  const close = () => {
    if (run.length > 0) {
      const top = run.map((i) => `${sx(xs[i]).toFixed(1)},${sy(mean[i] + sd[i]).toFixed(1)}`);
      const bottom = run.map((i) => `${sx(xs[i]).toFixed(1)},${sy(mean[i] - sd[i]).toFixed(1)}`).reverse();
      d += `M${[...top, ...bottom].join("L")}Z`;
    }
    run = [];
  };
  for (let i = 0; i < xs.length; ++i) {
    if (Number.isFinite(mean[i]) && Number.isFinite(sd[i])) run.push(i);
    else close();
  }
  close();
  return d;
}

/** The values a band reaches (mean - sd and mean + sd), for the plot's range. */
export function bandEdges(mean: ArrayLike<number>, sd: ArrayLike<number>): Float32Array[] {
  const lo = Float32Array.from(mean, (m, i) => m - sd[i]);
  const hi = Float32Array.from(mean, (m, i) => m + sd[i]);
  return [lo, hi];
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
  /**
   * Read coarsely while the mouse moves (what, in words): drawn dashed,
   * joined across the time points not read, and named at the plot's top
   * right until the finest values replace it.
   */
  coarse?: string;
  /** A spread around the values (a parcel's SD across its vertices), drawn as a band. */
  sd?: ArrayLike<number>;
}

export interface PlotData {
  /** Each time point's time, in the unit shown. */
  times: ArrayLike<number>;
  unit: string;
  series: PlotSeries[];
  /** After each value on the y axis and in the readout ("%"), if anything. */
  valueUnit?: string;
}

/**
 * A series' key: a short line in its colour, drawn as SVG so the colour is
 * an attribute (`currentColor` takes the text colour of the place it is in).
 */
export function swatch(colour: string): SVGSVGElement {
  const s = svgEl("svg", { class: "ts-swatch", viewBox: "0 0 12 2", "aria-hidden": "true" });
  s.append(svgEl("rect", { width: 12, height: 2, fill: colour }));
  return s;
}

export class Plot {
  readonly element = document.createElement("div");
  private readonly root = svgEl("svg", { class: "ts-plot", role: "img" });
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
    const [lo, hi] = valueRange(series.flatMap((s) => (s.sd === undefined ? [s.values] : [s.values, ...bandEdges(s.values, s.sd)])));
    const x0 = times[0] ?? 0;
    const x1 = times.length > 1 ? times[times.length - 1] : x0 + 1;
    const sx = (x: number) => pad.left + ((x - x0) / (x1 - x0 || 1)) * w;
    const sy = (y: number) => pad.top + (1 - (y - lo) / (hi - lo)) * h;
    this.sx = sx;
    root.setAttribute("aria-label", `${series.map((s) => s.label).join(", ") || "Nothing"} against time`);
    for (const t of ticks(lo, hi, Math.max(3, Math.floor(h / 30)))) {
      root.append(svgEl("line", { x1: pad.left, x2: pad.left + w, y1: sy(t), y2: sy(t), class: "ts-grid" }));
      const label = svgEl("text", { x: pad.left - 5, y: sy(t) + 3, class: "ts-tick", "text-anchor": "end" });
      label.textContent = `${fmt(t)}${valueUnit}`;
      root.append(label);
    }
    if (times.length > 0) {
      for (const t of ticks(x0, x1, Math.max(2, Math.floor(w / 80)))) {
        const label = svgEl("text", { x: sx(t), y: pad.top + h + 14, class: "ts-tick", "text-anchor": "middle" });
        label.textContent = fmt(t);
        root.append(label);
      }
    }
    root.append(svgEl("line", { x1: pad.left, x2: pad.left + w, y1: pad.top + h, y2: pad.top + h, class: "ts-axis" }));
    // The x axis's unit, under the y axis's ticks, clear of the time ticks.
    const unitLabel = svgEl("text", { x: pad.left - 8, y: pad.top + h + 14, class: "ts-tick", "text-anchor": "end" });
    unitLabel.textContent = unit ? `t (${unit})` : "t";
    root.append(unitLabel);
    this.marker = svgEl("line", { y1: pad.top, y2: pad.top + h, class: "ts-now", visibility: "hidden" });
    root.append(this.marker);
    // Bands under every line.
    for (const s of series) if (s.sd !== undefined) root.append(svgEl("path", { d: bandPath(times, s.values, s.sd, sx, sy), class: "ts-band", fill: s.colour }));
    for (const s of series) {
      root.append(svgEl("path", { d: linePath(times, s.values, sx, sy, s.coarse !== undefined), class: `ts-line${s.coarse !== undefined ? " ts-coarse" : ""}`, stroke: s.colour }));
    }
    const coarse = series.find((s) => s.coarse !== undefined);
    if (coarse !== undefined) {
      const note = svgEl("text", { x: pad.left + w - 4, y: pad.top + 12, class: "ts-tick ts-coarse-note", "text-anchor": "end" });
      note.textContent = `coarse (${coarse.coarse}) until the finest values are read`;
      root.append(note);
    }
    const cross = svgEl("line", { y1: pad.top, y2: pad.top + h, class: "ts-cross", visibility: "hidden" });
    const dots = series.map((s) => svgEl("circle", { r: 3.5, class: "ts-dot", fill: s.colour, visibility: "hidden" }));
    root.append(cross, ...dots);
    // The hover target is the whole plot area, wider than the lines.
    const hit = svgEl("rect", { x: pad.left, y: pad.top, width: w, height: h, fill: "transparent", class: "ts-hit" });
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
          const spread = s.sd !== undefined && Number.isFinite(s.sd[i]) ? ` ± ${fmt(s.sd[i])}` : "";
          return ["  ", swatch(s.colour), ` ${s.label} ${fmt(s.values[i])}${spread}${valueUnit}`];
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
