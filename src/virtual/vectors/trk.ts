/**
 * TrackVis .trk files: the header, and the streamlines read in one pass, in
 * RAS+ millimetres as nibabel gives them (nibabel.streamlines.trk), which is
 * how zarr-vectors-tools converts them.
 *
 * A .trk stores points in "voxmm" space: voxel coordinates times the voxel
 * size, with (0, 0, 0) the corner of the first voxel.  To RAS+ mm: divide by
 * the voxel size, move half a voxel (to voxel centres), reorder axes to the
 * order `vox_to_ras` implies when the header's voxel order differs, then
 * `vox_to_ras`.
 */

export interface TrkHeader {
  littleEndian: boolean;
  dims: [number, number, number];
  voxelSize: [number, number, number];
  /** Per-point values after each point's x, y, z. */
  scalarNames: string[];
  /** Per-streamline values after each streamline's points. */
  propertyNames: string[];
  voxToRas: Float64Array;
  voxelOrder: string;
  /** Streamlines, or 0 when the header does not say. */
  count: number;
  version: number;
  /** voxmm to RAS+ mm, row-major 4 × 4. */
  toRas: Float64Array;
}

export const TRK_HEADER_SIZE = 1000;

function text(bytes: Uint8Array, start: number, length: number): string {
  const end = bytes.indexOf(0, start);
  return new TextDecoder("latin1").decode(bytes.subarray(start, end === -1 || end > start + length ? start + length : end)).trim();
}

/** Names in a header's 10 × 20-byte name table; "name\0N" is N values called name. */
function names(bytes: Uint8Array, start: number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 10; ++i) {
    const at = start + 20 * i;
    const name = text(bytes, at, 20);
    const zero = bytes.indexOf(0, at);
    const repeat = zero !== -1 && zero < at + 19 ? Number.parseInt(text(bytes, zero + 1, at + 20 - zero - 1), 10) : NaN;
    const count = Number.isInteger(repeat) && repeat > 1 ? repeat : 1;
    for (let k = 0; k < count && out.length < n; ++k) out.push(count === 1 ? name || `value${out.length}` : `${name}_${k}`);
  }
  while (out.length < n) out.push(`value${out.length}`);
  return out;
}

/** The world axis (0 = R/L, 1 = A/P, 2 = S/I) and sign (+1 for R, A, S) of a voxel-order letter. */
function axisOf(letter: string): [number, number] | undefined {
  return ({ R: [0, 1], L: [0, -1], A: [1, 1], P: [1, -1], S: [2, 1], I: [2, -1] } as Record<string, [number, number]>)[letter.toUpperCase()];
}

const multiply = (a: Float64Array, b: Float64Array) => {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) out[4 * r + c] += a[4 * r + k] * b[4 * k + c];
  return out;
};

/** nibabel's get_affine_trackvis_to_rasmm. */
export function trkToRas(h: Pick<TrkHeader, "dims" | "voxelSize" | "voxToRas" | "voxelOrder">): Float64Array {
  // voxmm to voxel centres.
  let m = new Float64Array([1 / h.voxelSize[0], 0, 0, -0.5, 0, 1 / h.voxelSize[1], 0, -0.5, 0, 0, 1 / h.voxelSize[2], -0.5, 0, 0, 0, 1]);
  const v = h.voxToRas;
  const affine = v[15] === 0 ? new Float64Array([h.voxelSize[0], 0, 0, 0, 0, h.voxelSize[1], 0, 0, 0, 0, h.voxelSize[2], 0, 0, 0, 0, 1]) : v;
  // The header's voxel order to the order the affine implies (aff2axcodes), by axis flips and swaps.
  const affineAxes = [0, 1, 2].map((c) => {
    const column = [affine[c], affine[4 + c], affine[8 + c]];
    const world = column.map(Math.abs).indexOf(Math.max(...column.map(Math.abs)));
    return [world, Math.sign(column[world]) || 1];
  });
  const header = [...(h.voxelOrder || "RAS").slice(0, 3)].map(axisOf);
  if (header.every((a) => a !== undefined) && new Set(header.map((a) => a![0])).size === 3) {
    const reorder = new Float64Array(16);
    reorder[15] = 1;
    for (let i = 0; i < 3; ++i) {
      const [world, sign] = header[i]!;
      const j = affineAxes.findIndex(([w]) => w === world);
      if (j === -1) continue;
      if (sign === affineAxes[j][1]) {
        reorder[4 * j + i] = 1;
      } else {
        reorder[4 * j + i] = -1;
        reorder[4 * j + 3] = h.dims[i] - 1;
      }
    }
    m = multiply(reorder, m);
  }
  return multiply(affine, m);
}

