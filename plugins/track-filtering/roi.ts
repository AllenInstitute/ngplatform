/**
 * Track groups, the geometry: which line segments pass through a region of
 * interest, and how a group's regions and attribute filters combine.  Pure
 * functions over typed arrays, shared by the worker that tests chunks and
 * the panel that combines the results; tested without a viewer.
 *
 * TrackVis semantics: a group keeps the tracks that pass through every
 * "and" region, through at least one "or" region (when it has any), and
 * through no "not" region, and whose attributes are in range.  A region can
 * instead ask for a track's ends: either end in it, or both.  A disk (as
 * TrackVis's) is crossed: a segment passes from one side of its plane to
 * the other within its radius, and, with an angle limit, runs within that
 * angle of the disk's normal there.  A mask is a volume's voxels (a
 * painted label image, or an image above a threshold): a segment passes
 * through it when a point along it, at most half a voxel from the next,
 * lies in a voxel of the mask.
 */

export type RoiShape = "sphere" | "box" | "disk" | "mask";
export type RoiOp = "and" | "or" | "not";
/** What of a track must be in a region: by default any of it (it passes through); else either end, or both. */
export type RoiEnds = "either" | "both";

export interface Roi {
  id: string;
  shape: RoiShape;
  /** Centre, in the viewer's global coordinates. */
  center: [number, number, number];
  /** Sphere radius, in global units of the first axis. */
  radius: number;
  /** Box extents (full widths), in global units. */
  size: [number, number, number];
  op: RoiOp;
  ends?: RoiEnds;
  /** Disk: the axis it lies across (0, 1, 2: its normal is along x, y or z). */
  axis?: number;
  /** Disk: the most a crossing segment may turn from the normal, degrees; none: any. */
  angle?: number;
  /** Mask: the layer whose voxels it is, and which of them: at or above a value (images), or one label (none: any but 0). */
  mask?: { layer: string; threshold?: number; label?: number };
}

/** A mask as the worker reads it: the image, which of its levels, and store coordinates to that level's voxel indices. */
export interface MaskSource {
  store: string;
  level: number;
  storeToVoxel: number[];
  threshold?: number;
  label?: number;
}

/** A stable key for a mask's source. */
export function maskKey(m: MaskSource): string {
  return `${m.store}|${m.level}|${m.storeToVoxel.map((v) => Math.round(v * 1e6) / 1e6).join(",")}|${m.threshold ?? ""}|${m.label ?? ""}`;
}

/** A mask read: one byte a voxel (x fastest), and the box of its set voxels (`hi` exclusive). */
export interface MaskVolume {
  bits: Uint8Array;
  size: [number, number, number];
  lo: [number, number, number];
  hi: [number, number, number];
  storeToVoxel: Float64Array;
}

/** The mask of a volume's values: at or above `threshold`, or equal to `label`, or (neither given) not 0. */
export function maskBits(values: ArrayLike<number>, size: [number, number, number], source: { threshold?: number; label?: number }, storeToVoxel: Float64Array): MaskVolume {
  const bits = new Uint8Array(values.length);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const test = source.label !== undefined ? (v: number) => v === source.label : source.threshold !== undefined ? (v: number) => v >= source.threshold! : (v: number) => v !== 0 && !Number.isNaN(v);
  for (let z = 0, i = 0; z < size[2]; ++z) {
    for (let y = 0; y < size[1]; ++y) {
      for (let x = 0; x < size[0]; ++x, ++i) {
        if (!test(values[i])) continue;
        bits[i] = 1;
        if (x < lo[0]) lo[0] = x;
        if (y < lo[1]) lo[1] = y;
        if (z < lo[2]) lo[2] = z;
        if (x >= hi[0]) hi[0] = x + 1;
        if (y >= hi[1]) hi[1] = y + 1;
        if (z >= hi[2]) hi[2] = z + 1;
      }
    }
  }
  if (!Number.isFinite(lo[0])) return { bits, size, lo: [0, 0, 0], hi: [0, 0, 0], storeToVoxel };
  return { bits, size, lo, hi, storeToVoxel };
}

