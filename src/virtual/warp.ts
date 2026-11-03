/**
 * Images warped by landmarks, computed as they are viewed: a thin-plate
 * spline (3-D: the kernel |r|, with an affine part) fitted to landmark pairs
 * maps each voxel of the output (in the fixed space, millimetres) to where
 * it is in the moving image (millimetres), and the moving image is sampled
 * there (trilinear).  The output keeps the moving image's grid and levels;
 * a chunk reads only the box of the moving level its voxels map into.
 * Served by chunkmirage's engine as a view the page computes
 * (`Engine.serve`, in ./computed.ts).
 */

export type Vec3 = [number, number, number];

export interface Tps {
  /** Fixed points (the kernel's centres), mm. */
  centres: Vec3[];
  /** Kernel weights, one row per centre, x, y, z. */
  weights: Vec3[];
  /** The affine part: a constant and a 3 × 3 (rows x, y, z of the result). */
  affine: { constant: Vec3; linear: [Vec3, Vec3, Vec3] };
}

/** Solves A x = b by Gaussian elimination with partial pivoting (A square, b with several columns). */
function solve(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...b[i]]);
  const cols = b[0].length;
  for (let c = 0; c < n; ++c) {
    let pivot = c;
    for (let r = c + 1; r < n; ++r) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) throw new Error("the landmarks do not fix a warp: four or more, not all in one plane, are needed");
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < n; ++r) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      if (f === 0) continue;
      for (let k = c; k < n + cols; ++k) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row.slice(n).map((v) => v / m[i][i]));
}

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The thin-plate spline taking each fixed point to its moving partner
 * exactly, and smooth (least bending) between them.  `smoothing` (≥ 0, mm)
 * lets it pass near rather than through the points.
 */
