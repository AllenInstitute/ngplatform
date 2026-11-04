/**
 * TRX tractograms (https://github.com/tee-ar-ex/trx-spec): a zip of arrays
 * named by what they hold: `header.json`, `positions.3.<dtype>` (RAS+ mm),
 * `offsets.<dtype>` (each streamline's first point), `dpv/<name>.<dtype>`
 * (per point), `dps/<name>.<dtype>` (per streamline).  Read from the zip in
 * place (stored entries a slice at a time; deflated ones decompressed once),
 * handed on in the same batches as a .trk.
 */
import { gather, readRanges, type TrkBatch } from "./trk.js";

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);
const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

async function bytesAt(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** A zip's entries, from its central directory (ZIP64 included). */
export async function zipEntries(file: Blob): Promise<Map<string, ZipEntry>> {
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await bytesAt(file, tailStart, file.size);
  const view = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; --i) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip file (no end of central directory)");
  let count = u16(view, eocd + 10);
  let size = u32(view, eocd + 12);
  let offset = u32(view, eocd + 16);
  if (offset === 0xffffffff || size === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(view, locator) !== 0x07064b50) throw new Error("a ZIP64 file without its locator");
    const at = u64(view, locator + 8);
    const record = new DataView((await bytesAt(file, at, at + 56)).buffer);
    if (u32(record, 0) !== 0x06064b50) throw new Error("a broken ZIP64 end record");
    count = u64(record, 32);
    size = u64(record, 40);
    offset = u64(record, 48);
  }
  const directory = await bytesAt(file, offset, offset + size);
  const dir = new DataView(directory.buffer);
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let i = 0; i < count; ++i) {
    if (u32(dir, p) !== 0x02014b50) throw new Error("a broken zip central directory");
    const method = u16(dir, p + 10);
    let compressedSize = u32(dir, p + 20);
    let entrySize = u32(dir, p + 24);
    const nameLength = u16(dir, p + 28);
    const extraLength = u16(dir, p + 30);
    const commentLength = u16(dir, p + 32);
    let localOffset = u32(dir, p + 42);
    const name = new TextDecoder().decode(directory.subarray(p + 46, p + 46 + nameLength));
    // ZIP64 sizes and offset, in the extra field, in this order where saturated.
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = u16(dir, e);
      const length = u16(dir, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (entrySize === 0xffffffff) (entrySize = u64(dir, q)), (q += 8);
        if (compressedSize === 0xffffffff) (compressedSize = u64(dir, q)), (q += 8);
        if (localOffset === 0xffffffff) localOffset = u64(dir, q);
      }
      e += 4 + length;
    }
    entries.set(name, { name, method, compressedSize, size: entrySize, localOffset });
    p = extraEnd + commentLength;
  }
  return entries;
}

/** Reads ranges of an entry's (uncompressed) bytes. */
async function entryReader(file: Blob, entry: ZipEntry): Promise<(start: number, end: number) => Promise<Uint8Array>> {
  const local = new DataView((await bytesAt(file, entry.localOffset, entry.localOffset + 30)).buffer);
  if (u32(local, 0) !== 0x04034b50) throw new Error(`${entry.name}: a broken zip entry`);
  const data = entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
  if (entry.method === 0) return (start, end) => bytesAt(file, data + start, data + end);
  if (entry.method !== 8) throw new Error(`${entry.name}: zip compression ${entry.method} is not read (stored and deflate only)`);
  const stream = file.slice(data, data + entry.compressedSize).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const whole = new Uint8Array(await new Response(stream).arrayBuffer());
  return async (start, end) => whole.subarray(start, end);
}

const SIZES: Record<string, number> = { float16: 2, float32: 4, float64: 8, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8 };

/** Half-precision floats to numbers. */
function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Little-endian values of a dtype as numbers. */
function decode(bytes: Uint8Array, dtype: string): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = SIZES[dtype];
  const n = Math.floor(bytes.byteLength / size);
  const out = new Float64Array(n);
  const get: (at: number) => number = {
    float16: (at: number) => half(view.getUint16(at, true)),
    float32: (at: number) => view.getFloat32(at, true),
    float64: (at: number) => view.getFloat64(at, true),
    int8: (at: number) => view.getInt8(at),
    uint8: (at: number) => view.getUint8(at),
    int16: (at: number) => view.getInt16(at, true),
    uint16: (at: number) => view.getUint16(at, true),
    int32: (at: number) => view.getInt32(at, true),
    uint32: (at: number) => view.getUint32(at, true),
    int64: (at: number) => Number(view.getBigInt64(at, true)),
    uint64: (at: number) => Number(view.getBigUint64(at, true)),
  }[dtype]!;
  for (let i = 0; i < n; ++i) out[i] = get(i * size);
  return out;
}

