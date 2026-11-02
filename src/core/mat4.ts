/**
 * 4 × 4 matrices, row-major, for placements: voxel to RAS millimetres, and
 * the transforms between spaces.
 */

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];

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
