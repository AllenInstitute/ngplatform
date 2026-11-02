/**
 * The drawing tools' work on a label volume, voxel by voxel: a brush (a
 * ball, or the disc of it in one section), flood fills in a section and in
 * a bounded box, and the tests that limit them (an intensity range of an
 * image, or the label a fill started on).  Each writes through a stroke,
 * so it can be undone.
 *
 * Voxel coordinates: indices x, y, z, integers at voxel centres.
 */
import type { Stroke } from "./history.js";
import type { LabelVolume } from "./label_volume.js";

export type Vec3 = [number, number, number];
/** A symmetric 3 × 3 matrix, row-major. */
export type Mat3 = number[];

/** What a stroke writes, and where it may. */
export interface Paint {
  /** The label written (0 erases). */
  value: number;
  /** Only voxels whose label is this now ("only empty voxels": 0; erase one label only: that label). */
  only?: number;
  /** Only voxels this allows (an intensity range of an image). */
  where?: (x: number, y: number, z: number) => boolean;
}

function allowed(volume: LabelVolume, paint: Paint, x: number, y: number, z: number): boolean {
  if (paint.only !== undefined && volume.get(x, y, z) !== paint.only) return false;
  return paint.where === undefined || paint.where(x, y, z);
}

function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) throw new Error("singular");
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/**
 * A ball's shape in voxels: the offsets d with dᵀ·Q·d ≤ 1.  With a radius
 * in millimetres, `voxelToMm` (its linear part) makes it round in space
 * however the voxels are shaped; in voxels it is round in indices.
 */
export function ballShape(radius: number, unit: "mm" | "voxels", voxelToMm?: ArrayLike<number>): Mat3 {
  const r2 = radius * radius;
  if (unit === "voxels" || voxelToMm === undefined) return [1 / r2, 0, 0, 0, 1 / r2, 0, 0, 0, 1 / r2];
  const col = (c: number) => [voxelToMm[c], voxelToMm[4 + c], voxelToMm[8 + c]];
  const q: Mat3 = [];
  for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) q.push(col(i).reduce((s, v, k) => s + v * col(j)[k], 0) / r2);
  return q;
}

/** How far a ball reaches along each voxel axis. */
export function ballReach(q: Mat3): Vec3 {
  const inv = invert3(q);
  return [Math.sqrt(inv[0]), Math.sqrt(inv[4]), Math.sqrt(inv[8])];
}

/**
 * Paints a ball (or, given `plane`, its disc in one section) at `centre`.
 * `plane` is the section's normal in voxel indices: voxels within half a
 * voxel of the plane through the centre along the axis it is closest to
 * are painted.  Returns the voxels changed.
 */
export function paintBall(stroke: Stroke, centre: Vec3, q: Mat3, paint: Paint, plane?: Vec3): number {
  const volume = stroke.volume;
  const reach = ballReach(q);
  let c: Vec3 = [...centre];
  let normal: Vec3 | undefined;
  let tolerance = 0;
  if (plane !== undefined) {
    const n = Math.hypot(...plane);
    normal = plane.map((v) => v / n) as Vec3;
    const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
    // The section shown is the layer of voxels the centre is in.
    c[axis] = Math.round(c[axis]);
    tolerance = 0.5 * Math.abs(normal[axis]);
  }
  c = c as Vec3;
  const lo = [0, 1, 2].map((k) => Math.max(0, Math.ceil(c[k] - reach[k] - 1e-9)));
  const hi = [0, 1, 2].map((k) => Math.min(volume.size[k] - 1, Math.floor(c[k] + reach[k] + 1e-9)));
  let changed = 0;
  for (let z = lo[2]; z <= hi[2]; ++z) {
    const dz = z - c[2];
    for (let y = lo[1]; y <= hi[1]; ++y) {
      const dy = y - c[1];
      for (let x = lo[0]; x <= hi[0]; ++x) {
        const dx = x - c[0];
        if (normal !== undefined && Math.abs(normal[0] * dx + normal[1] * dy + normal[2] * dz) > tolerance + 1e-9) continue;
        const s = dx * (q[0] * dx + q[1] * dy + q[2] * dz) + dy * (q[3] * dx + q[4] * dy + q[5] * dz) + dz * (q[6] * dx + q[7] * dy + q[8] * dz);
        if (s > 1 + 1e-9) continue;
        if (!allowed(volume, paint, x, y, z)) continue;
        if (stroke.set(x, y, z, paint.value)) ++changed;
      }
    }
  }
  return changed;
}