/** The store-coordinate box around a mask's set voxels (voxel centres at integers, so each voxel spans ±0.5). */
export function maskBounds(mask: MaskVolume): { lo: number[]; hi: number[] } {
  const toStore = invert3x4(mask.storeToVoxel);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; ++c) {
    const v = [0, 1, 2].map((k) => ((c >> k) & 1 ? mask.hi[k] - 0.5 : mask.lo[k] - 0.5));
    for (let r = 0; r < 3; ++r) {
      const p = toStore[4 * r] * v[0] + toStore[4 * r + 1] * v[1] + toStore[4 * r + 2] * v[2] + toStore[4 * r + 3];
      lo[r] = Math.min(lo[r], p);
      hi[r] = Math.max(hi[r], p);
    }
  }
  return { lo, hi };
}

function invert3x4(m: ArrayLike<number>): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inv = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const t = [m[3], m[7], m[11]];
  const out = new Float64Array(16);
  for (let r = 0; r < 3; ++r) {
    for (let k = 0; k < 3; ++k) out[4 * r + k] = inv[3 * r + k];
    out[4 * r + 3] = -(inv[3 * r] * t[0] + inv[3 * r + 1] * t[1] + inv[3 * r + 2] * t[2]);
  }
  out[15] = 1;
  return out;
}

/** Adds the ids of the objects with a segment (or, for points, a vertex) through the mask's voxels. */
export function testChunkMask(geometry: ChunkGeometry, mask: MaskVolume, hits: IdSet): void {
  const { positions: p, idLow, idHigh, next, extra, hasSegments } = geometry;
  const n = idLow.length;
  const m = mask.storeToVoxel;
  const [nx, ny, nz] = mask.size;
  const voxel = (i: number) => [0, 1, 2].map((r) => m[4 * r] * p[3 * i] + m[4 * r + 1] * p[3 * i + 1] + m[4 * r + 2] * p[3 * i + 2] + m[4 * r + 3]);
  const set = (x: number, y: number, z: number) => {
    const i = Math.round(x);
    const j = Math.round(y);
    const k = Math.round(z);
    return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && mask.bits[i + nx * (j + ny * k)] === 1;
  };
  const extraPairs = extra.length / 2;
  for (let s = 0; s < n + extraPairs; ++s) {
    let a: number;
    let b: number;
    if (s < n) {
      if (hasSegments) {
        if (next[s] === 0) continue;
        a = s;
        b = s + 1;
      } else a = b = s;
    } else {
      a = extra[2 * (s - n)];
      b = extra[2 * (s - n) + 1];
    }
    const va = voxel(a);
    const vb = voxel(b);
    // Outside the set voxels' box at both ends, on one side: no meeting.
    if ([0, 1, 2].some((k) => (va[k] < mask.lo[k] - 0.5 && vb[k] < mask.lo[k] - 0.5) || (va[k] > mask.hi[k] - 0.5 && vb[k] > mask.hi[k] - 0.5))) continue;
    // Points along it at most half a voxel apart.
    const steps = Math.max(1, Math.ceil(2 * Math.max(Math.abs(vb[0] - va[0]), Math.abs(vb[1] - va[1]), Math.abs(vb[2] - va[2]))));
    for (let t = 0; t <= steps; ++t) {
      const f = t / steps;
      if (set(va[0] + f * (vb[0] - va[0]), va[1] + f * (vb[1] - va[1]), va[2] + f * (vb[2] - va[2]))) {
        hits.add(idLow[a], idHigh === undefined ? 0 : idHigh[a]);
        break;
      }
    }
  }
}

/** A region in store coordinates, as the worker tests it. */
export interface RoiGeometry {
  shape: RoiShape;
  center: [number, number, number];
  radius: number;
  size: [number, number, number];
  ends?: RoiEnds;
  axis?: number;
  angle?: number;
  /** Mask: the volume it reads. */
  maskSource?: MaskSource;
}

export function roiBounds(roi: RoiGeometry, margin = 0): { lo: number[]; hi: number[] } {
  const half = roi.shape === "sphere" ? [roi.radius, roi.radius, roi.radius] : roi.shape === "disk" ? [0, 1, 2].map((k) => (k === (roi.axis ?? 2) ? 0 : roi.radius)) : roi.size.map((s) => Math.abs(s) / 2);
  return {
    lo: roi.center.map((c, i) => c - half[i] - margin),
    hi: roi.center.map((c, i) => c + half[i] + margin),
  };
}

/** A stable key for a region's geometry, to cache its result by. */
export function roiKey(roi: RoiGeometry, level: number): string {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return `${level}|${roi.shape}|${roi.center.map(r).join(",")}|${r(roi.radius)}|${roi.size.map(r).join(",")}${roi.ends ? `|${roi.ends}` : ""}${roi.shape === "disk" ? `|${roi.axis ?? 2}|${roi.angle ?? ""}` : ""}${roi.maskSource ? `|${maskKey(roi.maskSource)}` : ""}`;
}

