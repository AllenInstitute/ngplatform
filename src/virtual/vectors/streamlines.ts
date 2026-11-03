/**
 * A virtual zarr-vectors streamline store: streamlines (from a .trk, .tck,
 * .trx, or any reader that hands them over in batches) binned once into
 * spatial cells, and every key of the store (`zarr.json`,
 * `0/vertices/c/1/0/2`, …) made from that when asked.
 *
 * The layout is format 0.9.2's, as zarr-vectors-py writes a streamline
 * store and zarr-vectors-tools converts a tractogram, and is read by this
 * package's reader and by Track filtering:
 *
 * - level 0: every streamline, split where it changes cell into fragments
 *   (one per run of vertices in a cell, in object then walk order; boundary
 *   vertices are not repeated), with a bridge record (links/0/<offset>,
 *   the "directed" policy) for each crossing;
 * - levels 1 to 4, for large tractograms: about one streamline in 10, 100,
 *   1000 … (each a subset of the one before: see `sampleDepth`) while a
 *   level keeps about 2,000 or more, every 4th, 8th, 16th … point (and the
 *   last), in cells 2, 4, 8 … times as large, keeping level 0's ids;
 * - objects: a manifest per streamline (its fragments in walk order) in
 *   the `vlen_manifests_v1` layout, whose rows are the ids (0, 1, 2 … in
 *   file order), and per-streamline columns (length, points, the file's
 *   properties); per-point values as vertex attributes.
 *
 * Unsharded and uncompressed throughout, so every cell is range-readable.
 *
 * Memory: the one pass over the file writes each cell's fragments and
 * bridges, each level's manifests and the object columns into a spill
 * (./spill.ts: a file in OPFS for a large tractogram, memory for a small
 * one), as append-only segments; memory keeps only an index of them (per
 * cell: its segments, rows, fragments, bounds, bridge directions; per 16,384
 * objects: where their manifests are; per 16 streamlines: where they start
 * in the file).  Keys are made from the spill when asked, and decoded cells
 * are kept in a least-recently-used cache (`cacheBudget()`).  Whole
 * streamlines by id (`message({ curves })`) are read from the file itself.
 */
import { cacheBudget, MemorySpill, type Spill } from "./spill.js";
import type { TrkBatch } from "./trk.js";

const MAGIC = 0x5a564647;
const MANIFEST_ROWS = 16384;
const COLUMN_ROWS = 65536;
/** Every CHECKPOINT-th streamline's place in the file is kept, to read streamlines by id. */
export const CHECKPOINT = 16;
/** A cell's pending records are written out at this size … */
const FLUSH_BYTES = 128 * 1024;
/** … and every cell's once all of them hold this much. */
const PENDING_BYTES = 64 * 1024 * 1024;

/** A typed array that grows. */
class Grow<T extends Float32Array | Float64Array | Uint32Array | Int32Array | Uint8Array> {
  data: T;
  length = 0;
  constructor(private readonly make: (n: number) => T, capacity = 64) {
    this.data = make(capacity);
  }
  reserve(extra: number): void {
    if (this.length + extra <= this.data.length) return;
    let capacity = this.data.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = this.make(capacity);
    next.set(this.data.subarray(0, this.length) as never);
    this.data = next;
  }
  push(value: number): void {
    this.reserve(1);
    this.data[this.length++] = value;
  }
  view(): T {
    return this.data.subarray(0, this.length) as T;
  }
}

const f32 = (n: number) => new Float32Array(n);
const f64 = (n: number) => new Float64Array(n);
const u32 = (n: number) => new Uint32Array(n);
const u8 = (n: number) => new Uint8Array(n);

// ---------------------------------------------------------------- sampling