/** "fa.float32" or "fa.1.float32": the name, columns and dtype; undefined when not an array name. */
function arrayName(file: string): { name: string; columns: number; dtype: string } | undefined {
  const m = /^(.+?)(?:\.(\d+))?\.(float16|float32|float64|u?int(?:8|16|32|64))$/.exec(file);
  return m === null ? undefined : { name: m[1], columns: m[2] === undefined ? 1 : Number(m[2]), dtype: m[3] };
}

export interface TrxInfo {
  entries: Map<string, ZipEntry>;
  count: number;
  vertices: number;
  dims: number[];
  voxelToRas: number[][];
  positions: { entry: ZipEntry; dtype: string };
  offsets: { entry: ZipEntry; dtype: string };
  /** Single-column per-point and per-streamline values (others are left out). */
  scalars: { name: string; entry: ZipEntry; dtype: string }[];
  properties: { name: string; entry: ZipEntry; dtype: string }[];
}

export async function openTrxInfo(file: Blob): Promise<TrxInfo> {
  const entries = await zipEntries(file);
  // Entries may sit in a top folder.
  const strip = (name: string) => name.replace(/^[^/]+\.trx\//, "");
  const byName = new Map([...entries.values()].map((e) => [strip(e.name), e]));
  const headerEntry = byName.get("header.json");
  if (headerEntry === undefined) throw new Error("a TRX without header.json");
  const header = JSON.parse(new TextDecoder().decode(await (await entryReader(file, headerEntry))(0, headerEntry.size)));
  const find = (prefix: string) =>
    [...byName.entries()].flatMap(([name, entry]) => {
      if (!name.startsWith(prefix)) return [];
      const parsed = arrayName(name.slice(prefix.length));
      return parsed === undefined || name.slice(prefix.length).includes("/") ? [] : [{ ...parsed, entry }];
    });
  const positions = find("").find((a) => a.name === "positions" && a.columns === 3);
  const offsets = find("").find((a) => a.name === "offsets");
  if (positions === undefined || offsets === undefined) throw new Error("a TRX without positions.3.<dtype> or offsets.<dtype>");
  return {
    entries,
    count: Number(header.NB_STREAMLINES ?? 0),
    vertices: Number(header.NB_VERTICES ?? 0),
    dims: header.DIMENSIONS ?? [],
    voxelToRas: header.VOXEL_TO_RASMM ?? [],
    positions: { entry: positions.entry, dtype: positions.dtype },
    offsets: { entry: offsets.entry, dtype: offsets.dtype },
    scalars: find("dpv/").filter((a) => a.columns === 1).map(({ name, entry, dtype }) => ({ name, entry, dtype })),
    properties: find("dps/").filter((a) => a.columns === 1).map(({ name, entry, dtype }) => ({ name, entry, dtype })),
  };
}

/** Where an entry's data starts in the zip. */
async function dataOffset(file: Blob, entry: ZipEntry): Promise<number> {
  const local = new DataView((await bytesAt(file, entry.localOffset, entry.localOffset + 30)).buffer);
  if (u32(local, 0) !== 0x04034b50) throw new Error(`${entry.name}: a broken zip entry`);
  return entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
}

/**
 * Reads an entry from its start, `n` bytes at a time: a stored entry
 * straight from the file, a deflated one through a decompressing stream,
 * so neither is held whole.
 */
async function entryStream(file: Blob, entry: ZipEntry): Promise<(n: number) => Promise<Uint8Array>> {
  const data = await dataOffset(file, entry);
  if (entry.method === 0) {
    let at = 0;
    return async (n) => {
      const out = await bytesAt(file, data + at, data + Math.min(entry.size, at + n));
      at += out.byteLength;
      return out;
    };
  }
  if (entry.method !== 8) throw new Error(`${entry.name}: zip compression ${entry.method} is not read (stored and deflate only)`);
  const reader = file.slice(data, data + entry.compressedSize).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  let parts: Uint8Array[] = [];
  let held = 0;
  let ended = false;
  return async (n) => {
    while (held < n && !ended) {
      const { done, value } = await reader.read();
      if (done) ended = true;
      else {
        parts.push(value);
        held += value.byteLength;
      }
    }
    const take = Math.min(n, held);
    const out = new Uint8Array(take);
    let at = 0;
    const rest: Uint8Array[] = [];
    for (const part of parts) {
      if (at >= take) rest.push(part);
      else if (at + part.byteLength <= take) {
        out.set(part, at);
        at += part.byteLength;
      } else {
        out.set(part.subarray(0, take - at), at);
        rest.push(part.subarray(take - at));
        at = take;
      }
    }
    parts = rest;
    held -= take;
    return out;
  };
}

/** Reads every streamline, `perBatch` streamlines at a time, each array streamed; resolves to how many there were. */
export async function readTrx(
  file: Blob,
  info: TrxInfo,
  onBatch: (batch: TrkBatch) => void | Promise<void>,
  options: { perBatch?: number; progress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const perBatch = options.perBatch ?? 100_000;
  const offsetSize = SIZES[info.offsets.dtype];
  const positionSize = 3 * SIZES[info.positions.dtype];
  const vertices = info.vertices || info.positions.entry.size / positionSize;
  const entryCount = info.offsets.entry.size / offsetSize;
  // Offsets are each streamline's start; some writers add the end too.
  const count = info.count || entryCount;
  const offsets = await entryStream(file, info.offsets.entry);
  const positions = await entryStream(file, info.positions.entry);
  const scalars = await Promise.all(info.scalars.map(async (s) => ({ ...s, read: await entryStream(file, s.entry), size: SIZES[s.dtype] })));
  const properties = await Promise.all(info.properties.map(async (p) => ({ ...p, read: await entryStream(file, p.entry), size: SIZES[p.dtype] })));
  let next = decode(await offsets(offsetSize), info.offsets.dtype)[0] ?? 0;
  for (let first = 0; first < count; first += perBatch) {
    const last = Math.min(count, first + perBatch);
    // This batch's starts, and the next one's (the end, past the last streamline).
    const more = decode(await offsets((last - first) * offsetSize), info.offsets.dtype);
    const starts = new Float64Array(last - first + 1);
    starts[0] = next;
    for (let s = 1; s <= last - first; ++s) starts[s] = s - 1 < more.length && first + s < count ? more[s - 1] : vertices;
    next = starts[last - first];
    const v0 = starts[0];
    const v1 = starts[last - first];
    const points = Float32Array.from(decode(await positions((v1 - v0) * positionSize), info.positions.dtype));
    const values = new Float32Array((v1 - v0) * scalars.length);
    for (let k = 0; k < scalars.length; ++k) {
      const column = decode(await scalars[k].read((v1 - v0) * scalars[k].size), scalars[k].dtype);
      for (let i = 0; i < column.length; ++i) values[i * scalars.length + k] = column[i];
    }
    const batchOffsets = new Uint32Array(last - first + 1);
    for (let s = 0; s <= last - first; ++s) batchOffsets[s] = starts[s] - v0;
    const props = new Float32Array((last - first) * properties.length);
    for (let k = 0; k < properties.length; ++k) {
      const column = decode(await properties[k].read((last - first) * properties[k].size), properties[k].dtype);
      for (let s = 0; s < column.length; ++s) props[s * properties.length + k] = column[s];
    }
    await onBatch({ points, offsets: batchOffsets, scalars: values, properties: props, starts });
    options.progress?.(last, count);
  }
  return count;
}

/** Whether a TRX's streamlines can be read by id in place: its offsets and positions stored, not deflated. */
export function trxInPlace(info: TrxInfo): boolean {
  return info.offsets.entry.method === 0 && info.positions.entry.method === 0;
}

/**
 * Streamlines `ids` (sorted) of a TRX whose offsets and positions are
 * stored: each one's offsets, then its points, read from the file in place.
 */
export async function readTrxStreamlines(file: Blob, info: TrxInfo, ids: Uint32Array): Promise<{ offsets: Uint32Array; points: Float32Array }> {
  const offsetSize = SIZES[info.offsets.dtype];
  const positionSize = 3 * SIZES[info.positions.dtype];
  const vertices = info.vertices || info.positions.entry.size / positionSize;
  const entryCount = info.offsets.entry.size / offsetSize;
  const count = info.count || entryCount;
  const offsetsAt = await dataOffset(file, info.offsets.entry);
  const positionsAt = await dataOffset(file, info.positions.entry);
  // Each id's start and end (the next start, or the end of the positions).
  const spans = new Float64Array(2 * ids.length);
  await readRanges(
    file,
    Array.from(ids, (id) => ({ start: offsetsAt + id * offsetSize, end: offsetsAt + Math.min(entryCount, id + 2) * offsetSize })),
    (k, bytes, at) => {
      const values = decode(bytes.subarray(at, at + 2 * offsetSize), info.offsets.dtype);
      spans[2 * k] = values[0];
      spans[2 * k + 1] = values.length > 1 && ids[k] + 1 < count ? values[1] : vertices;
    },
  );
  const found = new Map<number, Float32Array>();
  await readRanges(
    file,
    Array.from(ids, (_, k) => ({ start: positionsAt + spans[2 * k] * positionSize, end: positionsAt + spans[2 * k + 1] * positionSize })),
    (k, bytes, at) => {
      const n = spans[2 * k + 1] - spans[2 * k];
      found.set(ids[k], Float32Array.from(decode(bytes.subarray(at, at + n * positionSize), info.positions.dtype)));
    },
  );
  return gather(ids, found);
}
