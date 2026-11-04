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

/**
 * The voxel a coordinate (integers at voxel centres) is in, as Neuroglancer
 * shows it: a position on the boundary between two (as a view's position
 * often is, voxel centres being at halves) belongs to the upper one, with a
 * little room for rounding on the way.
 */
export function voxelIndex(c: number): number {
  return Math.floor(c + 0.5 + 1e-3);
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
    c[axis] = voxelIndex(c[axis]);
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
  /** It reached its box where the volume goes on beyond it. */
  edge: boolean;
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
  if (size.some((n) => n <= 0) || s.some((v, k) => v < lo[k] || v >= hi[k]) || !inside(...s)) return { changed: 0, reached: 0, limited: false, edge: false };
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
  let edge = false;
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
      if (X < lo[0] || Y < lo[1] || Z < lo[2] || X >= hi[0] || Y >= hi[1] || Z >= hi[2]) {
        if (volume.inside(X, Y, Z)) edge = true;
        continue;
      }
      const j = index(X, Y, Z);
      if (visited[j]) continue;
      visited[j] = 1;
      if (inside(X, Y, Z)) push(j);
    }
  }
  return { changed, reached, limited, edge };
}

/**
 * The voxels whose centres lie inside a closed outline in a section (the
 * even-odd rule: a figure of eight fills both loops), as runs along u: for
 * each row w, the u from
 * `from` up to `to` (exclusive).  Points are (u, w) voxel coordinates,
 * integers at voxel centres; the outline closes from the last back to the
 * first.
 */
export function polygonRuns(points: readonly (readonly [number, number])[]): { w: number; from: number; to: number }[] {
  const runs: { w: number; from: number; to: number }[] = [];
  if (points.length < 3) return runs;
  let low = Infinity;
  let high = -Infinity;
  for (const [, w] of points) {
    low = Math.min(low, w);
    high = Math.max(high, w);
  }
  const crossings: number[] = [];
  for (let w = Math.ceil(low); w <= Math.floor(high); ++w) {
    crossings.length = 0;
    for (let i = 0; i < points.length; ++i) {
      const [ua, wa] = points[i];
      const [ub, wb] = points[(i + 1) % points.length];
      // Half-open in w, so a vertex on the row counts once.
      if (wa <= w !== wb <= w) crossings.push(ua + ((w - wa) * (ub - ua)) / (wb - wa));
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.ceil(crossings[k]);
      const to = Math.ceil(crossings[k + 1]);
      if (to > from) runs.push({ w, from, to });
    }
  }
  return runs;
}

/**
 * Paints inside a closed outline drawn in the section `index` across voxel
 * `axis` (the lasso): `points` are (u, w) voxel coordinates along the two
 * other axes in order.  Returns the voxels changed.
 */
export function fillOutline(stroke: Stroke, axis: number, index: number, points: readonly (readonly [number, number])[], paint: Paint): number {
  const volume = stroke.volume;
  const [u, w] = [0, 1, 2].filter((k) => k !== axis);
  if (index < 0 || index >= volume.size[axis]) return 0;
  const v: Vec3 = [0, 0, 0];
  v[axis] = index;
  let changed = 0;
  for (const run of polygonRuns(points)) {
    if (run.w < 0 || run.w >= volume.size[w]) continue;
    v[w] = run.w;
    for (let i = Math.max(0, run.from); i < Math.min(volume.size[u], run.to); ++i) {
      v[u] = i;
      if (allowed(volume, paint, v[0], v[1], v[2]) && stroke.set(v[0], v[1], v[2], paint.value)) ++changed;
    }
  }
  return changed;
}

/** Every voxel of label `from` becomes `to` (0 erases it): a merge, or a label removed.  Returns the voxels changed. */
export function relabel(stroke: Stroke, from: number, to: number): number {
  const volume = stroke.volume;
  if (from === to || from === 0) return 0;
  let changed = 0;
  for (const key of volume.keys()) {
    const c = volume.chunk(key)!;
    const [cx, cy, cz] = volume.coords(key);
    for (let i = 0; i < c.length; ++i) {
      if (c[i] !== from) continue;
      const x = cx * 64 + (i & 63);
      const y = cy * 64 + ((i >> 6) & 63);
      const z = cz * 64 + (i >> 12);
      if (stroke.set(x, y, z, to)) ++changed;
    }
  }
  return changed;
}

