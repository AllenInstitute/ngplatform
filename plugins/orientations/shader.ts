/**
 * Direction colour for the image layer itself: a Neuroglancer shader that
 * shows each voxel's principal direction as colour (|x| red, |y| green,
 * |z| blue, in RAS), weighted by its anisotropy, as Freeview shows a
 * tensor fit's V1 with its FA (`-dti vector FA`).
 *
 * The shader needs every component of a voxel at once, so the layer's
 * component axis becomes a channel dimension (`c^`); the plugin renames it
 * when it sets the shader.
 *
 * - Vectors: the vector's direction, weighted by its length (up to 1).
 * - Tensors: the principal eigenvector (power iteration on the traceless
 *   part, shifted to be positive), weighted by FA (from the Frobenius norms,
 *   no eigenvalues needed).
 * - Spherical harmonics: the order-2 terms are a quadratic form dᵀQd; Q's
 *   principal eigenvector is the ODF's dominant direction (exact for one
 *   fibre, the mean direction for crossings), weighted by the GFA.
 */
import type { GlyphOptions } from "./glyphs.js";
import { lmaxOf, quadraticForms } from "./sh.js";
import { TENSOR_POSITIONS } from "./tensor.js";

const f = (v: number) => {
  const s = Number(v.toPrecision(7)).toString();
  return /[.e]/.test(s) ? s : `${s}.0`;
};

const mat3 = (m: ArrayLike<number>) => `mat3(${Array.from(m, f).join(", ")})`;

/** The principal eigenvector of a symmetric matrix, by power iteration on its traceless part. */
const PRINCIPAL = `
vec3 principal(mat3 m) {
  float t = (m[0][0] + m[1][1] + m[2][2]) / 3.0;
  mat3 a = m - t * mat3(1.0);
  float n = sqrt(dot(a[0], a[0]) + dot(a[1], a[1]) + dot(a[2], a[2]));
  if (n <= 0.0) return vec3(0.0);
  mat3 b = a / n + mat3(1.0);
  b = b * b;
  // Start from b's longest column: never at right angles to the answer.
  vec3 e = b[0];
  if (dot(b[1], b[1]) > dot(e, e)) e = b[1];
  if (dot(b[2], b[2]) > dot(e, e)) e = b[2];
  for (int i = 0; i < 12; ++i) e = normalize(b * e);
  return e;
}
`;

/**
 * The shader for an image of `components` per voxel, as `options` reads
 * them; undefined when there is no direction to show.
 */
export function directionShader(options: GlyphOptions, components: number): string | undefined {
  // Data directions to RAS: toData's transpose; GLSL fills a mat3 by columns, which are toData's rows.
  const toRas = mat3(options.toData);
  const head = `#uicontrol float brightness slider(min=0.2, max=4, default=1)
// Direction colour (orientations plugin): |x| red, |y| green, |z| blue, weighted by anisotropy.
float component(int i) { return toNormalized(getDataValue(i)); }
${PRINCIPAL}`;
  if (options.kind === "vector" || options.kind === "peaks") {
    return `${head}
void main() {
  vec3 v = vec3(component(0), component(1), component(2));
  float n = length(v);
  if (!(n > 0.0)) { emitRGB(vec3(0.0)); return; }
  emitRGB(clamp(abs(${toRas} * (v / n)) * min(n, 1.0) * brightness, 0.0, 1.0));
}
`;
  }
  if (options.kind === "tensor") {
    if (components !== 6) return undefined;
    const [xx, xy, xz, yy, yz, zz] = TENSOR_POSITIONS[options.tensorOrder];
    return `${head}
void main() {
  float xx = component(${xx}), xy = component(${xy}), xz = component(${xz});
  float yy = component(${yy}), yz = component(${yz}), zz = component(${zz});
  mat3 d = mat3(xx, xy, xz, xy, yy, yz, xz, yz, zz);
  float nd = sqrt(dot(d[0], d[0]) + dot(d[1], d[1]) + dot(d[2], d[2]));
  if (!(nd > 0.0)) { emitRGB(vec3(0.0)); return; }
  float t = (xx + yy + zz) / 3.0;
  mat3 a = d - t * mat3(1.0);
  float fa = clamp(sqrt(1.5) * sqrt(dot(a[0], a[0]) + dot(a[1], a[1]) + dot(a[2], a[2])) / nd, 0.0, 1.0);
  emitRGB(clamp(abs(${toRas} * principal(d)) * fa * brightness, 0.0, 1.0));
}
`;
  }
  const lmax = lmaxOf(components);
  if (lmax === undefined || lmax < 2) return undefined;
  const q = quadraticForms(options.basis);
  // The MRtrix 0.2 basis is not orthonormal: its m ≠ 0 terms count twice in the norm.
  const legacy = options.basis === "tournier07-legacy";
  return `${head}
void main() {
  float c0 = component(0);
  mat3 q = component(1) * ${mat3(q[0])}
    + component(2) * ${mat3(q[1])}
    + component(3) * ${mat3(q[2])}
    + component(4) * ${mat3(q[3])}
    + component(5) * ${mat3(q[4])};
  float total = c0 * c0;
  for (int i = 1; i < ${components}; ++i) { float c = component(i); total += ${legacy ? "2.0 * " : ""}c * c; }
  if (!(total > 0.0)) { emitRGB(vec3(0.0)); return; }
  float gfa = sqrt(max(0.0, 1.0 - c0 * c0 / total));
  emitRGB(clamp(abs(${toRas} * principal(q)) * gfa * brightness, 0.0, 1.0));
}
`;
}
