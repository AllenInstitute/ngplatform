/**
 * Writing images to files: NIfTI-1 (sform and, where the
 * placement is a rotation and scales, qform) or as an OME-Zarr pyramid
 * (0.5 scale and translation when the grid lies along x, y and z; else 0.6
 * with an affine, as this app's NIfTI stores are written).
 *
 * Volumes are x fastest; `voxelToRas` takes voxel indices (x, y, z) to RAS
 * millimetres, a 4 × 4 row-major.
 */
import { invert4, type Mat4, multiply4 } from "../../core/mat4.js";

export type VoxelType = "uint8" | "int8" | "uint16" | "int16" | "uint32" | "int32" | "float32" | "float64";
export type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
export type Method = "nearest" | "linear" | "cubic";

export const ARRAYS = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
} as const;

export interface Volume {
  data: TypedArray;
  size: [number, number, number];
  type: VoxelType;
  voxelToRas: Mat4;
}

export interface Grid {
  size: [number, number, number];
  voxelToRas: Mat4;
}

const NIFTI: Record<VoxelType, [number, number]> = {
  uint8: [2, 8],
  int16: [4, 16],
  int32: [8, 32],
  float32: [16, 32],
  float64: [64, 64],
  int8: [256, 8],
  uint16: [512, 16],
  uint32: [768, 32],
};

/** A voxel-to-RAS matrix as NIfTI's quaternion form, when it is a rotation times positive scales (and perhaps a flip of k). */

/** Bytes (little-endian, as read) as an array of their type. */
export function typed(type: VoxelType, bytes: Uint8Array): TypedArray {
  const Type = ARRAYS[type];
  const aligned = bytes.byteOffset % Type.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice();
  return new Type(aligned.buffer as ArrayBuffer, aligned.byteOffset, aligned.byteLength / Type.BYTES_PER_ELEMENT);
}

// ------------------------------------------------------------ resampling

export function quaternionOf(m: Mat4): { b: number; c: number; d: number; pixdim: [number, number, number]; qfac: number } | undefined {
  const col = (k: number) => [m[k], m[4 + k], m[8 + k]];
  const pixdim = [0, 1, 2].map((k) => Math.hypot(...col(k))) as [number, number, number];
  if (pixdim.some((p) => !(p > 0))) return undefined;
  const r = [0, 1, 2].map((k) => col(k).map((v) => v / pixdim[k]));
  // Columns must be orthonormal.
  for (let i = 0; i < 3; ++i) for (let j = i + 1; j < 3; ++j) if (Math.abs(r[i][0] * r[j][0] + r[i][1] * r[j][1] + r[i][2] * r[j][2]) > 1e-4) return undefined;
  const det =
    r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[1][0] * (r[0][1] * r[2][2] - r[0][2] * r[2][1]) + r[2][0] * (r[0][1] * r[1][2] - r[0][2] * r[1][1]);
  const qfac = det < 0 ? -1 : 1;
  if (qfac < 0) r[2] = r[2].map((v) => -v);
  // R[row][col] = r[col][row]; nifti_mat44_to_quatern.
  const R = (i: number, j: number) => r[j][i];
  let a = R(0, 0) + R(1, 1) + R(2, 2) + 1;
  let b: number;
  let c: number;
  let d: number;
  if (a > 0.5) {
    a = 0.5 * Math.sqrt(a);
    b = (0.25 * (R(2, 1) - R(1, 2))) / a;
    c = (0.25 * (R(0, 2) - R(2, 0))) / a;
    d = (0.25 * (R(1, 0) - R(0, 1))) / a;
  } else {
    const xd = 1 + R(0, 0) - (R(1, 1) + R(2, 2));
    const yd = 1 + R(1, 1) - (R(0, 0) + R(2, 2));
    const zd = 1 + R(2, 2) - (R(0, 0) + R(1, 1));
    if (xd > 1) {
      b = 0.5 * Math.sqrt(xd);
      c = (0.25 * (R(0, 1) + R(1, 0))) / b;
      d = (0.25 * (R(0, 2) + R(2, 0))) / b;
      a = (0.25 * (R(2, 1) - R(1, 2))) / b;
    } else if (yd > 1) {
      c = 0.5 * Math.sqrt(yd);
      b = (0.25 * (R(0, 1) + R(1, 0))) / c;
      d = (0.25 * (R(1, 2) + R(2, 1))) / c;
      a = (0.25 * (R(0, 2) - R(2, 0))) / c;
    } else {
      d = 0.5 * Math.sqrt(zd);
      b = (0.25 * (R(0, 2) + R(2, 0))) / d;
      c = (0.25 * (R(1, 2) + R(2, 1))) / d;
      a = (0.25 * (R(1, 0) - R(0, 1))) / d;
    }
    if (a < 0) {
      b = -b;
      c = -c;
      d = -d;
    }
  }
  return { b, c, d, pixdim, qfac };
}

