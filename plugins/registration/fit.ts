/**
 * Fitting a transform to landmark pairs: moving points m_i (in the moving
 * layer's own space) and fixed points f_i (in the global space), both in
 * millimetres, so a fit is the same whatever the voxel sizes.  Rigid and
 * similarity use Horn's quaternion method (a proper rotation always, never
 * a reflection); affine is least squares.  Matrices are 4 × 4, row-major.
 */

export type Mat4 = Float64Array;
export type Model = "translation" | "rigid" | "similarity" | "affine";
export type Vec3 = [number, number, number];

/** The fewest pairs each model needs. */
export const MINIMUM: Record<Model, number> = { translation: 1, rigid: 3, similarity: 3, affine: 4 };

export function identity4(): Mat4 {
  return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function multiply4(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) out[4 * r + c] += a[4 * r + k] * b[4 * k + c];
  return out;
}

export function apply4(m: Mat4, p: ArrayLike<number>): Vec3 {
  return [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]) as Vec3;
}

/** The inverse of a 4 × 4 matrix (Gauss-Jordan); throws when it is singular. */
export function invert4(m: Mat4): Mat4 {
  const a = Array.from({ length: 4 }, (_, r) => [...Array.from(m.slice(4 * r, 4 * r + 4)), ...[0, 1, 2, 3].map((c) => (c === r ? 1 : 0))]);
  for (let c = 0; c < 4; ++c) {
    let pivot = c;
    for (let r = c + 1; r < 4; ++r) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-12) throw new Error("the matrix is singular");
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 8; ++k) a[c][k] /= d;
    for (let r = 0; r < 4; ++r) {
      if (r === c) continue;
      const f = a[r][c];
      for (let k = 0; k < 8; ++k) a[r][k] -= f * a[c][k];
    }
  }
  return Float64Array.from(a.flatMap((row) => row.slice(4)));
}

function mean(points: Vec3[]): Vec3 {
  const s: Vec3 = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; ++k) s[k] += p[k] / points.length;
  return s;
}

/** Eigenvector of the largest eigenvalue of a symmetric 4 × 4 matrix (Jacobi rotations). */
function largestEigenvector(n: number[][]): number[] {
  const a: number[][] = n.map((row) => [...row]);
  const v: number[][] = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => (r === c ? 1 : 0)));
  for (let sweep = 0; sweep < 50; ++sweep) {
    let off = 0;
    for (let p = 0; p < 4; ++p) for (let q = p + 1; q < 4; ++q) off += a[p][q] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < 4; ++p) {
      for (let q = p + 1; q < 4; ++q) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; ++k) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; ++k) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; ++k) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; ++i) if (a[i][i] > a[best][best]) best = i;
  return [0, 1, 2, 3].map((k) => v[k][best]);
}

/** The rotation (3 × 3, row-major) best taking centred moving points to centred fixed ones (Horn 1987). */
function hornRotation(m: Vec3[], f: Vec3[]): number[] {
  const s = [0, 1, 2].map(() => [0, 0, 0]);
  for (let i = 0; i < m.length; ++i) for (let a = 0; a < 3; ++a) for (let b = 0; b < 3; ++b) s[a][b] += m[i][a] * f[i][b];
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = s;
  const n = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [w, x, y, z] = largestEigenvector(n);
  return [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
}

/** Solves a small linear system (Gaussian elimination with pivoting); throws when singular. */
function solve(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...b[i]]);
  const width = m[0].length;
  for (let c = 0; c < n; ++c) {
    let pivot = c;
    for (let r = c + 1; r < n; ++r) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-9) throw new Error("the points do not fix an affine transform (they lie in a plane or a line)");
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < n; ++r) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < width; ++k) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row.slice(n).map((v) => v / row[i]));
}

export interface Fit {
  matrix: Mat4;
  /** Distance from T(m_i) to f_i, mm, per pair. */
  residuals: number[];
  rms: number;
  max: number;
}

/** The transform of a model best taking `moving` to `fixed`; throws with a reason when there are too few pairs. */
export function fit(model: Model, moving: Vec3[], fixed: Vec3[]): Fit {
  const n = Math.min(moving.length, fixed.length);
  if (n < MINIMUM[model]) throw new Error(`${model} needs at least ${MINIMUM[model]} pairs; there ${n === 1 ? "is" : "are"} ${n}`);
  const cm = mean(moving);
  const cf = mean(fixed);
  const matrix = identity4();
  if (model === "translation") {
    for (let k = 0; k < 3; ++k) matrix[4 * k + 3] = cf[k] - cm[k];
  } else if (model === "rigid" || model === "similarity") {
    const m = moving.map((p) => p.map((v, k) => v - cm[k]) as Vec3);
    const f = fixed.map((p) => p.map((v, k) => v - cf[k]) as Vec3);
    const r = hornRotation(m, f);
    let scale = 1;
    if (model === "similarity") {
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; ++i) {
        const rm = [0, 1, 2].map((a) => r[3 * a] * m[i][0] + r[3 * a + 1] * m[i][1] + r[3 * a + 2] * m[i][2]);
        num += rm[0] * f[i][0] + rm[1] * f[i][1] + rm[2] * f[i][2];
        den += m[i][0] ** 2 + m[i][1] ** 2 + m[i][2] ** 2;
      }
      scale = den > 0 ? num / den : 1;
    }
    for (let a = 0; a < 3; ++a) {
      for (let b = 0; b < 3; ++b) matrix[4 * a + b] = scale * r[3 * a + b];
      matrix[4 * a + 3] = cf[a] - scale * (r[3 * a] * cm[0] + r[3 * a + 1] * cm[1] + r[3 * a + 2] * cm[2]);
    }
  } else {
    // Least squares: rows [m 1] times A^T = f.
    const xtx = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const xtf = [0, 1, 2, 3].map(() => [0, 0, 0]);
    for (let i = 0; i < n; ++i) {
      const x = [...moving[i], 1];
      for (let a = 0; a < 4; ++a) {
        for (let b = 0; b < 4; ++b) xtx[a][b] += x[a] * x[b];
        for (let k = 0; k < 3; ++k) xtf[a][k] += x[a] * fixed[i][k];
      }
    }
    const at = solve(xtx, xtf);
    for (let r = 0; r < 3; ++r) for (let c = 0; c < 4; ++c) matrix[4 * r + c] = at[c][r];
  }
  const residuals = moving.slice(0, n).map((p, i) => {
    const q = apply4(matrix, p);
    return Math.hypot(q[0] - fixed[i][0], q[1] - fixed[i][1], q[2] - fixed[i][2]);
  });
  return {
    matrix,
    residuals,
    rms: Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, n)),
    max: Math.max(0, ...residuals),
  };
}

/** A linear part's determinant and scales (column norms): a negative determinant is a reflection. */
export function describe(m: Mat4): { determinant: number; scales: Vec3 } {
  const a = (r: number, c: number) => m[4 * r + c];
  const determinant =
    a(0, 0) * (a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1)) - a(0, 1) * (a(1, 0) * a(2, 2) - a(1, 2) * a(2, 0)) + a(0, 2) * (a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0));
  const scales = [0, 1, 2].map((c) => Math.hypot(a(0, c), a(1, c), a(2, c))) as Vec3;
  return { determinant, scales };
}
