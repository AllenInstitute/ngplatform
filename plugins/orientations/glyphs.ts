/**
 * Glyphs from voxels: what each voxel's components look like as a shape.
 *
 * - Spherical harmonics: the function on a sphere of directions, each
 *   vertex pushed out to its value, min-max normalised per voxel by default
 *   (FURY's odf_slicer), coloured by each point's direction.
 * - Tensors: an ellipsoid with axes along the eigenvectors, as long as the
 *   eigenvalues (the largest 1), coloured by the principal direction
 *   (|x|, |y|, |z|, dimmed where the anisotropy is low); or a line along
 *   the principal direction.
 * - Vectors and peaks: lines through the voxel's centre, both ways (fibre
 *   directions have no sign), coloured by direction.
 *
 * Glyphs are placed in RAS millimetres; directions in the data are in the
 * data's own frame (the voxel axes or the world's), so each is turned into
 * RAS with `toData` (RAS → data, orthogonal).  Plain code: the worker runs
 * it, and the tests check it.
 */
import { evaluate, gfa, lmaxOf, type ShBasis, shMatrix } from "./sh.js";
import { icosphere } from "./sphere.js";
import { eigenSymmetric, fractionalAnisotropy, type TensorOrder, tensorMatrix } from "./tensor.js";

export type OrientationKind = "sh" | "tensor" | "vector" | "peaks";
export type Normalise = "minmax" | "max" | "none";

export interface GlyphOptions {
  kind: OrientationKind;
  basis: ShBasis;
  tensorOrder: TensorOrder;
  /** RAS directions to the data's frame: a row-major 3 × 3, orthogonal (rotations and flips). */
  toData: number[];
  normalise: Normalise;
  /** Tensors as ellipsoids, or as lines along the principal direction. */
  tensorGlyph: "ellipsoid" | "line";
  /** The sphere's subdivisions (2: 162 vertices, 3: 642). */
  subdivisions: number;
  /** Leave out glyphs less anisotropic than this (GFA for SH, FA for tensors), 0..1. */
  minAnisotropy?: number;
}

export interface GlyphSet {
  shape: "surface" | "lines";
  count: number;
  /** Each glyph's centre, RAS mm. */
  centres: Float32Array;
  /** Surfaces: each glyph's radius at each sphere vertex (count × vertices), 0..1. */
  radii?: Float32Array;
  subdivisions?: number;
  /** Lines: half of each line, RAS, length 0..1 (in half-voxels once drawn). */
  dirs?: Float32Array;
  /** One colour per glyph (r, g, b); surfaces without them take each point's direction. */
  colours?: Float32Array;
}

/** Voxel (x, y, z) to RAS mm: a row-major 4 × 4. */
type Mat4 = ArrayLike<number>;

function centreOf(voxelToRas: Mat4, x: number, y: number, z: number, out: Float32Array, at: number): void {
  for (let r = 0; r < 3; ++r) out[at + r] = voxelToRas[4 * r] * x + voxelToRas[4 * r + 1] * y + voxelToRas[4 * r + 2] * z + voxelToRas[4 * r + 3];
}

