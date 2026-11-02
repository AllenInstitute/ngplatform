/**
 * MRtrix .tck files: a text header ("mrtrix tracks" … "END"), then float32
 * x y z triplets in scanner RAS+ millimetres, a NaN triplet after each
 * streamline and an infinite one at the end.  Read in one pass, handed on
 * in the same batches as a .trk.
 */
import type { TrkBatch } from "./trk.js";

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
  // The streamline being read, carried across slices.
  let current: number[] = [];
  let done = false;
  while (!done && at < file.size) {
    options.signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(at, Math.min(file.size, at + slice)).arrayBuffer());
    at += bytes.byteLength;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points: number[] = [];
    const offsets: number[] = [0];
    const take = (line: number[]) => {
      for (const v of line) points.push(v);
      offsets.push(points.length / 3);
    };
    for (let p = 0; p + 12 <= bytes.byteLength; p += 12) {
      const x = view.getFloat32(p, little);
      const y = view.getFloat32(p + 4, little);
      const z = view.getFloat32(p + 8, little);
      if (Number.isNaN(x)) {
        take(current);
        current = [];
      } else if (!Number.isFinite(x)) {
        done = true;
        break;
      } else {
        current.push(x, y, z);
      }
    }
    if (offsets.length > 1) {
      streamlines += offsets.length - 1;
      await onBatch({ points: Float32Array.from(points), offsets: Uint32Array.from(offsets), scalars: new Float32Array(0), properties: new Float32Array(0) });
    }
  }
  // A file cut short of its end marker: keep the last streamline.
  if (current.length > 0) {
    streamlines += 1;
    await onBatch({ points: Float32Array.from(current), offsets: Uint32Array.from([0, current.length / 3]), scalars: new Float32Array(0), properties: new Float32Array(0) });
  }
  return streamlines;
}
