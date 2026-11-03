/**
 * MRtrix .tck files: a text header ("mrtrix tracks" … "END"), then float32
 * x y z triplets in scanner RAS+ millimetres, a NaN triplet after each
 * streamline and an infinite one at the end.  Read in one pass, handed on
 * in the same batches as a .trk.
 */
import { gather, readRanges, type TrkBatch } from "./trk.js";

export interface TckHeader {
  /** Where the points start. */
  offset: number;
  littleEndian: boolean;
  /** Streamlines, or 0 when the header does not say. */
  count: number;
  fields: Record<string, string>;
}

export function parseTckHeader(bytes: Uint8Array): TckHeader {
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.startsWith("mrtrix tracks")) throw new Error("not an MRtrix .tck file");
  const end = text.indexOf("\nEND");
  if (end === -1) throw new Error("a .tck header without END (or longer than was read)");
  const fields: Record<string, string> = {};
  for (const line of text.slice(0, end).split("\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const file = /^\.\s+(\d+)$/.exec(fields.file ?? "");
  if (file === null) throw new Error(`a .tck whose data is not in the same file (file: ${fields.file})`);
  const datatype = fields.datatype ?? "Float32LE";
  if (!/^Float32(LE|BE)?$/i.test(datatype)) throw new Error(`a .tck of ${datatype} (Float32 only)`);
  return { offset: Number(file[1]), littleEndian: !/BE$/i.test(datatype), count: Number.parseInt(fields.count ?? "0", 10) || 0, fields };
}

/** A slice's floats (little- or big-endian, aligned or not) as a Float32Array. */
function floatsOf(bytes: Uint8Array, little: boolean): Float32Array {
  if (little && bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength >> 2);
  for (let i = 0; i < out.length; ++i) out[i] = view.getFloat32(4 * i, little);
  return out;
}

/** Reads every streamline, `slice` bytes at a time; resolves to how many there were. */
export async function readTck(
  file: Blob,
  header: TckHeader,
  onBatch: (batch: TrkBatch) => void | Promise<void>,
  options: { slice?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const slice = Math.max(12, Math.floor((options.slice ?? 32 * 1024 * 1024) / 12) * 12);
  const little = header.littleEndian;
  let at = header.offset;
  let streamlines = 0;
  // The streamline being read, carried across slices: its points and where it starts.
  let carry = new Float32Array(0);
  let carryStart = at;
  let done = false;
  while (!done && at < file.size) {
    options.signal?.throwIfAborted();
    const sliceStart = at;
    const bytes = new Uint8Array(await file.slice(at, Math.min(file.size, at + slice)).arrayBuffer());
    at += bytes.byteLength;
    const f = floatsOf(bytes.subarray(0, bytes.byteLength - (bytes.byteLength % 12)), little);
    const triplets = f.length / 3;
    // Separators first: how many streamlines end here, and the points.
    let ends = 0;
    let stop = triplets;
    for (let t = 0; t < triplets; ++t) {
      const x = f[3 * t];
      if (Number.isNaN(x)) ++ends;
      else if (!Number.isFinite(x)) {
        stop = t;
        done = true;
        break;
      }
    }
    const pointCount = carry.length / 3 + stop - ends;
    const points = new Float32Array(3 * (ends > 0 ? pointCount : 0));
    const offsets = new Uint32Array(ends + 1);
    const starts = new Float64Array(ends + 1);
    let n = 0;
    let s = 0;
    let lineStart = carryStart;
    if (ends > 0) {
      points.set(carry);
      n = carry.length / 3;
    }
    let pending = ends > 0 ? -1 : 0;
    for (let t = 0; t < stop; ++t) {
      const x = f[3 * t];
      if (Number.isNaN(x)) {
        if (s < ends) {
          starts[s] = lineStart;
          offsets[++s] = n;
          lineStart = sliceStart + 12 * (t + 1);
          if (s === ends) pending = t + 1;
        }
      } else if (s < ends) {
        points[3 * n] = x;
        points[3 * n + 1] = f[3 * t + 1];
        points[3 * n + 2] = f[3 * t + 2];
        ++n;
      }
    }
    // What follows the last separator carries on into the next slice.
    if (ends > 0) {
      carry = f.slice(3 * pending, 3 * stop);
      carryStart = lineStart;
      starts[ends] = lineStart;
      streamlines += ends;
      // (Points after the last separator went to the carry, not here.)
      await onBatch({ points: points.subarray(0, 3 * n), offsets, scalars: new Float32Array(0), properties: new Float32Array(0), starts });
    } else {
      const grown = new Float32Array(carry.length + 3 * stop);
      grown.set(carry);
      grown.set(f.subarray(0, 3 * stop), carry.length);
      carry = grown;
    }
  }
  // A file cut short of its end marker: keep the last streamline.
  if (carry.length > 0) {
    streamlines += 1;
    await onBatch({ points: carry, offsets: Uint32Array.from([0, carry.length / 3]), scalars: new Float32Array(0), properties: new Float32Array(0), starts: Float64Array.from([carryStart, at]) });
  }
  return streamlines;
}

/**
 * Streamlines `ids` (sorted) of a .tck, whole: each found from the
 * checkpoint before it (every `every`-th streamline's first byte, the last
 * entry the end of the data) by counting separators.
 */
export async function readTckStreamlines(file: Blob, header: TckHeader, ids: Uint32Array, checkpoints: Float64Array, every: number): Promise<{ offsets: Uint32Array; points: Float32Array }> {
  const blocks: { start: number; end: number; block: number }[] = [];
  for (const id of ids) {
    const block = Math.floor(id / every);
    if (blocks.length > 0 && blocks[blocks.length - 1].block === block) continue;
    blocks.push({ start: checkpoints[block], end: checkpoints[Math.min(block + 1, checkpoints.length - 1)], block });
  }
  const found = new Map<number, Float32Array>();
  let next = 0;
  await readRanges(file, blocks, (k, bytes, at) => {
    const block = blocks[k];
    const f = floatsOf(bytes.subarray(at, at + (block.end - block.start) - ((block.end - block.start) % 12)), header.littleEndian);
    let id = block.block * every;
    let t = 0;
    while (next < ids.length && Math.floor(ids[next] / every) === block.block) {
      const want = ids[next];
      for (; id < want; ++id) {
        while (t < f.length / 3 && !Number.isNaN(f[3 * t])) ++t;
        ++t;
      }
      const first = t;
      while (t < f.length / 3 && Number.isFinite(f[3 * t])) ++t;
      found.set(want, f.slice(3 * first, 3 * t));
      ++next;
    }
  });
  return gather(ids, found);
}