/** The 0.5th and 99.5th percentiles of a strided sample: a display window. */
export function displayWindow(data: TypedArray): [number, number] {
  const step = Math.max(1, Math.floor(data.length / 200_000));
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) sample.push(data[i]);
  if (sample.length === 0) return [0, 1];
  sample.sort((x, y) => x - y);
  const lo = sample[Math.floor(0.005 * (sample.length - 1))];
  const hi = sample[Math.ceil(0.995 * (sample.length - 1))];
  return hi > lo ? [lo, hi] : [sample[0], Math.max(sample[sample.length - 1], sample[0] + 1)];
}

/** A NIfTI-1 single file (.nii): the volume with `voxelToRas` as its sform (and qform where it can be one). */
export function niftiFile(volume: Volume, options: { description?: string; label?: boolean; window?: [number, number] } = {}): Uint8Array {
  const body = new Uint8Array(volume.data.buffer, volume.data.byteOffset, volume.data.byteLength);
  const out = new Uint8Array(352 + body.byteLength);
  out.set(niftiHeader(volume, options));
  out.set(body, 352);
  return out;
}

/** A NIfTI-1 file's 352 bytes before its voxels (header and an empty extension flag), for a volume of this size, type and placement. */
export function niftiHeader(volume: Omit<Volume, "data">, options: { description?: string; label?: boolean; window?: [number, number] } = {}): Uint8Array {
  const [code, bitpix] = NIFTI[volume.type];
  const out = new Uint8Array(352);
  const v = new DataView(out.buffer);
  const m = volume.voxelToRas;
  const q = quaternionOf(m);
  const pixdim = q?.pixdim ?? ([0, 1, 2].map((k) => Math.hypot(m[k], m[4 + k], m[8 + k])) as [number, number, number]);
  v.setInt32(0, 348, true);
  [3, ...volume.size, 1, 1, 1, 1].forEach((d, k) => v.setInt16(40 + 2 * k, d, true));
  if (options.label) v.setInt16(68, 1002, true); // NIFTI_INTENT_LABEL
  v.setInt16(70, code, true);
  v.setInt16(72, bitpix, true);
  [q?.qfac ?? 1, ...pixdim, 0, 0, 0, 0].forEach((d, k) => v.setFloat32(76 + 4 * k, d, true));
  v.setFloat32(108, 352, true); // vox_offset
  v.setFloat32(112, 1, true); // scl_slope
  out[123] = 2; // millimetres
  if (options.window !== undefined) {
    v.setFloat32(124, options.window[1], true); // cal_max
    v.setFloat32(128, options.window[0], true); // cal_min
  }
  out.set(new TextEncoder().encode((options.description ?? "").slice(0, 79)), 148);
  if (q !== undefined) {
    v.setInt16(252, 2, true); // qform_code: aligned
    v.setFloat32(256, q.b, true);
    v.setFloat32(260, q.c, true);
    v.setFloat32(264, q.d, true);
    for (let r = 0; r < 3; ++r) v.setFloat32(268 + 4 * r, m[4 * r + 3], true);
  }
  v.setInt16(254, 2, true); // sform_code: aligned
  for (let r = 0; r < 3; ++r) for (let c = 0; c < 4; ++c) v.setFloat32(280 + 16 * r + 4 * c, m[4 * r + c], true);
  out.set([110, 43, 49, 0], 344); // "n+1"
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The values an integer type holds, for rounding and clamping. */
export const RANGE: Partial<Record<VoxelType, [number, number]>> = {
  uint8: [0, 255],
  int8: [-128, 127],
  uint16: [0, 65535],
  int16: [-32768, 32767],
  uint32: [0, 4294967295],
  int32: [-2147483648, 2147483647],
};

// ------------------------------------------------------------ MGH

/** FreeSurfer's MGH voxel types; other types are written as the nearest that holds them. */
const MGH_TYPES: Record<VoxelType, { code: number; as: VoxelType }> = {
  uint8: { code: 0, as: "uint8" },
  int8: { code: 4, as: "int16" },
  int16: { code: 4, as: "int16" },
  uint16: { code: 1, as: "int32" },
  int32: { code: 1, as: "int32" },
  uint32: { code: 3, as: "float32" },
  float32: { code: 3, as: "float32" },
  float64: { code: 3, as: "float32" },
};

/**
 * An MGH file (FreeSurfer's own format; gzip it for .mgz): the 284-byte
 * big-endian header (sizes, type, voxel sizes, the direction cosines of the
 * columns, rows and slices, and c_ras, the RAS of voxel dims / 2), the
 * voxels big-endian, then the optional scan parameters (TR, flip angle,
 * TE, TI, FoV), here zero, as nibabel writes them.
 */
export function mghFile(volume: Volume): Uint8Array {
  const body = mghBody(volume.data, volume.type);
  const out = new Uint8Array(MGH_HEADER_BYTES + body.byteLength + MGH_FOOTER_BYTES);
  out.set(mghHeader(volume));
  out.set(body, MGH_HEADER_BYTES);
  return out;
}

export const MGH_HEADER_BYTES = 284;
/** After the voxels: TR, flip angle, TE, TI and field of view, here zero. */
export const MGH_FOOTER_BYTES = 5 * 4;

/** Voxels as an MGH file stores them: big-endian, in the type MGH has for theirs. */
export function mghBody(src: ArrayLike<number>, type: VoxelType): Uint8Array {
  const { as } = MGH_TYPES[type];
  const per = ARRAYS[as].BYTES_PER_ELEMENT;
  const out = new Uint8Array(src.length * per);
  const view = new DataView(out.buffer);
  for (let i = 0, at = 0; i < src.length; ++i, at += per) {
    const v = src[i];
    if (as === "uint8") view.setUint8(at, v);
    else if (as === "int16") view.setInt16(at, v, false);
    else if (as === "int32") view.setInt32(at, v, false);
    else view.setFloat32(at, v, false);
  }
  return out;
}

/** An MGH file's 284 bytes before its voxels. */
export function mghHeader(volume: Omit<Volume, "data">): Uint8Array {
  const { code } = MGH_TYPES[volume.type];
  const [ni, nj, nk] = volume.size;
  const out = new Uint8Array(MGH_HEADER_BYTES);
  const view = new DataView(out.buffer);
  [1, ni, nj, nk, 1, code, 0].forEach((v, k) => view.setInt32(4 * k, v, false));
  view.setInt16(28, 1, false);
  const m = volume.voxelToRas;
  const spacing = [0, 1, 2].map((c) => Math.hypot(m[c], m[4 + c], m[8 + c]) || 1);
  spacing.forEach((s, k) => view.setFloat32(30 + 4 * k, s, false));
  for (let c = 0; c < 3; ++c) for (let r = 0; r < 3; ++r) view.setFloat32(42 + 12 * c + 4 * r, m[4 * r + c] / spacing[c], false);
  const centre = [0, 1, 2].map((r) => m[4 * r] * (ni / 2) + m[4 * r + 1] * (nj / 2) + m[4 * r + 2] * (nk / 2) + m[4 * r + 3]);
  centre.forEach((v, k) => view.setFloat32(78 + 4 * k, v, false));
  return out;
}

// ------------------------------------------------------------ OME-Zarr

/** Half the size: the mean of each 2 × 2 × 2 block (labels: its first voxel), a level coarser; its voxels' placement too. */
export function halve(volume: Volume, label: boolean): Volume {
  const [nx, ny, nz] = volume.size;
  const size = [Math.ceil(nx / 2), Math.ceil(ny / 2), Math.ceil(nz / 2)] as [number, number, number];
  const out = new ARRAYS[volume.type](size[0] * size[1] * size[2]);
  const src = volume.data;
  const range = RANGE[volume.type];
  let at = 0;
  for (let z = 0; z < size[2]; ++z) {
    for (let y = 0; y < size[1]; ++y) {
      for (let x = 0; x < size[0]; ++x, ++at) {
        if (label) {
          out[at] = src[2 * x + nx * (2 * y + ny * 2 * z)];
          continue;
        }
        let sum = 0;
        let n = 0;
        for (let k = 2 * z; k < Math.min(2 * z + 2, nz); ++k) {
          for (let j = 2 * y; j < Math.min(2 * y + 2, ny); ++j) {
            for (let i = 2 * x; i < Math.min(2 * x + 2, nx); ++i) {
              sum += src[i + nx * (j + ny * k)];
              n++;
            }
          }
        }
        out[at] = range ? Math.round(sum / n) : sum / n;
      }
    }
  }
  // A coarse voxel's centre is the centre of the fine voxels it covers.
  const step = Float64Array.from([2, 0, 0, 0.5, 0, 2, 0, 0.5, 0, 0, 2, 0.5, 0, 0, 0, 1]);
  return { data: out, size, type: volume.type, voxelToRas: multiply4(volume.voxelToRas, label ? Float64Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]) : step) };
}

