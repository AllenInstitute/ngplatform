/**
 * Feather (Arrow IPC file, version 2) tables of points, as pandas and
 * pyarrow write them: every record batch's numeric columns (integers,
 * floats, booleans), their buffers uncompressed, LZ4 (frame) or ZSTD
 * compressed.  Strings and nested columns are skipped (their buffers
 * counted, so the columns after them are read right).  The Arrow metadata
 * is FlatBuffers, read here directly: the few tables a reader of numbers
 * needs.
 */
import { decompress as zstd } from "fzstd";
import { type PointTable, pointTableOf } from "./point_files.js";

/** A FlatBuffers table: its position and its vtable's. */
class Table {
  constructor(
    private readonly view: DataView,
    readonly at: number,
  ) {}

  static root(view: DataView, at = 0): Table {
    return new Table(view, at + view.getUint32(at, true));
  }

  /** Where field `i` is, or 0 when absent. */
  private field(i: number): number {
    const vtable = this.at - this.view.getInt32(this.at, true);
    const size = this.view.getUint16(vtable, true);
    if (4 + 2 * i >= size) return 0;
    const offset = this.view.getUint16(vtable + 4 + 2 * i, true);
    return offset === 0 ? 0 : this.at + offset;
  }

  int(i: number, bytes: 1 | 2 | 4 | 8, fallback = 0): number {
    const at = this.field(i);
    if (at === 0) return fallback;
    return bytes === 1 ? this.view.getUint8(at) : bytes === 2 ? this.view.getInt16(at, true) : bytes === 4 ? this.view.getInt32(at, true) : Number(this.view.getBigInt64(at, true));
  }

  table(i: number): Table | undefined {
    const at = this.field(i);
    return at === 0 ? undefined : new Table(this.view, at + this.view.getUint32(at, true));
  }

  string(i: number): string {
    const at = this.field(i);
    if (at === 0) return "";
    const start = at + this.view.getUint32(at, true);
    const length = this.view.getUint32(start, true);
    return new TextDecoder().decode(new Uint8Array(this.view.buffer, this.view.byteOffset + start + 4, length));
  }

  /** A vector of tables. */
  tables(i: number): Table[] {
    const at = this.field(i);
    if (at === 0) return [];
    const start = at + this.view.getUint32(at, true);
    const n = this.view.getUint32(start, true);
    return Array.from({ length: n }, (_, k) => {
      const element = start + 4 + 4 * k;
      return new Table(this.view, element + this.view.getUint32(element, true));
    });
  }

  /** A vector of structs `size` bytes each: where each starts. */
  structs(i: number, size: number): number[] {
    const at = this.field(i);
    if (at === 0) return [];
    const start = at + this.view.getUint32(at, true);
    return Array.from({ length: this.view.getUint32(start, true) }, (_, k) => start + 4 + size * k);
  }
}

/** Arrow's type ids (Schema.fbs `Type` union). */
const TYPE = { Null: 1, Int: 2, FloatingPoint: 3, Binary: 4, Utf8: 5, Bool: 6, Decimal: 7, Date: 8, Time: 9, Timestamp: 10, Interval: 11, List: 12, Struct: 13, Union: 14, FixedSizeBinary: 15, FixedSizeList: 16, Map: 17, Duration: 18, LargeBinary: 19, LargeUtf8: 20, LargeList: 21 };

interface Column {
  name: string;
  /** How its values are read: an integer of so many bytes (signed or not), a float, a bit; else skipped. */
  kind: { int: number; signed: boolean } | { float: 2 | 4 | 8 } | { bool: true } | undefined;
  /** How many buffers it (and its children) take. */
  buffers: number;
}

