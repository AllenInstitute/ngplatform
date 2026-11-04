/**
 * Real, symmetric spherical harmonics (even orders only), in the bases
 * diffusion software writes ODFs and fibre orientation distributions in.
 * Coefficients are ordered by order l = 0, 2, 4, … and, within an order, by
 * degree m = -l … l, as DIPY and MRtrix both store them, so an image with
 * lmax 8 has 45 per voxel.
 *
 * The four bases are DIPY's definitions (dipy.reconst.shm), built on the
 * complex harmonics Y_l^m of scipy.special.sph_harm (with the
 * Condon-Shortley phase):
 *
 *  - descoteaux07 (legacy; DIPY's default): m < 0: √2 Re Y_l^|m|, m = 0:
 *    Y_l^0, m > 0: √2 Im Y_l^m.
 *  - descoteaux07 (DIPY's newer form, legacy=False): m < 0 takes √2 Re
 *    Y_l^m with m negative, which is (-1)^m times the legacy term.
 *  - tournier07 (MRtrix3, and DIPY legacy=False): m < 0: √2 Im Y_l^|m|,
 *    m = 0: Y_l^0, m > 0: √2 Re Y_l^m.
 *  - tournier07 legacy (MRtrix 0.2): the same without the √2.
 *
 * Plain code, tested against values DIPY gives (tests/sh.test.ts).
 */

export type ShBasis = "descoteaux07-legacy" | "descoteaux07" | "tournier07" | "tournier07-legacy";

export const SH_BASES: [ShBasis, string][] = [
  ["descoteaux07-legacy", "descoteaux07 (DIPY's default, legacy)"],
  ["descoteaux07", "descoteaux07 (DIPY, legacy=False)"],
  ["tournier07", "tournier07 (MRtrix3)"],
  ["tournier07-legacy", "tournier07 legacy (MRtrix 0.2)"],
];

/** Coefficients of a symmetric basis up to order `lmax`: 1, 6, 15, 28, 45, 66, 91 for 0, 2, …, 12. */
export function coefficientCount(lmax: number): number {
  return ((lmax + 1) * (lmax + 2)) / 2;
}

/** The order a coefficient count stands for, or undefined if it is not one. */
export function lmaxOf(count: number): number | undefined {
  for (let l = 0; l <= 20; l += 2) if (coefficientCount(l) === count) return l;
  return undefined;
}

/** Each coefficient's order and degree, in storage order. */
export function shIndices(lmax: number): { l: number; m: number }[] {
  const out: { l: number; m: number }[] = [];
  for (let l = 0; l <= lmax; l += 2) for (let m = -l; m <= l; ++m) out.push({ l, m: m || 0 });
  return out;
}

/**
 * The associated Legendre functions P_l^m(x) for 0 ≤ m ≤ l ≤ lmax, with the
 * Condon-Shortley phase (as scipy's lpmv), indexed [l * (lmax + 1) + m].
 */
export function legendre(lmax: number, x: number): Float64Array {
  const n = lmax + 1;
  const p = new Float64Array(n * n);
  const s = Math.sqrt(Math.max(0, 1 - x * x));
  let pmm = 1;
  for (let m = 0; m <= lmax; ++m) {
    if (m > 0) pmm *= -(2 * m - 1) * s;
    p[m * n + m] = pmm;
    if (m + 1 <= lmax) p[(m + 1) * n + m] = x * (2 * m + 1) * pmm;
    for (let l = m + 2; l <= lmax; ++l) p[l * n + m] = ((2 * l - 1) * x * p[(l - 1) * n + m] - (l + m - 1) * p[(l - 2) * n + m]) / (l - m);
  }
  return p;
}

/** sqrt((2l + 1) / 4π · (l - m)! / (l + m)!), for m ≥ 0. */
function norm(l: number, m: number): number {
  let ratio = 1;
  for (let k = l - m + 1; k <= l + m; ++k) ratio /= k;
  return Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * ratio);
}

