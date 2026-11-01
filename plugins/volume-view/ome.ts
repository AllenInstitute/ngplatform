/**
 * OME-Zarr image pyramids as the volume view reads them: each level's array
 * and a matrix from its voxel indices to RAS+ millimetres in a chosen
 * coordinate system.  Several stores may make up one pyramid (one store per
 * resolution, as BigBrain's OME-Zarr release is published); their levels
 * are merged by voxel size.
 *
 * Read: OME-Zarr 0.4 and 0.5 (`axes`, per-dataset scale and translation,
 * then the multiscale's own), and 0.6 (RFC 5): `coordinateSystems`, a
 * dataset's `sequence` into the first system, and the multiscale's
 * transforms between systems (`affine`, `scale`, `translation`,
 * `sequence`), followed to the system asked for.
 *
 * Output axes named x, y, z are taken as right, anterior, superior.
 */

/** A 4 × 4 matrix, row-major. */
export type Mat4 = Float64Array;

export interface VolumeLevel {
  /** The store's URL, ending in "/". */
  url: string;
  /** The array's path in the store. */
  path: string;
  /** Voxel indices (x, y, z) to RAS millimetres. */
  voxelToRas: Mat4;
  /** About how many millimetres a voxel is (the mean of its edges). */
  voxelSize: number;
  /** The array's axis names, in its order (C order: the last varies fastest). */
  axes: string[];
}

export interface Pyramid {
  levels: VolumeLevel[];
  /** The coordinate system the levels are placed in. */
  space: string;
  name: string;
  /** Free text from the store (licence, source), when it has it. */
  description?: string;
}

// ------------------------------------------------------------- matrices

export function identity(): Mat4 {
  return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; ++r) {
    for (let c = 0; c < 4; ++c) {
      let s = 0;
      for (let k = 0; k < 4; ++k) s += a[4 * r + k] * b[4 * k + c];
      out[4 * r + c] = s;
    }
  }
  return out;
}

export function invert(m: Mat4): Mat4 {
  // Gauss-Jordan with partial pivoting.
  const a = Array.from({ length: 4 }, (_, r) => [...m.slice(4 * r, 4 * r + 4), ...[0, 1, 2, 3].map((c) => (c === r ? 1 : 0))]);
  for (let c = 0; c < 4; ++c) {
    let pivot = c;
    for (let r = c + 1; r < 4; ++r) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-300) throw new Error("singular transform");
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const p = a[c][c];
    for (let k = 0; k < 8; ++k) a[c][k] /= p;
    for (let r = 0; r < 4; ++r) {
      if (r === c) continue;
      const f = a[r][c];
      if (f !== 0) for (let k = 0; k < 8; ++k) a[r][k] -= f * a[c][k];
    }
  }
  return Float64Array.from(a.flatMap((row) => row.slice(4)));
}

export function apply(m: Mat4, p: ArrayLike<number>): [number, number, number] {
  const out: number[] = [];
  for (let r = 0; r < 3; ++r) out.push(m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]);
  return out as [number, number, number];
}

// ------------------------------------------------------------- metadata

const UNIT_MM: Record<string, number> = {
  meter: 1000,
  m: 1000,
  millimeter: 1,
  mm: 1,
  micrometer: 1e-3,
  um: 1e-3,
  µm: 1e-3,
  micron: 1e-3,
  nanometer: 1e-6,
  nm: 1e-6,
};

interface Axis {
  name: string;
  unit?: string;
}

interface Transform {
  type: string;
  scale?: number[];
  translation?: number[];
  affine?: number[][] | number[];
  transformations?: Transform[];
  input?: { name?: string; path?: string } | string;
  output?: { name?: string; path?: string } | string;
}

const nameOf = (end: Transform["input"]) => (typeof end === "string" ? end : end?.name);

/** A transform's matrix over `n` axes, as an (n+1) × (n+1) row-major array. */
function matrixOf(t: Transform, n: number): number[][] {
  const eye = (): number[][] => Array.from({ length: n + 1 }, (_, r) => Array.from({ length: n + 1 }, (_, c) => (r === c ? 1 : 0)));
  const m = eye();
  switch (t.type) {
    case "identity":
      return m;
    case "scale":
      t.scale!.forEach((s, i) => (m[i][i] = s));
      return m;
    case "translation":
      t.translation!.forEach((v, i) => (m[i][n] = v));
      return m;
    case "affine": {
      const rows = Array.isArray(t.affine![0]) ? (t.affine as number[][]) : chunk(t.affine as number[], n + 1);
      for (let r = 0; r < n; ++r) for (let c = 0; c <= n; ++c) m[r][c] = rows[r][c];
      return m;
    }
    case "sequence":
      // Applied in order: the last is outermost.
      return (t.transformations ?? []).reduce((acc, step) => mul(matrixOf(step, n), acc), m);
    default:
      throw new Error(`unsupported coordinate transform "${t.type}"`);
  }
}

function chunk(values: number[], width: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < values.length; i += width) rows.push(values.slice(i, i + width));
  return rows;
}

function mul(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, c) => row.reduce((s, v, k) => s + v * b[k][c], 0)));
}

/**
 * The levels of one OME-Zarr image group (its `zarr.json`, or a v2 group's
 * `.zattrs`), placed in `space` when it names one of the image's coordinate
 * systems (else in the image's own).
 */