/** Whether a voxel-to-RAS matrix scales each of x, y, z (positively) and turns nothing: OME-Zarr 0.5 can hold it. */
export function alongAxes(m: Mat4): boolean {
  for (let r = 0; r < 3; ++r) for (let c = 0; c < 3; ++c) if (r !== c && Math.abs(m[4 * r + c]) > 1e-9 * Math.abs(m[4 * c + c])) return false;
  return m[0] > 0 && m[5] > 0 && m[10] > 0;
}

const CHUNK = 64;

/** One array's chunks (z, y, x order, `CHUNK` a side, x fastest), gzipped; chunks all zero are left out (the fill value). */
async function chunks(volume: Volume, path: string, files: Map<string, Uint8Array>): Promise<void> {
  const [nx, ny, nz] = volume.size;
  const Type = ARRAYS[volume.type];
  const grid = [Math.ceil(nz / CHUNK), Math.ceil(ny / CHUNK), Math.ceil(nx / CHUNK)];
  const chunk = new Type(CHUNK * CHUNK * CHUNK);
  for (let cz = 0; cz < grid[0]; ++cz) {
    for (let cy = 0; cy < grid[1]; ++cy) {
      for (let cx = 0; cx < grid[2]; ++cx) {
        chunk.fill(0);
        let any = false;
        for (let z = 0; z < CHUNK && cz * CHUNK + z < nz; ++z) {
          for (let y = 0; y < CHUNK && cy * CHUNK + y < ny; ++y) {
            const from = cx * CHUNK + nx * (cy * CHUNK + y + ny * (cz * CHUNK + z));
            const run = Math.min(CHUNK, nx - cx * CHUNK);
            const row = volume.data.subarray(from, from + run);
            chunk.set(row as never, (z * CHUNK + y) * CHUNK);
            if (!any) for (let i = 0; i < run; ++i) if (row[i] !== 0) { any = true; break; }
          }
        }
        if (!any) continue;
        files.set(`${path}/c/${cz}/${cy}/${cx}`, await gzip(new Uint8Array(chunk.buffer.slice(0))));
      }
    }
  }
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 1));

