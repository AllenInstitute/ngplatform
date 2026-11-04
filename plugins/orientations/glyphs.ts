/**
 * Glyphs from voxels: what each voxel's components look like as a shape.
 *
 * - Spherical harmonics: the surface at radius f(d) towards each direction
 *   d, min-max normalised per voxel by default (FURY's odf_slicer, from the
 *   values at a sphere's vertices), coloured by each point's direction;
 *   given by its coefficients (the renderer ray-casts it, no mesh).
 * - Tensors: an ellipsoid with axes along the eigenvectors, as long as the
 *   eigenvalues (the largest 1), coloured by the principal direction
 *   (|x|, |y|, |z|, dimmed where the anisotropy is low), given by its three
 *   semi-axes (the renderer ray-casts it, no mesh); or a line along the
 *   principal direction.
 * - Vectors and peaks: lines through the voxel's centre, both ways (fibre
 *   directions have no sign), coloured by direction.
 *
 * Glyphs are placed in RAS millimetres; directions in the data are in the
 * data's own frame (the voxel axes or the world's), so each is turned into
 * RAS with `toData` (RAS → data, orthogonal).  Plain code: the worker runs
 * it, and the tests check it.
 */
import { canonicalTerms, evaluate, evaluateMonomials, gfa, lmaxOf, type ShBasis, shMatrix, toCanonical, toMonomials } from "./sh.js";
import { icosphere, type Sphere } from "./sphere.js";
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
  /** Spherical harmonics as ODF shapes, or as lines along each ODF's peaks (as MRtrix's sh2peaks). */
  shGlyph?: "odf" | "peaks";
  /** The sphere's subdivisions (2: 162 vertices, 3: 642). */
  subdivisions: number;
  /** Leave out glyphs less anisotropic than this (GFA for SH, FA for tensors), 0..1. */
  minAnisotropy?: number;
}

