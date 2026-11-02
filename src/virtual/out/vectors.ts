/**
 * Writing geometry to files: tractograms as TrackVis .trk and MRtrix .tck,
 * meshes as OBJ, binary STL and binary PLY, points as CSV.  Coordinates are
 * RAS millimetres, as the platform's readers give them.
 */
import type { MeshData } from "../vectors/mesh_files.js";

export interface Curves {
  /** x y z per point, RAS mm, every streamline's in turn. */
  positions: Float32Array;
  /** Streamline i's points are [offsets[i], offsets[i + 1]). */
  offsets: Uint32Array;
}

const ascii = (view: DataView, at: number, text: string) => {
  for (let i = 0; i < text.length; ++i) view.setUint8(at + i, text.charCodeAt(i));
};

/**
 * A TrackVis v2 .trk on a 1 mm RAS grid covering the points.  TrackVis keeps
 * points in "voxmm" from the grid's corner; with 1 mm voxels and voxel to
 * RAS a translation to the grid's origin, nibabel's reading (RAS = voxel to
 * RAS · (voxmm / voxel size - 0.5)) gives the points back.
 */
export function trkFile(curves: Curves): Uint8Array {
  const { positions, offsets } = curves;
  const n = offsets.length - 1;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; ++k) {
      lo[k] = Math.min(lo[k], positions[i + k]);
      hi[k] = Math.max(hi[k], positions[i + k]);
    }
  }
  const origin = lo.map((v) => (Number.isFinite(v) ? Math.floor(v) : 0));
  const dims = hi.map((v, k) => (Number.isFinite(v) ? Math.min(32767, Math.max(1, Math.ceil(v - origin[k]) + 1)) : 1));
  const points = positions.length / 3;
  const out = new Uint8Array(1000 + 4 * n + 12 * points);
  const view = new DataView(out.buffer);
  ascii(view, 0, "TRACK");
  dims.forEach((d, k) => view.setInt16(6 + 2 * k, d, true));
  for (let k = 0; k < 3; ++k) view.setFloat32(12 + 4 * k, 1, true);
  // vox_to_ras: the grid's origin.
  const voxToRas = [1, 0, 0, origin[0], 0, 1, 0, origin[1], 0, 0, 1, origin[2], 0, 0, 0, 1];
  voxToRas.forEach((v, i) => view.setFloat32(440 + 4 * i, v, true));
  ascii(view, 948, "RAS");
  view.setInt32(988, n, true);
  view.setInt32(992, 2, true);
  view.setInt32(996, 1000, true);
  let at = 1000;
  for (let s = 0; s < n; ++s) {
    const first = offsets[s];
    const last = offsets[s + 1];
    view.setInt32(at, last - first, true);
    at += 4;
    for (let p = first; p < last; ++p) {
      for (let k = 0; k < 3; ++k) view.setFloat32(at + 4 * k, positions[3 * p + k] - origin[k] + 0.5, true);
      at += 12;
    }
  }
  return out;
}

/** An MRtrix .tck: a text header, then each streamline's points (float32, RAS mm), NaNs between, infinities at the end. */
export function tckFile(curves: Curves): Uint8Array {
  const { positions, offsets } = curves;
  const n = offsets.length - 1;
  const points = positions.length / 3;
  const head = (offset: number) => `mrtrix tracks\ndatatype: Float32LE\ncount: ${n}\nfile: . ${offset}\nEND\n`;
  let offset = head(0).length;
  while (head(offset).length > offset) offset = head(offset).length;
  const header = head(offset).padEnd(offset, "\n");
  const out = new Uint8Array(offset + 12 * (points + n + 1));
  const view = new DataView(out.buffer);
  ascii(view, 0, header);
  let at = offset;
  const triple = (x: number, y: number, z: number) => {
    view.setFloat32(at, x, true);
    view.setFloat32(at + 4, y, true);
    view.setFloat32(at + 8, z, true);
    at += 12;
  };
  for (let s = 0; s < n; ++s) {
    for (let p = offsets[s]; p < offsets[s + 1]; ++p) triple(positions[3 * p], positions[3 * p + 1], positions[3 * p + 2]);
    triple(NaN, NaN, NaN);
  }
  triple(Infinity, Infinity, Infinity);
  return out;
}

/** Wavefront OBJ: vertices, then each object's faces under its name (1-based indices). */
export function objFile(mesh: MeshData): Uint8Array {
  const lines: string[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i]} ${p[i + 1]} ${p[i + 2]}`);
  for (let o = 0; o < mesh.objects.length; ++o) {
    if (mesh.objects.length > 1) lines.push(`o ${mesh.objects[o]}`);
    const t = mesh.triangles;
    for (let f = 0; f < t.length / 3; ++f) if (mesh.triangleObject[f] === o) lines.push(`f ${t[3 * f] + 1} ${t[3 * f + 1] + 1} ${t[3 * f + 2] + 1}`);
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

/** Binary STL: each triangle with its normal. */
export function stlFile(mesh: MeshData): Uint8Array {
  const t = mesh.triangles;
  const p = mesh.positions;
  const n = t.length / 3;
  const out = new Uint8Array(84 + 50 * n);
  const view = new DataView(out.buffer);
  ascii(view, 0, "binary STL written by ngplatform");
  view.setUint32(80, n, true);
  for (let f = 0, at = 84; f < n; ++f, at += 50) {
    const v = [0, 1, 2].map((c) => [p[3 * t[3 * f + c]], p[3 * t[3 * f + c] + 1], p[3 * t[3 * f + c] + 2]]);
    const a = [0, 1, 2].map((k) => v[1][k] - v[0][k]);
    const b = [0, 1, 2].map((k) => v[2][k] - v[0][k]);
    const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const length = Math.hypot(...normal) || 1;
    normal.forEach((x, k) => view.setFloat32(at + 4 * k, x / length, true));
    v.forEach((vertex, c) => vertex.forEach((x, k) => view.setFloat32(at + 12 + 12 * c + 4 * k, x, true)));
  }
  return out;
}

/** Binary little-endian PLY: float vertices, faces as lists of three int indices. */
export function plyFile(mesh: MeshData): Uint8Array {
  const vertices = mesh.positions.length / 3;
  const faces = mesh.triangles.length / 3;
  const header = `ply\nformat binary_little_endian 1.0\ncomment written by ngplatform\nelement vertex ${vertices}\nproperty float x\nproperty float y\nproperty float z\nelement face ${faces}\nproperty list uchar int vertex_indices\nend_header\n`;
  const out = new Uint8Array(header.length + 12 * vertices + 13 * faces);
  const view = new DataView(out.buffer);
  ascii(view, 0, header);
  let at = header.length;
  for (let i = 0; i < mesh.positions.length; ++i, at += 4) view.setFloat32(at, mesh.positions[i], true);
  for (let f = 0; f < faces; ++f) {
    view.setUint8(at++, 3);
    for (let c = 0; c < 3; ++c, at += 4) view.setInt32(at, mesh.triangles[3 * f + c], true);
  }
  return out;
}

/** A CSV of points: x, y, z and any other columns. */
export function csvFile(positions: ArrayLike<number>, columns: { name: string; values: ArrayLike<number> }[] = []): Uint8Array {
  const lines = [["x", "y", "z", ...columns.map((c) => c.name)].join(",")];
  for (let i = 0; i < positions.length / 3; ++i) lines.push([positions[3 * i], positions[3 * i + 1], positions[3 * i + 2], ...columns.map((c) => c.values[i])].join(","));
  return new TextEncoder().encode(lines.join("\n") + "\n");
}