/** Points between two brush positions, close enough that the dabs overlap (a quarter of the smallest reach apart). */
export function dabsBetween(a: Vec3, b: Vec3, q: Mat3): Vec3[] {
  const step = Math.max(0.5, Math.min(...ballReach(q)) / 2);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.ceil(Math.hypot(...d) / step);
  const out: Vec3[] = [];
  for (let i = 1; i <= n; ++i) out.push([a[0] + (d[0] * i) / n, a[1] + (d[1] * i) / n, a[2] + (d[2] * i) / n]);
  return out;
}

export interface FillResult {
  changed: number;
  /** Voxels reached (in the region). */
  reached: number;
  /** It stopped at its limit of voxels before the region ended. */
  limited: boolean;
}

/**
 * Flood fill from `seed` through the voxels `inside` says belong (6
 * neighbours; in a section, the 4 in its plane), within `box` and at most
 * `maxVoxels`, painting each.  `axis` makes it a fill of the section through
 * the seed across that voxel axis.
 */
export function floodFill(
  stroke: Stroke,
  seed: Vec3,
  inside: (x: number, y: number, z: number) => boolean,
  paint: Paint,
  options: { axis?: number; box?: { lo: number[]; hi: number[] }; maxVoxels?: number } = {},
): FillResult {
  const volume = stroke.volume;
  const s = seed.map(Math.round) as Vec3;
  const lo = [0, 1, 2].map((k) => Math.max(0, options.box?.lo[k] ?? 0));
  const hi = [0, 1, 2].map((k) => Math.min(volume.size[k], options.box?.hi[k] ?? volume.size[k]));
  if (options.axis !== undefined) {
    lo[options.axis] = s[options.axis];
    hi[options.axis] = s[options.axis] + 1;
  }
  const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
  if (size.some((n) => n <= 0) || s.some((v, k) => v < lo[k] || v >= hi[k]) || !inside(...s)) return { changed: 0, reached: 0, limited: false };
  const max = options.maxVoxels ?? 64 * 2 ** 20;
  const visited = new Uint8Array(size[0] * size[1] * size[2]);
  const index = (x: number, y: number, z: number) => x - lo[0] + size[0] * (y - lo[1] + size[1] * (z - lo[2]));
  // A queue of packed local indices, grown as needed.
  let queue = new Int32Array(1024);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (tail === queue.length) {
      if (head > 0) {
        queue.copyWithin(0, head, tail);
        tail -= head;
        head = 0;
      }
      if (tail === queue.length) {
        const bigger = new Int32Array(queue.length * 2);
        bigger.set(queue);
        queue = bigger;
      }
    }
    queue[tail++] = i;
  };
  visited[index(...s)] = 1;
  push(index(...s));
  let reached = 0;
  let changed = 0;
  let limited = false;
  const neighbours = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ].filter((d) => options.axis === undefined || d[options.axis] === 0);
  while (head < tail) {
    const i = queue[head++];
    const x = lo[0] + (i % size[0]);
    const y = lo[1] + (Math.floor(i / size[0]) % size[1]);
    const z = lo[2] + Math.floor(i / (size[0] * size[1]));
    ++reached;
    if (allowed(volume, paint, x, y, z) && stroke.set(x, y, z, paint.value)) ++changed;
    if (reached >= max) {
      limited = head < tail;
      break;
    }
    for (const [dx, dy, dz] of neighbours) {
      const X = x + dx;
      const Y = y + dy;
      const Z = z + dz;
      if (X < lo[0] || Y < lo[1] || Z < lo[2] || X >= hi[0] || Y >= hi[1] || Z >= hi[2]) continue;
      const j = index(X, Y, Z);
      if (visited[j]) continue;
      visited[j] = 1;
      if (inside(X, Y, Z)) push(j);
    }
  }
  return { changed, reached, limited };
}

/** A block of an image's values on the label grid (x fastest), from voxel `lo`. */
export interface ImageBlock {
  lo: Vec3;
  size: Vec3;
  data: Float32Array;
}

/** An image block's value at a label voxel; NaN outside it. */
export function blockValue(block: ImageBlock, x: number, y: number, z: number): number {
  const i = x - block.lo[0];
  const j = y - block.lo[1];
  const k = z - block.lo[2];
  if (i < 0 || j < 0 || k < 0 || i >= block.size[0] || j >= block.size[1] || k >= block.size[2]) return NaN;
  return block.data[i + block.size[0] * (j + block.size[1] * k)];
}

/** Voxels whose image value is in [low, high]. */
export function inRange(block: ImageBlock, low: number, high: number): (x: number, y: number, z: number) => boolean {
  return (x, y, z) => {
    const v = blockValue(block, x, y, z);
    return v >= low && v <= high;
  };
}

/** Voxels with the label the seed has. */
export function sameLabel(volume: LabelVolume, seed: Vec3): (x: number, y: number, z: number) => boolean {
  const value = volume.get(...(seed.map(Math.round) as Vec3));
  return (x, y, z) => volume.get(x, y, z) === value;
}