/** A level of a pyramid: its size and the placement of its voxels. */
export interface LevelGrid {
  size: [number, number, number];
  voxelToRas: Mat4;
}

/** The levels of a pyramid halved from `grid` down to about `chunk` voxels a side (at most 12), as `halve` places them. */
export function pyramidGrids(grid: LevelGrid, label: boolean, chunk = CHUNK): LevelGrid[] {
  const levels = [grid];
  const step = label ? [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] : [2, 0, 0, 0.5, 0, 2, 0, 0.5, 0, 0, 2, 0.5, 0, 0, 0, 1];
  while (levels.length < 12 && Math.max(...levels[levels.length - 1].size) > chunk) {
    const l = levels[levels.length - 1];
    levels.push({ size: l.size.map((n) => Math.ceil(n / 2)) as [number, number, number], voxelToRas: multiply4(l.voxelToRas, Float64Array.from(step)) });
  }
  return levels;
}

/**
 * The metadata of an OME-Zarr image (Zarr v3) of these levels: the group's
 * zarr.json and each array's, by path.  Chunks are `chunk` voxels a side,
 * stored with `codecs` (raw bytes, then gzip, unless given).
 */
export function omeZarrMetadata(
  levels: LevelGrid[],
  type: VoxelType,
  name: string,
  options: { label?: boolean; window?: [number, number]; description?: string; chunk?: number; codecs?: unknown[] } = {},
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const chunk = options.chunk ?? CHUNK;
  const codecs = options.codecs ?? [{ name: "bytes", configuration: { endian: "little" } }, { name: "gzip", configuration: { level: 5 } }];
  for (let i = 0; i < levels.length; ++i) {
    const l = levels[i];
    files.set(`${i}/zarr.json`, json({
      zarr_format: 3,
      node_type: "array",
      shape: [l.size[2], l.size[1], l.size[0]],
      data_type: type,
      chunk_grid: { name: "regular", configuration: { chunk_shape: [chunk, chunk, chunk] } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: 0,
      codecs,
      dimension_names: ["z", "y", "x"],
      attributes: {},
    }));
  }
  const space = (n: string) => ({ name: n, type: "space", unit: "millimeter" });
  const kind = options.label ? "nearest" : "mean";
  const omero = options.window === undefined || options.label ? {} : { omero: { channels: [{ label: name, active: true, window: { min: options.window[0], max: options.window[1], start: options.window[0], end: options.window[1] } }] } };
  const metadata = options.description ? { metadata: { description: options.description } } : {};
  let multiscale: unknown;
  let version: string;
  if (levels.every((l) => alongAxes(l.voxelToRas))) {
    version = "0.5";
    multiscale = {
      name,
      axes: ["z", "y", "x"].map(space),
      datasets: levels.map((l, i) => ({
        path: String(i),
        coordinateTransformations: [
          { type: "scale", scale: [l.voxelToRas[10], l.voxelToRas[5], l.voxelToRas[0]] },
          { type: "translation", translation: [l.voxelToRas[11], l.voxelToRas[7], l.voxelToRas[3]] },
        ],
      })),
      type: kind,
      ...metadata,
    };
  } else {
    // 0.6: each level to level 0's voxels ("array"), then an affine to RAS.
    version = "0.6";
    const m = levels[0].voxelToRas;
    // Rows x, y, z; columns the array's axes z, y, x, then the offset.
    const affine = [0, 1, 2].map((r) => [m[4 * r + 2], m[4 * r + 1], m[4 * r], m[4 * r + 3]]);
    const toLevel0 = levels.map((l) => multiply4(invert4(m), l.voxelToRas));
    multiscale = {
      name,
      coordinateSystems: [
        { name: "physical", axes: ["x", "y", "z"].map(space) },
        { name: "array", axes: ["z", "y", "x"].map((n) => ({ name: n, type: "space" })) },
      ],
      datasets: levels.map((_, i) => {
        const t = toLevel0[i];
        const scale = [t[10], t[5], t[0]];
        return i === 0
          ? { path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1], input: "0", output: "array" }] }
          : {
              path: String(i),
              coordinateTransformations: [
                { type: "sequence", input: String(i), output: "array", transformations: [{ type: "scale", scale }, { type: "translation", translation: [t[11], t[7], t[3]] }] },
              ],
            };
      }),
      coordinateTransformations: [{ type: "affine", affine, input: "array", output: "physical" }],
      type: kind,
      ...metadata,
    };
  }
  files.set("zarr.json", json({ zarr_format: 3, node_type: "group", attributes: { ome: { version, multiscales: [multiscale], ...omero } } }));
  return files;
}