/**
 * The basis evaluated at unit directions (x, y, z per row of `dirs`): a
 * row-major matrix, one row per direction, one column per coefficient, so
 * a voxel's values on the sphere are this matrix times its coefficients.
 */
export function shMatrix(basis: ShBasis, lmax: number, dirs: ArrayLike<number>): Float32Array {
  const count = coefficientCount(lmax);
  const rows = Math.floor(dirs.length / 3);
  const out = new Float32Array(rows * count);
  const n = lmax + 1;
  const norms = new Float64Array(n * n);
  for (let l = 0; l <= lmax; ++l) for (let m = 0; m <= l; ++m) norms[l * n + m] = norm(l, m);
  const indices = shIndices(lmax);
  for (let r = 0; r < rows; ++r) {
    const x = dirs[3 * r];
    const y = dirs[3 * r + 1];
    const z = dirs[3 * r + 2];
    const len = Math.hypot(x, y, z) || 1;
    const cosTheta = Math.max(-1, Math.min(1, z / len));
    const phi = Math.atan2(y, x);
    const p = legendre(lmax, cosTheta);
    for (let j = 0; j < count; ++j) {
      const { l, m } = indices[j];
      const a = Math.abs(m);
      // The complex harmonic Y_l^|m| = k (cos |m|φ + i sin |m|φ).
      const k = norms[l * n + a] * p[l * n + a];
      let v: number;
      if (m === 0) v = k;
      else if (basis === "descoteaux07-legacy") v = Math.SQRT2 * k * (m < 0 ? Math.cos(a * phi) : Math.sin(a * phi));
      else if (basis === "descoteaux07") v = Math.SQRT2 * k * (m < 0 ? (a % 2 === 1 ? -1 : 1) * Math.cos(a * phi) : Math.sin(a * phi));
      else {
        const t = m < 0 ? Math.sin(a * phi) : Math.cos(a * phi);
        v = basis === "tournier07" ? Math.SQRT2 * k * t : k * t;
      }
      out[r * count + j] = v;
    }
  }
  return out;
}

/** Values on the sphere: `matrix` (rows × count) times `coefficients` (count, from `offset`), into `out`. */
export function evaluate(matrix: Float32Array, count: number, coefficients: ArrayLike<number>, offset: number, out: Float32Array): Float32Array {
  const rows = out.length;
  for (let r = 0; r < rows; ++r) {
    let s = 0;
    const base = r * count;
    for (let j = 0; j < count; ++j) s += matrix[base + j] * coefficients[offset + j];
    out[r] = s;
  }
  return out;
}

/**
 * The generalised fractional anisotropy of an ODF from its coefficients in
 * an orthonormal basis: sqrt(1 - c0² / Σ c²) (Tuch's GFA, as the norms on
 * the sphere give it).  The MRtrix 0.2 basis is not orthonormal; its
 * higher terms are scaled by √2 first.
 */
export function gfa(coefficients: ArrayLike<number>, offset: number, count: number, basis: ShBasis): number {
  const c0 = coefficients[offset];
  let total = c0 * c0;
  const scale = basis === "tournier07-legacy" ? 2 : 1;
  const indices = shIndices(lmaxOf(count) ?? 0);
  for (let j = 1; j < count; ++j) {
    const c = coefficients[offset + j];
    total += (indices[j].m === 0 ? 1 : scale) * c * c;
  }
  return total > 0 ? Math.sqrt(Math.max(0, 1 - (c0 * c0) / total)) : 0;
}

/**
 * The l = 2 part of an SH function as a quadratic form: for each of the
 * five l = 2 coefficients (j = 1 … 5), the symmetric matrix Q_j (row-major
 * 3 × 3, traceless) with Y_j(d) = dᵀ Q_j d on the unit sphere.  The
 * principal eigenvector of Σ c_j Q_j is an ODF's dominant direction, which
 * a shader can find (the image layer's direction colour).
 */