function column(field: Table): Column {
  const name = field.string(0);
  const type = field.int(2, 1);
  const spec = field.table(3);
  const children = field.tables(5).map(column);
  const below = children.reduce((n, c) => n + c.buffers, 0);
  switch (type) {
    case TYPE.Int:
      return { name, kind: { int: (spec?.int(0, 4) ?? 32) / 8, signed: spec?.int(1, 1) === 1 }, buffers: 2 };
    case TYPE.FloatingPoint:
      return { name, kind: { float: ([2, 4, 8] as const)[spec?.int(0, 2) ?? 1] }, buffers: 2 };
    case TYPE.Bool:
      return { name, kind: { bool: true }, buffers: 2 };
    case TYPE.Null:
      return { name, kind: undefined, buffers: 0 };
    case TYPE.Binary: case TYPE.Utf8: case TYPE.LargeBinary: case TYPE.LargeUtf8:
      return { name, kind: undefined, buffers: 3 };
    case TYPE.List: case TYPE.LargeList: case TYPE.Map:
      return { name, kind: undefined, buffers: 2 + below };
    case TYPE.Struct: case TYPE.FixedSizeList:
      return { name, kind: undefined, buffers: 1 + below };
    case TYPE.Union:
      return { name, kind: undefined, buffers: (spec?.int(0, 2) === 1 ? 2 : 1) + below };
    default:
      // Fixed-width others (decimals, dates, times, timestamps, durations, intervals, fixed-size binary).
      return { name, kind: undefined, buffers: 2 };
  }
}

/**
 * An LZ4 frame, decompressed (linked or independent blocks: each block's
 * matches may reach back into the ones before, so all are decoded into one
 * output).
 */
export function lz4Frame(input: Uint8Array, size: number): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0, true) !== 0x184d2204) throw new Error("not an LZ4 frame");
  const flags = input[4];
  let at = 6 + (flags & 0x08 ? 8 : 0) + (flags & 0x01 ? 4 : 0) + 1;
  const blockChecksum = (flags & 0x10) !== 0;
  const out = new Uint8Array(size);
  let o = 0;
  for (;;) {
    const word = view.getUint32(at, true);
    at += 4;
    if (word === 0) break;
    const length = word & 0x7fffffff;
    if (word & 0x80000000) {
      out.set(input.subarray(at, at + length), o);
      o += length;
    } else {
      o = lz4Block(input, at, at + length, out, o);
    }
    at += length + (blockChecksum ? 4 : 0);
  }
  if (o !== size) throw new Error(`an LZ4 frame of ${o} bytes, not the ${size} its buffer says`);
  return out;
}

/** One LZ4 block from input[at, end) into out at `o`; returns where it ends. */
function lz4Block(input: Uint8Array, at: number, end: number, out: Uint8Array, o: number): number {
  while (at < end) {
    const token = input[at++];
    let literals = token >> 4;
    if (literals === 15) for (let b = 255; b === 255; literals += b) b = input[at++];
    out.set(input.subarray(at, at + literals), o);
    at += literals;
    o += literals;
    if (at >= end) break;
    const offset = input[at] | (input[at + 1] << 8);
    at += 2;
    let match = token & 15;
    if (match === 15) for (let b = 255; b === 255; match += b) b = input[at++];
    match += 4;
    // Byte by byte: a match may overlap what it copies.
    for (let from = o - offset; match > 0; --match) out[o++] = out[from++];
  }
  return o;
}

