/**
 * Regions for a mean time course: an annotation layer's boxes and
 * ellipsoids, and the image voxels whose centres lie inside one.  Only the
 * spatial dimensions (those in metres) bound a region; along time it spans
 * the whole series.
 */
import type { SeriesInfo } from "./reader.js";
import { inputsOf } from "./series.js";
import type { LayerMap } from "./space.js";

/** An annotation as Neuroglancer's state keeps it (the kinds read here). */
export interface AnnotationJson {
  type: string;
  id: string;
  description?: string;
  pointA?: number[];
  pointB?: number[];
  center?: number[];
  radii?: number[];
}

export type RegionShape = { type: "box"; a: number[]; b: number[] } | { type: "ellipsoid"; center: number[]; radii: number[] };

/** A box or an ellipsoid annotation as a region; undefined for other kinds. */
export function shapeOf(a: AnnotationJson): RegionShape | undefined {
  if (a.type === "axis_aligned_bounding_box" && a.pointA && a.pointB) return { type: "box", a: a.pointA, b: a.pointB };
  if (a.type === "ellipsoid" && a.center && a.radii) return { type: "ellipsoid", center: a.center, radii: a.radii };
  return undefined;
}

/** The annotation dimensions a region is bounded along: those in metres. */
function spatial(map: LayerMap): number[] {
  return map.transform.input.units.map((u, c) => (u === "m" ? c : -1)).filter((c) => c !== -1);
}

/** Whether a point in the annotation layer's coordinates is inside the shape, along `dims`. */
export function inside(shape: RegionShape, p: ArrayLike<number>, dims: number[]): boolean {
  if (shape.type === "box") {
    return dims.every((d) => p[d] >= Math.min(shape.a[d], shape.b[d]) && p[d] <= Math.max(shape.a[d], shape.b[d]));
  }
  let s = 0;
  for (const d of dims) {
    const r = shape.radii[d];
    const off = p[d] - shape.center[d];
    // A flat ellipsoid (an ellipse drawn in a section) is half a unit thick.
    if (r === 0) {
      if (Math.abs(off) > 0.5) return false;
      continue;
    }
    s += (off / r) ** 2;
  }
  return s <= 1;
}

/** The corners of the shape's bounding box, in the annotation layer's coordinates. */
function corners(shape: RegionShape, dims: number[]): number[][] {
  const lo = shape.type === "box" ? shape.a.map((v, d) => Math.min(v, shape.b[d])) : shape.center.map((c, d) => c - Math.abs(shape.radii[d]));
  const hi = shape.type === "box" ? shape.a.map((v, d) => Math.max(v, shape.b[d])) : shape.center.map((c, d) => c + Math.abs(shape.radii[d]));
  const mid = lo.map((v, d) => (v + hi[d]) / 2);
  const out: number[][] = [];
  for (let k = 0; k < 1 << dims.length; ++k) {
    const p = [...mid];
    dims.forEach((d, j) => (p[d] = (k >> j) & 1 ? hi[d] : lo[d]));
    out.push(p);
  }
  return out;
}

export interface RegionVoxels {
  /** Each voxel's index along every image axis (the metadata's order), in turn. */
  voxels: Int32Array;
  count: number;
}

/**
 * The image voxels whose centres are inside a region drawn in an
 * annotation layer.  Image axes other than space and time are taken where
 * `position` is.  An error past `limit` voxels.
 */
export function regionVoxels(
  shape: RegionShape,
  annotation: LayerMap,
  image: LayerMap,
  info: SeriesInfo,
  position: ArrayLike<number>,
  limit = 500_000,
): RegionVoxels {
  const dims = spatial(annotation);
  if (dims.length === 0) throw new Error("the annotation layer has no spatial dimensions");
  const inputs = inputsOf(image, info);
  const here = image.toInput(position);
  if (here === undefined) throw new Error("the image's transform cannot be inverted");
  // The image voxels spanning the shape's bounding box.
  const lo = info.shape.map(() => Infinity);
  const hi = info.shape.map(() => -Infinity);
  for (const corner of corners(shape, dims)) {
    const source = image.toInput(annotation.toGlobal(corner, position));
    if (source === undefined) throw new Error("the image's transform cannot be inverted");
    info.axes.forEach((_, a) => {
      const c = inputs[a];
      if (c === -1 || image.transform.input.units[c] !== "m") return;
      lo[a] = Math.min(lo[a], source[c]);
      hi[a] = Math.max(hi[a], source[c]);
    });
  }
  const ranges = info.axes.map((_, a): [number, number] => {
    const c = inputs[a];
    if (a === info.timeAxis) return [0, 0];
    if (!Number.isFinite(lo[a])) {
      // Not spatial: where the position is.
      const i = c === -1 ? 0 : image.voxelOf(c, here[c]);
      return [i, i];
    }
    return [Math.max(0, image.voxelOf(c, lo[a])), Math.min(info.shape[a] - 1, image.voxelOf(c, hi[a]))];
  });
  const total = ranges.reduce((n, [a, b]) => n * Math.max(0, b - a + 1), 1);
  if (total > limit) throw new Error(`the region spans ${total.toLocaleString()} voxels; ${limit.toLocaleString()} at most`);
  const rank = info.axes.length;
  const out: number[] = [];
  const voxel = ranges.map(([a]) => a);
  const source = [...here];
  for (let n = 0; n < total; ++n) {
    // The voxel's centre, through the global space, in the annotation layer's coordinates.
    info.axes.forEach((_, a) => {
      if (inputs[a] !== -1) source[inputs[a]] = image.centreOf(inputs[a], voxel[a]);
    });
    const p = annotation.toInput(image.toGlobal(source, position));
    if (p !== undefined && inside(shape, p, dims)) out.push(...voxel);
    // The next voxel, the last axis fastest.
    for (let a = rank - 1; a >= 0; --a) {
      if (++voxel[a] <= ranges[a][1]) break;
      voxel[a] = ranges[a][0];
    }
  }
  return { voxels: Int32Array.from(out), count: out.length / rank };
}
