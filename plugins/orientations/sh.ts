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