export function parseOmeLevels(url: string, group: any, space?: string): Pyramid {
  const attributes = group?.attributes ?? group ?? {};
  const ome = attributes.ome ?? attributes;
  const multiscale = ome?.multiscales?.[0];
  if (multiscale === undefined) throw new Error(`${url}: not an OME-Zarr image (no multiscales)`);
  const systems: { name: string; axes: Axis[] }[] = multiscale.coordinateSystems ?? [];
  // The system the datasets map into, and its axes.
  const datasets: { path: string; coordinateTransformations?: Transform[] }[] = multiscale.datasets ?? [];
  if (datasets.length === 0) throw new Error(`${url}: the image has no datasets`);
  const firstOutput = nameOf(datasets[0].coordinateTransformations?.[0]?.output);
  const base = systems.find((s) => s.name === firstOutput) ?? systems[0];
  const inputAxes: Axis[] = base?.axes ?? multiscale.axes ?? [];
  const n = inputAxes.length;
  if (n === 0) throw new Error(`${url}: the image names no axes`);
  const spatial = inputAxes.filter((a) => ["x", "y", "z"].includes(a.name));
  if (spatial.length !== 3 || n !== 3) throw new Error(`${url}: only 3-D images (axes z, y, x) are shown; this one has ${inputAxes.map((a) => a.name).join(", ")}`);

  // Transforms applied after each dataset's: 0.4/0.5's shared ones, or
  // 0.6's chain from the datasets' system to the one asked for.
  const shared: Transform[] = multiscale.coordinateTransformations ?? [];
  const between = shared.filter((t) => nameOf(t.input) !== undefined || nameOf(t.output) !== undefined);
  const common = shared.filter((t) => !between.includes(t));
  let outputAxes = inputAxes;
  let outputName = base?.name ?? "physical";
  let after = common.reduce((acc, t) => mul(matrixOf(t, n), acc), matrixOf({ type: "identity" }, n));
  // The system asked for when a transform leads there; else, as Neuroglancer
  // does, the first one a transform leads to (so the two agree).
  const leadsTo = (name: string | undefined) => between.find((t) => nameOf(t.input) === outputName && nameOf(t.output) === name && systems.some((s) => s.name === name));
  const step = (space !== undefined ? leadsTo(space) : undefined) ?? between.find((t) => nameOf(t.input) === outputName && leadsTo(nameOf(t.output)) !== undefined);
  const target = systems.find((s) => s.name === nameOf(step?.output));
  if (step !== undefined && target !== undefined && target.name !== outputName) {
    after = mul(matrixOf(step, n), after);
    outputAxes = target.axes;
    outputName = target.name;
  }
  // Output axes (in their order) to RAS millimetres.
  const toRas: number[][] = Array.from({ length: 4 }, (_, r) => Array.from({ length: n + 1 }, (_, c) => (r === 3 && c === n ? 1 : 0)));
  outputAxes.forEach((axis, i) => {
    const row = { x: 0, y: 1, z: 2 }[axis.name as "x" | "y" | "z"];
    const factor = UNIT_MM[axis.unit ?? "millimeter"] ?? 1;
    toRas[row][i] = factor;
  });
  // Voxel (x, y, z) to the array's axis order.
  const fromVoxel: number[][] = Array.from({ length: n + 1 }, (_, r) => Array.from({ length: 4 }, (_, c) => (r === n && c === 3 ? 1 : 0)));
  inputAxes.forEach((axis, i) => {
    fromVoxel[i][{ x: 0, y: 1, z: 2 }[axis.name as "x" | "y" | "z"]] = 1;
  });

  const levels = datasets.map((dataset): VolumeLevel => {
    const own = (dataset.coordinateTransformations ?? []).reduce((acc, t) => mul(matrixOf(t, n), acc), matrixOf({ type: "identity" }, n));
    const m = mul(toRas, mul(after, mul(own, fromVoxel)));
    const voxelToRas = Float64Array.from(m.flat());
    const edges = [0, 1, 2].map((c) => Math.hypot(voxelToRas[c], voxelToRas[4 + c], voxelToRas[8 + c]));
    return {
      url: url.endsWith("/") ? url : `${url}/`,
      path: dataset.path,
      voxelToRas,
      voxelSize: (edges[0] + edges[1] + edges[2]) / 3,
      axes: inputAxes.map((a) => a.name),
    };
  });
  const description = multiscale.metadata?.description;
  return { levels, space: outputName, name: String(multiscale.name ?? url), description: typeof description === "string" ? description : undefined };
}

/**
 * One pyramid from several stores' levels, finest first; of levels within
 * 2% of the same voxel size the first given is kept.
 */
export function mergeLevels(pyramids: Pyramid[]): VolumeLevel[] {
  const all = pyramids.flatMap((p) => p.levels);
  const kept: VolumeLevel[] = [];
  for (const level of all) {
    if (!kept.some((k) => Math.abs(k.voxelSize - level.voxelSize) <= 0.02 * k.voxelSize)) kept.push(level);
  }
  return kept.sort((a, b) => a.voxelSize - b.voxelSize);
}

/** The bounding box, in RAS millimetres, of an array of `shape` (in the level's axis order). */
export function rasBounds(level: VolumeLevel, shape: number[]): { lo: [number, number, number]; hi: [number, number, number] } {
  const size = [0, 1, 2].map((k) => shape[level.axes.indexOf("xyz"[k])]);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; ++corner) {
    const p = [0, 1, 2].map((k) => (corner >> k) & 1 ? size[k] - 0.5 : -0.5);
    const q = apply(level.voxelToRas, p);
    for (let k = 0; k < 3; ++k) {
      lo[k] = Math.min(lo[k], q[k]);
      hi[k] = Math.max(hi[k], q[k]);
    }
  }
  return { lo, hi };
}