/** A 32-bit hash of a streamline's id (murmur3's finaliser). */
export function sampleHash(id: number): number {
  let h = (id >>> 0) ^ Math.floor(id / 4294967296);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The coarsest sample level that keeps streamline `id`: level k keeps the
 * ids whose hash is below 2³² / 10ᵏ, so each level keeps about one in ten
 * of the one before and is a subset of it, decided from the id alone while
 * the file streams past.  Uniform over the ids like zarr-vectors-tools'
 * `random` sparsity strategy (each level a fraction of the one before),
 * though not the same ids, and the counts are about, not exactly, a tenth.
 */
export function sampleDepth(id: number, levels: number): number {
  const h = sampleHash(id);
  let k = 0;
  let limit = 4294967296 / 10;
  while (k < levels && h < limit) {
    ++k;
    limit /= 10;
  }
  return k;
}

// ---------------------------------------------------------------- spilled cells

/** The writer every level shares: the spill, and pending bytes across cells. */
class Writer {
  pending = 0;
  readonly cells: Cell[] = [];
  constructor(readonly spill: Spill) {}

  /** Writes out every pending record, and gives back the buffers' memory. */
  flushAll(): void {
    for (const cell of this.cells) {
      cell.flushFragments(this, true);
      cell.flushBridges(this, true);
    }
  }
}

/** Records waiting to be written: 32-bit words. */
class Pending {
  words = new Uint32Array(256);
  /** The same words, as floats. */
  floats = new Float32Array(this.words.buffer);
  length = 0;
  reserve(writer: Writer, extra: number): void {
    if (this.length + extra <= this.words.length) return;
    let capacity = this.words.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.set(this.words.subarray(0, this.length));
    writer.pending += 4 * (capacity - this.words.length);
    this.words = next;
    this.floats = new Float32Array(next.buffer);
  }
  /**
   * Writes the words out as one segment ([offset, length] pushed onto
   * `segments`); with `release`, gives back the buffer's memory too.
   */
  flush(writer: Writer, segments: number[], release: boolean): void {
    if (this.length > 0) {
      const bytes = new Uint8Array(this.words.buffer, 0, 4 * this.length);
      segments.push(writer.spill.append(bytes), bytes.byteLength);
      this.length = 0;
    }
    if (release && this.words.length > 256) {
      writer.pending -= 4 * (this.words.length - 256);
      this.words = new Uint32Array(256);
      this.floats = new Float32Array(this.words.buffer);
    }
  }
}

class Cell {
  rows = 0;
  /** The object of the last fragment written (fragment headers give steps from it). */
  lastOwner = 0;
  fragments = 0;
  bridges = 0;
  /** Fragment and bridge records written: offset, length pairs. */
  readonly segments: number[] = [];
  readonly bridgeSegments: number[] = [];
  fragmentWords: Pending | undefined;
  bridgeWords: Pending | undefined;
  /** Directions bridges leave this cell in (indices into the level's names). */
  readonly directions = new Set<number>();
  readonly lo = [Infinity, Infinity, Infinity];
  readonly hi = [-Infinity, -Infinity, -Infinity];
  constructor(readonly at: [number, number, number], readonly index: number) {}

  flushFragments(writer: Writer, release = false): void {
    this.fragmentWords?.flush(writer, this.segments, release);
  }

  flushBridges(writer: Writer, release = false): void {
    this.bridgeWords?.flush(writer, this.bridgeSegments, release);
  }
}

/** A cell decoded from the spill. */
interface Decoded {
  vertices: Float32Array;
  counts: Uint32Array;
  owners: Uint32Array;
  values: Float32Array[];
  bytes: number;
}

/** A cell's bridges, by direction: (row here, row there) pairs. */
type DecodedBridges = Map<number, Int32Array>;

const cellKey = (x: number, y: number, z: number) => ((x + 32768) * 65536 + (y + 32768)) * 65536 + (z + 32768);

// ---------------------------------------------------------------- varints

function putVarint(out: Grow<Uint8Array>, value: number): void {
  out.reserve(10);
  while (value >= 0x80) {
    out.data[out.length++] = (value % 128) | 0x80;
    value = Math.floor(value / 128);
  }
  out.data[out.length++] = value;
}

/** One level being built, then served. */
class Level {
  readonly cells: Cell[] = [];
  private readonly index = new Map<number, number>();
  /** Bridge directions ("+1.0.-1") by index. */
  readonly directionNames: string[] = [];
  private readonly directionIndex = new Map<number, number>();
  /** Manifests: per MANIFEST_ROWS objects, one segment (offset, length). */
  readonly manifestSegments: number[] = [];
  private readonly manifest = new Grow(u8, 4096);
  private readonly blocks = new Grow(u32);
  /** The run of points being made (x, y, z and values each). */
  private readonly run = new Grow(f32, 1024);
  readonly lo = [Infinity, Infinity, Infinity];
  readonly hi = [-Infinity, -Infinity, -Infinity];
  vertexCount = 0;
  present = 0;
  links = 0;
  private objects = 0;

  constructor(
    readonly path: string,
    readonly chunk: number,
    readonly valueNames: string[],
    readonly depth: number,
    readonly pointStep: number,
    private readonly writer: Writer,
  ) {}

  private cellAt(x: number, y: number, z: number): number {
    const key = cellKey(x, y, z);
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.cells.length;
      this.index.set(key, i);
      const cell = new Cell([x, y, z], i);
      this.cells.push(cell);
      this.writer.cells.push(cell);
    }
    return i;
  }

  private direction(from: number[], to: number[]): number {
    const key = cellKey(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    let i = this.directionIndex.get(key);
    if (i === undefined) {
      i = this.directionNames.length;
      this.directionNames.push([0, 1, 2].map((k) => to[k] - from[k]).map((d) => (d > 0 ? `+${d}` : `${d}`)).join("."));
      this.directionIndex.set(key, i);
    }
    return i;
  }

  /** Adds streamline `object` (the next one): points [first, last) of a batch, or none when it is not kept. */
  add(object: number, batch: TrkBatch, first: number, last: number, nValues: number, kept: boolean): void {
    if (object !== this.objects) throw new Error(`streamline ${object} out of order (expected ${this.objects})`);
    this.blocks.length = 0;
    if (kept && last > first) this.addPoints(object, batch, first, last, nValues);
    this.endObject();
  }

  private addPoints(object: number, batch: TrkBatch, first: number, last: number, nValues: number): void {
    const { points, scalars } = batch;
    const writer = this.writer;
    const c = this.chunk;
    const nv = this.valueNames.length;
    const stride = 3 + nv;
    const run = this.run;
    let cell: Cell | undefined;
    let prevLastRow = -1;
    let lastX = NaN;
    let lastY = NaN;
    let lastZ = NaN;
    let ci = -1;
    for (let p = first; p < last; ++p) {
      if (this.pointStep > 1 && (p - first) % this.pointStep !== 0 && p !== last - 1) continue;
      const x = points[3 * p];
      const y = points[3 * p + 1];
      const z = points[3 * p + 2];
      const gx = Math.floor(x / c);
      const gy = Math.floor(y / c);
      const gz = Math.floor(z / c);
      if (gx !== lastX || gy !== lastY || gz !== lastZ) {
        ci = this.cellAt(gx, gy, gz);
        lastX = gx;
        lastY = gy;
        lastZ = gz;
      }
      if (cell === undefined || ci !== cell.index) {
        const previous = cell;
        if (previous !== undefined) this.closeRun(previous, object, stride);
        cell = this.cells[ci];
        const fragment = cell.fragments++;
        const row = cell.rows;
        this.blocks.push(ci);
        this.blocks.push(fragment);
        if (previous !== undefined) {
          if (previous.bridgeWords === undefined) {
            previous.bridgeWords = new Pending();
            writer.pending += 1024;
          }
          const bridge = previous.bridgeWords;
          bridge.reserve(writer, 3);
          const d = this.direction(previous.at, cell.at);
          // (direction, row here, row there): the first two in one word when they fit.
          if (d < 64 && prevLastRow < 1 << 25) bridge.words[bridge.length++] = 0x80000000 + d * (1 << 25) + prevLastRow;
          else {
            bridge.words[bridge.length++] = d;
            bridge.words[bridge.length++] = prevLastRow;
          }
          bridge.words[bridge.length++] = row;
          previous.directions.add(d);
          previous.bridges++;
          this.links++;
          if (bridge.length * 4 >= FLUSH_BYTES) previous.flushBridges(writer);
        }
        run.length = 0;
      }
      run.reserve(stride);
      const floats = run.data;
      let at = run.length;
      floats[at++] = x;
      floats[at++] = y;
      floats[at++] = z;
      for (let k = 0; k < nv; ++k) floats[at++] = scalars[p * nValues + k];
      run.length = at;
      prevLastRow = cell.rows++;
      ++this.vertexCount;
      if (x < cell.lo[0]) cell.lo[0] = x;
      if (x > cell.hi[0]) cell.hi[0] = x;
      if (y < cell.lo[1]) cell.lo[1] = y;
      if (y > cell.hi[1]) cell.hi[1] = y;
      if (z < cell.lo[2]) cell.lo[2] = z;
      if (z > cell.hi[2]) cell.hi[2] = z;
    }
    if (cell !== undefined) this.closeRun(cell, object, stride);
    ++this.present;
    if (writer.pending > PENDING_BYTES) writer.flushAll();
  }

  /**
   * Writes the run of points just made in `cell` as a fragment record: a
   * header (its object and point count: one word, the object as a step from
   * the cell's last fragment's, when both fit; else two), then the points.
   */
  private closeRun(cell: Cell, object: number, stride: number): void {
    const writer = this.writer;
    const n = this.run.length / stride;
    if (cell.fragmentWords === undefined) {
      cell.fragmentWords = new Pending();
      writer.pending += 1024;
    }
    const words = cell.fragmentWords;
    words.reserve(writer, 2 + this.run.length);
    const step = object - cell.lastOwner;
    if (n < 4096 && step >= 0 && step < 1 << 19) words.words[words.length++] = 0x80000000 + step * 4096 + n;
    else {
      if (n >= 0x80000000) throw new Error(`a run of ${n} points`);
      words.words[words.length++] = n;
      words.words[words.length++] = object;
    }
    cell.lastOwner = object;
    words.floats.set(this.run.data.subarray(0, this.run.length), words.length);
    words.length += this.run.length;
    if (words.length * 4 >= FLUSH_BYTES) cell.flushFragments(writer);
  }

  private endObject(): void {
    const blocks = this.blocks;
    putVarint(this.manifest, blocks.length / 2);
    for (let i = 0; i < blocks.length; ++i) putVarint(this.manifest, blocks.data[i]);
    ++this.objects;
    if (this.objects % MANIFEST_ROWS === 0) this.flushManifests();
  }

  private flushManifests(): void {
    const bytes = this.manifest.view();
    this.manifestSegments.push(this.writer.spill.append(bytes), bytes.byteLength);
    this.manifest.length = 0;
  }

  /** Writes out what is pending; the level's bounds from its cells'. */
  finish(): void {
    if (this.objects % MANIFEST_ROWS !== 0 || this.objects === 0) this.flushManifests();
    for (const cell of this.cells) {
      for (let k = 0; k < 3; ++k) {
        if (cell.lo[k] < this.lo[k]) this.lo[k] = cell.lo[k];
        if (cell.hi[k] > this.hi[k]) this.hi[k] = cell.hi[k];
      }
    }
  }

  /** The grid's origin and shape, from bounds shared by every level. */
  grid(lo: number[], hi: number[]): { origin: number[]; shape: number[] } {
    const origin = lo.map((v) => Math.floor(v / this.chunk));
    const shape = hi.map((v, k) => Math.floor(v / this.chunk) - origin[k] + 1);
    return { origin, shape };
  }

  cellIndex(x: number, y: number, z: number): number | undefined {
    return this.index.get(cellKey(x, y, z));
  }

  /** Object `o`'s manifest: (cell, fragment) pairs, from its chunk of manifests. */
  manifestChunk(spill: Spill, chunk: number, count: number): Uint32Array[] {
    const at = this.manifestSegments[2 * chunk];
    const length = this.manifestSegments[2 * chunk + 1];
    const bytes = spill.read(at, length);
    const out: Uint32Array[] = [];
    let p = 0;
    const next = () => {
      let value = 0;
      let scale = 1;
      for (;;) {
        const b = bytes[p++];
        value += (b & 0x7f) * scale;
        if (b < 0x80) return value;
        scale *= 128;
      }
    };
    for (let o = 0; o < count; ++o) {
      const n = next();
      const pairs = new Uint32Array(2 * n);
      for (let i = 0; i < 2 * n; ++i) pairs[i] = next();
      out.push(pairs);
    }
    return out;
  }
}

/** Reads every segment of a list into one buffer. */
function readSegments(spill: Spill, segments: number[]): Uint8Array {
  let total = 0;
  for (let i = 1; i < segments.length; i += 2) total += segments[i];
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < segments.length; i += 2) {
    out.set(spill.read(segments[i], segments[i + 1]), at);
    at += segments[i + 1];
  }
  return out;
}