export function quadraticForms(basis: ShBasis): Float64Array[] {
  // Y_j is a harmonic polynomial of degree 2: dᵀ Q d with Q traceless, so
  // six samples fix Q's six entries.
  const samples = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [Math.SQRT1_2, Math.SQRT1_2, 0],
    [Math.SQRT1_2, 0, Math.SQRT1_2],
    [0, Math.SQRT1_2, Math.SQRT1_2],
  ];
  const values = shMatrix(basis, 2, samples.flat());
  const out: Float64Array[] = [];
  for (let j = 1; j <= 5; ++j) {
    const v = (s: number) => values[s * 6 + j];
    const xx = v(0);
    const yy = v(1);
    const zz = v(2);
    // dᵀ Q d at (1, 1, 0)/√2 = (xx + yy) / 2 + xy.
    const xy = v(3) - (xx + yy) / 2;
    const xz = v(4) - (xx + zz) / 2;
    const yz = v(5) - (yy + zz) / 2;
    out.push(Float64Array.from([xx, xy, xz, xy, yy, yz, xz, yz, zz]));
  }
  return out;
}

/**
 * Least-squares coefficients of a function sampled at unit directions
 * (x y z per row): what fitting an ODF on a sphere gives, for test data and
 * conversions.  `smooth` adds Laplace-Beltrami regularisation (λ l²(l+1)²),
 * as DIPY's sf_to_sh does.
 */
export function fitSh(basis: ShBasis, lmax: number, dirs: ArrayLike<number>, values: ArrayLike<number>, smooth = 0): Float64Array {
  const b = shMatrix(basis, lmax, dirs);
  const n = coefficientCount(lmax);
  const rows = values.length;
  const indices = shIndices(lmax);
  // Normal equations (BᵀB + λL) c = Bᵀf, solved by Gaussian elimination.
  const a = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let r = 0; r < rows; ++r) {
    for (let i = 0; i < n; ++i) {
      const bi = b[r * n + i];
      a[i][n] += bi * values[r];
      for (let j = 0; j < n; ++j) a[i][j] += bi * b[r * n + j];
    }
  }
  for (let i = 0; i < n; ++i) {
    const l = indices[i].l;
    a[i][i] += smooth * l * l * (l + 1) * (l + 1);
  }
  for (let c = 0; c < n; ++c) {
    let pivot = c;
    for (let r = c + 1; r < n; ++r) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const p = a[c][c];
    for (let k = c; k <= n; ++k) a[c][k] /= p;
    for (let r = 0; r < n; ++r) {
      if (r === c || a[r][c] === 0) continue;
      const f = a[r][c];
      for (let k = c; k <= n; ++k) a[r][k] -= f * a[c][k];
    }
  }
  return Float64Array.from(a, (row) => row[n]);
}

/**
 * The canonical form the ray-cast ODF shader evaluates, the same for every
 * basis: for each even order l, the terms
 *
 *   P̄_l^m(z) · (C_lm Re (x + iy)^m + S_lm Im (x + iy)^m),  m = 0 … l,
 *
 * where P̄_l^m is the associated Legendre function without its sin^m θ
 * (P_l^m = sin^m θ P̄_l^m, P̄_m^m = (-1)^m (2m - 1)!!) and, on the unit
 * sphere, sin^m θ cos mφ = Re (x + iy)^m.  All of it is polynomial in x, y
 * and z: no angles, nothing to divide by at the poles.  The coefficients
 * are stored by order, 2l + 1 an order as the bases have them: C_l0, then
 * C_l1, S_l1, C_l2, S_l2, …  Each of a basis's coefficients becomes one of
 * these times its normalisation (and √2, and a sign); `canonicalTerms`
 * gives, for each, where it goes and that factor.
 */