export function fitTps(fixed: Vec3[], moving: Vec3[], smoothing = 0): Tps {
  const n = fixed.length;
  if (n !== moving.length) throw new Error("as many moving landmarks as fixed ones are needed");
  if (n < 4) throw new Error("a warp needs four landmark pairs or more");
  const a: number[][] = [];
  for (let i = 0; i < n; ++i) {
    const row = fixed.map((f, j) => (i === j ? smoothing : distance(fixed[i], f)));
    a.push([...row, 1, ...fixed[i]]);
  }
  for (let k = 0; k < 4; ++k) a.push([...fixed.map((f) => (k === 0 ? 1 : f[k - 1])), 0, 0, 0, 0]);
  const b = [...moving.map((m) => [...m]), [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const x = solve(a, b);
  const at = (r: number) => x[r] as Vec3;
  return {
    centres: fixed.map((f) => [...f] as Vec3),
    weights: fixed.map((_, i) => at(i)),
    affine: {
      constant: at(n),
      // Result component c's coefficient of input axis k is x[n + 1 + k][c]: rows by result.
      linear: [0, 1, 2].map((c) => [0, 1, 2].map((k) => x[n + 1 + k][c])) as [Vec3, Vec3, Vec3],
    },
  };
}

/** Where the spline takes point p (mm). */
export function applyTps(t: Tps, p: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
  const { constant, linear } = t.affine;
  for (let c = 0; c < 3; ++c) out[c] = constant[c] + linear[c][0] * p[0] + linear[c][1] * p[1] + linear[c][2] * p[2];
  for (let i = 0; i < t.centres.length; ++i) {
    const u = distance(p, t.centres[i]);
    const w = t.weights[i];
    out[0] += w[0] * u;
    out[1] += w[1] * u;
    out[2] += w[2] * u;
  }
  return out;
}

/** A level's grid as chunkmirage gives it: shape, voxel size and origin per axis (in its axes' order), and which of x, y, z each axis is, in mm per unit. */
export interface WarpGrid {
  shape: number[];
  voxel: number[];
  origin: number[];
  /** For each axis, x (0), y (1) or z (2). */
  xyz: number[];
  /** Millimetres in one unit of each axis. */
  mm: number[];
}

/** The box of the moving level [lo, hi) a block reads, and its values (C order, the level's axes). */
export type Reader = (lo: number[], hi: number[]) => Promise<ArrayLike<number>>;

/**
 * Chunk `index` (of `chunk` voxels a side) of the warped level: each voxel's
 * place in the fixed space taken through the spline into the moving image
 * and sampled there (trilinear; 0 outside it), as float32, whole chunks.
 */
export async function warpChunk(grid: WarpGrid, chunk: number[], index: number[], tps: Tps, read: Reader): Promise<Float32Array> {
  const R = grid.shape.length;
  const lo = index.map((i, k) => i * chunk[k]);
  const hi = lo.map((v, k) => Math.min(v + chunk[k], grid.shape[k]));
  const out = new Float32Array(chunk.reduce((n, s) => n * s, 1));
  if (hi.some((v, k) => v <= lo[k])) return out;
  // A voxel's place in mm (x, y, z), and a place in mm as the level's (fractional) voxel.
  const toMm = (v: ArrayLike<number>) => {
    const p = [0, 0, 0];
    for (let k = 0; k < R; ++k) p[grid.xyz[k]] = (grid.origin[k] + v[k] * grid.voxel[k]) * grid.mm[k];
    return p;
  };
  const toVoxel = (p: ArrayLike<number>, into: number[]) => {
    for (let k = 0; k < R; ++k) into[k] = (p[grid.xyz[k]] / grid.mm[k] - grid.origin[k]) / grid.voxel[k];
    return into;
  };
  // The box the chunk maps into: a lattice of its points through the spline, a margin round it.
  const from = grid.shape.map(() => Infinity);
  const to = grid.shape.map(() => -Infinity);
  const v = new Array<number>(R).fill(0);
  const steps = 4;
  const visit = (k: number, at: number[]) => {
    if (k === R) {
      toVoxel(applyTps(tps, toMm(at)), v);
      for (let d = 0; d < R; ++d) {
        from[d] = Math.min(from[d], v[d]);
        to[d] = Math.max(to[d], v[d]);
      }
      return;
    }
    for (let s = 0; s <= steps; ++s) visit(k + 1, [...at, lo[k] + ((hi[k] - 1 - lo[k]) * s) / steps]);
  };
  visit(0, []);
  const span = from.map((f, d) => to[d] - f);
  const rlo = from.map((f, d) => Math.max(0, Math.floor(f - 2 - span[d] * 0.1)));
  const rhi = to.map((t, d) => Math.min(grid.shape[d], Math.ceil(t + 3 + span[d] * 0.1)));
  if (rhi.some((h, d) => h <= rlo[d])) return out;
  const data = await read(rlo, rhi);
  const rs = rhi.map((h, d) => h - rlo[d]);
  const stride = rs.map((_, d) => rs.slice(d + 1).reduce((n, s) => n * s, 1));
  const at = (c: number[]) => {
    let i = 0;
    for (let d = 0; d < R; ++d) i += c[d] * stride[d];
    return Number(data[i]);
  };
  // Each voxel: trilinear over the 2^R corners round its place.
  const voxel = new Array<number>(R).fill(0);
  const place = new Array<number>(R).fill(0);
  const p = [0, 0, 0];
  const corner = new Array<number>(R).fill(0);
  const cs = chunk.map((_, d) => chunk.slice(d + 1).reduce((n, s) => n * s, 1));
  const total = hi.reduce((n, h, d) => n * (h - lo[d]), 1);
  const extent = hi.map((h, d) => h - lo[d]);
  for (let flat = 0; flat < total; ++flat) {
    let rest = flat;
    let o = 0;
    for (let d = R - 1; d >= 0; --d) {
      const c = rest % extent[d];
      rest = Math.floor(rest / extent[d]);
      voxel[d] = lo[d] + c;
      o += c * cs[d];
    }
    applyTps(tps, toMm(voxel), p);
    toVoxel(p, place);
    let value = 0;
    let inside = true;
    for (let d = 0; d < R; ++d) if (place[d] < -0.5 || place[d] > grid.shape[d] - 0.5) inside = false;
    if (!inside) continue;
    for (let m = 0; m < 1 << R; ++m) {
      let w = 1;
      for (let d = 0; d < R; ++d) {
        const base = Math.floor(place[d]);
        const f = place[d] - base;
        const up = (m >> d) & 1;
        const c = Math.min(Math.max(base + up, 0), grid.shape[d] - 1) - rlo[d];
        if (c < 0 || c >= rs[d]) {
          w = 0;
          break;
        }
        corner[d] = c;
        w *= up ? f : 1 - f;
      }
      if (w > 0) value += w * at(corner);
    }
    out[o] = value;
  }
  return out;
}

/** Millimetres in one unit of an axis (OME's names). */
export function mmPerUnit(unit: string): number {
  const u = unit.toLowerCase();
  if (u === "micrometer" || u === "µm" || u === "um") return 1e-3;
  if (u === "nanometer" || u === "nm") return 1e-6;
  if (u === "meter" || u === "m") return 1e3;
  if (u === "centimeter" || u === "cm") return 10;
  return 1;
}
