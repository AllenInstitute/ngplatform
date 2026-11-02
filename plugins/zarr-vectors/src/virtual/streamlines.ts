/**
 * A virtual zarr-vectors streamline store: streamlines (from a .trk, or any
 * reader that hands them over in batches) binned once into spatial cells,
 * and every key of the store (`zarr.json`, `0/vertices/c/1/0/2`, …) made
 * from that when asked.  Nothing is written anywhere.
 *
 * The layout is format 0.9.2's, as zarr-vectors-py writes a streamline
 * store and zarr-vectors-tools converts a tractogram, and is read by this
 * package's reader and by Track filtering:
 *
 * - level 0: every streamline, split where it changes cell into fragments
 *   (one per run of vertices in a cell, in object then walk order; boundary
 *   vertices are not repeated), with a bridge record (links/0/<offset>,
 *   the "directed" policy) for each crossing;
 * - level 1, for large tractograms: one streamline in ten, every fourth
 *   point (and the last), in cells twice as large, keeping level 0's ids;
 * - objects: a manifest per streamline (its fragments in walk order),
 *   identity ids, and per-streamline columns (length, points, the file's
 *   properties); per-point values as vertex attributes.
 *
 * Unsharded and uncompressed throughout, so every cell is range-readable.
 */
import type { TrkBatch } from "./trk.js";

const MAGIC = 0x5a564647;
const MANIFEST_ROWS = 16384;
const COLUMN_ROWS = 65536;

/** A typed array that grows. */
class Grow<T extends Float32Array | Uint32Array | Int32Array> {
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
const u32 = (n: number) => new Uint32Array(n);
const i32 = (n: number) => new Int32Array(n);

interface Cell {
  at: [number, number, number];
  vertices: Grow<Float32Array>;
  /** Each fragment's object and vertex count, in fragment order. */
  owners: Grow<Uint32Array>;
  counts: Grow<Uint32Array>;
  /** Per-point values, one array per name. */
  values: Grow<Float32Array>[];
}

/** One level being built, then served. */
class Level {
  readonly cells: Cell[] = [];
  private readonly index = new Map<string, number>();
  /** Object o's fragments are blocks [blockStart[o], blockStart[o + 1]): (cell, fragment). */
  readonly blockStart = new Grow(u32);
  readonly blockCell = new Grow(i32);
  readonly blockFragment = new Grow(u32);
  /** Bridges by offset, then source cell: pairs of rows (last of one run, first of the next). */
  readonly bridges = new Map<string, Map<number, Grow<Int32Array>>>();
  readonly lo = [Infinity, Infinity, Infinity];
  readonly hi = [-Infinity, -Infinity, -Infinity];
  vertexCount = 0;
  present = 0;

  constructor(
    readonly path: string,
    readonly chunk: number,
    readonly valueNames: string[],
    /** Which streamlines this level keeps, and which of their points. */
    readonly keep: (object: number) => boolean,
    readonly pointStep: number,
  ) {
    this.blockStart.push(0);
  }

