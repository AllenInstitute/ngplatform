/**
 * Writing a moved image, as Freeview's Save Volume As does: either its
 * voxels unchanged with the new placement in its header, or resampled
 * (nearest, trilinear or cubic B-spline, as FreeSurfer's) onto a grid (its own, or another image's)
 * so the voxels themselves are moved.  The writers (NIfTI, OME-Zarr, zip)
 * are the platform's (src/virtual/out/volume.ts).
 */
import { ARRAYS, type Grid, type Method, type TypedArray, type Volume, RANGE } from "@ngplatform/sdk/volume_out";
import { invert4, type Mat4, multiply4 } from "./fit.js";

export * from "@ngplatform/sdk/volume_out";


/** Cubic B-spline weights for a fraction t, applied to spline coefficients (bsplineCoefficients). */
function cubicWeights(t: number, w: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  const u = 1 - t;
  w[0] = (u * u * u) / 6;
  w[1] = (3 * t3 - 6 * t2 + 4) / 6;
  w[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  w[3] = t3 / 6;
}

/** An index mirrored into 0 .. n - 1 (the boundary B-spline interpolation assumes). */
function mirror(i: number, n: number): number {
  if (n === 1) return 0;
  const period = 2 * n - 2;
  let k = ((i % period) + period) % period;
  if (k >= n) k = period - k;
  return k;
}

/**
 * The cubic B-spline coefficients of a volume, so that the spline through
 * them passes through every voxel (Unser's recursive prefilter along each
 * axis, mirror boundaries): cubic resampling as FreeSurfer's does it
 * (SAMPLE_CUBIC_BSPLINE), not an approximating smoother.
 */
export function bsplineCoefficients(data: ArrayLike<number>, size: [number, number, number]): Float64Array {
  const c = Float64Array.from(data);
  const z = Math.sqrt(3) - 2;
  const line = new Float64Array(Math.max(...size));
  const [nx, ny] = size;
  const strides = [1, nx, nx * ny];
  for (let axis = 0; axis < 3; ++axis) {
    const n = size[axis];
    if (n < 2) continue;
    const stride = strides[axis];
    const others = [0, 1, 2].filter((a) => a !== axis);
    for (let b = 0; b < size[others[1]]; ++b) {
      for (let a = 0; a < size[others[0]]; ++a) {
        const start = a * strides[others[0]] + b * strides[others[1]];
        for (let k = 0; k < n; ++k) line[k] = 6 * c[start + k * stride];
        // Causal: the first coefficient of the line mirrored about its ends;
        // summed until z^k is negligible, else exactly (Unser 1999).
        const horizon = Math.ceil(Math.log(1e-12) / Math.log(Math.abs(z)));
        let sum = line[0];
        if (horizon < n) {
          let zk = z;
          for (let k = 1; k < horizon; ++k, zk *= z) sum += zk * line[k];
        } else {
          const z2n = z ** (2 * n - 2);
          let zk = z;
          let zback = z2n / z;
          for (let k = 1; k < n - 1; ++k, zk *= z, zback /= z) sum += (zk + zback) * line[k];
          sum = (sum + zk * line[n - 1]) / (1 - z2n);
        }
        line[0] = sum;
        for (let k = 1; k < n; ++k) line[k] += z * line[k - 1];
        // Anticausal.
        line[n - 1] = (z / (z * z - 1)) * (line[n - 1] + z * line[n - 2]);
        for (let k = n - 2; k >= 0; --k) line[k] = z * (line[k + 1] - line[k]);
        for (let k = 0; k < n; ++k) c[start + k * stride] = line[k];
      }
    }
  }
  return c;
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
  // Cubic samples the B-spline through the voxels: its coefficients, once.
  const coefficients = method === "cubic" ? bsplineCoefficients(src, [nx, ny, nz]) : undefined;
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
          const cs = coefficients!;
          for (let dk = 0; dk < 4; ++dk) {
            const k = mirror(k0 - 1 + dk, nz);
            for (let dj = 0; dj < 4; ++dj) {
              const j = mirror(j0 - 1 + dj, ny);
              const w = wz[dk] * wy[dj];
              const row = j * sy + k * sz;
              for (let di = 0; di < 4; ++di) v += w * wx[di] * cs[row + mirror(i0 - 1 + di, nx)];
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

// ------------------------------------------------------------ memory

/**
 * The memory (bytes) a save made in memory needs: the source, the resampled
 * output and the file made from it, and for cubic the B-spline
 * coefficients (a 64-bit float a source voxel: eight times a uint8
 * source).  With the voxels kept (`header`), the source and its file.
 */
export function saveBytes(sourceVoxels: number, outputVoxels: number, bytesPerVoxel: number, method: Method, header: boolean): number {
  if (header) return 2 * sourceVoxels * bytesPerVoxel;
  return sourceVoxels * bytesPerVoxel + 2 * outputVoxels * bytesPerVoxel + (method === "cubic" ? 8 * sourceVoxels : 0);
}

/** The first (finest) of `needs` (bytes, finest first) of at most `max`; else the last (the coarsest). */
export function finestThatFits(needs: number[], max: number): number {
  const i = needs.findIndex((n) => n <= max);
  return i === -1 ? needs.length - 1 : i;
}

// ------------------------------------------------------------ NIfTI-1

/** `SaveRequest.grid` asking for the layer's own voxels on a grid grown to hold all of the moved image. */
export const ENLARGE = "enlarge";

/** The source's voxel grid (same voxel size and axes), grown or shrunk to just hold the moved image's corners. */
export function enlargedGrid(source: { size: number[]; voxelToRas: Float64Array }, move: Float64Array): { size: [number, number, number]; voxelToRas: Float64Array } {
  const toIndex = multiply4(invert4(source.voxelToRas), multiply4(move, source.voxelToRas));
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; ++c) {
    // Voxel corners: from -0.5 to size - 0.5 along each axis.
    const p = [0, 1, 2].map((k) => ((c >> k) & 1 ? source.size[k] - 0.5 : -0.5));
    for (let r = 0; r < 3; ++r) {
      const v = toIndex[4 * r] * p[0] + toIndex[4 * r + 1] * p[1] + toIndex[4 * r + 2] * p[2] + toIndex[4 * r + 3];
      lo[r] = Math.min(lo[r], v);
      hi[r] = Math.max(hi[r], v);
    }
  }
  const first = lo.map((v) => Math.floor(v + 0.5));
  const size = hi.map((v, k) => Math.max(1, Math.ceil(v - 0.5) - first[k] + 1)) as [number, number, number];
  const shift = Float64Array.from([1, 0, 0, first[0], 0, 1, 0, first[1], 0, 0, 1, first[2], 0, 0, 0, 1]);
  return { size, voxelToRas: multiply4(source.voxelToRas, shift) };
}
