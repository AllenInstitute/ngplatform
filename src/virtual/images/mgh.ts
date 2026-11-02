/**
 * FreeSurfer's own volumes, `.mgh` and `.mgz` (gzipped), read as virtual
 * OME-Zarr images.  An MGH file is a 284-byte big-endian header and the
 * voxels straight after it, so it is described here as the NIfTI header
 * that says the same thing (sizes, type, byte order, the voxel-to-RAS
 * placement as an sform) and served by the NIfTI store unchanged: pyramid,
 * chunks, byte order and all.  The tags after the voxels (talairach,
 * command lines) are not read.
 *
 * Header layout (FreeSurfer's mghformat): version, width, height, depth,
 * frames, type, dof (int32 each); goodRASflag (int16); then, when that flag
 * is set, the voxel sizes (3 × float32), the direction cosines of the
 * columns, rows and slices (3 × 3 float32: x_r x_a x_s, y_r y_a y_s,
 * z_r z_a z_s) and c_ras, the RAS of the volume's centre (3 float32).
 */
import { type NiftiHeader, NiftiStore } from "./nifti.js";
import { blobSource, gunzipHead, gunzipSource, isGzip } from "./store.js";

export const MGH_FILE = /\.mg[hz]$/i;
export const MGH_HEADER = 284;

/** MGH voxel types, and the NIfTI datatype and bit count meaning the same. */
const TYPES: Record<number, [datatype: number, bitpix: number, name: string]> = {
  0: [2, 8, "uchar"],
  1: [8, 32, "int"],
  3: [16, 32, "float"],
  4: [4, 16, "short"],
};

export interface MghHeader {
  version: number;
  dims: [number, number, number];
  frames: number;
  type: number;
  goodRas: boolean;
  spacing: [number, number, number];
  /** Unit directions of the column, row and slice axes, in RAS. */
  directions: [number[], number[], number[]];
  /** RAS of the volume's centre voxel (at dims / 2). */
  centre: [number, number, number];
}

export function parseMghHeader(bytes: Uint8Array): MghHeader {
  if (bytes.byteLength < MGH_HEADER) throw new Error("the file is too short for an MGH header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i32 = (o: number) => view.getInt32(o, false);
  const f32 = (o: number) => view.getFloat32(o, false);
  const version = i32(0);
  if (version !== 1) throw new Error(`not an MGH file (version ${version}, not 1)`);
  const goodRas = view.getInt16(28, false) !== 0;
  if (goodRas) {
    return {
      version,
      dims: [i32(4), i32(8), i32(12)],
      frames: i32(16),
      type: i32(20),
      goodRas,
      spacing: [f32(30), f32(34), f32(38)],
      directions: [0, 1, 2].map((k) => [f32(42 + 12 * k), f32(46 + 12 * k), f32(50 + 12 * k)]) as MghHeader["directions"],
      centre: [f32(78), f32(82), f32(86)],
    };
  }
  // No placement recorded: FreeSurfer assumes a coronal (LIA) volume of 1 mm voxels centred on 0.
  return {
    version,
    dims: [i32(4), i32(8), i32(12)],
    frames: i32(16),
    type: i32(20),
    goodRas,
    spacing: [1, 1, 1],
    directions: [
      [-1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    centre: [0, 0, 0],
  };
}

/** Voxel (column, row, slice) to RAS, as FreeSurfer computes it: the centre voxel is at dims / 2. */
export function mghVoxelToRas(h: MghHeader): number[][] {
  const m = [0, 1, 2].map((r) => [0, 1, 2].map((c) => h.directions[c][r] * h.spacing[c]));
  const offset = [0, 1, 2].map((r) => h.centre[r] - m[r].reduce((s, v, c) => s + v * (h.dims[c] / 2), 0));
  return [0, 1, 2].map((r) => [...m[r], offset[r]]);
}

/** The NIfTI-1 header describing the same voxels, at `MGH_HEADER` in the (decompressed) file. */
export function mghAsNifti(h: MghHeader, description = ""): NiftiHeader {
  const type = TYPES[h.type];
  if (type === undefined) throw new Error(`MGH voxel type ${h.type} is not read (uchar, short, int and float are)`);
  const frames = Math.max(1, h.frames);
  const rank = frames > 1 ? 4 : 3;
  const srow = mghVoxelToRas(h);
  return {
    version: 1,
    littleEndian: false,
    magic: "n+1",
    dim: [rank, h.dims[0], h.dims[1], h.dims[2], frames, 1, 1, 1],
    intentCode: 0,
    datatype: type[0],
    bitpix: type[1],
    pixdim: [1, h.spacing[0], h.spacing[1], h.spacing[2], 1, 1, 1, 1],
    voxOffset: MGH_HEADER,
    sclSlope: 0,
    sclInter: 0,
    calMax: 0,
    calMin: 0,
    // Millimetres.
    xyztUnits: 2,
    toffset: 0,
    description,
    qformCode: 0,
    // Scanner space.
    sformCode: 1,
    quatern: [0, 0, 0],
    qoffset: [0, 0, 0],
    srow,
  };
}

export async function openMgh(file: Blob, name: string, options: { label?: boolean } = {}): Promise<NiftiStore> {
  const start = new Uint8Array(await file.slice(0, MGH_HEADER).arrayBuffer());
  const gz = isGzip(start);
  const header = mghAsNifti(parseMghHeader(gz ? await gunzipHead(file, MGH_HEADER) : start), `FreeSurfer ${gz ? "MGZ" : "MGH"}: ${name}`);
  const key = file instanceof File ? `${file.name}|${file.size}|${file.lastModified}` : undefined;
  const whole = blobSource(file);
  return new NiftiStore(header, gz ? gunzipSource(file, key) : () => Promise.resolve(whole), name, options);
}