export function canonicalTerms(basis: ShBasis, lmax: number): { index: Int32Array; factor: Float64Array } {
  const indices = shIndices(lmax);
  const index = new Int32Array(indices.length);
  const factor = new Float64Array(indices.length);
  indices.forEach(({ l, m }, j) => {
    const a = Math.abs(m);
    const offset = (l * (l - 1)) / 2;
    const k = norm(l, a);
    if (m === 0) {
      index[j] = offset;
      factor[j] = k;
      return;
    }
    // Whether the term takes the cosine (C) or the sine (S), and its factor.
    let cos: boolean;
    let f = Math.SQRT2 * k;
    if (basis === "descoteaux07-legacy") cos = m < 0;
    else if (basis === "descoteaux07") {
      cos = m < 0;
      if (m < 0 && a % 2 === 1) f = -f;
    } else {
      cos = m > 0;
      if (basis === "tournier07-legacy") f = k;
    }
    index[j] = offset + (cos ? 2 * a - 1 : 2 * a);
    factor[j] = f;
  });
  return { index, factor };
}

/** A voxel's coefficients (from `offset`) in the canonical form, each times `scale`, into `out` from `at`. */
export function toCanonical(terms: { index: Int32Array; factor: Float64Array }, coefficients: ArrayLike<number>, offset: number, scale: number, out: Float32Array | Float64Array, at: number): void {
  const { index, factor } = terms;
  for (let j = 0; j < index.length; ++j) out[at + index[j]] = coefficients[offset + j] * factor[j] * scale;
}

/**
 * A canonical-form function (coefficients from `offset`) at a unit
 * direction, by the Legendre recurrences, with no angles (for tests: the
 * shader sums the polynomial of `monomialMatrix` instead).
 */
export function evaluateCanonical(c: ArrayLike<number>, offset: number, lmax: number, x: number, y: number, z: number): number {
  let sum = 0;
  let cr = 1;
  let ci = 0;
  let pmm = 1;
  for (let m = 0; m <= lmax; ++m) {
    if (m > 0) {
      const r = cr * x - ci * y;
      ci = cr * y + ci * x;
      cr = r;
      pmm *= -(2 * m - 1);
    }
    let p1 = 0;
    let p2 = 0;
    for (let l = m; l <= lmax; ++l) {
      const p = l === m ? pmm : l === m + 1 ? z * (2 * m + 1) * pmm : ((2 * l - 1) * z * p1 - (l + m - 1) * p2) / (l - m);
      p2 = p1;
      p1 = p;
      if (l % 2 === 1) continue;
      const base = offset + (l * (l - 1)) / 2;
      sum += m === 0 ? c[base] * p : p * (c[base + 2 * m - 1] * cr + c[base + 2 * m] * ci);
    }
  }
  return sum;
}

/**
 * The monomials of degree lmax in x, y and z, in the order the shader sums
 * them: z's power k = 0 … lmax, then y's j = 0 … lmax - k, x's the rest.
 * There are as many as the basis has coefficients ((lmax + 1)(lmax + 2) / 2).
 */
export function monomials(lmax: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let k = 0; k <= lmax; ++k) for (let j = 0; j <= lmax - k; ++j) out.push([lmax - k - j, j, k]);
  return out;
}

const monomialCache = new Map<number, Float64Array>();

/**
 * The matrix (row-major, monomial × canonical coefficient) that turns the
 * canonical form into one homogeneous polynomial of degree lmax: each term
 * written out in x, y and z, and those of lower degree raised to lmax by
 * (x² + y² + z²)^k, which is 1 on the sphere.  A degree-lmax polynomial has
 * as many monomials as the even orders to lmax have harmonics, so the
 * shader evaluates it with one product a coefficient and no recurrences.
 */
