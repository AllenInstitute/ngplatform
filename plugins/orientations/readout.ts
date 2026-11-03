/**
 * What one voxel holds, in words, for the panel's "Under the cursor" line:
 * a tensor's eigenvalues, FA, MD and principal direction (as Freeview and
 * mrview report them), an ODF's GFA and peaks, a vector's direction and
 * length.  Directions are in RAS, after the data's frame and flips.
 */
import { basisAtSphere, type GlyphOptions, odfPeaks } from "./glyphs.js";
import { evaluate, gfa, lmaxOf } from "./sh.js";
import { icosphere } from "./sphere.js";
import { eigenSymmetric, fractionalAnisotropy, meanDiffusivity, tensorMatrix } from "./tensor.js";

const num = (v: number) => {
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 0.01 && a < 1000 ? v.toFixed(a >= 10 ? 1 : 3).replace(/\.?0+$/, "") : v.toExponential(2);
};

/** A unit direction, RAS, rounded. */
const dir = (d: ArrayLike<number>) => `(${Array.from(d, (v) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2)).join(", ")})`;

/** Mᵀ v for a row-major 3 × 3: data frame to RAS. */
function toRas(m: number[], v: ArrayLike<number>): number[] {
  return [0, 1, 2].map((c) => m[c] * v[0] + m[3 + c] * v[1] + m[6 + c] * v[2]);
}

export function describeVoxel(values: ArrayLike<number>, components: number, options: GlyphOptions): string {
  if (Array.from({ length: components }, (_, c) => values[c]).every((v) => v === 0 || v !== v)) return "nothing here";
  if (options.kind === "tensor" && components === 6) {
    const e = eigenSymmetric(tensorMatrix(values, 0, options.tensorOrder));
    const v1 = toRas(options.toData, e.vectors.subarray(0, 3));
    return `FA ${num(fractionalAnisotropy(e.values))}, MD ${num(meanDiffusivity(e.values))}, λ ${e.values.map(num).join(" / ")}, V1 ${dir(v1)}`;
  }
  if (options.kind === "sh") {
    const lmax = lmaxOf(components);
    if (lmax === undefined) return `${components} components`;
    const sphere = icosphere(3);
    const row = evaluate(basisAtSphere(options.basis, lmax, 3, options.toData), components, values, 0, new Float32Array(sphere.count));
    const peaks = odfPeaks(row, sphere);
    const top = peaks[0]?.value ?? 1;
    const list = peaks.map((p) => `${dir(sphere.vertices.subarray(3 * p.vertex, 3 * p.vertex + 3))} ${num(p.value / top)}`);
    return `GFA ${num(gfa(values, 0, components, options.basis))}; ${peaks.length === 0 ? "no peaks" : `peaks ${list.join(", ")}`}`;
  }
  // Vectors and peaks.
  const out: string[] = [];
  for (let k = 0; k + 2 < components; k += 3) {
    const v = [values[k], values[k + 1], values[k + 2]];
    const n = Math.hypot(v[0], v[1], v[2]);
    if (!(n > 0)) continue;
    out.push(`${dir(toRas(options.toData, v.map((x) => x / n)))} × ${num(n)}`);
    if (options.kind === "vector") break;
  }
  return out.length === 0 ? "nothing here" : out.join(", ");
}