// ---------------------------------------------------------------- bytes

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** One element of a per-cell vlen-bytes array: u32 1, u32 length, the bytes. */
function element(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** A fragment index (fragment_index_v1) of fragments that are all ranges, tiling the cell's rows. */
export function fragmentIndex(counts: ArrayLike<number>): Uint8Array {
  const f = counts.length;
  const bitmap = 8 * Math.ceil(f / 64);
  const out = new Uint8Array(f === 0 ? 16 : 16 + bitmap + 16 * f + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, f, true);
  view.setUint32(12, f, true);
  if (f === 0) return out;
  for (let i = 0; i < f; ++i) out[16 + (i >> 3)] |= 1 << (i & 7);
  let row = 0;
  for (let i = 0; i < f; ++i) {
    const at = 16 + bitmap + 16 * i;
    view.setBigInt64(at, BigInt(row), true);
    view.setBigInt64(at + 8, BigInt(counts[i]), true);
    row += counts[i];
  }
  // The explicit fragments' offsets: none, so a single 0.
  view.setUint32(16 + bitmap + 16 * f, 0, true);
  return out;
}

/** A 1-D vlen-bytes chunk: `rows` elements, those past `items` empty. */
function vlenChunk(items: Uint8Array[], rows: number): Uint8Array {
  const size = 4 + 4 * rows + items.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, rows, true);
  let at = 4;
  for (let r = 0; r < rows; ++r) {
    const item = items[r];
    view.setUint32(at, item?.byteLength ?? 0, true);
    at += 4;
    if (item !== undefined) {
      out.set(item, at);
      at += item.byteLength;
    }
  }
  return out;
}

