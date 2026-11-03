/**
 * Where glyphs go: each 2-D view's section as seen from RAS millimetres,
 * which level of the pyramid suits its zoom, and which voxels of that
 * level to read (a box around what the view shows, and the slab of voxels
 * the section passes through).  Plain code, tested without a viewer.
 */

/** Row-major 4 × 4, voxel (x, y, z) to RAS mm. */
type Mat4 = ArrayLike<number>;
export type Vec3 = [number, number, number];

/**
 * A 2-D view as an affine map from RAS mm to its screen: x and y in CSS
 * pixels from its top left, and depth along the view direction (any scale).
 */
export interface Section {
  /** Row-major 3 × 4: x, y, depth rows. */
  toScreen: number[];
  width: number;
  height: number;
  /** A point on the section, RAS mm (the view's position). */
  origin: Vec3;
  /** The section's unit normal, RAS, pointing into the screen. */
  normal: Vec3;
  /** Screen pixels per millimetre in the section. */
  pxPerMm: number;
}

/**
 * The section of a view, from where it projects four points: `origin` and
 * a millimetre from it along x, y and z.  Undefined when they do not
 * project (a view without x, y and z).
 */
export function sectionOf(project: (ras: Vec3) => { x: number; y: number; depth: number } | undefined, origin: Vec3, width: number, height: number): Section | undefined {
  const p0 = project(origin);
  if (p0 === undefined) return undefined;
  const cols: [number, number, number][] = [];
  for (let k = 0; k < 3; ++k) {
    const q: Vec3 = [...origin];
    q[k] += 1;
    const p = project(q);
    if (p === undefined) return undefined;
    cols.push([p.x - p0.x, p.y - p0.y, p.depth - p0.depth]);
  }
  const row = (r: number) => [cols[0][r], cols[1][r], cols[2][r]];
  const [rx, ry] = [row(0), row(1)];
  // Into the screen: right × down (the view's own depth may not vary across a section).
  const n = [rx[1] * ry[2] - rx[2] * ry[1], rx[2] * ry[0] - rx[0] * ry[2], rx[0] * ry[1] - rx[1] * ry[0]];
  const nn = Math.hypot(n[0], n[1], n[2]);
  const pxPerMm = Math.sqrt(Math.hypot(rx[0], rx[1], rx[2]) * Math.hypot(ry[0], ry[1], ry[2]));
  if (!(nn > 0) || !(pxPerMm > 0)) return undefined;
  const normal = n.map((v) => v / nn) as Vec3;
  // Depth is millimetres along the normal, 0 on the section.
  const rz = normal;
  const t = [p0.x, p0.y, 0].map((v, r) => v - [rx, ry, rz][r].reduce((s, c, k) => s + c * origin[k], 0));
  const toScreen = [...rx, t[0], ...ry, t[1], ...rz, t[2]];
  return { toScreen, width, height, origin, normal, pxPerMm };
}

function solve3(m: number[], b: number[]): Vec3 | undefined {
  const [a, bb, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-300) return undefined;
  const inv = [e * i - f * h, c * h - bb * i, bb * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, bb * g - a * h, a * e - bb * d].map((v) => v / det);
  return [0, 1, 2].map((r) => inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2]) as Vec3;
}

/** The RAS point on the section under a screen point. */
export function unproject(section: Section, x: number, y: number): Vec3 | undefined {
  const m = section.toScreen;
  const depth = m[8] * section.origin[0] + m[9] * section.origin[1] + m[10] * section.origin[2] + m[11];
  return solve3([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], [x - m[3], y - m[7], depth - m[11]]);
}

/**
 * The finest level whose voxels are at least `spacing` pixels apart on the
 * screen; the coarsest when none is.  `voxelSizes` finest first, mm.
 */
export function chooseLevel(voxelSizes: number[], pxPerMm: number, spacing: number): number {
  for (let i = 0; i < voxelSizes.length; ++i) if (voxelSizes[i] * pxPerMm >= spacing * 0.98) return i;
  return voxelSizes.length - 1;
}