/**
 * An OME-Zarr image (Zarr v3) as files by path in the store: a pyramid
 * halved down to about 64 voxels a side, chunks 64³ gzipped.
 */
export async function omeZarrFiles(volume: Volume, name: string, options: { label?: boolean; window?: [number, number]; description?: string } = {}): Promise<Map<string, Uint8Array>> {
  const levels = [volume];
  while (levels.length < 12 && Math.max(...levels[levels.length - 1].size) > CHUNK) levels.push(halve(levels[levels.length - 1], options.label === true));
  const files = omeZarrMetadata(levels, volume.type, name, options);
  for (let i = 0; i < levels.length; ++i) await chunks(levels[i], String(i), files);
  return files;
}

// ------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; ++i) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Files in a zip, stored (the chunks are compressed already); for browsers that cannot write a folder. Under 4 GB. */
export function zipFiles(files: Map<string, Uint8Array>): Blob {
  if (files.size > 0xffff) throw new Error("too many files for a zip (over 65,535)");
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = new TextEncoder().encode(path);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); // UTF-8 names
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    e.setUint16(6, 20, true);
    e.setUint16(8, 0x0800, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, data.length, true);
    e.setUint32(24, data.length, true);
    e.setUint16(28, name.length, true);
    e.setUint32(42, offset, true);
    entry.set(name, 46);
    parts.push(local, data as BlobPart);
    central.push(entry);
    offset += local.length + data.length;
    if (offset > 0xffffffff) throw new Error("too large for a zip (over 4 GB)");
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, files.size, true);
  d.setUint16(10, files.size, true);
  d.setUint32(12, size, true);
  d.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end]);
}