function arrayJson(shape: number[], attributes: Record<string, unknown>): unknown {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "variable_length_bytes",
    chunk_grid: { name: "regular", configuration: { chunk_shape: shape.map(() => 1) } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: "",
    codecs: [{ name: "vlen-bytes", configuration: {} }],
    attributes,
  };
}

function columnJson(n: number, rows: number, dataType: string, fill: unknown, attributes: Record<string, unknown> = {}): unknown {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [n],
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: [rows] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: fill,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    attributes,
  };
}

const group = (attributes: Record<string, unknown> = {}) => ({ zarr_format: 3, node_type: "group", attributes });

// ---------------------------------------------------------------- store

/** Whole streamlines: streamline i's points (RAS mm) are `points[3 * offsets[i] ..< 3 * offsets[i + 1]]`. */
export interface Streamlines {
  offsets: Uint32Array;
  points: Float32Array;
}

export interface StreamlineInput {
  /** Hands over every streamline, in batches, in order; resolves to how many there were. */
  read(onBatch: (batch: TrkBatch) => void | Promise<void>): Promise<number>;
  /**
   * Reads streamlines `ids` (sorted, distinct) whole from the file, given
   * where every CHECKPOINT-th streamline starts (`TrkBatch.starts`; the
   * last entry where the data ends).  Absent: the store reads them from its
   * cells instead (slower).
   */
  streamlines?(ids: Uint32Array, checkpoints: Float64Array): Promise<Streamlines>;
  /** Per-point and per-streamline value names. */
  scalarNames: string[];
  propertyNames: string[];
  /** About how many streamlines there are (0: unknown), to decide on coarse levels. */
  expectedCount: number;
  /** The space's extent, mm, to choose the cell size by (0: unknown). */
  extent: number;
  /** About how many bytes of points the file holds (0: unknown), to choose the cell size by. */
  bytes?: number;
  name: string;
}

/** Where a store keeps what it makes (default: memory). */
export interface BuildOptions {
  spill?: Spill;
  /** Decoded cells kept in memory, bytes (default: `cacheBudget()`). */
  cacheBytes?: number;
}

const NICE = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 100, 128, 200, 256];

/**
 * The cell size, mm: a round number giving about 10 cells across `extent`;
 * smaller for a large file, so that a cell holds about 4 MB of points
 * (assuming the points fill about 30% of the extent's cube).
 */
export function cellSize(extent: number, bytes = 0): number {
  if (!(extent > 0)) return 16;
  const want = extent / 10;
  let size = NICE.find((n) => n >= want) ?? 256;
  const cells = bytes / (4 * 1024 * 1024) / 0.3;
  if (cells > 1000) {
    const fine = extent / Math.cbrt(cells);
    const smaller = [...NICE].reverse().find((n) => n <= fine) ?? 1;
    size = Math.min(size, smaller);
  }
  return size;
}

/** How many sample levels a tractogram of about `count` streamlines gets: while a level keeps about 2,000. */
export function sampleLevels(count: number): number {
  if (count <= 20_000) return 0;
  let k = 0;
  for (let every = 10; k < 4 && count / every >= 2_000; every *= 10) ++k;
  return k;
}

class Column {
  private buffer = new Float32Array(COLUMN_ROWS).fill(Number.NaN);
  private n = 0;
  /** Per chunk of COLUMN_ROWS: offset, length. */
  readonly segments: number[] = [];
  constructor(readonly name: string) {}

  push(spill: Spill, value: number): void {
    this.buffer[this.n++ % COLUMN_ROWS] = value;
    if (this.n % COLUMN_ROWS === 0) this.flush(spill, COLUMN_ROWS);
  }

  private flush(spill: Spill, rows: number): void {
    this.segments.push(spill.append(bytesOf(this.buffer.subarray(0, rows))), 4 * rows);
    this.buffer.fill(Number.NaN);
  }

  finish(spill: Spill): void {
    if (this.n % COLUMN_ROWS !== 0) this.flush(spill, this.n % COLUMN_ROWS);
  }

  chunk(spill: Spill, k: number): Uint8Array | undefined {
    if (2 * k >= this.segments.length) return undefined;
    const out = new Float32Array(COLUMN_ROWS).fill(Number.NaN);
    const bytes = spill.read(this.segments[2 * k], this.segments[2 * k + 1]);
    out.set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    return bytesOf(out);
  }
}

