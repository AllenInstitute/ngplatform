/**
 * NumPy `.npy` arrays read as virtual OME-Zarr images.  The file is a small
 * text header (`{'descr': '<f4', 'fortran_order': False, 'shape': (z, y, x)}`)
 * and the values straight after it, so, as for MGH, it is described as the
 * NIfTI header saying the same thing and served by the NIfTI store.
 *
 * Axes: a C-ordered array's last axis varies fastest, so it is x, the one
 * before y, and so on: an array indexed [z, y, x] (as napari, scikit-image
 * and most Python imaging code index volumes) shows the right way round.  A
 * 4-D array's first axis is time or channels.  There is no voxel size or
 * placement in the file: voxels are 1 unit, from the origin.
 */
import type { NiftiHeader } from "./nifti.js";
import { NiftiStore } from "./nifti.js";
import { blobSource } from "./store.js";

export const NPY_FILE = /\.npy$/i;

/** NumPy type characters and sizes to NIfTI datatypes. */
const TYPES: Record<string, [datatype: number, bitpix: number]> = {
  u1: [2, 8],
  i1: [256, 8],
  b1: [2, 8],
  i2: [4, 16],
  u2: [512, 16],
  i4: [8, 32],
  u4: [768, 32],
  i8: [1024, 64],
  u8: [1280, 64],
  f4: [16, 32],
  f8: [64, 64],
};

export interface NpyHeader {
  littleEndian: boolean;
  type: string;
  fortran: boolean;
  shape: number[];
  dataOffset: number;
}

export function parseNpyHeader(bytes: Uint8Array): NpyHeader {
  const magic = String.fromCharCode(...bytes.slice(1, 6));
  if (bytes[0] !== 0x93 || magic !== "NUMPY") throw new Error("not a NumPy .npy file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const length = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = major === 1 ? 10 : 12;
  if (bytes.byteLength < start + length) throw new Error("the .npy header is longer than what was read");
  const text = new TextDecoder("latin1").decode(bytes.slice(start, start + length));
  const descr = /'descr'\s*:\s*'([<>|=])([a-z])(\d+)'/.exec(text);
  const fortran = /'fortran_order'\s*:\s*True/.test(text);
  const shape = /'shape'\s*:\s*\(([^)]*)\)/.exec(text);
  if (descr === null || shape === null) throw new Error("the .npy header could not be read");
  return {
    littleEndian: descr[1] !== ">",
    type: `${descr[2]}${descr[3]}`,
    fortran,
    shape: shape[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map(Number),
    dataOffset: start + length,
  };
}

/** The NIfTI-1 header describing the same voxels, x fastest. */
export function npyAsNifti(h: NpyHeader, description = ""): NiftiHeader {
  const type = TYPES[h.type];
  if (type === undefined) throw new Error(`NumPy arrays of type ${h.type} are not read (integers and floats are)`);
  if (h.shape.length < 2 || h.shape.length > 4) throw new Error(`a ${h.shape.length}-D array is not an image (2-D to 4-D are)`);
  // x fastest: a C-ordered array's last axis, a Fortran-ordered one's first.
  const fastestFirst = h.fortran ? [...h.shape] : [...h.shape].reverse();
  while (fastestFirst.length < 3) fastestFirst.push(1);
  const rank = fastestFirst.length;
  return {
    version: 1,
    littleEndian: h.littleEndian,
    magic: "n+1",
    dim: [rank, ...fastestFirst, ...new Array(7 - rank).fill(1)],
    intentCode: 0,
    datatype: type[0],
    bitpix: type[1],
    pixdim: [1, 1, 1, 1, 1, 1, 1, 1],
    voxOffset: h.dataOffset,
    sclSlope: 0,
    sclInter: 0,
    calMax: 0,
    calMin: 0,
    xyztUnits: 0,
    toffset: 0,
    description,
    qformCode: 0,
    sformCode: 0,
    quatern: [0, 0, 0],
    qoffset: [0, 0, 0],
    srow: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
    ],
  };
}

export async function openNpy(file: Blob, name: string): Promise<NiftiStore> {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const header = npyAsNifti(parseNpyHeader(head), `NumPy array: ${name}`);
  const whole = blobSource(file);
  return new NiftiStore(header, () => Promise.resolve(whole), name);
}