/**
 * A set of object ids, which arrive as two 32-bit words.  Ids below 2^53 (all
 * of them, in most stores) are kept as numbers; larger ones as bigints.
 */
export class IdSet {
  private small = new Set<number>();
  private big = new Set<bigint>();

  add(low: number, high: number): void {
    if (high < 0x200000) this.small.add(high * 0x100000000 + low);
    else this.big.add((BigInt(high) << 32n) | BigInt(low));
  }

  /** Adds an id as testEnds keys it. */
  addKey(key: number | bigint): void {
    if (typeof key === "number") this.small.add(key);
    else this.big.add(key);
  }

  get size(): number {
    return this.small.size + this.big.size;
  }

  toArray(): BigUint64Array {
    const out = new BigUint64Array(this.size);
    let i = 0;
    for (const v of this.small) out[i++] = BigInt(v);
    for (const v of this.big) out[i++] = v;
    return out;
  }
}

/**
 * A chunk's geometry as the region tests keep it: about 17 bytes a vertex.
 * A streamline's segments join consecutive vertices, so they are one flag
 * per vertex ("joined to the next"), plus any other pairs; ids are 32-bit
 * unless a store's ids need more.
 */
export interface ChunkGeometry {
  positions: Float32Array;
  idLow: Uint32Array;
  /** Present only when some id is 2^32 or more. */
  idHigh: Uint32Array | undefined;
  next: Uint8Array;
  /** Segments that are not between consecutive vertices, as index pairs. */
  extra: Uint32Array;
  /** Whether the chunk has segments at all (points have none). */
  hasSegments: boolean;
  bytes: number;
}

/** Packs a chunk's positions, ids (two words a vertex) and segments (index pairs). */
export function compactChunk(positions: Float32Array, segmentIds: Uint32Array, edges: Uint32Array): ChunkGeometry {
  const n = positions.length / 3;
  const idLow = new Uint32Array(n);
  let wide = false;
  for (let v = 0; v < n; ++v) {
    idLow[v] = segmentIds[2 * v];
    if (segmentIds[2 * v + 1] !== 0) wide = true;
  }
  let idHigh: Uint32Array | undefined;
  if (wide) {
    idHigh = new Uint32Array(n);
    for (let v = 0; v < n; ++v) idHigh[v] = segmentIds[2 * v + 1];
  }
  const next = new Uint8Array(n);
  const extra: number[] = [];
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e];
    const b = edges[e + 1];
    if (b === a + 1) next[a] = 1;
    else if (a === b + 1) next[b] = 1;
    else extra.push(a, b);
  }
  const packed = Uint32Array.from(extra);
  return {
    positions,
    idLow,
    idHigh,
    next,
    extra: packed,
    hasSegments: edges.length > 0,
    bytes: positions.byteLength + idLow.byteLength + (idHigh?.byteLength ?? 0) + next.byteLength + packed.byteLength,
  };
}

/**
 * Adds the ids of the objects with a segment (or, for points, a vertex)
 * inside the region.  Sphere: the segment comes within the radius of the
 * centre.  Box: the segment meets the box.
 */
