/**
 * An image's time axis as the views show it, the voxel under a position,
 * stepping and playing through time, the series' colours, and the plotted
 * series as CSV.  Plain code, without the page.
 */
import { csvField } from "@ngplatform/sdk/format";
import type { SeriesInfo } from "./reader.js";
import type { LayerMap } from "./space.js";

/** Units a store may give its time axis, in seconds. */
const UNITS: Record<string, [string, number]> = {
  hour: ["h", 3600],
  minute: ["min", 60],
  second: ["s", 1],
  millisecond: ["ms", 1e-3],
  microsecond: ["µs", 1e-6],
  nanosecond: ["ns", 1e-9],
};

/** An image's time axis: where its time points are in the global space and in seconds. */
export interface TimeAxis {
  /** Time points. */
  count: number;
  /** The dimension it is shown along: a global one, or the layer's local one after them (see Place). */
  dim: number;
  /** The source dimension it is. */
  input: number;
  /** The time of time point 0, and between time points, in the unit shown. */
  start: number;
  step: number;
  /** The unit shown ("s", "ms"…; "" when the image gives none) and seconds in one. */
  unit: { label: string; seconds: number };
}

/** The source dimension of each of the image's axes (in the metadata's order); -1 when the layer lacks one. */
export function inputsOf(map: LayerMap, info: SeriesInfo): number[] {
  const names = map.inputNames;
  return info.axes.map((a) => names.indexOf(a));
}

/**
 * The image's time axis in a layer, at a position (whose other dimensions
 * place the line through time, for an oblique transform); a reason when it
 * is not one of the global dimensions.
 */
export function timeAxis(map: LayerMap, info: SeriesInfo, position: ArrayLike<number>): TimeAxis | string {
  const input = inputsOf(map, info)[info.timeAxis];
  if (input === -1) return "the layer does not show the image's time axis";
  if (!map.invertible) return "the layer's transform cannot be inverted";
  const at = (i: number) => {
    const source = map.toInput(position) ?? new Array(map.rank).fill(0);
    source[input] = map.centreOf(input, i);
    return map.toGlobal(source, position);
  };
  const g0 = at(0);
  const g1 = at(1);
  // The global dimension time point 0 to 1 moves along: one in seconds if there is one.
  const moves = (g: number) => Number.isFinite(g0[g]) && Number.isFinite(g1[g]) && Math.abs(g1[g] - g0[g]) > 1e-12;
  const seconds = g0.findIndex((_, g) => moves(g) && map.space.units[g] === "s");
  const dim = seconds !== -1 ? seconds : g0.findIndex((_, g) => moves(g));
  if (dim === -1) return `the image's time axis (${info.axes[info.timeAxis]}) is not one of the views' dimensions or the layer's local ones`;
  const [label, inSeconds] = seconds !== -1 ? (UNITS[info.timeUnit ?? "second"] ?? UNITS.second) : ["", 1];
  const scale = seconds !== -1 ? map.space.scales[dim] / inSeconds : 1;
  return {
    count: info.shape[info.timeAxis],
    dim,
    input,
    start: g0[dim] * scale,
    step: (g1[dim] - g0[dim]) * scale,
    unit: { label, seconds: inSeconds },
  };
}

/** The time of time point `i`, in the unit shown. */
export function timeOf(axis: TimeAxis, i: number): number {
  return axis.start + i * axis.step;
}

/** The times of every time point, in the unit shown. */
export function timesOf(axis: TimeAxis): Float64Array {
  return Float64Array.from({ length: axis.count }, (_, i) => timeOf(axis, i));
}

/** The time point a global position is at (clamped to the series). */
export function indexAt(map: LayerMap, axis: TimeAxis, position: ArrayLike<number>): number {
  const source = map.toInput(position);
  if (source === undefined) return 0;
  const i = map.voxelOf(axis.input, source[axis.input]);
  return Math.max(0, Math.min(axis.count - 1, Number.isFinite(i) ? i : 0));
}

/** The global coordinate along the time dimension that shows time point `i` (its centre). */
export function coordinateOf(map: LayerMap, axis: TimeAxis, position: ArrayLike<number>, i: number): number {
  const source = map.toInput(position) ?? new Array(map.rank).fill(0);
  source[axis.input] = map.centreOf(axis.input, i);
  return map.toGlobal(source, position)[axis.dim];
}

/**
 * The image voxel (an index along each of its axes, in the metadata's
 * order; the time axis's entry 0) at a global position; undefined outside
 * the image.
 */
