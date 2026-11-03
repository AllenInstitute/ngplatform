/**
 * Images warped by a smooth map, computed as they are viewed: each voxel of
 * the output (its place in millimetres) is mapped to a place in the moving
 * image (millimetres), and the moving image is sampled there (trilinear).
 * The map is either a thin-plate spline (3-D: the kernel |r|, with an
 * affine part) fitted to landmark pairs, or a displacement field (OME-NGFF
 * 0.6's `displacements`) between affine steps (`FieldWarp`).  The output
 * keeps the moving image's grid and levels; a chunk reads only the box of
 * the moving level its voxels map into, and of a field only the box its
 * voxels look up.  Served by chunkmirage's engine as a view the page
 * computes (`Engine.serve`, in ./computed.ts).
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

/** A map of places (mm; x, y, z): an output voxel's place to its place in the moving image. */
export type PointMap = (p: ArrayLike<number>, out: number[]) => number[];

/**
 * A map that needs data before it can be applied (a displacement field):
 * `forChunk` reads what a chunk needs, given a lattice of places over the
 * chunk (mm; x, y, z; its corners among them), and answers the map there.
 */
export interface Warp {
  forChunk(lattice: number[][]): Promise<PointMap>;
}

/**
 * Chunk `index` (of `chunk` voxels a side) of the warped level: each voxel's
 * place taken through the warp (a thin-plate spline, or a `Warp`) into the
 * moving image and sampled there (trilinear; 0 outside it), as float32,
 * whole chunks.
 */
export async function warpChunk(grid: WarpGrid, chunk: number[], index: number[], warp: Tps | Warp, read: Reader): Promise<Float32Array> {
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
  // A lattice of places over the chunk, its corners among them (mm).
  const lattice: number[][] = [];
  const steps = 6;
  const visit = (k: number, at: number[]) => {
    if (k === R) {
      lattice.push(toMm(at));
      return;
    }
    for (let s = 0; s <= steps; ++s) visit(k + 1, [...at, lo[k] + ((hi[k] - 1 - lo[k]) * s) / steps]);
  };
  visit(0, []);
  const map: PointMap = "forChunk" in warp ? await warp.forChunk(lattice) : (q, o) => applyTps(warp, q, o);
  // The box the chunk maps into: the lattice through the map, a margin round it.
  const from = grid.shape.map(() => Infinity);
  const to = grid.shape.map(() => -Infinity);
  const v = new Array<number>(R).fill(0);
  const mapped = [0, 0, 0];
  for (const q of lattice) {
    toVoxel(map(q, mapped), v);
    for (let d = 0; d < R; ++d) {
      from[d] = Math.min(from[d], v[d]);
      to[d] = Math.max(to[d], v[d]);
    }
  }
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
    map(toMm(voxel), p);
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

/** A 4 × 4 affine on x, y, z (row-major, millimetres). */
export type Affine = number[];

const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Affine, b: Affine): Affine {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) out[4 * r + c] += a[4 * r + k] * b[4 * k + c];
  return out;
}

/** Affines applied one after another, as one. */
export function composeAffines(steps: Affine[]): Affine {
  return steps.reduce((m, step) => multiply(step, m), [...IDENTITY]);
}

function applyAffine(m: Affine, p: ArrayLike<number>, out: number[]): number[] {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  for (let r = 0; r < 3; ++r) out[r] = m[4 * r] * x + m[4 * r + 1] * y + m[4 * r + 2] * z + m[4 * r + 3];
  return out;
}

/**
 * A displacement field between affine steps (OME-NGFF 0.6's
 * `displacements`, in a sequence of affines): an output voxel's place p
 * goes through `before`, then the field (q to q + D(q), D looked up at q,
 * trilinear), then `after`.
 */
export interface FieldSpec {
  /** Affines applied, in order, to the output voxel's place before the field (mm). */
  before: Affine[];
  /** Affines applied, in order, after it. */
  after: Affine[];
  /**
   * The field's inverse instead: the place x with x + D(x) = q, estimated
   * by iteration (x ← q − D(x)), for a field written in the direction the
   * image is not resampled in.
   */
  invert: boolean;
  /** The field's grid: its spatial axes (the level read). */
  grid: WarpGrid;
  /** For each component of the stored vector, in its order: x (0), y (1) or z (2). */
  components: number[];
  /** Millimetres in one unit of a displacement. */
  mm: number;
}

/** The field's box [lo, hi) of its grid: one array per component (C order, the grid's axes). */
export type FieldReader = (lo: number[], hi: number[]) => Promise<ArrayLike<number>[]>;

/**
 * A displacement field as a `Warp`: for each chunk it reads the box of the
 * field the chunk's places look up (from the lattice, the affines before it
 * being affine; for the inverse, widened by the largest displacement in
 * it), then maps each place.  Past the field's edge the edge's
 * displacement holds.
 */
export class FieldWarp implements Warp {
  private readonly before: Affine;
  private readonly after: Affine;

  constructor(
    readonly spec: FieldSpec,
    private readonly read: FieldReader,
  ) {
    this.before = composeAffines(spec.before);
    this.after = composeAffines(spec.after);
  }

  /** A place (mm) as the field's fractional voxel. */
  private toVoxel(q: ArrayLike<number>, into: number[]): number[] {
    const g = this.spec.grid;
    for (let k = 0; k < g.shape.length; ++k) into[k] = (q[g.xyz[k]] / g.mm[k] - g.origin[k]) / g.voxel[k];
    return into;
  }