export function parseTrkHeader(bytes: Uint8Array): TrkHeader {
  if (bytes.byteLength < TRK_HEADER_SIZE || text(bytes, 0, 6) !== "TRACK") throw new Error("not a TrackVis .trk file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, TRK_HEADER_SIZE);
  const little = view.getInt32(996, true) === TRK_HEADER_SIZE;
  if (!little && view.getInt32(996, false) !== TRK_HEADER_SIZE) throw new Error("a .trk header whose size is not 1000 bytes");
  const i16 = (at: number) => view.getInt16(at, little);
  const f32 = (at: number) => view.getFloat32(at, little);
  const nScalars = i16(36);
  const nProperties = i16(238);
  const voxToRas = new Float64Array(16).map((_, i) => f32(440 + 4 * i));
  const h = {
    littleEndian: little,
    dims: [i16(6), i16(8), i16(10)] as [number, number, number],
    voxelSize: [f32(12), f32(16), f32(20)].map((s) => (s > 0 ? s : 1)) as [number, number, number],
    scalarNames: names(bytes, 38, nScalars),
    propertyNames: names(bytes, 240, nProperties),
    voxToRas,
    voxelOrder: text(bytes, 948, 4),
    count: view.getInt32(988, little),
    version: view.getInt32(992, little),
  };
  return { ...h, toRas: trkToRas(h) };
}

export interface TrkBatch {
  /** Points, RAS+ mm, x y z each, every streamline's in turn. */
  points: Float32Array;
  /** Streamline i's points are [offsets[i], offsets[i + 1]). */
  offsets: Uint32Array;
  /** Per-point values, `scalarNames.length` per point. */
  scalars: Float32Array;
  /** Per-streamline values, `propertyNames.length` each. */
  properties: Float32Array;
}

/**
 * Reads every streamline of a .trk, `slice` bytes at a time, handing them on
 * in batches.  `progress` gets bytes read and the file's size.
 */
export async function readTrk(
  file: Blob,
  header: TrkHeader,
  onBatch: (batch: TrkBatch) => void | Promise<void>,
  options: { slice?: number; signal?: AbortSignal; progress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const slice = options.slice ?? 32 * 1024 * 1024;
  const ns = header.scalarNames.length;
  const np = header.propertyNames.length;
  const toRas = header.toRas;
  const little = header.littleEndian;
  let carry = new Uint8Array(0);
  let at = TRK_HEADER_SIZE;
  let streamlines = 0;
  while (at < file.size || carry.byteLength > 0) {
    options.signal?.throwIfAborted();
    const fresh = at < file.size ? new Uint8Array(await file.slice(at, Math.min(file.size, at + slice)).arrayBuffer()) : new Uint8Array(0);
    at += fresh.byteLength;
    let bytes = fresh;
    if (carry.byteLength > 0) {
      bytes = new Uint8Array(carry.byteLength + fresh.byteLength);
      bytes.set(carry);
      bytes.set(fresh, carry.byteLength);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Whole records in these bytes.
    const starts: number[] = [];
    const counts: number[] = [];
    let p = 0;
    let points = 0;
    while (p + 4 <= bytes.byteLength) {
      const n = view.getInt32(p, little);
      if (n < 0) throw new Error(`a streamline of ${n} points at byte ${at - bytes.byteLength + p}`);
      const size = 4 + 4 * (n * (3 + ns) + np);
      if (p + size > bytes.byteLength) break;
      starts.push(p);
      counts.push(n);
      points += n;
      p += size;
    }
    if (starts.length === 0 && fresh.byteLength === 0) throw new Error(`the file ends inside a streamline (${bytes.byteLength} bytes left)`);
    const batch: TrkBatch = {
      points: new Float32Array(points * 3),
      offsets: new Uint32Array(starts.length + 1),
      scalars: new Float32Array(points * ns),
      properties: new Float32Array(starts.length * np),
    };
    let point = 0;
    for (let s = 0; s < starts.length; ++s) {
      let q = starts[s] + 4;
      batch.offsets[s] = point;
      for (let i = 0; i < counts[s]; ++i, ++point) {
        const x = view.getFloat32(q, little);
        const y = view.getFloat32(q + 4, little);
        const z = view.getFloat32(q + 8, little);
        q += 12;
        batch.points[3 * point] = toRas[0] * x + toRas[1] * y + toRas[2] * z + toRas[3];
        batch.points[3 * point + 1] = toRas[4] * x + toRas[5] * y + toRas[6] * z + toRas[7];
        batch.points[3 * point + 2] = toRas[8] * x + toRas[9] * y + toRas[10] * z + toRas[11];
        for (let k = 0; k < ns; ++k, q += 4) batch.scalars[point * ns + k] = view.getFloat32(q, little);
      }
      for (let k = 0; k < np; ++k, q += 4) batch.properties[s * np + k] = view.getFloat32(q, little);
    }
    batch.offsets[starts.length] = point;
    streamlines += starts.length;
    if (starts.length > 0) await onBatch(batch);
    carry = bytes.slice(p);
    options.progress?.(at, file.size);
    if (fresh.byteLength === 0 && carry.byteLength > 0) throw new Error(`the file ends inside a streamline (${carry.byteLength} bytes left)`);
  }
  return streamlines;
}
