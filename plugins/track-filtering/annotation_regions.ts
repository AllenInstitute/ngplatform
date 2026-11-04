/**
 * Region tests on annotations (a layer's own, drawn by hand or loaded):
 * which annotations meet a region.  Points inside it, lines and polylines
 * that cross it, boxes and ellipsoids that overlap it (an ellipsoid by its bounding box).
 * Coordinates are nanometres, converted from the viewer's by the caller.
 */
import { inside, type NmRegion } from "./labels.js";

export interface AnnotationGeometry {
  id: string;
  type: string;
  /** The annotation's points, nm: a point's one, a line's or box's two, a polyline's vertices, an ellipsoid's centre and radii. */
  points: number[][];
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The region's box, nm: [lo, hi]. */
function regionBox(region: NmRegion): [number[], number[]] {
  const h = region.shape === "sphere" ? [region.radius, region.radius, region.radius] : region.size.map((s) => Math.abs(s) / 2);
  return [region.center.map((c, k) => c - h[k]), region.center.map((c, k) => c + h[k])];
}

/** Whether the segment a–b meets the region. */
export function segmentMeets(region: NmRegion, a: number[], b: number[]): boolean {
  if (region.shape === "sphere") {
    const d = sub(b, a);
    const len2 = dot(d, d);
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(region.center, a), d) / len2));
    return inside(region, [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]);
  }
  // Slabs: the part of the segment inside each axis's range.
  const [lo, hi] = regionBox(region);
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; ++k) {
    const d = b[k] - a[k];
    if (d === 0) {
      if (a[k] < lo[k] || a[k] > hi[k]) return false;
      continue;
    }
    let u = (lo[k] - a[k]) / d;
    let v = (hi[k] - a[k]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return true;
}

/** Whether the box [lo, hi] meets the region. */
export function boxMeets(region: NmRegion, lo: number[], hi: number[]): boolean {
  if (region.shape === "sphere") {
    const nearest = [0, 1, 2].map((k) => Math.max(lo[k], Math.min(hi[k], region.center[k])));
    return inside(region, nearest);
  }
  const [rlo, rhi] = regionBox(region);
  return [0, 1, 2].every((k) => lo[k] <= rhi[k] && hi[k] >= rlo[k]);
}

export function annotationMeets(region: NmRegion, a: AnnotationGeometry): boolean {
  const [p, q] = a.points;
  switch (a.type) {
    case "point":
      return inside(region, p);
    case "line":
      return segmentMeets(region, p, q);
    case "polyline":
      return a.points.length === 1 ? inside(region, p) : a.points.slice(1).some((b, i) => segmentMeets(region, a.points[i], b));
    case "axis_aligned_bounding_box":
      return boxMeets(
        region,
        [0, 1, 2].map((k) => Math.min(p[k], q[k])),
        [0, 1, 2].map((k) => Math.max(p[k], q[k])),
      );
    case "ellipsoid":
      return boxMeets(
        region,
        [0, 1, 2].map((k) => p[k] - Math.abs(q[k])),
        [0, 1, 2].map((k) => p[k] + Math.abs(q[k])),
      );
    default:
      return a.points.some((point) => inside(region, point));
  }
}

/**
 * An annotation layer's annotations (Neuroglancer's JSON) as geometry in nm,
 * given each global axis's size in nm; those of other types are left out.
 */
export function annotationGeometry(annotations: unknown[], nm: [number, number, number]): AnnotationGeometry[] {
  const scale = (v: unknown) => (Array.isArray(v) ? [0, 1, 2].map((k) => Number(v[k]) * nm[k]) : undefined);
  const out: AnnotationGeometry[] = [];
  for (const raw of annotations) {
    const a = raw as Record<string, unknown>;
    const id = String(a.id ?? "");
    const type = String(a.type ?? "");
    const points =
      type === "point"
        ? [scale(a.point)]
        : type === "line" || type === "axis_aligned_bounding_box"
          ? [scale(a.pointA), scale(a.pointB)]
          : type === "ellipsoid"
            ? [scale(a.center), scale(a.radii)]
            : type === "polyline" && Array.isArray(a.points)
              ? a.points.map(scale)
              : [];
    if (id === "" || points.length === 0 || points.some((p) => p === undefined || p.some((v) => !Number.isFinite(v)))) continue;
    out.push({ id, type, points: points as number[][] });
  }
  return out;
}