  /** The box of field voxels round `places` (mm), `pad` voxels more each way, inside the field. */
  private box(places: number[][], pad: number[]): { lo: number[]; hi: number[] } {
    const g = this.spec.grid;
    const R = g.shape.length;
    const from = new Array<number>(R).fill(Infinity);
    const to = new Array<number>(R).fill(-Infinity);
    const v = new Array<number>(R).fill(0);
    for (const q of places) {
      this.toVoxel(q, v);
      for (let d = 0; d < R; ++d) {
        from[d] = Math.min(from[d], v[d]);
        to[d] = Math.max(to[d], v[d]);
      }
    }
    const lo = from.map((f, d) => Math.min(Math.max(Math.floor(f - 1 - pad[d]), 0), g.shape[d] - 1));
    const hi = to.map((t, d) => Math.max(Math.min(Math.ceil(t + 2 + pad[d]), g.shape[d]), lo[d] + 1));
    return { lo, hi };
  }

  /** D at places in the box [lo, hi) of the field (values read there): mm, x, y, z. */
  private sampler(lo: number[], hi: number[], values: ArrayLike<number>[]): (q: ArrayLike<number>, out: number[]) => number[] {
    const { grid: g, components, mm } = this.spec;
    const R = g.shape.length;
    const rs = hi.map((h, d) => h - lo[d]);
    const stride = rs.map((_, d) => rs.slice(d + 1).reduce((n, s) => n * s, 1));
    const v = new Array<number>(R).fill(0);
    const base = new Array<number>(R).fill(0);
    const frac = new Array<number>(R).fill(0);
    return (q, out) => {
      this.toVoxel(q, v);
      for (let d = 0; d < R; ++d) {
        // Clamped to the field (its edge holds past it), and to the box read.
        const f = Math.min(Math.max(v[d], lo[d]), hi[d] - 1) - lo[d];
        base[d] = Math.min(Math.floor(f), Math.max(rs[d] - 2, 0));
        frac[d] = rs[d] > 1 ? f - base[d] : 0;
      }
      out[0] = out[1] = out[2] = 0;
      for (let m = 0; m < 1 << R; ++m) {
        let w = 1;
        let i = 0;
        for (let d = 0; d < R; ++d) {
          const up = (m >> d) & 1;
          if (up && rs[d] < 2) {
            w = 0;
            break;
          }
          w *= up ? frac[d] : 1 - frac[d];
          i += (base[d] + up) * stride[d];
        }
        if (w === 0) continue;
        for (let c = 0; c < components.length; ++c) out[components[c]] += w * Number(values[c][i]) * mm;
      }
      return out;
    };
  }

  async forChunk(lattice: number[][]): Promise<PointMap> {
    const g = this.spec.grid;
    const R = g.shape.length;
    const places = lattice.map((p) => applyAffine(this.before, p, [0, 0, 0]));
    let { lo, hi } = this.box(places, new Array<number>(R).fill(0));
    let values = await this.read(lo, hi);
    if (this.spec.invert) {
      // The inverse looks D up where q − D(x) lands: widen the box by the largest displacement in it.
      let reach = 0;
      const n = values[0].length;
      for (let i = 0; i < n; ++i) {
        let s = 0;
        for (const c of values) s += Number(c[i]) ** 2;
        reach = Math.max(reach, Math.sqrt(s));
      }
      reach *= this.spec.mm;
      const wider = this.box(places, g.voxel.map((vx, d) => reach / (vx * g.mm[d])));
      if (wider.lo.some((l, d) => l !== lo[d] || wider.hi[d] !== hi[d])) {
        ({ lo, hi } = wider);
        values = await this.read(lo, hi);
      }
    }
    const D = this.sampler(lo, hi, values);
    const q = [0, 0, 0];
    const d = [0, 0, 0];
    const x = [0, 0, 0];
    const tolerance = 1e-4 * Math.min(...g.voxel.map((vx, k) => vx * g.mm[k]));
    return (p, out) => {
      applyAffine(this.before, p, q);
      D(q, d);
      if (!this.spec.invert) {
        for (let k = 0; k < 3; ++k) x[k] = q[k] + d[k];
      } else {
        for (let k = 0; k < 3; ++k) x[k] = q[k] - d[k];
        for (let i = 0; i < 50; ++i) {
          D(x, d);
          let moved = 0;
          for (let k = 0; k < 3; ++k) {
            const next = q[k] - d[k];
            moved = Math.max(moved, Math.abs(next - x[k]));
            x[k] = next;
          }
          if (moved < tolerance) break;
        }
      }
      return applyAffine(this.after, x, out);
    };
  }
}

/**
 * Warps one after another (a chain through several displacement fields):
 * each part reads what its places need, its places being where the parts
 * before it took the chunk's lattice.
 */
export class ChainWarp implements Warp {
  constructor(readonly parts: Warp[]) {}

  async forChunk(lattice: number[][]): Promise<PointMap> {
    const maps: PointMap[] = [];
    let places = lattice;
    for (const part of this.parts) {
      const map = await part.forChunk(places);
      maps.push(map);
      places = places.map((p) => map(p, [0, 0, 0]));
    }
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    return (p, out) => {
      let from: ArrayLike<number> = p;
      maps.forEach((map, i) => {
        const into = i === maps.length - 1 ? out : i % 2 === 0 ? a : b;
        from = map(from, into);
      });
      return maps.length === 0 ? Array.from(p, Number) : out;
    };
  }
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