export function monomialMatrix(lmax: number): Float64Array {
  const known = monomialCache.get(lmax);
  if (known !== undefined) return known;
  const list = monomials(lmax);
  const n = list.length;
  const where = new Map(list.map(([i, j, k], r) => [`${i},${j},${k}`, r]));
  const out = new Float64Array(n * n);
  const binomial = (a: number, b: number) => {
    let r = 1;
    for (let t = 1; t <= b; ++t) r = (r * (a - b + t)) / t;
    return r;
  };
  for (let l = 0; l <= lmax; l += 2) {
    const offset = (l * (l - 1)) / 2;
    for (let m = 0; m <= l; ++m) {
      // P̄_l^m(z) as coefficients of z^0 … z^(l-m), by the recurrence in l.
      let pmm = 1;
      for (let t = 1; t <= m; ++t) pmm *= -(2 * t - 1);
      let prev: number[] = [];
      let p: number[] = [pmm];
      for (let q = m + 1; q <= l; ++q) {
        const next = new Array(q - m + 1).fill(0);
        p.forEach((v, e) => (next[e + 1] += ((2 * q - 1) * v) / (q - m)));
        prev.forEach((v, e) => (next[e] -= ((q + m - 1) * v) / (q - m)));
        [prev, p] = [p, next];
      }
      // (x + iy)^m: its real and imaginary parts' monomials x^(m-t) y^t.
      for (const [part, column] of [
        ["re", m === 0 ? offset : offset + 2 * m - 1],
        ["im", offset + 2 * m],
      ] as const) {
        if (m === 0 && part === "im") continue;
        for (let t = 0; t <= m; ++t) {
          if ((t % 2 === 0) !== (part === "re")) continue;
          const sign = Math.floor(t / 2) % 2 === 0 ? 1 : -1;
          const xy = sign * binomial(m, t);
          p.forEach((zc, e) => {
            if (zc === 0) return;
            // x^(m-t) y^t z^e, of degree m + e, times (x² + y² + z²)^h.
            const h = (lmax - m - e) / 2;
            for (let a = 0; a <= h; ++a) {
              for (let b = 0; a + b <= h; ++b) {
                const c = h - a - b;
                const multinomial = binomial(h, a) * binomial(h - a, b);
                const row = where.get(`${m - t + 2 * a},${t + 2 * b},${e + 2 * c}`)!;
                out[row * n + column] += xy * zc * multinomial;
              }
            }
          });
        }
      }
    }
  }
  monomialCache.set(lmax, out);
  return out;
}

/** Canonical coefficients (from `offset`) to monomial ones, into `out` from `at`. */
export function toMonomials(lmax: number, canonical: ArrayLike<number>, offset: number, out: Float32Array | Float64Array, at: number): void {
  const m = monomialMatrix(lmax);
  const n = coefficientCount(lmax);
  for (let r = 0; r < n; ++r) {
    let s = 0;
    for (let c = 0; c < n; ++c) s += m[r * n + c] * canonical[offset + c];
    out[at + r] = s;
  }
}

/** A degree-lmax polynomial (coefficients from `offset`, in `monomials` order) at (x, y, z): what the shader computes. */
export function evaluateMonomials(c: ArrayLike<number>, offset: number, lmax: number, x: number, y: number, z: number): number {
  if (powersX.length <= lmax) [powersX, powersY] = [new Float64Array(lmax + 1), new Float64Array(lmax + 1)];
  powersX[0] = powersY[0] = 1;
  for (let e = 1; e <= lmax; ++e) {
    powersX[e] = powersX[e - 1] * x;
    powersY[e] = powersY[e - 1] * y;
  }
  let sum = 0;
  let r = offset;
  let zk = 1;
  for (let k = 0; k <= lmax; ++k) {
    let s = 0;
    for (let j = 0; j <= lmax - k; ++j) s += c[r++] * powersX[lmax - k - j] * powersY[j];
    sum += s * zk;
    zk *= z;
  }
  return sum;
}

let powersX = new Float64Array(13);
let powersY = new Float64Array(13);