/** M v for a row-major 3 × 3. */
function times(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

/** Mᵀ v: data to RAS, for an orthogonal M. */
function timesT(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
}

/**
 * The rotation (and flips) from RAS directions to a level's voxel axes: its
 * voxel-to-RAS matrix's columns, made unit length, transposed (so the
 * inverse for a matrix without shear).
 */
export function voxelFrame(voxelToRas: Mat4): number[] {
  const out: number[] = [];
  for (let c = 0; c < 3; ++c) {
    const col = [voxelToRas[c], voxelToRas[4 + c], voxelToRas[8 + c]];
    const n = Math.hypot(col[0], col[1], col[2]) || 1;
    out.push(col[0] / n, col[1] / n, col[2] / n);
  }
  return out;
}

/** A frame with axes flipped: flips[k] negates the data's axis k. */
export function withFlips(toData: number[], flips: [boolean, boolean, boolean]): number[] {
  return toData.map((v, i) => (flips[Math.floor(i / 3)] ? -v : v));
}

const matrices = new Map<string, Float32Array>();

/** The basis at the sphere's vertices turned into the data's frame (cached: the same for every set). */
function basisAtSphere(basis: ShBasis, lmax: number, subdivisions: number, toData: number[]): Float32Array {
  const key = `${basis}|${lmax}|${subdivisions}|${toData.map((v) => v.toFixed(6)).join(",")}`;
  let m = matrices.get(key);
  if (m === undefined) {
    const { vertices, count } = icosphere(subdivisions);
    const dirs = new Float32Array(3 * count);
    for (let v = 0; v < count; ++v) dirs.set(times(toData, vertices[3 * v], vertices[3 * v + 1], vertices[3 * v + 2]), 3 * v);
    m = shMatrix(basis, lmax, dirs);
    if (matrices.size > 16) matrices.clear();
    matrices.set(key, m);
  }
  return m;
}

/**
 * Whether a voxel has no glyph: every component zero; or, when `partial` is
 * false, any component not a number.  Peaks may leave some slots NaN (as
 * MRtrix's sh2peaks does for a voxel with fewer peaks than slots), so for
 * them only a voxel with no number at all is empty.
 */
function empty(values: ArrayLike<number>, offset: number, n: number, partial: boolean): boolean {
  let any = false;
  for (let c = 0; c < n; ++c) {
    const v = values[offset + c];
    if (v !== v) {
      if (!partial) return true;
    } else if (v !== 0) any = true;
  }
  return !any;
}

/** The glyphs of some voxels (indices x, y, z; `components` values each), on a level placed by `voxelToRas`. */
export function computeGlyphs(indices: ArrayLike<number>, values: Float32Array, components: number, voxelToRas: Mat4, options: GlyphOptions): GlyphSet {
  const count = Math.floor(indices.length / 3);
  let kept: number[] = [];
  const partial = options.kind === "peaks" || options.kind === "vector";
  for (let i = 0; i < count; ++i) if (!empty(values, i * components, components, partial)) kept.push(i);
  const least = options.minAnisotropy ?? 0;
  if (least > 0 && options.kind === "sh" && lmaxOf(components) !== undefined) kept = kept.filter((i) => gfa(values, i * components, components, options.basis) >= least);
  const centresOf = (list: number[]) => {
    const centres = new Float32Array(3 * list.length);
    list.forEach((i, k) => centreOf(voxelToRas, indices[3 * i], indices[3 * i + 1], indices[3 * i + 2], centres, 3 * k));
    return centres;
  };
  const { kind, toData } = options;
  if (kind === "sh") {
    const lmax = lmaxOf(components);
    if (lmax === undefined) throw new Error(`${components} components is not a spherical-harmonic order (6, 15, 28, 45, 66, …)`);
    const sphere = icosphere(options.subdivisions);
    const nv = sphere.count;
    const matrix = basisAtSphere(options.basis, lmax, options.subdivisions, toData);
    const radii = new Float32Array(kept.length * nv);
    const row = new Float32Array(nv);
    let globalMax = 0;
    kept.forEach((i, k) => {
      evaluate(matrix, components, values, i * components, row);
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < nv; ++v) {
        lo = Math.min(lo, row[v]);
        hi = Math.max(hi, row[v]);
      }
      const out = radii.subarray(k * nv, (k + 1) * nv);
      if (options.normalise === "minmax") {
        const span = hi - lo;
        if (span > 1e-12 * Math.max(Math.abs(hi), 1e-30)) for (let v = 0; v < nv; ++v) out[v] = (row[v] - lo) / span;
        else out.fill(1);
      } else {
        for (let v = 0; v < nv; ++v) out[v] = Math.max(0, row[v]);
        if (options.normalise === "max") {
          if (hi > 0) for (let v = 0; v < nv; ++v) out[v] /= hi;
        } else globalMax = Math.max(globalMax, hi);
      }
    });
    if (options.normalise === "none" && globalMax > 0) for (let j = 0; j < radii.length; ++j) radii[j] /= globalMax;
    return { shape: "surface", count: kept.length, centres: centresOf(kept), radii, subdivisions: options.subdivisions };
  }
  if (kind === "tensor") {
    if (components !== 6) throw new Error(`tensors have 6 components, not ${components}`);
    const m = new Float64Array(9);
    let eigens = kept.map((i) => eigenSymmetric(tensorMatrix(values, i * components, options.tensorOrder, m)));
    if (least > 0) {
      const anisotropic = eigens.map((e) => fractionalAnisotropy(e.values) >= least);
      kept = kept.filter((_, k) => anisotropic[k]);
      eigens = eigens.filter((_, k) => anisotropic[k]);
    }
    const colours = new Float32Array(3 * kept.length);
    let globalMax = 0;
    for (const e of eigens) globalMax = Math.max(globalMax, e.values[0]);
    eigens.forEach((e, k) => {
      const fa = fractionalAnisotropy(e.values);
      const d = timesT(toData, e.vectors[0], e.vectors[1], e.vectors[2]);
      const shade = 0.3 + 0.7 * fa;
      for (let r = 0; r < 3; ++r) colours[3 * k + r] = Math.abs(d[r]) * shade;
    });
    if (options.tensorGlyph === "line") {
      const dirs = new Float32Array(3 * kept.length);
      eigens.forEach((e, k) => {
        const d = timesT(toData, e.vectors[0], e.vectors[1], e.vectors[2]);
        const length = options.normalise === "none" && globalMax > 0 ? Math.max(0, e.values[0]) / globalMax : 1;
        for (let r = 0; r < 3; ++r) dirs[3 * k + r] = d[r] * length;
      });
      return { shape: "lines", count: kept.length, centres: centresOf(kept), dirs, colours };
    }
    const sphere = icosphere(options.subdivisions);
    const nv = sphere.count;
    const radii = new Float32Array(kept.length * nv);
    // The sphere's directions in the data's frame.
    const dirs = new Float32Array(3 * nv);
    for (let v = 0; v < nv; ++v) dirs.set(times(toData, sphere.vertices[3 * v], sphere.vertices[3 * v + 1], sphere.vertices[3 * v + 2]), 3 * v);
    eigens.forEach((e, k) => {
      const l1 = e.values[0];
      const size = options.normalise === "none" && globalMax > 0 ? Math.max(0, l1) / globalMax : 1;
      // Semi-axes relative to the longest, never quite flat, so a disc still shows.
      const axes = e.values.map((l) => (l1 > 0 ? Math.max(0.08, Math.max(0, l) / l1) : 1));
      const inv = axes.map((a) => 1 / (a * a));
      const v0 = e.vectors;
      for (let v = 0; v < nv; ++v) {
        const x = dirs[3 * v];
        const y = dirs[3 * v + 1];
        const z = dirs[3 * v + 2];
        let s = 0;
        for (let a = 0; a < 3; ++a) {
          const dot = x * v0[3 * a] + y * v0[3 * a + 1] + z * v0[3 * a + 2];
          s += dot * dot * inv[a];
        }
        radii[k * nv + v] = (size / Math.sqrt(s)) || 0;
      }
    });
    return { shape: "surface", count: kept.length, centres: centresOf(kept), radii, subdivisions: options.subdivisions, colours };
  }
  // Vectors (3 components) and peaks (3 per peak): lines.
  if (components % 3 !== 0) throw new Error(`${components} components are not whole vectors (3 each)`);
  const perVoxel = kind === "vector" ? 1 : components / 3;
  const lines: { voxel: number; d: [number, number, number]; length: number }[] = [];
  let globalMax = 0;
  for (const i of kept) {
    let voxelMax = 0;
    const own: { d: [number, number, number]; length: number }[] = [];
    for (let p = 0; p < perVoxel; ++p) {
      const o = i * components + 3 * p;
      const length = Math.hypot(values[o], values[o + 1], values[o + 2]);
      if (!(length > 0)) continue;
      const d = timesT(toData, values[o] / length, values[o + 1] / length, values[o + 2] / length);
      own.push({ d, length });
      voxelMax = Math.max(voxelMax, length);
    }
    globalMax = Math.max(globalMax, voxelMax);
    for (const line of own) lines.push({ voxel: i, d: line.d, length: options.normalise === "none" ? line.length : line.length / voxelMax });
  }
  const centres = centresOf(lines.map((l) => l.voxel));
  const dirs = new Float32Array(3 * lines.length);
  const colours = new Float32Array(3 * lines.length);
  lines.forEach(({ d, length }, k) => {
    const scale = options.normalise === "none" ? (globalMax > 0 ? length / globalMax : 0) : length;
    for (let r = 0; r < 3; ++r) {
      dirs[3 * k + r] = d[r] * scale;
      colours[3 * k + r] = Math.abs(d[r]);
    }
  });
  return { shape: "lines", count: lines.length, centres, dirs, colours };
}
