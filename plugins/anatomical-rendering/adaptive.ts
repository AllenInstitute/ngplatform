/**
 * Multiscale images in the browser's path tracer (plans/adaptive-multiscale.md), the pure part: how an image's finer
 * levels lie over the level read whole (the base), which bricks of a finer level a region of the base needs, and
 * which level each region is drawn at.
 *
 * - The **base** is the level read whole, as before: always there, so nothing is ever a hole.
 * - A **region** is REGION³ voxels of the base. Each is drawn at one level: the base, or a finer one whose bricks
 *   (BRICK_SIDE³ voxels of that level, with an APRON of its neighbours' voxels round them, so sampling and the
 *   gradient never reach outside a brick) are all held.
 * - Levels are chosen where the camera rests: a region's error at a level is its voxel over the size of a pixel
 *   there; the regions in view with the largest error are refined a level at a time while the bricks allow.
 */

/** Base voxels a region's side: 8 (one brick of the occupancy; at a level 16 times finer, 4 bricks a side). */
export const REGION = 8;
export const BRICK_SIDE = 32;
export const APRON = 2;
export const SLOT = BRICK_SIDE + 2 * APRON;
/** Finer levels an image may draw (besides its base). */
export const MAX_LEVELS = 7;

type V3 = [number, number, number];

/** A finer level as the shaders take it: where a base voxel point is in it (u = scale · v + offset, voxel centres at integers). */
export interface MsLevel {
  /** Its index among the reader's levels (finest first). */
  index: number;
  path: string;
  size: V3;
  scale: V3;
  offset: V3;
  voxelMm: number;
}

/** A 4 × 4 row-major matrix's inverse (affine). */
function invertAffine(m: ArrayLike<number>): number[] | undefined {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-30) return undefined;
  const inv = [
    (a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
    (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det,
  ];
  const t = [m[3], m[7], m[11]];
  const out = new Array(16).fill(0);
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) out[4 * r + c] = inv[3 * r + c];
    out[4 * r + 3] = -(inv[3 * r] * t[0] + inv[3 * r + 1] * t[1] + inv[3 * r + 2] * t[2]);
  }
  out[15] = 1;
  return out;
}

function mul(a: number[], b: ArrayLike<number>): number[] {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) out[4 * r + c] += a[4 * r + k] * b[4 * k + c];
  return out;
}

/**
 * The levels finer than the base (`base`: its voxel to RAS, row-major), as base to level maps, coarsest first; at
 * most MAX_LEVELS. A level not lined up with the base's axes (a rotation or shear between them) is left out.
 */
export function finerLevels(base: { voxelToRas: ArrayLike<number>; voxelMm: number }, levels: { index: number; path: string; size: V3; voxelMm: number; voxelToRas: ArrayLike<number> }[]): MsLevel[] {
  const out: MsLevel[] = [];
  for (const l of levels) {
    if (l.voxelMm >= base.voxelMm * 0.95) continue;
    const inv = invertAffine(l.voxelToRas);
    if (inv === undefined) continue;
    const m = mul(inv, base.voxelToRas);
    const scale = [m[0], m[5], m[10]] as V3;
    const off = Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[4]) + Math.abs(m[6]) + Math.abs(m[8]) + Math.abs(m[9]);
    if (off > 1e-6 * Math.max(...scale.map(Math.abs)) || scale.some((s) => !(s > 1))) continue;
    out.push({ index: l.index, path: l.path, size: l.size, scale, offset: [m[3], m[7], m[11]], voxelMm: l.voxelMm });
  }
  return out.sort((a, b) => b.voxelMm - a.voxelMm).slice(-MAX_LEVELS);
}

/** The base's regions along x, y and z. */
export function regionGrid(baseSize: V3): V3 {
  return baseSize.map((n) => Math.max(1, Math.ceil(n / REGION))) as V3;
}

/** The bricks of `level` a region of the base needs: the first (x, y, z) and how many along each. */
export function regionBricks(region: V3, level: MsLevel, baseSize: V3): { b0: V3; n: V3 } {
  const b0 = [0, 0, 0] as V3;
  const n = [0, 0, 0] as V3;
  for (let k = 0; k < 3; ++k) {
    // The region's extent in base voxels (centres at integers: voxel i spans i - 0.5 … i + 0.5), in the level.
    const lo = region[k] * REGION - 0.5;
    const hi = Math.min((region[k] + 1) * REGION, baseSize[k]) - 0.5;
    const flo = lo * level.scale[k] + level.offset[k];
    const fhi = hi * level.scale[k] + level.offset[k];
    const last = Math.max(0, Math.ceil(level.size[k] / BRICK_SIDE) - 1);
    const a = Math.min(last, Math.max(0, Math.floor((flo + 0.5) / BRICK_SIDE)));
    const b = Math.min(last, Math.max(a, Math.floor((fhi + 0.5 - 1e-6) / BRICK_SIDE)));
    b0[k] = a;
    n[k] = b - a + 1;
  }
  return { b0, n };
}

/** Bricks a region of `level` needs. */
export function brickCount(region: V3, level: MsLevel, baseSize: V3): number {
  const { n } = regionBricks(region, level, baseSize);
  return n[0] * n[1] * n[2];
}

/** How much finer than the threshold a region drawn at a level must be before it is drawn coarser (hysteresis). */
export const KEEP = 0.5;