export function testChunk(geometry: ChunkGeometry, roi: RoiGeometry, hits: IdSet): void {
  const { positions: p, idLow, idHigh, next, extra, hasSegments } = geometry;
  const n = idLow.length;
  const { lo, hi } = roiBounds(roi);
  const [lx, ly, lz] = lo;
  const [hx, hy, hz] = hi;
  const [cx, cy, cz] = roi.center;
  const r2 = roi.radius * roi.radius;
  const sphere = roi.shape === "sphere";
  const disk = roi.shape === "disk";
  const axis = roi.axis ?? 2;
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  const cosLimit = roi.angle === undefined ? -1 : Math.cos((Math.min(90, Math.max(0, roi.angle)) * Math.PI) / 180);
  // The segments: consecutive vertices flagged in `next`, then the `extra`
  // pairs; for points, each vertex as a segment of length zero.
  const extraPairs = extra.length / 2;
  for (let j = 0; j < n + extraPairs; ++j) {
    let a: number;
    let b: number;
    if (j < n) {
      if (hasSegments) {
        if (next[j] === 0) continue;
        a = j;
        b = j + 1;
      } else {
        a = b = j;
      }
    } else {
      a = extra[2 * (j - n)];
      b = extra[2 * (j - n) + 1];
    }
    const px = p[3 * a];
    const py = p[3 * a + 1];
    const pz = p[3 * a + 2];
    const qx = p[3 * b];
    const qy = p[3 * b + 1];
    const qz = p[3 * b + 2];
    // Both ends beyond one face of the bounds: no meeting (most segments).
    if ((px < lx && qx < lx) || (px > hx && qx > hx) || (py < ly && qy < ly) || (py > hy && qy > hy) || (pz < lz && qz < lz) || (pz > hz && qz > hz)) {
      continue;
    }
    let inside: boolean;
    if (disk) {
      inside = segmentCrossesDisk(p, a, b, roi.center, r2, axis, u, v, cosLimit);
    } else if (sphere) {
      const dx = qx - px;
      const dy = qy - py;
      const dz = qz - pz;
      const ex = cx - px;
      const ey = cy - py;
      const ez = cz - pz;
      const len2 = dx * dx + dy * dy + dz * dz;
      let t = len2 > 0 ? (ex * dx + ey * dy + ez * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const fx = ex - t * dx;
      const fy = ey - t * dy;
      const fz = ez - t * dz;
      inside = fx * fx + fy * fy + fz * fz <= r2;
    } else {
      inside = segmentHitsBox(p, a, b, lo, hi);
    }
    if (inside) hits.add(idLow[a], idHigh === undefined ? 0 : idHigh[a]);
  }
}

/** A chunk's line ends: the vertices joined to at most one other, each with its object's id. */
export interface ChunkEnds {
  positions: Float32Array;
  idLow: Uint32Array;
  idHigh: Uint32Array | undefined;
  bytes: number;
}

/**
 * The ends of the chunk's lines: vertices with at most one segment, counting
 * the links `linked` gives a vertex (to fragments elsewhere) as segments.  A
 * lone vertex is both ends of its line, so it is listed twice.
 */
export function chunkEnds(geometry: ChunkGeometry, linked: Map<number, number>): ChunkEnds {
  const { positions, idLow, idHigh, next, extra } = geometry;
  const n = idLow.length;
  const degree = new Uint8Array(n);
  for (let v = 0; v < n; ++v) {
    if (next[v] !== 0) {
      degree[v]++;
      degree[v + 1]++;
    }
  }
  for (const v of extra) degree[v] = Math.min(255, degree[v] + 1);
  for (const [v, links] of linked) if (v < n) degree[v] = Math.min(255, degree[v] + links);
  const ends: number[] = [];
  for (let v = 0; v < n; ++v) {
    if (degree[v] === 0) ends.push(v, v);
    else if (degree[v] === 1) ends.push(v);
  }
  const out: ChunkEnds = {
    positions: new Float32Array(3 * ends.length),
    idLow: new Uint32Array(ends.length),
    idHigh: idHigh === undefined ? undefined : new Uint32Array(ends.length),
    bytes: 0,
  };
  ends.forEach((v, i) => {
    out.positions.set(positions.subarray(3 * v, 3 * v + 3), 3 * i);
    out.idLow[i] = idLow[v];
    if (out.idHigh !== undefined) out.idHigh[i] = idHigh![v];
  });
  out.bytes = out.positions.byteLength + out.idLow.byteLength + (out.idHigh?.byteLength ?? 0);
  return out;
}

/** Counts, per object, its line ends inside the region (into `counts`, keyed as IdSet keys them). */
export function testEnds(ends: ChunkEnds, roi: RoiGeometry, counts: Map<number | bigint, number>): void {
  const { lo, hi } = roiBounds(roi);
  const r2 = roi.radius * roi.radius;
  const p = ends.positions;
  for (let i = 0; i < ends.idLow.length; ++i) {
    const x = p[3 * i];
    const y = p[3 * i + 1];
    const z = p[3 * i + 2];
    const inside =
      roi.shape === "sphere"
        ? (x - roi.center[0]) ** 2 + (y - roi.center[1]) ** 2 + (z - roi.center[2]) ** 2 <= r2
        : x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
    if (!inside) continue;
    const high = ends.idHigh === undefined ? 0 : ends.idHigh[i];
    const key = high < 0x200000 ? high * 0x100000000 + ends.idLow[i] : (BigInt(high) << 32n) | BigInt(ends.idLow[i]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

/**
 * Whether the segment between vertices `a` and `b` crosses the disk at
 * `center` across `axis` (radius² `r2`; `u`, `v` the other axes): from one
 * side of its plane to the other (or touching it), where it meets the plane
 * within the radius, and at no more than the angle whose cosine is
 * `cosLimit` from the normal.  A point (a = b) crosses only lying in it.
 */
export function segmentCrossesDisk(p: Float32Array, a: number, b: number, center: number[], r2: number, axis: number, u: number, v: number, cosLimit: number): boolean {
  const sa = p[3 * a + axis] - center[axis];
  const sb = p[3 * b + axis] - center[axis];
  if ((sa > 0 && sb > 0) || (sa < 0 && sb < 0)) return false;
  const t = sa === sb ? 0 : sa / (sa - sb);
  const du = p[3 * a + u] + t * (p[3 * b + u] - p[3 * a + u]) - center[u];
  const dv = p[3 * a + v] + t * (p[3 * b + v] - p[3 * a + v]) - center[v];
  if (du * du + dv * dv > r2) return false;
  if (cosLimit <= 0) return true;
  const d = [0, 1, 2].map((k) => p[3 * b + k] - p[3 * a + k]);
  const len = Math.hypot(d[0], d[1], d[2]);
  return len > 0 && Math.abs(d[axis]) / len >= cosLimit;
}

/** Whether the segment between vertices `a` and `b` meets the box [lo, hi] (slab test). */
export function segmentHitsBox(positions: Float32Array, a: number, b: number, lo: number[], hi: number[]): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; ++k) {
    const p = positions[3 * a + k];
    const d = positions[3 * b + k] - p;
    if (d === 0) {
      if (p < lo[k] || p > hi[k]) return false;
      continue;
    }
    let ta = (lo[k] - p) / d;
    let tb = (hi[k] - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

// ------------------------------------------------------------ combining

/** Row of each id, through a map only when the ids are not simply 0..n-1. */
export function rowIndex(ids: BigUint64Array): (id: bigint) => number | undefined {
  const n = ids.length;
  let identity = true;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 1000))) {
    if (ids[i] !== BigInt(i)) {
      identity = false;
      break;
    }
  }
  if (identity && n > 0 && ids[n - 1] === BigInt(n - 1)) {
    return (id) => (id < BigInt(n) ? Number(id) : undefined);
  }
  const map = new Map<bigint, number>();
  for (let i = 0; i < n; ++i) map.set(ids[i], i);
  return (id) => map.get(id);
}

/** One byte per row: 1 where the row's id is in `ids`. */
export function rowMask(n: number, ids: BigUint64Array, rowOf: (id: bigint) => number | undefined): Uint8Array {
  const mask = new Uint8Array(n);
  for (const id of ids) {
    const row = rowOf(id);
    if (row !== undefined) mask[row] = 1;
  }
  return mask;
}

/**
 * A group's rows: the attribute mask, through every "and" region, at least
 * one "or" region when there are any, and no "not" region.
 */
export function groupMask(n: number, attributes: Uint8Array | undefined, regions: { op: RoiOp; rows: Uint8Array }[]): Uint8Array {
  const mask = attributes !== undefined ? attributes.slice() : new Uint8Array(n).fill(1);
  const ors = regions.filter((r) => r.op === "or");
  for (let i = 0; i < n; ++i) {
    if (mask[i] === 0) continue;
    let keep = true;
    for (const r of regions) {
      if ((r.op === "and" && r.rows[i] === 0) || (r.op === "not" && r.rows[i] === 1)) {
        keep = false;
        break;
      }
    }
    if (keep && ors.length > 0) keep = ors.some((r) => r.rows[i] === 1);
    if (!keep) mask[i] = 0;
  }
  return mask;
}

/**
 * Reads and tests chunks, `concurrency` at a time, in order.  `stale` is
 * asked between chunks: once it says the work is no longer wanted (the
 * request cancelled, or the store opened again), no further chunk is read
 * and the answer is `false`.
 */
export async function scanChunks<T>(
  coords: number[][],
  concurrency: number,
  read: (coords: number[]) => Promise<T>,
  test: (data: T) => void,
  stale: () => boolean,
  progress?: (done: number, total: number) => void,
): Promise<boolean> {
  let next = 0;
  let done = 0;
  const work = async () => {
    while (next < coords.length && !stale()) {
      const data = await read(coords[next++]);
      if (stale()) return;
      test(data);
      progress?.(++done, coords.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, coords.length) }, work));
  return !stale();
}
