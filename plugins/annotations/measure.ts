/**
 * Measurements of Neuroglancer's annotations, in millimetres: the length of
 * a line or polyline, the volume of a box or an ellipsoid (an area when it
 * is flat), and the points along a line where a profile samples an image.
 * Annotations are as the state's JSON writes them, in their layer's
 * coordinates; `toGlobal` places those in the global space.
 */
import { distanceMm, type GlobalSpace, spatialMm } from "./geometry.js";

export interface AnnotationJson {
  type: string;
  id: string;
  description?: string;
  point?: number[];
  pointA?: number[];
  pointB?: number[];
  center?: number[];
  radii?: number[];
  points?: number[][];
  /** Values of the layer's annotation properties, in their order. */
  props?: (number | string)[];
}

export type Quantity = "length" | "area" | "volume";

export interface Measurement {
  layer: string;
  id: string;
  type: string;
  description: string;
  quantity: Quantity;
  /** mm, mm² or mm³. */
  value: number;
  /** For boxes, each side; for ellipsoids, each radius (mm). */
  sides?: number[];
}

const POWER: Record<Quantity, 1 | 2 | 3> = { length: 1, area: 2, volume: 3 };
export const powerOf = (q: Quantity) => POWER[q];

/** Lengths of a polyline's segments, in mm, between global positions. */
export function pathLength(points: number[][], space: GlobalSpace): number {
  let s = 0;
  for (let i = 1; i < points.length; ++i) s += distanceMm(points[i - 1], points[i], space);
  return s;
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

const norm = (a: number[]) => Math.hypot(...a);

/**
 * The size spanned by edge vectors (mm), those of zero length left out:
 * three span a volume (|det|), two an area, one a length.
 */
export function spanned(edges: number[][]): { quantity: Quantity; value: number } {
  const e = edges.map((v) => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]).filter((v) => norm(v) > 1e-12);
  if (e.length >= 3) {
    const c = cross(e[1], e[2]);
    return { quantity: "volume", value: Math.abs(e[0][0] * c[0] + e[0][1] * c[1] + e[0][2] * c[2]) };
  }
  if (e.length === 2) return { quantity: "area", value: norm(cross(e[0], e[1])) };
  return { quantity: "length", value: e.length === 1 ? norm(e[0]) : 0 };
}

/**
 * An annotation's measurement, or undefined for a point.  `toGlobal`
 * places the layer's coordinates in the global space.
 */
export function measure(a: AnnotationJson, layer: string, toGlobal: (p: ArrayLike<number>) => number[], space: GlobalSpace): Measurement | undefined {
  const base = { layer, id: a.id, type: a.type, description: a.description ?? "" };
  const mm = (p: ArrayLike<number>) => spatialMm(toGlobal(p), space);
  switch (a.type) {
    case "line": {
      if (!a.pointA || !a.pointB) return undefined;
      return { ...base, quantity: "length", value: pathLength([toGlobal(a.pointA), toGlobal(a.pointB)], space) };
    }
    case "polyline": {
      if (!a.points || a.points.length < 2) return undefined;
      return { ...base, quantity: "length", value: pathLength(a.points.map(toGlobal), space) };
    }
    case "axis_aligned_bounding_box": {
      if (!a.pointA || !a.pointB) return undefined;
      // Edges along each of the layer's own axes, placed in the global space (a turned layer turns its boxes).
      const origin = mm(a.pointA);
      const edges = a.pointA.map((_, k) => {
        const q = a.pointA!.slice();
        q[k] = a.pointB![k];
        return mm(q).map((v, i) => v - origin[i]);
      });
      const { quantity, value } = spanned(edges);
      return { ...base, quantity, value, sides: edges.map(norm).filter((v) => v > 1e-12) };
    }
    case "ellipsoid": {
      if (!a.center || !a.radii) return undefined;
      const c = mm(a.center);
      const axes = a.center.map((_, k) => {
        const q = a.center!.slice();
        q[k] += a.radii![k];
        return mm(q).map((v, i) => v - c[i]);
      });
      const { quantity, value } = spanned(axes);
      // An ellipsoid fills π/6 of its box's volume (4/3 π abc), an ellipse π/4 of its rectangle's (π ab).
      const factor = quantity === "volume" ? (4 / 3) * Math.PI : quantity === "area" ? Math.PI : 2;
      return { ...base, quantity, value: value * factor, sides: axes.map(norm).filter((v) => v > 1e-12) };
    }
    default:
      return undefined;
  }
}

/** Every measurable annotation of the layers in a state. */
export function measureAll(
  layers: { name: string; type?: string; annotations?: AnnotationJson[] }[],
  toGlobalOf: (layer: string, rank: number) => (p: ArrayLike<number>) => number[],
  space: GlobalSpace,
): Measurement[] {
  const out: Measurement[] = [];
  for (const layer of layers) {
    const annotations = layer.annotations ?? [];
    if (annotations.length === 0) continue;
    const first = annotations[0];
    const rank = (first.point ?? first.pointA ?? first.center ?? first.points?.[0] ?? []).length;
    const toGlobal = toGlobalOf(layer.name, rank);
    for (const a of annotations) {
      const m = measure(a, layer.name, toGlobal, space);
      if (m !== undefined) out.push(m);
    }
  }
  return out;
}

/**
 * Where a profile samples a line from `a` to `b` (global positions): `n`
 * points evenly from end to end, with their distance from `a` in mm.
 */
export function samplePoints(a: number[], b: number[], n: number, space: GlobalSpace): { positions: number[][]; distances: number[] } {
  const count = Math.max(2, Math.floor(n));
  const length = distanceMm(a, b, space);
  const positions: number[][] = [];
  const distances: number[] = [];
  for (let i = 0; i < count; ++i) {
    const t = i / (count - 1);
    positions.push(a.map((v, k) => (Number.isFinite(v) && Number.isFinite(b[k]) ? v + t * (b[k] - v) : v)));
    distances.push(t * length);
  }
  return { positions, distances };
}

/**
 * Where a profile samples a path through global positions (a polyline):
 * `n` points evenly along its length, with their distance along it in mm.
 */
export function samplePath(points: number[][], n: number, space: GlobalSpace): { positions: number[][]; distances: number[] } {
  if (points.length === 2) return samplePoints(points[0], points[1], n, space);
  const cumulative = [0];
  for (let i = 1; i < points.length; ++i) cumulative.push(cumulative[i - 1] + distanceMm(points[i - 1], points[i], space));
  const total = cumulative[cumulative.length - 1];
  const count = Math.max(2, Math.floor(n));
  const positions: number[][] = [];
  const distances: number[] = [];
  let segment = 1;
  for (let i = 0; i < count; ++i) {
    const d = (i / (count - 1)) * total;
    while (segment < points.length - 1 && cumulative[segment] < d) ++segment;
    const a = points[segment - 1];
    const b = points[segment];
    const length = cumulative[segment] - cumulative[segment - 1];
    const t = length > 0 ? Math.min(1, Math.max(0, (d - cumulative[segment - 1]) / length)) : 0;
    positions.push(a.map((v, k) => (Number.isFinite(v) && Number.isFinite(b[k]) ? v + t * (b[k] - v) : v)));
    distances.push(d);
  }
  return { positions, distances };
}

/** How many samples a profile takes: about one a voxel along the line, between 2 and `max`. */
export function sampleCount(lengthMm: number, voxelMm: number, max = 4096): number {
  if (!(voxelMm > 0) || !Number.isFinite(lengthMm)) return 2;
  return Math.max(2, Math.min(max, Math.round(lengthMm / voxelMm) + 1));
}