/**
 * Each region's level (0: the base; i: levels[i - 1]): starting from the base everywhere, the region with the largest
 * error (its voxel, `voxelWorld[level]`, over the pixel there, `pixel[region]`; Infinity off screen: never refined)
 * refined a level at a time while its error is over `threshold` and the bricks it needs fit in `slots`.
 * `cost(region, level)`: the bricks it needs at that level. Regions `skip` says are empty are left at the base.
 *
 * - `current` (the levels drawn now): a region keeps a level it is drawn at until its error there is under
 *   KEEP × threshold, and is preferred for the budget while it does, so a still or slightly moved camera's choice
 *   does not churn bricks.
 * - `grid` (the regions along x, y, z): neighbours in view and not empty differ by at most a level (seams between
 *   levels kept to one step): the coarser one raised while the bricks allow, else the finer one lowered.
 */
export function chooseLevels(options: {
  regions: number;
  levels: number;
  voxelWorld: number[];
  pixel: Float32Array;
  slots: number;
  cost: (region: number, level: number) => number;
  skip?: (region: number) => boolean;
  threshold?: number;
  current?: Uint8Array;
  grid?: [number, number, number];
}): Uint8Array {
  const { regions, levels, voxelWorld, pixel, slots, cost, skip, current, grid } = options;
  const threshold = options.threshold ?? 1;
  const chosen = new Uint8Array(regions);
  const used = new Int32Array(regions);
  // A max-heap of [error, region].
  const heap: [number, number][] = [];
  const push = (e: number, r: number) => {
    heap.push([e, r]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] >= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] > heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const errorAt = (r: number, level: number) => (Number.isFinite(pixel[r]) && pixel[r] > 0 ? voxelWorld[level] / pixel[r] : 0);
  // A level up to the one drawn now: kept to a lower threshold, and first for the budget.
  const kept = (r: number, next: number) => current !== undefined && next <= current[r];
  const wants = (r: number, level: number) => {
    const e = errorAt(r, level);
    return kept(r, level + 1) ? e > KEEP * threshold : e > threshold;
  };
  const priority = (r: number, level: number) => errorAt(r, level) * (kept(r, level + 1) ? 1 / KEEP : 1);
  const skipped = new Uint8Array(regions);
  for (let r = 0; r < regions; ++r) {
    if (skip?.(r)) {
      skipped[r] = 1;
      continue;
    }
    if (wants(r, 0) && levels > 0) push(priority(r, 0), r);
  }
  let total = 0;
  while (heap.length > 0) {
    const [, r] = pop();
    const next = chosen[r] + 1;
    if (next > levels) continue;
    const c = cost(r, next);
    if (total - used[r] + c > slots) continue;
    total += c - used[r];
    used[r] = c;
    chosen[r] = next;
    if (next < levels && wants(r, next)) push(priority(r, next), r);
  }
  if (grid !== undefined) total = oneLevelApart(chosen, grid, (r) => skipped[r] === 1 || !Number.isFinite(pixel[r]), cost, used, total, slots);
  return chosen;
}

/**
 * Neighbours (not `free`: off screen or empty, where a seam is not seen) made to differ by at most a level: the
 * coarser raised while the bricks fit, else the finer lowered. Returns the bricks used.
 */
function oneLevelApart(chosen: Uint8Array, grid: [number, number, number], free: (r: number) => boolean, cost: (r: number, l: number) => number, used: Int32Array, total: number, slots: number): number {
  const [gx, gy, gz] = grid;
  const set = (r: number, l: number) => {
    const c = l === 0 ? 0 : cost(r, l);
    total += c - used[r];
    used[r] = c;
    chosen[r] = l;
  };
  // Finest first: a raise there can call for raises further out, met in the same sweep.
  for (let pass = 0; pass < 8; ++pass) {
    let changed = false;
    const order = Array.from({ length: chosen.length }, (_, i) => i).filter((r) => chosen[r] > 1 && !free(r));
    order.sort((a, b) => chosen[b] - chosen[a]);
    for (const r of order) {
      const x = r % gx, y = Math.floor(r / gx) % gy, z = Math.floor(r / (gx * gy));
      const near: number[] = [];
      if (x > 0) near.push(r - 1);
      if (x < gx - 1) near.push(r + 1);
      if (y > 0) near.push(r - gx);
      if (y < gy - 1) near.push(r + gx);
      if (z > 0) near.push(r - gx * gy);
      if (z < gz - 1) near.push(r + gx * gy);
      for (const n of near) {
        if (free(n) || chosen[r] - chosen[n] <= 1) continue;
        const want = chosen[r] - 1;
        const extra = cost(n, want) - used[n];
        if (total + extra <= slots) set(n, want);
        else set(r, chosen[n] + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return total;
}

/** The share of the regions (by their voxels of the base) drawn at each level (0: the base). */
export function levelShares(chosen: Uint8Array, grid: V3, baseSize: V3, levels: number): number[] {
  const shares = new Array(levels + 1).fill(0);
  let total = 0;
  for (let z = 0, r = 0; z < grid[2]; ++z)
    for (let y = 0; y < grid[1]; ++y)
      for (let x = 0; x < grid[0]; ++x, ++r) {
        const v = [x, y, z].reduce((a, c, k) => a * (Math.min((c + 1) * REGION, baseSize[k]) - c * REGION), 1);
        shares[chosen[r]] += v;
        total += v;
      }
  return shares.map((s) => (total > 0 ? s / total : 0));
}