  private cellAt(x: number, y: number, z: number): number {
    const key = `${x},${y},${z}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.cells.length;
      this.index.set(key, i);
      this.cells.push({ at: [x, y, z], vertices: new Grow(f32), owners: new Grow(u32), counts: new Grow(u32), values: this.valueNames.map(() => new Grow(f32)) });
    }
    return i;
  }

  /** Adds streamline `object`: points [first, last) of a batch. */
  add(object: number, batch: TrkBatch, first: number, last: number, nValues: number): void {
    if (!this.keep(object) || last <= first) {
      this.blockStart.push(this.blockCell.length);
      return;
    }
    const { points, scalars } = batch;
    const c = this.chunk;
    let run = -1;
    let runCell = -1;
    let prevCell = -1;
    let prevLastRow = -1;
    const close = () => {
      if (runCell < 0) return;
      const cell = this.cells[runCell];
      cell.counts.data[cell.counts.length - 1] = run;
    };
    for (let p = first; p < last; ++p) {
      if (this.pointStep > 1 && (p - first) % this.pointStep !== 0 && p !== last - 1) continue;
      const x = points[3 * p];
      const y = points[3 * p + 1];
      const z = points[3 * p + 2];
      const ci = this.cellAt(Math.floor(x / c), Math.floor(y / c), Math.floor(z / c));
      const cell = this.cells[ci];
      if (ci !== runCell) {
        close();
        const fragment = cell.owners.length;
        const row = cell.vertices.length / 3;
        cell.owners.push(object);
        cell.counts.push(0);
        this.blockCell.push(ci);
        this.blockFragment.push(fragment);
        if (prevCell >= 0) {
          const from = this.cells[prevCell].at;
          const offset = [0, 1, 2].map((k) => cell.at[k] - from[k]);
          const name = offset.map((d) => (d > 0 ? `+${d}` : `${d}`)).join(".");
          let bucket = this.bridges.get(name);
          if (bucket === undefined) this.bridges.set(name, (bucket = new Map()));
          let rows = bucket.get(prevCell);
          if (rows === undefined) bucket.set(prevCell, (rows = new Grow(i32)));
          rows.push(prevLastRow);
          rows.push(row);
        }
        runCell = ci;
        run = 0;
      }
      cell.vertices.reserve(3);
      cell.vertices.data[cell.vertices.length++] = x;
      cell.vertices.data[cell.vertices.length++] = y;
      cell.vertices.data[cell.vertices.length++] = z;
      for (let k = 0; k < this.valueNames.length; ++k) cell.values[k].push(scalars[p * nValues + k]);
      ++run;
      prevCell = ci;
      prevLastRow = cell.vertices.length / 3 - 1;
      ++this.vertexCount;
      for (let k = 0; k < 3; ++k) {
        const v = points[3 * p + k];
        if (v < this.lo[k]) this.lo[k] = v;
        if (v > this.hi[k]) this.hi[k] = v;
      }
    }
    close();
    ++this.present;
    this.blockStart.push(this.blockCell.length);
  }

  /** The grid's origin and shape, from bounds shared by every level. */
  grid(lo: number[], hi: number[]): { origin: number[]; shape: number[] } {
    const origin = lo.map((v) => Math.floor(v / this.chunk));
    const shape = hi.map((v, k) => Math.floor(v / this.chunk) - origin[k] + 1);
    return { origin, shape };
  }

  cellByKey(key: string): Cell | undefined {
    const i = this.index.get(key);
    return i === undefined ? undefined : this.cells[i];
  }

  cellIndex(key: string): number | undefined {
    return this.index.get(key);
  }
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

export interface StreamlineInput {
  /** Hands over every streamline, in batches, in order; resolves to how many there were. */
  read(onBatch: (batch: TrkBatch) => void): Promise<number>;
  /** Per-point and per-streamline value names. */
  scalarNames: string[];
  propertyNames: string[];
  /** About how many streamlines there are (0: unknown), to decide on a coarse level. */
  expectedCount: number;
  /** The space's extent, mm, to choose the cell size by (0: unknown). */
  extent: number;
  name: string;
}

/** The cell size, mm: a round number giving about 10 cells across `extent`. */
export function cellSize(extent: number): number {
  if (!(extent > 0)) return 16;
  const nice = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 100, 128, 200, 256];
  const want = extent / 10;
  return nice.find((n) => n >= want) ?? 256;
}

export class StreamlineStore {
  private readonly levels: Level[];
  private readonly count: number;
  private readonly lo: number[];
  private readonly hi: number[];
  private readonly columns: { name: string; values: Float32Array }[];
  /** Directory paths, for listings. */
  private readonly directories: Set<string>;

  private constructor(levels: Level[], count: number, columns: { name: string; values: Float32Array }[], readonly name: string) {
    this.levels = levels;
    this.count = count;
    this.columns = columns;
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
      for (const a of ["vertices", "vertex_fragments", "fragment_attributes/segment_id", "object_index/manifests", "object_index/object_ids", "links/0"]) add(`${p}/${a}`);
      for (const seg of level.bridges.keys()) add(`${p}/links/0/${seg}`);
      for (const v of level.valueNames) add(`${p}/vertex_attributes/${v}`);
    }
    for (const c of columns) add(`0/object_attributes/${c.name}`);
  }

  /** Reads every streamline once and bins it. */
  static async build(input: StreamlineInput): Promise<StreamlineStore> {
    const chunk = cellSize(input.extent);
    const nValues = input.scalarNames.length;
    const nProperties = input.propertyNames.length;
    const levels = [new Level("0", chunk, input.scalarNames, () => true, 1)];
    if (input.expectedCount > 20_000) levels.push(new Level("1", 2 * chunk, [], (o) => o % 10 === 0, 4));
    const length = new Grow(f32);
    const points = new Grow(f32);
    const properties = input.propertyNames.map(() => new Grow(f32));
    let object = 0;
    const count = await input.read((batch) => {
      for (let s = 0; s + 1 < batch.offsets.length; ++s, ++object) {
        const first = batch.offsets[s];
        const last = batch.offsets[s + 1];
        for (const level of levels) level.add(object, batch, first, last, nValues);
        let arc = 0;
        for (let p = first + 1; p < last; ++p) {
          const dx = batch.points[3 * p] - batch.points[3 * p - 3];
          const dy = batch.points[3 * p + 1] - batch.points[3 * p - 2];
          const dz = batch.points[3 * p + 2] - batch.points[3 * p - 1];
          arc += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        length.push(arc);
        points.push(last - first);
        for (let k = 0; k < nProperties; ++k) properties[k].push(batch.properties[s * nProperties + k]);
      }
    });
    const columns = [
      { name: "length", values: length.view() },
      { name: "n_points", values: points.view() },
      ...input.propertyNames.map((name, k) => ({ name, values: properties[k].view() })),
    ];
    return new StreamlineStore(levels, count, columns, input.name);
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
    const nonempty = level.cells.map((c) => c.at.join("."));
    const perCell = (attributes: Record<string, unknown>) => json(arrayJson(shape, { nonempty_chunks: nonempty, chunk_grid_origin: origin, ...attributes }));
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
                    parent_level: 0,
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
      case "links/0/zarr.json": {
        let records = 0;
        for (const bucket of level.bridges.values()) for (const rows of bucket.values()) records += rows.length / 2;
        return json(group({ zv_array: "links_family", level_delta: 0, link_width: 2, directed: true, store: "canonical", sid_ndim: 3, num_links: records, num_physical_records: records }));
      }
      case "object_index/zarr.json":
        return json(group({ zv_array: "object_index", num_objects: this.count, num_present: level.present, sid_ndim: 3, layout: "vlen_manifests_v2", object_ids_sorted: true }));
      case "object_index/manifests/zarr.json":
        return json({ ...(columnJson(this.count, MANIFEST_ROWS, "variable_length_bytes", "") as object), codecs: [{ name: "vlen-bytes", configuration: {} }] });
      case "object_index/object_ids/zarr.json":
        return json(columnJson(this.count, COLUMN_ROWS, "int64", 0));
    }
    if (this.directories.has(`${level.path}/${key.replace(/\/zarr\.json$/, "")}`) && key.endsWith("zarr.json")) {
      const dir = key.replace(/\/?zarr\.json$/, "");
      const link = /^links\/0\/([^/]+)$/.exec(dir);
      if (link !== null) {
        const bucket = level.bridges.get(link[1])!;
        const offset = link[1].split(".").map(Number);
        return json(
          arrayJson(shape, {
            nonempty_chunks: [...bucket.keys()].map((i) => level.cells[i].at.join(".")),
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

  private levelChunk(level: Level, key: string, origin: number[]): Uint8Array | undefined {
    const cellKey = /^(.*)\/c\/(-?\d+)\/(-?\d+)\/(-?\d+)$/.exec(key);
    if (cellKey !== null) {
      const at = [2, 3, 4].map((g, k) => Number(cellKey[g]) + origin[k]);
      const index = level.cellIndex(at.join(","));
      if (index === undefined) return undefined;
      const cell = level.cells[index];
      const array = cellKey[1];
      if (array === "vertices") return element(bytesOf(cell.vertices.view()));
      if (array === "vertex_fragments") return element(fragmentIndex(cell.counts.view()));
      if (array === "fragment_attributes/segment_id") return element(bytesOf(cell.owners.view().slice()));
      const value = /^vertex_attributes\/(.+)$/.exec(array);
      if (value !== null) {
        const k = level.valueNames.indexOf(value[1]);
        return k === -1 ? undefined : element(bytesOf(cell.values[k].view()));
      }
      const link = /^links\/0\/([^/]+)$/.exec(array);
      if (link !== null) {
        const rows = level.bridges.get(link[1])?.get(index);
        if (rows === undefined) return undefined;
        // One group: K = 1, its byte offset 0, then the rows (int32 pairs).
        const header = new BigInt64Array([1n, 0n]);
        const out = new Uint8Array(16 + rows.length * 4);
        out.set(bytesOf(header));
        out.set(bytesOf(rows.view()), 16);
        return element(out);
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
      const items: Uint8Array[] = [];
      for (let o = first; o < Math.min(this.count, first + MANIFEST_ROWS); ++o) items.push(this.manifest(level, o));
      return vlenChunk(items, MANIFEST_ROWS);
    }
    const first = chunk * COLUMN_ROWS;
    if (first >= this.count) return undefined;
    if (array === "object_index/object_ids") {
      const ids = new BigInt64Array(COLUMN_ROWS);
      for (let i = 0; i < COLUMN_ROWS && first + i < this.count; ++i) ids[i] = BigInt(first + i);
      return bytesOf(ids);
    }
    const column = /^object_attributes\/(.+)$/.exec(array);
    if (column !== null && level.path === "0") {
      const values = this.columns.find((c) => c.name === column[1])?.values;
      if (values === undefined) return undefined;
      const out = new Float32Array(COLUMN_ROWS).fill(Number.NaN);
      out.set(values.subarray(first, first + COLUMN_ROWS));
      return bytesOf(out);
    }
    return undefined;
  }

  /** Object o's manifest: its fragments, in walk order, as (absolute cell, fragment) blocks. */
  private manifest(level: Level, o: number): Uint8Array {
    const start = level.blockStart.data[o];
    const end = level.blockStart.data[o + 1];
    const out = new Uint8Array(4 + 33 * (end - start));
    const view = new DataView(out.buffer);
    view.setUint32(0, end - start, true);
    for (let b = start; b < end; ++b) {
      const at = 4 + 33 * (b - start);
      const cell = level.cells[level.blockCell.data[b]].at;
      view.setBigInt64(at, BigInt(cell[0]), true);
      view.setBigInt64(at + 8, BigInt(cell[1]), true);
      view.setBigInt64(at + 16, BigInt(cell[2]), true);
      view.setUint8(at + 24, 0);
      view.setBigInt64(at + 25, BigInt(level.blockFragment.data[b]), true);
    }
    return out;
  }
}