export function invert4(m: Mat4): number[] {
  // Gauss-Jordan; matrices here are affine and well conditioned.
  const a = Array.from({ length: 4 }, (_, r) => [...Array.from({ length: 4 }, (_, c) => m[4 * r + c]), ...[0, 1, 2, 3].map((c) => (c === r ? 1 : 0))]);
  for (let c = 0; c < 4; ++c) {
    let pivot = c;
    for (let r = c + 1; r < 4; ++r) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const p = a[c][c];
    if (Math.abs(p) < 1e-300) throw new Error("singular transform");
    for (let k = 0; k < 8; ++k) a[c][k] /= p;
    for (let r = 0; r < 4; ++r) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let k = 0; k < 8; ++k) a[r][k] -= f * a[c][k];
    }
  }
  return a.flatMap((row) => row.slice(4));
}

export function applyAffine(m: ArrayLike<number>, p: ArrayLike<number>): Vec3 {
  return [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]) as Vec3;
}

export interface Slab {
  n: Vec3;
  d: number;
  h: number;
}

/**
 * The voxels of a level a plane passes through, as a slab in voxel
 * indices: unit normal n, offset d, half-thickness h (half a voxel along
 * the axis nearest the normal), so each line of voxels across it gives one.
 */
export function slabOf(voxelToRas: Mat4, origin: Vec3, normal: Vec3): Slab {
  // n·(L v + t - o) = 0  ⇔  (Lᵀ n)·v = n·(o - t).
  const n = [0, 1, 2].map((c) => voxelToRas[c] * normal[0] + voxelToRas[4 + c] * normal[1] + voxelToRas[8 + c] * normal[2]);
  const offset = normal.reduce((s, v, r) => s + v * (origin[r] - voxelToRas[4 * r + 3]), 0);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const unit = n.map((v) => v / len) as Vec3;
  return { n: unit, d: offset / len, h: 0.5 * Math.max(...unit.map(Math.abs)) };
}

export interface Box {
  lo: Vec3;
  hi: Vec3;
}

/** The voxel box (whole voxels, within the level) holding some RAS points, grown by `margin` of its size and a voxel. */
export function boxAround(voxelToRas: Mat4, size: Vec3, points: Vec3[], margin: number): Box | undefined {
  const toVoxel = invert4(voxelToRas);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const v = applyAffine(toVoxel, p);
    for (let k = 0; k < 3; ++k) {
      lo[k] = Math.min(lo[k], v[k]);
      hi[k] = Math.max(hi[k], v[k]);
    }
  }
  const out: Box = { lo: [0, 0, 0], hi: [0, 0, 0] };
  for (let k = 0; k < 3; ++k) {
    const grow = (hi[k] - lo[k]) * margin + 1;
    out.lo[k] = Math.max(0, Math.floor(lo[k] - grow));
    out.hi[k] = Math.min(size[k], Math.ceil(hi[k] + grow) + 1);
    if (out.hi[k] <= out.lo[k]) return undefined;
  }
  return out;
}

export function contains(outer: Box, inner: Box): boolean {
  return [0, 1, 2].every((k) => outer.lo[k] <= inner.lo[k] && outer.hi[k] >= inner.hi[k]);
}

/** About how many voxels of a box a slab holds: the box's area across the slab's main axis. */
export function slabVoxels(box: Box, slab: Slab): number {
  const dims = [0, 1, 2].map((k) => box.hi[k] - box.lo[k]);
  const axis = [0, 1, 2].reduce((best, k) => (Math.abs(slab.n[k]) > Math.abs(slab.n[best]) ? k : best), 0);
  return dims.reduce((p, v) => p * v, 1) / dims[axis];
}

/**
 * Three planes through a voxel, along the level's axes, within a box of
 * `half` voxels each way: the slabs and box for the 3-D view when there are
 * no 2-D views to follow.
 */
export function planesAround(voxel: Vec3, size: Vec3, half: number): { box: Box; slabs: Slab[] } | undefined {
  const at = voxel.map((v, k) => Math.max(0, Math.min(size[k] - 1, Math.round(v)))) as Vec3;
  const box: Box = {
    lo: at.map((v) => Math.max(0, v - half)) as Vec3,
    hi: at.map((v, k) => Math.min(size[k], v + half + 1)) as Vec3,
  };
  const slabs: Slab[] = [0, 1, 2].map((k) => ({ n: [0, 1, 2].map((j) => (j === k ? 1 : 0)) as Vec3, d: at[k], h: 0.5 }));
  return { box, slabs };
}