// ------------------------------------------------------------ interpolation

/** Squared distances along a line to the nearest zero of `f` (0 where set, Infinity elsewhere): Felzenszwalb and Huttenlocher's lower envelope. */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; ++q) {
    if (f[q] === Infinity) continue;
    if (f[v[0]] === Infinity) {
      v[0] = q;
      continue;
    }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      --k;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    ++k;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]] === Infinity) {
    out.fill(Infinity, 0, n);
    return;
  }
  k = 0;
  for (let q = 0; q < n; ++q) {
    while (z[k + 1] < q) ++k;
    out[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Euclidean distances in a w × h image to the nearest pixel where `seed` is set. */
export function distance2d(seed: Uint8Array, w: number, h: number): Float64Array {
  const d = new Float64Array(w * h);
  for (let i = 0; i < d.length; ++i) d[i] = seed[i] ? 0 : Infinity;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; ++x) {
    for (let y = 0; y < h; ++y) f[y] = d[x + w * y];
    edt1d(f, h, out, v, z);
    for (let y = 0; y < h; ++y) d[x + w * y] = out[y];
  }
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) f[x] = d[x + w * y];
    edt1d(f, w, out, v, z);
    for (let x = 0; x < w; ++x) d[x + w * y] = Math.sqrt(out[x]);
  }
  return d;
}

/** A section's mask as a signed distance: positive inside (to the edge), negative outside. */
export function signedDistance(mask: Uint8Array, w: number, h: number): Float64Array {
  const toOutside = distance2d(mask.map((m) => (m ? 0 : 1)), w, h);
  const toInside = distance2d(mask, w, h);
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; ++i) out[i] = mask[i] ? toOutside[i] : -toInside[i];
  return out;
}

/**
 * Fills the sections between labelled ones (shape-based interpolation, as
 * WebKnossos's and ITK-SNAP's): along `axis`, where a label is drawn in
 * sections a and b with only unlabelled sections between, each section
 * between gets the shape where the two signed distances, weighted by
 * nearness, are positive.  Within `box` (the label's own box, say); over
 * any label, or (`only`) only voxels with that label now, as 0 for
 * unlabelled ones.  Returns the sections filled.
 */
export function interpolate(stroke: Stroke, value: number, axis: number, box: { lo: number[]; hi: number[] }, only?: number): number {
  const volume = stroke.volume;
  const [u, w] = [0, 1, 2].filter((k) => k !== axis);
  const nu = box.hi[u] - box.lo[u];
  const nw = box.hi[w] - box.lo[w];
  const at = (s: number, i: number, j: number) => {
    const p = [0, 0, 0];
    p[axis] = s;
    p[u] = box.lo[u] + i;
    p[w] = box.lo[w] + j;
    return p as Vec3;
  };
  const mask = (s: number) => {
    const m = new Uint8Array(nu * nw);
    let any = false;
    for (let j = 0; j < nw; ++j) {
      for (let i = 0; i < nu; ++i) {
        if (volume.get(...at(s, i, j)) === value) {
          m[i + nu * j] = 1;
          any = true;
        }
      }
    }
    return any ? m : undefined;
  };
  const drawn: number[] = [];
  const masks = new Map<number, Uint8Array>();
  for (let s = box.lo[axis]; s < box.hi[axis]; ++s) {
    const m = mask(s);
    if (m === undefined) continue;
    drawn.push(s);
    masks.set(s, m);
  }
  let filled = 0;
  for (let k = 1; k < drawn.length; ++k) {
    const a = drawn[k - 1];
    const b = drawn[k];
    if (b - a < 2) continue;
    const da = signedDistance(masks.get(a)!, nu, nw);
    const db = signedDistance(masks.get(b)!, nu, nw);
    for (let s = a + 1; s < b; ++s) {
      const t = (s - a) / (b - a);
      for (let j = 0; j < nw; ++j) {
        for (let i = 0; i < nu; ++i) {
          const q = i + nu * j;
          if ((1 - t) * da[q] + t * db[q] <= 0) continue;
          const p = at(s, i, j);
          if (only === undefined || volume.get(...p) === only) stroke.set(...p, value);
        }
      }
      ++filled;
    }
  }
  return filled;
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