/** A Feather file's columns of numbers: names (every column's, in order), values, and how many rows. */
export function readFeather(bytes: Uint8Array): { names: string[]; values: Map<string, Float64Array>; rows: number; numeric: Set<string> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 6));
  if (magic(0) !== "ARROW1" || magic(bytes.length - 6) !== "ARROW1") {
    throw new Error(bytes[0] === 0x46 && bytes[1] === 0x45 ? "a Feather version 1 file (read only version 2, Arrow IPC)" : "not a Feather (Arrow IPC) file");
  }
  const footerLength = view.getInt32(bytes.length - 10, true);
  const footer = Table.root(new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 10 - footerLength, footerLength));
  const schema = footer.table(1);
  if (schema === undefined) throw new Error("a Feather file without a schema");
  if (schema.int(0, 2) === 1) throw new Error("a big-endian Feather file");
  const columns = schema.tables(1).map(column);
  // Record batch blocks: offset (int64), metadata length (int32, padded), body length (int64).
  const blocks = footer.structs(3, 24);
  const footerView = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 10 - footerLength, footerLength);
  const batches = blocks.map((b) => ({ offset: Number(footerView.getBigInt64(b, true)), metadata: footerView.getInt32(b + 8, true) }));
  const parts = new Map<string, Float64Array[]>(columns.filter((c) => c.kind !== undefined).map((c) => [c.name, []]));
  let rows = 0;
  for (const batch of batches) {
    // The message: a continuation marker (0xFFFFFFFF) and its length, then the flatbuffer.
    let start = batch.offset;
    if (view.getUint32(start, true) === 0xffffffff) start += 4;
    const metaLength = view.getInt32(start, true);
    const message = Table.root(new DataView(bytes.buffer, bytes.byteOffset + start + 4, metaLength));
    if (message.int(1, 1) !== 3) continue; // not a RecordBatch
    const record = message.table(2)!;
    const length = record.int(0, 8);
    const messageView = new DataView(bytes.buffer, bytes.byteOffset + start + 4, metaLength);
    const buffers = record.structs(2, 16).map((b) => ({ offset: Number(messageView.getBigInt64(b, true)), length: Number(messageView.getBigInt64(b + 8, true)) }));
    const compression = record.table(3);
    const codec = compression === undefined ? undefined : compression.int(0, 1);
    const body = batch.offset + batch.metadata;
    const buffer = (i: number): Uint8Array => {
      const b = buffers[i];
      const raw = bytes.subarray(body + b.offset, body + b.offset + b.length);
      if (codec === undefined || raw.length === 0) return raw;
      const size = Number(new DataView(raw.buffer, raw.byteOffset).getBigInt64(0, true));
      // -1: stored uncompressed after the length.
      if (size === -1) return raw.subarray(8);
      return codec === 0 ? lz4Frame(raw.subarray(8), size) : zstd(raw.subarray(8));
    };
    let next = 0;
    for (const c of columns) {
      if (c.kind !== undefined) {
        const validity = buffer(next);
        const data = buffer(next + 1);
        const values = new Float64Array(length);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const valid = (i: number) => validity.length === 0 || ((validity[i >> 3] >> (i & 7)) & 1) === 1;
        const k = c.kind;
        for (let i = 0; i < length; ++i) {
          if (!valid(i)) values[i] = NaN;
          else if ("bool" in k) values[i] = (data[i >> 3] >> (i & 7)) & 1;
          else if ("float" in k) values[i] = k.float === 8 ? dv.getFloat64(8 * i, true) : k.float === 4 ? dv.getFloat32(4 * i, true) : halfFloat(dv.getUint16(2 * i, true));
          else if (k.int === 8) values[i] = Number(k.signed ? dv.getBigInt64(8 * i, true) : dv.getBigUint64(8 * i, true));
          else if (k.int === 4) values[i] = k.signed ? dv.getInt32(4 * i, true) : dv.getUint32(4 * i, true);
          else if (k.int === 2) values[i] = k.signed ? dv.getInt16(2 * i, true) : dv.getUint16(2 * i, true);
          else values[i] = k.signed ? dv.getInt8(i) : dv.getUint8(i);
        }
        parts.get(c.name)!.push(values);
      }
      next += c.buffers;
    }
    rows += length;
  }
  const values = new Map<string, Float64Array>();
  for (const [name, list] of parts) {
    const all = new Float64Array(rows);
    let at = 0;
    for (const p of list) {
      all.set(p, at);
      at += p.length;
    }
    values.set(name, all);
  }
  return { names: columns.map((c) => c.name), values, rows, numeric: new Set(parts.keys()) };
}

function halfFloat(h: number): number {
  const e = (h >> 10) & 31;
  const f = h & 1023;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
}

/** A Feather file as a point table. */
export function featherPoints(bytes: Uint8Array): PointTable {
  const t = readFeather(bytes);
  return pointTableOf(t.names, t.values, t.rows, t.numeric, "Feather");
}