export interface GlyphSet {
  /** ODFs (ray-cast from their coefficients), ellipsoids (tensors, ray-cast), or lines. */
  shape: "odfs" | "ellipsoids" | "lines";
  count: number;
  /** Each glyph's centre, RAS mm. */
  centres: Float32Array;
  /**
   * ODFs: each glyph's coefficients as a polynomial's monomials (sh.ts,
   * `monomials`), the normalisation folded in, so the glyph's radius
   * towards a direction d (RAS) is max(0, f(toData d)): about 0..1.
   */
  coefficients?: Float32Array;
  lmax?: number;
  /** ODFs: a radius each glyph stays within. */
  bounds?: Float32Array;
  /** ODFs: RAS directions to the data's frame, row-major 3 × 3. */
  toData?: number[];
  /** Ellipsoids: each glyph's three semi-axes, RAS (9 a glyph, orthogonal, the longest at most 1). */
  axes?: Float32Array;
  /** Lines: half of each line, RAS, length 0..1 (in half-voxels once drawn). */
  dirs?: Float32Array;
  /** One colour per glyph (r, g, b); ODFs take each point's direction instead. */
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
export function basisAtSphere(basis: ShBasis, lmax: number, subdivisions: number, toData: number[]): Float32Array {
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
  if (kind === "sh" && options.shGlyph === "peaks") {
    const lmax = lmaxOf(components);
    if (lmax === undefined) throw new Error(`${components} components is not a spherical-harmonic order (6, 15, 28, 45, 66, …)`);
    // Peaks want a fine sphere whatever the glyphs' size: 642 points, about 8° apart.
    const sphere = icosphere(3);
    const matrix = basisAtSphere(options.basis, lmax, 3, toData);
    const row = new Float32Array(sphere.count);
    const lines: { voxel: number; v: number; length: number }[] = [];
    let globalMax = 0;
    for (const i of kept) {
      evaluate(matrix, components, values, i * components, row);
      const peaks = odfPeaks(row, sphere);
      if (peaks.length === 0) continue;
      const top = peaks[0].value;
      globalMax = Math.max(globalMax, top);
      for (const p of peaks) lines.push({ voxel: i, v: p.vertex, length: options.normalise === "none" ? p.value : p.value / top });
    }
    const centres = centresOf(lines.map((l) => l.voxel));
    const dirs = new Float32Array(3 * lines.length);
    const colours = new Float32Array(3 * lines.length);
    lines.forEach(({ v, length }, k) => {
      const scale = options.normalise === "none" ? (globalMax > 0 ? length / globalMax : 0) : length;
      for (let r = 0; r < 3; ++r) {
        const d = sphere.vertices[3 * v + r];
        dirs[3 * k + r] = d * scale;
        colours[3 * k + r] = Math.abs(d);
      }
    });
    return { shape: "lines", count: lines.length, centres, dirs, colours };
  }
  if (kind === "sh") {
    const lmax = lmaxOf(components);
    if (lmax === undefined) throw new Error(`${components} components is not a spherical-harmonic order (6, 15, 28, 45, 66, …)`);
    // The normalisation (min-max, as FURY's odf_slicer) from the values at
    // a sphere's vertices, as the meshes had it; but the highest is found
    // between them (each high vertex climbed to its peak), since the
    // ray-cast surface is the function itself, not cut flat at the vertices.
    // So 162 vertices do (a lowest a little high only sinks the glyph's
    // narrowest waist to its centre).
    const subdivisions = Math.min(2, options.subdivisions);
    const sphere = icosphere(subdivisions);
    const nv = sphere.count;
    const matrix = basisAtSphere(options.basis, lmax, subdivisions, toData);
    const terms = canonicalTerms(options.basis, lmax);
    const coefficients = new Float32Array(kept.length * components);
    const bounds = new Float32Array(kept.length);
    const row = new Float32Array(nv);
    // The vertices in the data's frame, where the polynomial is evaluated.
    const dataDirs = new Float64Array(3 * nv);
    for (let v = 0; v < nv; ++v) dataDirs.set(times(toData, sphere.vertices[3 * v], sphere.vertices[3 * v + 1], sphere.vertices[3 * v + 2]), 3 * v);
    // One of each opposite pair (the function is even).
    const upper = (v: number) => {
      const [x, y, z] = sphere.vertices.subarray(3 * v, 3 * v + 3);
      return z > 1e-9 || (z > -1e-9 && (y > 1e-9 || (y > -1e-9 && x > 0)));
    };
    // Half the distance between neighbouring vertices, radians.
    const spacing = (1.1 * 2 ** -subdivisions) / 2;
    const highs = new Float32Array(kept.length);
    // The polynomial of the constant 1: what b (below) adds.
    const one = new Float64Array(components);
    toMonomials(lmax, Float64Array.from({ length: components }, (_, j) => (j === 0 ? 1 : 0)), 0, one, 0);
    const canonical = new Float64Array(components);
    const poly = new Float64Array(components);
    let globalMax = 0;
    kept.forEach((i, k) => {
      evaluate(matrix, components, values, i * components, row);
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < nv; ++v) {
        lo = Math.min(lo, row[v]);
        hi = Math.max(hi, row[v]);
      }
      toCanonical(terms, values, i * components, 1, canonical, 0);
      toMonomials(lmax, canonical, 0, poly, 0);
      let top = hi;
      for (let v = 0; v < nv; ++v) {
        const value = row[v];
        if (value < hi - 0.3 * (hi - lo) || !upper(v) || sphere.rings[v].some((n) => row[n] > value)) continue;
        top = Math.max(top, climb(poly, lmax, dataDirs[3 * v], dataDirs[3 * v + 1], dataDirs[3 * v + 2], value, spacing));
      }
      // Radius = max(0, a f + b).
      let a = 1;
      let b = 0;
      if (options.normalise === "minmax") {
        const span = top - lo;
        if (span > 1e-12 * Math.max(Math.abs(top), 1e-30)) [a, b] = [1 / span, -lo / span];
        else [a, b] = [0, 1];
      } else if (options.normalise === "max") a = top > 0 ? 1 / top : 0;
      else globalMax = Math.max(globalMax, top);
      const at = k * components;
      for (let j = 0; j < components; ++j) coefficients[at + j] = a * poly[j] + b * one[j];
      highs[k] = Math.max(0, a * top + b);
    });
    if (options.normalise === "none") {
      const a = globalMax > 0 ? 1 / globalMax : 0;
      for (let j = 0; j < coefficients.length; ++j) coefficients[j] *= a;
      for (let k = 0; k < kept.length; ++k) highs[k] *= a;
    }
    // A little more than the peak found, for float rounding in the shader.
    for (let k = 0; k < kept.length; ++k) bounds[k] = Math.max(1e-3, highs[k] * 1.02);
    return { shape: "odfs", count: kept.length, centres: centresOf(kept), lmax, coefficients, bounds, toData: [...toData] };
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
    const axes = new Float32Array(9 * kept.length);
    eigens.forEach((e, k) => {
      const l1 = e.values[0];
      const size = options.normalise === "none" && globalMax > 0 ? Math.max(0, l1) / globalMax : 1;
      for (let a = 0; a < 3; ++a) {
        // Semi-axes relative to the longest, never quite flat, so a disc still shows.
        const length = size * (l1 > 0 ? Math.max(0.08, Math.max(0, e.values[a]) / l1) : 1);
        const d = timesT(toData, e.vectors[3 * a], e.vectors[3 * a + 1], e.vectors[3 * a + 2]);
        for (let r = 0; r < 3; ++r) axes[9 * k + 3 * a + r] = d[r] * length;
      }
    });
    return { shape: "ellipsoids", count: kept.length, centres: centresOf(kept), axes, colours };
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

const antipodes = new Map<Sphere, Uint32Array>();

/** Each vertex's opposite (an icosphere has one for every vertex). */
function antipodeOf(sphere: Sphere): Uint32Array {
  let out = antipodes.get(sphere);
  if (out === undefined) {
    const { vertices: v, count } = sphere;
    out = new Uint32Array(count);
    for (let i = 0; i < count; ++i) {
      let best = 0;
      let bestDot = Infinity;
      for (let j = 0; j < count; ++j) {
        const dot = v[3 * i] * v[3 * j] + v[3 * i + 1] * v[3 * j + 1] + v[3 * i + 2] * v[3 * j + 2];
        if (dot < bestDot) [best, bestDot] = [j, dot];
      }
      out[i] = best;
    }
    antipodes.set(sphere, out);
  }
  return out;
}

/**
 * An ODF's peaks: the sphere's vertices at least as high as every
 * neighbour, positive, and at least `relative` of the highest, one of each
 * opposite pair, highest first, at most `most`.  Directions are the
 * vertices' (RAS: the values were evaluated at RAS directions).
 */
export function odfPeaks(values: ArrayLike<number>, sphere: Sphere, relative = 0.5, most = 3): { vertex: number; value: number }[] {
  const opposite = antipodeOf(sphere);
  const found: { vertex: number; value: number }[] = [];
  for (let v = 0; v < sphere.count; ++v) {
    const value = values[v];
    if (!(value > 0)) continue;
    if (sphere.rings[v].every((n) => values[n] <= value)) found.push({ vertex: v, value });
  }
  found.sort((a, b) => b.value - a.value);
  const out: { vertex: number; value: number }[] = [];
  const taken = new Set<number>();
  for (const p of found) {
    if (out.length >= most || p.value < relative * (found[0]?.value ?? 0)) break;
    if (taken.has(p.vertex) || taken.has(opposite[p.vertex])) continue;
    // Plateaus give neighbouring maxima: keep only one.
    if (sphere.rings[p.vertex].some((n) => taken.has(n) || taken.has(opposite[n]))) continue;
    taken.add(p.vertex);
    out.push(p);
  }
  return out;
}

/**
 * From a direction (the data's frame, unit) where a polynomial (monomials)
 * has `value`, Newton steps on the sphere towards the peak nearby: the
 * gradient and curvature from five more values `h` away (first half the
 * vertices' spacing, then finer), a step to where the quadratic peaks (or
 * along the gradient where it does not, at most `reach`); the highest value
 * met.  About a dozen evaluations, where stepping about took fifty.
 */
function climb(c: ArrayLike<number>, lmax: number, x: number, y: number, z: number, value: number, reach: number): number {
  let best = value;
  const at = (px: number, py: number, pz: number) => {
    const n = Math.hypot(px, py, pz);
    return evaluateMonomials(c, 0, lmax, px / n, py / n, pz / n);
  };
  for (const h of [reach / 2, reach / 16, reach / 128]) {
    // Two directions across the sphere at (x, y, z).
    const [ax, ay, az] = Math.abs(x) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = y * az - z * ay;
    let uy = z * ax - x * az;
    let uz = x * ay - y * ax;
    const un = Math.hypot(ux, uy, uz);
    [ux, uy, uz] = [ux / un, uy / un, uz / un];
    const vx = y * uz - z * uy;
    const vy = z * ux - x * uz;
    const vz = x * uy - y * ux;
    const f0 = best;
    const fu = at(x + h * ux, y + h * uy, z + h * uz);
    const fU = at(x - h * ux, y - h * uy, z - h * uz);
    const fv = at(x + h * vx, y + h * vy, z + h * vz);
    const fV = at(x - h * vx, y - h * vy, z - h * vz);
    const fuv = at(x + h * (ux + vx), y + h * (uy + vy), z + h * (uz + vz));
    const gu = (fu - fU) / (2 * h);
    const gv = (fv - fV) / (2 * h);
    const huu = (fu + fU - 2 * f0) / (h * h);
    const hvv = (fv + fV - 2 * f0) / (h * h);
    const huv = (fuv - fu - fv + f0) / (h * h);
    const det = huu * hvv - huv * huv;
    let du: number;
    let dv: number;
    if (huu < 0 && det > 0) {
      // Newton: the quadratic's peak.
      du = -(hvv * gu - huv * gv) / det;
      dv = -(huu * gv - huv * gu) / det;
    } else {
      [du, dv] = [gu, gv];
    }
    const length = Math.hypot(du, dv);
    if (length > reach) [du, dv] = [(du * reach) / length, (dv * reach) / length];
    const fN = at(x + du * ux + dv * vx, y + du * uy + dv * vy, z + du * uz + dv * vz);
    // Move to the highest of the samples and the step's point, if any is higher.
    let pick: [number, number] | undefined;
    for (const [f, p, q] of [
      [fu, h, 0],
      [fU, -h, 0],
      [fv, 0, h],
      [fV, 0, -h],
      [fuv, h, h],
      [fN, du, dv],
    ]) {
      if (f > best) [best, pick] = [f, [p, q]];
    }
    if (pick !== undefined) {
      const [p, q] = pick;
      const nx = x + p * ux + q * vx;
      const ny = y + p * uy + q * vy;
      const nz = z + p * uz + q * vz;
      const n = Math.hypot(nx, ny, nz);
      [x, y, z] = [nx / n, ny / n, nz / n];
    }
  }
  return best;
}

/** An ODF glyph's radius towards a unit RAS direction: what the shader finds (for tests and checks). */
export function odfRadius(set: GlyphSet, glyph: number, d: ArrayLike<number>): number {
  const n = ((set.lmax! + 1) * (set.lmax! + 2)) / 2;
  const [x, y, z] = times(set.toData!, d[0], d[1], d[2]);
  return Math.max(0, evaluateMonomials(set.coefficients!, glyph * n, set.lmax!, x, y, z));
}