/** Decoded cells and bridges, least recently used first, bounded in bytes. */
class CellCache {
  private readonly entries = new Map<string, { value: Decoded | DecodedBridges; bytes: number }>();
  private bytes = 0;
  constructor(private readonly budget: () => number) {}

  get<T extends Decoded | DecodedBridges>(key: string, make: () => { value: T; bytes: number }): T {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value as T;
    }
    const made = make();
    this.entries.set(key, made);
    this.bytes += made.bytes;
    const budget = this.budget();
    for (const [old, entry] of this.entries) {
      if (this.bytes <= budget || old === key) break;
      this.entries.delete(old);
      this.bytes -= entry.bytes;
    }
    return made.value;
  }

  /** Bytes held, entries. */
  get size(): { bytes: number; entries: number } {
    return { bytes: this.bytes, entries: this.entries.size };
  }
}

export class StreamlineStore {
  private readonly levels: Level[];
  private readonly count: number;
  private readonly lo: number[];
  private readonly hi: number[];
  private readonly columns: Column[];
  /** Directory paths, for listings. */
  private readonly directories: Set<string>;
  private readonly cache: CellCache;
  private closed = false;

  private constructor(
    levels: Level[],
    count: number,
    columns: Column[],
    readonly name: string,
    private readonly spill: Spill,
    private readonly checkpoints: Float64Array,
    private readonly input: StreamlineInput,
    cacheBytes: number | undefined,
    /** Seconds the pass over the file took, and of them binning (the rest: reading and parsing). */
    readonly timing: { seconds: number; binning: number },
  ) {
    this.levels = levels;
    this.count = count;
    this.columns = columns;
    this.cache = new CellCache(() => cacheBytes ?? cacheBudget());
    // Bounds shared by every level: level 0's, which hold every point.
    this.lo = levels[0].lo.map((v) => (Number.isFinite(v) ? v : 0));
    this.hi = levels[0].hi.map((v) => (Number.isFinite(v) ? v : 0));
    this.directories = new Set();
    const add = (path: string) => {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; ++i) this.directories.add(parts.slice(0, i).join("/"));
    };
    for (const level of levels) {
      const p = level.path;
      for (const a of ["vertices", "vertex_fragments", "fragment_attributes/segment_id", "object_index/manifests", "links/0"]) add(`${p}/${a}`);
      for (const name of level.directionNames) add(`${p}/links/0/${name}`);
      for (const v of level.valueNames) add(`${p}/vertex_attributes/${v}`);
    }
    for (const c of columns) add(`0/object_attributes/${c.name}`);
  }

  /** Reads every streamline once and bins it. */
  static async build(input: StreamlineInput, options: BuildOptions = {}): Promise<StreamlineStore> {
    const started = performance.now();
    const spill = options.spill ?? new MemorySpill();
    try {
      const writer = new Writer(spill);
      const chunk = cellSize(input.extent, input.bytes ?? 0);
      const nValues = input.scalarNames.length;
      const nProperties = input.propertyNames.length;
      const depth = sampleLevels(input.expectedCount);
      const levels = [new Level("0", chunk, input.scalarNames, 0, 1, writer)];
      // Coarser levels for large tractograms, each about one streamline in
      // ten of the last (a subset of it), in cells twice as large, with
      // fewer points each, while a level still holds a couple of thousand.
      for (let k = 1; k <= depth; ++k) levels.push(new Level(String(k), 2 ** k * chunk, [], k, 2 ** (k + 1), writer));
      const columns = [new Column("length"), new Column("n_points"), ...input.propertyNames.map((name) => new Column(name))];
      const checkpoints = new Grow(f64, 1024);
      let end = 0;
      let object = 0;
      let binning = 0;
      const count = await input.read((batch) => {
        const t = performance.now();
        for (let s = 0; s + 1 < batch.offsets.length; ++s, ++object) {
          const first = batch.offsets[s];
          const last = batch.offsets[s + 1];
          if (batch.starts !== undefined && object % CHECKPOINT === 0) checkpoints.push(batch.starts[s]);
          const keep = depth === 0 ? 0 : sampleDepth(object, depth);
          for (const level of levels) level.add(object, batch, first, last, nValues, level.depth <= keep);
          let arc = 0;
          for (let p = first + 1; p < last; ++p) {
            const dx = batch.points[3 * p] - batch.points[3 * p - 3];
            const dy = batch.points[3 * p + 1] - batch.points[3 * p - 2];
            const dz = batch.points[3 * p + 2] - batch.points[3 * p - 1];
            arc += Math.sqrt(dx * dx + dy * dy + dz * dz);
          }
          columns[0].push(spill, arc);
          columns[1].push(spill, last - first);
          for (let k = 0; k < nProperties; ++k) columns[2 + k].push(spill, batch.properties[s * nProperties + k]);
        }
        if (batch.starts !== undefined) end = batch.starts[batch.offsets.length - 1];
        binning += performance.now() - t;
      });
      if (count !== object) throw new Error(`the reader handed over ${object} streamlines but counted ${count}`);
      for (const level of levels) level.finish();
      writer.flushAll();
      for (const column of columns) column.finish(spill);
      checkpoints.push(end);
      const timing = { seconds: (performance.now() - started) / 1000, binning: binning / 1000 };
      return new StreamlineStore(levels, count, columns, input.name, spill, checkpoints.view().slice(), input, options.cacheBytes, timing);
    } catch (e) {
      spill.close();
      throw e;
    }
  }

  /** Lets the spill go. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.spill.close();
  }

  /** What the store keeps: spill bytes, the cache, and the index in memory (about). */
  stats(): { streamlines: number; levels: { path: string; cells: number; vertices: number; streamlines: number; chunk: number }[]; spillBytes: number; cacheBytes: number; cachedCells: number; indexBytes: number; seconds: number; binningSeconds: number } {
    let index = this.checkpoints.byteLength;
    for (const level of this.levels) {
      index += level.manifestSegments.length * 8;
      for (const cell of level.cells) index += 200 + 8 * (cell.segments.length + cell.bridgeSegments.length);
    }
    return {
      streamlines: this.count,
      levels: this.levels.map((l) => ({ path: l.path, cells: l.cells.length, vertices: l.vertexCount, streamlines: l.present, chunk: l.chunk })),
      spillBytes: this.spill.size,
      cacheBytes: this.cache.size.bytes,
      cachedCells: this.cache.size.entries,
      indexBytes: index,
      seconds: this.timing.seconds,
      binningSeconds: this.timing.binning,
    };
  }

  /** Child names (directories end in "/") of a directory key ("" or ending in "/"); undefined when it is not one. */
  list(prefix: string): string[] | undefined {
    const dir = prefix.replace(/\/$/, "");
    if (dir !== "" && !this.directories.has(dir)) return undefined;
    const base = dir === "" ? "" : `${dir}/`;
    const names = new Set<string>(["zarr.json"]);
    for (const d of this.directories) {
      if (d === dir || !d.startsWith(base)) continue;
      names.add(`${d.slice(base.length).split("/")[0]}/`);
    }
    return [...names].sort();
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (key === "zarr.json") return json(this.root());
    const m = /^(\d+)\/(.*)$/.exec(key);
    const level = m === null ? undefined : this.levels.find((l) => l.path === m[1]);
    if (level === undefined) return undefined;
    return this.levelKey(level, m![2]);
  }

  /**
   * Messages from the page:
   * - `{ curves: { level, ids } }`: those streamlines whole at a level
   *   (level 0 every point; a sample level its points, and only the
   *   streamlines it keeps), as `{ ids, offsets, positions }` in store
   *   coordinates, read from the file itself where the reader can.
   * - `{ stats: true }`: what the store keeps (`stats()`).
   */
  async message(body: unknown): Promise<unknown> {
    const b = body as { curves?: { level?: number; ids: ArrayLike<number | bigint> }; stats?: boolean } | undefined;
    if (b?.stats) return this.stats();
    if (b?.curves !== undefined) return this.curves(b.curves.ids, b.curves.level ?? 0);
    if (b && "capabilities" in b) return { curves: true, stats: true };
    throw new Error("a streamline store answers { curves } and { stats }");
  }

  /** Streamlines `ids` whole at a level. */
  async curves(ids: ArrayLike<number | bigint>, levelIndex: number): Promise<{ ids: BigUint64Array; offsets: Uint32Array; positions: Float32Array }> {
    const level = this.levels[levelIndex];
    if (level === undefined) throw new Error(`no level ${levelIndex}`);
    const wanted: number[] = [];
    for (let i = 0; i < ids.length; ++i) {
      const id = Number(ids[i]);
      if (!(id >= 0 && id < this.count) || !Number.isInteger(id)) continue;
      if (level.depth > 0 && sampleDepth(id, this.levels.length - 1) < level.depth) continue;
      wanted.push(id);
    }
    const sorted = Uint32Array.from(new Set(wanted)).sort();
    const whole = this.input.streamlines !== undefined && this.checkpoints.length > 0 ? await this.input.streamlines(sorted, this.checkpoints) : this.fromCells(sorted);
    // A sample level's points: every pointStep-th and the last.
    const step = level.pointStep;
    let total = 0;
    const kept = (n: number) => (n === 0 ? 0 : step === 1 ? n : Math.floor((n - 1) / step) + 1 + ((n - 1) % step === 0 ? 0 : 1));
    for (let i = 0; i < sorted.length; ++i) total += kept(whole.offsets[i + 1] - whole.offsets[i]);
    const offsets = new Uint32Array(sorted.length + 1);
    const positions = new Float32Array(3 * total);
    let at = 0;
    for (let i = 0; i < sorted.length; ++i) {
      const first = whole.offsets[i];
      const last = whole.offsets[i + 1];
      for (let p = first; p < last; ++p) {
        if (step > 1 && (p - first) % step !== 0 && p !== last - 1) continue;
        positions[3 * at] = whole.points[3 * p];
        positions[3 * at + 1] = whole.points[3 * p + 1];
        positions[3 * at + 2] = whole.points[3 * p + 2];
        ++at;
      }
      offsets[i + 1] = at;
    }
    return { ids: BigUint64Array.from(sorted, (v) => BigInt(v)), offsets, positions };
  }

  /** Whole streamlines from level 0's cells (when the file cannot be read by id). */
  private fromCells(ids: Uint32Array): Streamlines {
    const level = this.levels[0];
    const manifests = new Map<number, Uint32Array[]>();
    const parts: Float32Array[] = [];
    const offsets = new Uint32Array(ids.length + 1);
    let total = 0;
    ids.forEach((id, i) => {
      const chunk = Math.floor(id / MANIFEST_ROWS);
      let rows = manifests.get(chunk);
      if (rows === undefined) manifests.set(chunk, (rows = level.manifestChunk(this.spill, chunk, Math.min(MANIFEST_ROWS, this.count - chunk * MANIFEST_ROWS))));
      const pairs = rows[id - chunk * MANIFEST_ROWS];
      for (let b = 0; b < pairs.length; b += 2) {
        const cell = this.decoded(level, level.cells[pairs[b]]);
        let row = 0;
        for (let f = 0; f < pairs[b + 1]; ++f) row += cell.counts[f];
        const n = cell.counts[pairs[b + 1]];
        parts.push(cell.vertices.subarray(3 * row, 3 * (row + n)));
        total += n;
      }
      offsets[i + 1] = total;
    });
    const points = new Float32Array(3 * total);
    let at = 0;
    for (const part of parts) {
      points.set(part, at);
      at += part.length;
    }
    return { offsets, points };
  }

  private root(): unknown {
    const datasets = this.levels.map((l) => ({
      path: l.path,
      coordinateTransformations: [
        { type: "scale", scale: [1, 1, 1] },
        { type: "translation", translation: [l.chunk / 2, l.chunk / 2, l.chunk / 2] },
      ],
    }));
    const values = this.levels[0].valueNames;
    return group({
      zarr_vectors: {
        zv_version: "0.9.2",
        format_capabilities: ["preserved_object_ids"],
        chunk_shape: [this.levels[0].chunk, this.levels[0].chunk, this.levels[0].chunk],
        bounds: [this.lo, this.hi],
        geometry_types: ["streamline"],
        links_convention: "implicit_sequential",
        object_index_convention: "standard",
        cross_chunk_strategy: "explicit_links",
        ...(values.length ? { attribute_specs: { vertex: Object.fromEntries(values.map((v) => [v, { dtype: "float32" }])) } } : {}),
      },
      multiscales: [
        {
          version: "0.4",
          name: this.name,
          axes: ["x", "y", "z"].map((name) => ({ name, type: "space", unit: "millimeter" })),
          datasets,
          metadata: { format: "zarr_vectors" },
        },
      ],
    });
  }

  private levelKey(level: Level, key: string): Uint8Array | undefined {
    const { origin, shape } = level.grid(this.lo, this.hi);
    const perCell = (attributes: Record<string, unknown>) => json(arrayJson(shape, { nonempty_chunks: level.cells.map((c) => c.at.join(".")), chunk_grid_origin: origin, ...attributes }));
    switch (key) {
      case "zarr.json":
        return json(
          group({
            zarr_vectors_level: {
              level: Number(level.path),
              vertex_count: level.vertexCount,
              arrays_present: ["vertices", "object_index"],
              ...(level.path === "0"
                ? { object_sparsity: 1, coarsening_method: "none", parent_level: null, fragments_tile: true }
                : {
                    chunk_shape: [level.chunk, level.chunk, level.chunk],
                    object_sparsity: level.present / Math.max(1, this.count),
                    coarsening_method: "subsample",
                    parent_level: Number(level.path) - 1,
                    preserves_object_ids: true,
                    inherited_num_objects: this.count,
                  }),
            },
          }),
        );
      case "vertices/zarr.json":
        return perCell({ zv_array: "vertices", dtype: "float32", encoding: "raw" });
      case "vertex_fragments/zarr.json":
        return perCell({ zv_array: "vertex_fragments", encoding: "fragment_index_v1" });
      case "fragment_attributes/segment_id/zarr.json":
        return perCell({ zv_array: "fragment_attribute", name: "segment_id", dtype: "uint32", row_shape: [] });
      case "links/0/zarr.json":
        return json(group({ zv_array: "links_family", level_delta: 0, link_width: 2, directed: true, store: "canonical", sid_ndim: 3, num_links: level.links, num_physical_records: level.links }));
      case "object_index/zarr.json":
        return json(group({ zv_array: "object_index", num_objects: this.count, num_present: level.present, sid_ndim: 3, layout: "vlen_manifests_v1" }));
      case "object_index/manifests/zarr.json":
        return json({ ...(columnJson(this.count, MANIFEST_ROWS, "variable_length_bytes", "") as object), codecs: [{ name: "vlen-bytes", configuration: {} }] });
    }
    if (this.directories.has(`${level.path}/${key.replace(/\/zarr\.json$/, "")}`) && key.endsWith("zarr.json")) {
      const dir = key.replace(/\/?zarr\.json$/, "");
      const link = /^links\/0\/([^/]+)$/.exec(dir);
      if (link !== null) {
        const d = level.directionNames.indexOf(link[1]);
        const offset = link[1].split(".").map(Number);
        return json(
          arrayJson(shape, {
            nonempty_chunks: level.cells.filter((c) => c.directions.has(d)).map((c) => c.at.join(".")),
            chunk_grid_origin: origin,
            zv_array: "links",
            dtype: "int32",
            offsets: [offset],
            has_perm: false,
            link_width: 2,
            level_delta: 0,
          }),
        );
      }
      const value = /^vertex_attributes\/([^/]+)$/.exec(dir);
      if (value !== null) return perCell({ zv_array: "attribute", name: value[1], dtype: "float32", row_shape: [] });
      const column = /^object_attributes\/([^/]+)$/.exec(dir);
      if (column !== null && level.path === "0") {
        return json(columnJson(this.count, COLUMN_ROWS, "float32", "NaN", { zv_array: "object_attribute", name: column[1], dtype: "float32", shape: [this.count], fill_sentinel_meaning: "absent" }));
      }
      return json(group());
    }
    return this.levelChunk(level, key, origin);
  }

  /** A cell's fragments, decoded from the spill (or the cache). */
  private decoded(level: Level, cell: Cell): Decoded {
    return this.cache.get(`${level.path}|${cell.index}`, () => {
      const bytes = readSegments(this.spill, cell.segments);
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const nv = level.valueNames.length;
      const vertices = new Float32Array(3 * cell.rows);
      const values = level.valueNames.map(() => new Float32Array(cell.rows));
      const counts = new Uint32Array(cell.fragments);
      const owners = new Uint32Array(cell.fragments);
      let i = 0;
      let row = 0;
      let owner = 0;
      for (let f = 0; f < cell.fragments; ++f) {
        const head = words[i++];
        let n: number;
        if (head >= 0x80000000) {
          n = head & 0xfff;
          owner += (head >>> 12) & 0x7ffff;
        } else {
          n = head;
          owner = words[i++];
        }
        owners[f] = owner;
        counts[f] = n;
        if (nv === 0) {
          vertices.set(floats.subarray(i, i + 3 * n), 3 * row);
          i += 3 * n;
          row += n;
        } else {
          for (let p = 0; p < n; ++p, ++row) {
            vertices[3 * row] = floats[i++];
            vertices[3 * row + 1] = floats[i++];
            vertices[3 * row + 2] = floats[i++];
            for (let k = 0; k < nv; ++k) values[k][row] = floats[i++];
          }
        }
      }
      if (i !== words.length || row !== cell.rows) throw new Error(`cell ${cell.at.join(".")} of level ${level.path} is damaged (${i} of ${words.length} words, ${row} of ${cell.rows} rows)`);
      return { value: { vertices, counts, owners, values, bytes: bytes.byteLength + 8 * cell.fragments }, bytes: bytes.byteLength + 8 * cell.fragments };
    });
  }

  private decodedBridges(level: Level, cell: Cell): DecodedBridges {
    return this.cache.get(`${level.path}|${cell.index}|bridges`, () => {
      const bytes = readSegments(this.spill, cell.bridgeSegments);
      const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      // Records of (direction, row here, row there): unpacked, then grouped by direction.
      const records = new Int32Array(3 * cell.bridges);
      let n = 0;
      for (let i = 0; i < words.length; ++n) {
        const head = words[i++];
        if (head >= 0x80000000) {
          records[3 * n] = (head >>> 25) & 0x3f;
          records[3 * n + 1] = head & 0x1ffffff;
        } else {
          records[3 * n] = head;
          records[3 * n + 1] = words[i++];
        }
        records[3 * n + 2] = words[i++];
      }
      if (n !== cell.bridges) throw new Error(`cell ${cell.at.join(".")} of level ${level.path}: ${n} of ${cell.bridges} bridges`);
      const counts = new Map<number, number>();
      for (let r = 0; r < n; ++r) counts.set(records[3 * r], (counts.get(records[3 * r]) ?? 0) + 1);
      const out: DecodedBridges = new Map([...counts].map(([d, c]) => [d, new Int32Array(2 * c)]));
      const at = new Map<number, number>();
      for (let r = 0; r < n; ++r) {
        const d = records[3 * r];
        const rows = out.get(d)!;
        const k = at.get(d) ?? 0;
        rows[k] = records[3 * r + 1];
        rows[k + 1] = records[3 * r + 2];
        at.set(d, k + 2);
      }
      return { value: out, bytes: bytes.byteLength };
    });
  }

  private levelChunk(level: Level, key: string, origin: number[]): Uint8Array | undefined {
    const cellKeyMatch = /^(.*)\/c\/(-?\d+)\/(-?\d+)\/(-?\d+)$/.exec(key);
    if (cellKeyMatch !== null) {
      const at = [2, 3, 4].map((g, k) => Number(cellKeyMatch[g]) + origin[k]);
      const index = level.cellIndex(at[0], at[1], at[2]);
      if (index === undefined) return undefined;
      const cell = level.cells[index];
      const array = cellKeyMatch[1];
      const link = /^links\/0\/([^/]+)$/.exec(array);
      if (link !== null) {
        const rows = this.decodedBridges(level, cell).get(level.directionNames.indexOf(link[1]));
        if (rows === undefined) return undefined;
        // One group: K = 1, its byte offset 0, then the rows (int32 pairs).
        const header = new BigInt64Array([1n, 0n]);
        const out = new Uint8Array(16 + rows.length * 4);
        out.set(bytesOf(header));
        out.set(bytesOf(rows), 16);
        return element(out);
      }
      if (array === "vertices") return element(bytesOf(this.decoded(level, cell).vertices));
      if (array === "vertex_fragments") return element(fragmentIndex(this.decoded(level, cell).counts));
      if (array === "fragment_attributes/segment_id") return element(bytesOf(this.decoded(level, cell).owners));
      const value = /^vertex_attributes\/(.+)$/.exec(array);
      if (value !== null) {
        const k = level.valueNames.indexOf(value[1]);
        return k === -1 ? undefined : element(bytesOf(this.decoded(level, cell).values[k]));
      }
      return undefined;
    }
    const row = /^(.*)\/c\/(\d+)$/.exec(key);
    if (row === null) return undefined;
    const array = row[1];
    const chunk = Number(row[2]);
    if (array === "object_index/manifests") {
      const first = chunk * MANIFEST_ROWS;
      if (first >= this.count) return undefined;
      const pairs = level.manifestChunk(this.spill, chunk, Math.min(MANIFEST_ROWS, this.count - first));
      return vlenChunk(
        pairs.map((p) => this.manifest(level, p)),
        MANIFEST_ROWS,
      );
    }
    const first = chunk * COLUMN_ROWS;
    if (first >= this.count) return undefined;
    const column = /^object_attributes\/(.+)$/.exec(array);
    if (column !== null && level.path === "0") return this.columns.find((c) => c.name === column[1])?.chunk(this.spill, chunk);
    return undefined;
  }

  /** An object's manifest: its fragments, in walk order, as (absolute cell, fragment) blocks. */
  private manifest(level: Level, pairs: Uint32Array): Uint8Array {
    const n = pairs.length / 2;
    const out = new Uint8Array(4 + 33 * n);
    const view = new DataView(out.buffer);
    view.setUint32(0, n, true);
    for (let b = 0; b < n; ++b) {
      const at = 4 + 33 * b;
      const cell = level.cells[pairs[2 * b]].at;
      view.setBigInt64(at, BigInt(cell[0]), true);
      view.setBigInt64(at + 8, BigInt(cell[1]), true);
      view.setBigInt64(at + 16, BigInt(cell[2]), true);
      view.setUint8(at + 24, 0);
      view.setBigInt64(at + 25, BigInt(pairs[2 * b + 1]), true);
    }
    return out;
  }
}