export function voxelAt(map: LayerMap, info: SeriesInfo, position: ArrayLike<number>): number[] | undefined {
  const source = map.toInput(position);
  if (source === undefined) return undefined;
  const inputs = inputsOf(map, info);
  const out: number[] = [];
  for (let a = 0; a < info.axes.length; ++a) {
    if (a === info.timeAxis) {
      out.push(0);
      continue;
    }
    const c = inputs[a];
    const i = c === -1 ? 0 : map.voxelOf(c, source[c]);
    if (!(i >= 0 && i < info.shape[a])) return undefined;
    out.push(i);
  }
  return out;
}

/** A voxel in words: its index along each axis but time. */
export function voxelLabel(info: SeriesInfo, voxel: number[]): string {
  return info.axes.map((name, a) => (a === info.timeAxis ? "" : `${name} ${voxel[a]}`)).filter(Boolean).join(", ");
}

/** A time in its unit, to a sensible precision ("34 s", "1.25 s", "17" without a unit). */
export function formatTime(value: number, unit: string): string {
  const v = Math.abs(value) >= 100 ? value.toFixed(0) : Number(value.toPrecision(4)).toString();
  return unit ? `${v} ${unit}` : v;
}

// ------------------------------------------------------------- stepping

/** The time point after `i` while playing: the next, the first again when looping, undefined at the end. */
export function nextIndex(i: number, count: number, loop: boolean): number | undefined {
  if (i + 1 < count) return i + 1;
  return loop && count > 0 ? 0 : undefined;
}

/** `i` moved by `delta`, kept within the series. */
export function stepIndex(i: number, delta: number, count: number): number {
  return Math.max(0, Math.min(count - 1, i + delta));
}

/** Playing rates offered, in time points a second. */
export const RATES = [0.5, 1, 2, 5, 10, 20, 30];

// --------------------------------------------------------------- colours

/**
 * Pinned series' colours, in the order they are given (on the docks' dark
 * ground); a pin keeps its colour, and there are no more pins than colours.
 */
export const COLOURS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** The first colour no pin has; undefined when all are taken. */
export function freeColour(used: number[]): number | undefined {
  const i = COLOURS.findIndex((_, c) => !used.includes(c));
  return i === -1 ? undefined : i;
}

/**
 * A spread as percent change: the SD around a series scaled as the series
 * is by `percentChange` (100 / |its mean|), so the band stays around it.
 */
export function percentChangeSpread(values: ArrayLike<number>, sd: ArrayLike<number>): Float32Array {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; ++i) {
    if (!Number.isFinite(values[i])) continue;
    sum += values[i];
    n++;
  }
  const mean = n > 0 ? sum / n : NaN;
  return Float32Array.from(sd, (s) => (mean !== 0 ? (100 * s) / Math.abs(mean) : NaN));
}

/** A series as its change from its own mean (of the values it has), in percent; NaN throughout when the mean is 0. */
export function percentChange(values: ArrayLike<number>): Float32Array {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; ++i) {
    if (!Number.isFinite(values[i])) continue;
    sum += values[i];
    n++;
  }
  const mean = n > 0 ? sum / n : NaN;
  // Divided by the mean's size: a series with a negative mean still rises when its values do.
  return Float32Array.from(values, (v) => (mean !== 0 ? (100 * (v - mean)) / Math.abs(mean) : NaN));
}

// ------------------------------------------------------------------- CSV

export interface NamedSeries {
  label: string;
  values: ArrayLike<number>;
  /** A spread (a parcel's SD across its vertices): a column of its own after the values. */
  sd?: ArrayLike<number>;
}

/**
 * Series as CSV: a row per time point with its index and time, then a
 * column per series (empty where a value is missing).
 */
export function seriesCsv(axis: Pick<TimeAxis, "count" | "start" | "step" | "unit">, series: NamedSeries[]): string {
  const timeHeader = axis.unit.label ? `time (${axis.unit.label})` : "time";
  const lines = [["time point", timeHeader, ...series.flatMap((s) => (s.sd === undefined ? [s.label] : [s.label, `${s.label} SD`]))].map(csvField).join(",")];
  const cell = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : String(Number(v.toPrecision(7))));
  for (let i = 0; i < axis.count; ++i) {
    const row = [String(i), String(Number((axis.start + i * axis.step).toPrecision(10)))];
    for (const s of series) {
      row.push(cell(s.values[i]));
      if (s.sd !== undefined) row.push(cell(s.sd[i]));
    }
    lines.push(row.join(","));
  }
  return `${lines.join("\n")}\n`;
}
