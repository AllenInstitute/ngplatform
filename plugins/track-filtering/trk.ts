/**
 * TrackVis `.trk` files (version 2): a 1000-byte header, then for each
 * streamline its point count and its points, in "voxmm" (millimetres from
 * the corner of the reference grid's first voxel).
 *
 * The reference grid is the store's bounding box at 1 mm, axis-aligned in
 * RAS+, so every group saved from one dataset has the same header and the
 * files load onto one another (TrackVis, DSI Studio, nibabel, MRtrix).
 * The store's axes are taken as x, y, z = right, anterior, superior, as
 * tractograms in MNI space are written.
 */
import type { StoreInfo } from "./roi_worker.js";

export interface TrkSpace {
  /** Store coordinates to RAS+ millimetres, per axis: mm = (x + offset) * scale. */
  scale: [number, number, number];
  offset: [number, number, number];
  /** Centre of the reference grid's first voxel, in mm. */
  origin: [number, number, number];
  /** The grid's size in voxels, and its voxel size in mm. */
  dims: [number, number, number];
  voxelSize: [number, number, number];
}

const HEADER_BYTES = 1000;

/** Millimetres per store unit along each axis (a unitless axis is taken as millimetres). */
export function millimetres(info: StoreInfo): [number, number, number] {
  return [0, 1, 2].map((k) => {
    const unit = info.axisUnits[k] ?? "";
    const scale = info.axisScales[k] ?? 1;
    return unit === "m" ? scale * 1000 : scale > 0 ? scale : 1;
  }) as [number, number, number];
}

export function trkSpace(info: StoreInfo): TrkSpace {
  const scale = millimetres(info);
  const offset = [0, 1, 2].map((k) => info.coordinateOffset?.[k] ?? 0) as [number, number, number];
  const lower = [0, 1, 2].map((k) => (info.bounds.lower[k] + offset[k]) * scale[k]);
  const upper = [0, 1, 2].map((k) => (info.bounds.upper[k] + offset[k]) * scale[k]);
  const origin = lower.map((v, k) => Math.floor(Math.min(v, upper[k]))) as [number, number, number];
  const dims = upper.map((v, k) => Math.min(32767, Math.max(1, Math.ceil(Math.max(v, lower[k]) - origin[k]) + 1))) as [number, number, number];
  return { scale, offset, origin, dims, voxelSize: [1, 1, 1] };
}

/** The `.trk` file of some curves (store coordinates, as the region worker gives them). */
export function writeTrk(curves: { offsets: Uint32Array; positions: Float32Array }, space: TrkSpace): ArrayBuffer {
  const header = trkHeader(space, curves.offsets.length - 1);
  const body = trkBody(curves, space);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(body), header.byteLength);
  return out.buffer;
}

/** The 1000-byte TrackVis v2 header, for `tracks` streamlines. */
export function trkHeader(space: TrkSpace, tracks: number): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; ++i) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "TRACK");
  space.dims.forEach((d, k) => view.setInt16(6 + 2 * k, d, true));
  space.voxelSize.forEach((v, k) => view.setFloat32(12 + 4 * k, v, true));
  // vox_to_ras, row-major: voxel centre (i, j, k) to RAS millimetres.
  const [vx, vy, vz] = space.voxelSize;
  const voxToRas = [vx, 0, 0, space.origin[0], 0, vy, 0, space.origin[1], 0, 0, vz, space.origin[2], 0, 0, 0, 1];
  voxToRas.forEach((v, i) => view.setFloat32(440 + 4 * i, v, true));
  ascii(948, "RAS");
  ascii(952, "RAS");
  [1, 0, 0, 0, 1, 0].forEach((v, i) => view.setFloat32(956 + 4 * i, v, true));
  view.setInt32(988, tracks, true);
  view.setInt32(992, 2, true);
  view.setInt32(996, HEADER_BYTES, true);
  return buffer;
}

/**
 * The streamlines' records (a count, then x, y, z per point, in voxmm),
 * for appending after the header: a file can be written a batch at a time.
 */
export function trkBody(curves: { offsets: Uint32Array; positions: Float32Array }, space: TrkSpace): ArrayBuffer {
  const tracks = curves.offsets.length - 1;
  const vertices = curves.positions.length / 3;
  const buffer = new ArrayBuffer(4 * tracks + 12 * vertices);
  const ints = new Int32Array(buffer);
  const floats = new Float32Array(buffer);
  const { positions, offsets } = curves;
  const { scale, offset, origin } = space;
  // voxmm = RAS - (first voxel's centre) + half a voxel.
  const shift = [0, 1, 2].map((k) => offset[k] * scale[k] - origin[k] + space.voxelSize[k] / 2);
  let at = 0;
  for (let t = 0; t < tracks; ++t) {
    const first = offsets[t];
    const last = offsets[t + 1];
    ints[at++] = last - first;
    for (let v = first; v < last; ++v) {
      floats[at++] = positions[3 * v] * scale[0] + shift[0];
      floats[at++] = positions[3 * v + 1] * scale[1] + shift[1];
      floats[at++] = positions[3 * v + 2] * scale[2] + shift[2];
    }
  }
  return buffer;
}

/** A name a file system accepts. */
export function fileName(name: string, extension: string): string {
  const stem = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "tracks";
  return `${stem}${extension}`;
}
