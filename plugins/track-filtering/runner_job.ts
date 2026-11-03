/**
 * A track group as a job for the runner on this computer: its regions and
 * attribute ranges as a zvf-predicate document, zarr-vectors-tools' filter
 * tree (zarr_vectors_tools.filtering.predicates), which the runner's filter
 * job evaluates over the whole tractogram.  Pure, so it is tested without a
 * viewer.
 *
 * Coordinates are the store's, as the region worker tests them (toStore):
 * for a tractogram file, RAS+ millimetres (the browser's reader and the
 * runner's compute them the same way); for a store, its positions as
 * stored.  The group's rule is TrackVis's: every "and" region, at least one
 * "or" region when it has any, no "not" region, and every attribute range.
 */
import type { FilterSpec } from "./filter.js";
import type { MaskVolume, RoiGeometry, RoiOp } from "./roi.js";

export interface ZvfDocument {
  format: "zvf-predicate";
  version: 1;
  tree: ZvfNode;
}

export type ZvfNode =
  | { op: "all" }
  | { op: "passes"; mode: "path" | "endpoints" | "both_endpoints"; region: ZvfRegion }
  | { op: "column"; name: string; cmp: "between"; value: [number, number] }
  | { op: "and" | "or"; args: ZvfNode[] }
  | { op: "not"; arg: ZvfNode };

export type ZvfRegion =
  | { type: "sphere"; center: number[]; radius: number }
  | { type: "box"; min: number[]; max: number[] }
  | { type: "disk"; center: number[]; normal: number[]; radius: number; angle: [number, number] }
  | { type: "mask"; shape: [number, number, number]; affine: number[][]; bits: string };

/** A region of a group, in store coordinates; a mask with its voxels as read. */
export interface JobRegion {
  op: RoiOp;
  geometry: RoiGeometry;
  mask?: MaskVolume;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** 4x4 inverse of a row-major affine (the last row 0 0 0 1). */
function invertAffine(m: ArrayLike<number>): number[][] {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || det === 0) throw new Error("the mask's placement cannot be inverted");
  const inv = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const t = [m[3], m[7], m[11]];
  const rows: number[][] = [];
  for (let r = 0; r < 3; ++r) rows.push([inv[3 * r], inv[3 * r + 1], inv[3 * r + 2], -(inv[3 * r] * t[0] + inv[3 * r + 1] * t[1] + inv[3 * r + 2] * t[2])]);
  rows.push([0, 0, 0, 1]);
  return rows;
}

/**
 * A mask as the filter tree's: the box around its set voxels, as voxels
 * indexed [x][y][z] (z fastest, as numpy's C order), bit-packed most
 * significant bit first, and the affine from those voxel indices to store
 * coordinates.  Undefined when no voxel is set.
 */
export function maskRegion(mask: MaskVolume): ZvfRegion | undefined {
  const [nx, ny] = mask.size;
  const [x0, y0, z0] = mask.lo;
  const shape: [number, number, number] = [mask.hi[0] - x0, mask.hi[1] - y0, mask.hi[2] - z0];
  if (shape.some((s) => s <= 0)) return undefined;
  const [sx, sy, sz] = shape;
  const packed = new Uint8Array(Math.ceil((sx * sy * sz) / 8));
  let bit = 0;
  for (let x = 0; x < sx; ++x) {
    for (let y = 0; y < sy; ++y) {
      const row = x0 + x + nx * (y0 + y + ny * z0);
      for (let z = 0; z < sz; ++z, ++bit) {
        if (mask.bits[row + nx * ny * z] === 1) packed[bit >> 3] |= 0x80 >> (bit & 7);
      }
    }
  }
  const toStore = invertAffine(mask.storeToVoxel);
  // Voxel index (i, j, k) of the box is (i + x0, j + y0, k + z0) of the volume.
  const affine = toStore.map((r, k) => (k === 3 ? r : [r[0], r[1], r[2], r[3] + r[0] * x0 + r[1] * y0 + r[2] * z0]));
  return { type: "mask", shape, affine, bits: base64(packed) };
}

function region(r: JobRegion): ZvfRegion {
  const g = r.geometry;
  switch (g.shape) {
    case "sphere":
      return { type: "sphere", center: [...g.center], radius: Math.abs(g.radius) };
    case "box": {
      const half = g.size.map((s) => Math.abs(s) / 2);
      return { type: "box", min: g.center.map((c, k) => c - half[k]), max: g.center.map((c, k) => c + half[k]) };
    }
    case "disk": {
      const axis = g.axis ?? 2;
      return { type: "disk", center: [...g.center], normal: [0, 1, 2].map((k) => (k === axis ? 1 : 0)), radius: Math.abs(g.radius), angle: [0, g.angle === undefined ? 90 : Math.min(90, Math.max(0, g.angle))] };
    }
    case "mask": {
      if (r.mask === undefined) throw new Error("a mask region's voxels have not been read");
      const m = maskRegion(r.mask);
      // An empty mask meets nothing: a box no streamline can be in.
      return m ?? { type: "box", min: [Infinity, Infinity, Infinity], max: [Infinity, Infinity, Infinity] };
    }
  }
}

function leaf(r: JobRegion): ZvfNode {
  const reg = region(r);
  if (reg.type === "box" && !Number.isFinite(reg.min[0])) return { op: "not", arg: { op: "all" } };
  const mode = reg.type === "disk" || r.geometry.ends === undefined ? "path" : r.geometry.ends === "both" ? "both_endpoints" : "endpoints";
  return { op: "passes", mode, region: reg };
}

/** Why a group cannot be run on this computer, or undefined when it can. */
export function cannotRun(filter: FilterSpec): string | undefined {
  if (filter.includeTags.length > 0 || filter.excludeTags.length > 0) return "a group that chooses by tags (stored groups) cannot be run on this computer yet; use regions and attribute ranges";
  return undefined;
}

/** The group's filter tree. */
export function groupPredicate(regions: JobRegion[], filter: FilterSpec): ZvfDocument {
  const reason = cannotRun(filter);
  if (reason !== undefined) throw new Error(reason);
  const args: ZvfNode[] = [];
  for (const r of regions.filter((r) => r.op === "and")) args.push(leaf(r));
  const ors = regions.filter((r) => r.op === "or");
  if (ors.length === 1) args.push(leaf(ors[0]));
  else if (ors.length > 1) args.push({ op: "or", args: ors.map(leaf) });
  for (const r of regions.filter((r) => r.op === "not")) args.push({ op: "not", arg: leaf(r) });
  for (const [name, [lo, hi]] of Object.entries(filter.ranges)) args.push({ op: "column", name, cmp: "between", value: [Math.min(lo, hi), Math.max(lo, hi)] });
  const tree: ZvfNode = args.length === 0 ? { op: "all" } : args.length === 1 ? args[0] : { op: "and", args };
  return { format: "zvf-predicate", version: 1, tree };
}

/** A file name from a group's name: letters, digits, dot, dash and underscore. */
export function safeName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "group";
}
