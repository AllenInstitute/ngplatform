/**
 * Writing a moved image, as Freeview's Save Volume As does: either its
 * voxels unchanged with the new placement in its header, or resampled
 * (nearest, trilinear or cubic) onto a grid (its own, or another image's)
 * so the voxels themselves are moved.  The writers (NIfTI, OME-Zarr, zip)
 * are the platform's (src/virtual/out/volume.ts).
 */
import { ARRAYS, type Grid, type Method, type TypedArray, type Volume, RANGE } from "@ngplatform/sdk/volume_out";
import { invert4, type Mat4, multiply4 } from "./fit.js";

export * from "@ngplatform/sdk/volume_out";


/** Catmull-Rom weights for a fraction t (Keys, a = -0.5): interpolating, as cubic resampling usually is. */
function cubicWeights(t: number, w: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

/**
 * `source` moved by `move` (its RAS to where it is shown, RAS) and sampled
 * at each voxel of `grid`: out[j] = source at V⁻¹ · move⁻¹ · G · j.  Outside
 * the source is 0.  Integer types are rounded and clamped.
 */

export function resample(source: Volume, grid: Grid, move: Mat4, method: Method, progress?: (done: number, total: number) => void): TypedArray {
  const [nx, ny, nz] = source.size;
  const [ox, oy, oz] = grid.size;
  const a = multiply4(invert4(source.voxelToRas), multiply4(invert4(move), grid.voxelToRas));
  const out = new ARRAYS[source.type](ox * oy * oz);
  const range = RANGE[source.type];
  const put = range
    ? (i: number, v: number) => {
        out[i] = v <= range[0] ? range[0] : v >= range[1] ? range[1] : Math.round(v);
      }
    : (i: number, v: number) => {
        out[i] = v;
      };
  const src = source.data;
  const sx = 1;
  const sy = nx;
  const sz = nx * ny;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const wz = new Float64Array(4);
  for (let z = 0; z < oz; ++z) {
    for (let y = 0; y < oy; ++y) {
      let px = a[1] * y + a[2] * z + a[3];
      let py = a[5] * y + a[6] * z + a[7];
      let pz = a[9] * y + a[10] * z + a[11];
      let at = (z * oy + y) * ox;
      for (let x = 0; x < ox; ++x, ++at, px += a[0], py += a[4], pz += a[8]) {
        if (method === "nearest") {
          const i = Math.round(px);
          const j = Math.round(py);
          const k = Math.round(pz);
          if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) out[at] = src[i * sx + j * sy + k * sz];
          continue;
        }
        if (px <= -1 || py <= -1 || pz <= -1 || px >= nx || py >= ny || pz >= nz) continue;
        const i0 = Math.floor(px);
        const j0 = Math.floor(py);
        const k0 = Math.floor(pz);
        const fx = px - i0;
        const fy = py - j0;
        const fz = pz - k0;
        let v = 0;
        if (method === "linear") {
          for (let dk = 0; dk < 2; ++dk) {
            const k = k0 + dk;
            if (k < 0 || k >= nz) continue;
            const cz = dk ? fz : 1 - fz;
            for (let dj = 0; dj < 2; ++dj) {
              const j = j0 + dj;
              if (j < 0 || j >= ny) continue;
              const cyz = cz * (dj ? fy : 1 - fy);
              const row = j * sy + k * sz;
              if (i0 >= 0) v += cyz * (1 - fx) * src[row + i0];
              if (i0 + 1 < nx) v += cyz * fx * src[row + i0 + 1];
            }
          }
        } else {
          cubicWeights(fx, wx);
          cubicWeights(fy, wy);
          cubicWeights(fz, wz);
          for (let dk = 0; dk < 4; ++dk) {
            const k = k0 - 1 + dk;
            if (k < 0 || k >= nz) continue;
            for (let dj = 0; dj < 4; ++dj) {
              const j = j0 - 1 + dj;
              if (j < 0 || j >= ny) continue;
              const w = wz[dk] * wy[dj];
              const row = j * sy + k * sz;
              for (let di = 0; di < 4; ++di) {
                const i = i0 - 1 + di;
                if (i >= 0 && i < nx) v += w * wx[di] * src[row + i];
              }
            }
          }
        }
        put(at, v);
      }
    }
    progress?.(z + 1, oz);
  }
  return out;
}

// ------------------------------------------------------------ NIfTI-1
