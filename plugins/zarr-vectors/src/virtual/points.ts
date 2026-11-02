/**
 * Virtual zarr-vectors point-cloud and skeleton stores: an SWC file's
 * neurons, or a point table's points, served as a format 0.9.2 store made
 * from them, nothing written.
 *
 * As for meshes (./meshes.ts), one cell holds everything: moved to start at
 * the cell's corner (`coordinate_offset`, which the reader adds back), the
 * cell the smallest power of two past every coordinate.  A point table too
 * large to make objects of is split into cells instead (about eight across),
 * so the viewer reads only those in view; each cell's points in file order.
 *
 * A skeleton store has one object per tree (segment ids 1..N, in file then
 * root order), each one fragment whose rows are its nodes in depth-first
 * pre-order from the root (children in file order).  A row's parent is the
 * row before it unless a `[child, parent]` record in `links/0/0.0.0` says
 * otherwise; the first row of a fragment, the root, has none.  Per node:
 * `radius` and `compartment` (the SWC type), as zarr-vectors-tools' SWC
 * ingest writes them.
 *
 * A point store's rows are the table's, in file order, every other numeric
 * column a per-point value.  Up to MAX_POINT_OBJECTS points each point is
 * also an object (segment id = row + 1) with those values as its columns,
 * so Track filtering can select points; past that the points are drawn but
 * not objects.
 *
 * Ids follow zarr-vectors-tools: identity `object_ids`, the segment ids in
 * `object_attributes/segment_id`, each fragment's object row in
 * `fragment_attributes/object_id`.
 */
import { meshUnit } from "./meshes.js";
import type { PointTable, SwcNode } from "./point_files.js";
import { fragmentIndex } from "./streamlines.js";

const MANIFEST_ROWS = 16384;
const COLUMN_ROWS = 65536;
export const MAX_POINT_OBJECTS = 250_000;
const U64_MAX = "18446744073709551615";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value).replace(`"${U64_MAX}"`, U64_MAX));
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const group = (attributes: Record<string, unknown> = {}) => ({ zarr_format: 3, node_type: "group", attributes });

function element(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

function perCell(shape: number[], nonempty: string[], attributes: Record<string, unknown>): unknown {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "variable_length_bytes",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 1, 1] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: "",
    codecs: [{ name: "vlen-bytes", configuration: {} }],
    attributes: { nonempty_chunks: nonempty, chunk_grid_origin: [0, 0, 0], ...attributes },
  };
}

function column(n: number, rows: number, dataType: string, fill: unknown, attributes: Record<string, unknown> = {}): unknown {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [n],
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: [rows] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: fill,
    codecs: dataType === "variable_length_bytes" ? [{ name: "vlen-bytes", configuration: {} }] : [{ name: "bytes", configuration: { endian: "little" } }],
    attributes,
  };
}

export interface CellStoreSpec {
  kind: "point_cloud" | "skeleton";
  /** World x, y, z per row, the rows in store order (each object's together). */
  positions: Float64Array;
  /** Rows per object, each object one fragment; none: the rows are one fragment and not objects. */
  objectRows?: number[];
  vertexAttributes: { name: string; values: Float32Array }[];
  objectColumns: { name: string; values: Float32Array }[];
  /** Skeletons: `[child, parent]` row pairs where the parent is not the row before. */
  links?: Int32Array;
  /** The axes' unit, if known. */
  unit?: string;
  /** Split into cells about this many across (points that are not objects only); else one cell. */
  cellsAcross?: number;
}

export class CellStore {
  private readonly vertices: Float32Array;
  private readonly offset: number[];
  private readonly chunk: number;
  private readonly lo: number[];
  private readonly hi: number[];
  private readonly directories = new Set<string>();
  /** Each cell's rows, in order, by its key ("i.j.k"); one cell unless the spec asks for more. */
  private readonly cells = new Map<string, Uint32Array>();
  private readonly shape: number[];
  /** Objects (0 when the rows are not objects). */
  readonly count: number;

  constructor(
    private readonly spec: CellStoreSpec,
    readonly name: string,
  ) {
    const world = spec.positions;
    const lo = [0, 1, 2].map((k) => {
      let m = Infinity;
      for (let i = k; i < world.length; i += 3) m = Math.min(m, world[i]);
      return Number.isFinite(m) ? m : 0;
    });
    this.offset = lo.map((v) => Math.floor(v));
    this.vertices = new Float32Array(world.length);
    for (let i = 0; i < world.length; ++i) this.vertices[i] = world[i] - this.offset[i % 3];
    const extreme = (k: number, pick: (a: number, b: number) => number, start: number) => {
      let m = start;
      for (let i = k; i < this.vertices.length; i += 3) m = pick(m, this.vertices[i]);
      return Number.isFinite(m) ? m : 0;
    };
    this.lo = [0, 1, 2].map((k) => extreme(k, Math.min, Infinity));
    this.hi = [0, 1, 2].map((k) => extreme(k, Math.max, -Infinity));
    // One cell: the smallest power of two past every coordinate (hi == C
    // would be the next cell).  Else a power of two about 1/cellsAcross of it.
    const span = Math.max(...this.hi);
    this.chunk = 1;
    while (this.chunk <= span) this.chunk *= 2;
    if (spec.cellsAcross !== undefined && spec.objectRows === undefined && spec.links === undefined) {
      while (this.chunk > 1 && this.chunk * spec.cellsAcross > 2 * span) this.chunk /= 2;
    }
    const n = this.vertices.length / 3;
    const cellOf = new Array<string>(n);
    const counts = new Map<string, number>();
    for (let v = 0; v < n; ++v) {
      const key = [0, 1, 2].map((k) => Math.floor(this.vertices[3 * v + k] / this.chunk)).join(".");
      cellOf[v] = key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (n === 0) counts.set("0.0.0", 0);
    const filled = new Map<string, number>();
    for (const [key, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
      this.cells.set(key, new Uint32Array(count));
      filled.set(key, 0);
    }
    for (let v = 0; v < n; ++v) {
      const key = cellOf[v];
      const at = filled.get(key)!;
      this.cells.get(key)![at] = v;
      filled.set(key, at + 1);
    }
    this.shape = [0, 1, 2].map((k) => Math.floor(this.hi[k] / this.chunk) + 1);
    this.count = spec.objectRows?.length ?? 0;
    const paths = ["0/vertices", "0/vertex_fragments", ...spec.vertexAttributes.map((a) => `0/vertex_attributes/${a.name}`)];
    if (spec.kind === "skeleton") paths.push("0/links/0/0.0.0");
    if (this.count > 0) {
      paths.push("0/object_index/manifests", "0/object_index/object_ids", "0/object_attributes/segment_id", "0/fragment_attributes/object_id");
      paths.push(...spec.objectColumns.map((c) => `0/object_attributes/${c.name}`));
    }
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; ++i) this.directories.add(parts.slice(0, i).join("/"));
    }
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
    if (!this.directories.has(key.replace(/\/(zarr\.json|c\/.*)$/, "")) && key !== "zarr.json") return undefined;
    const { spec } = this;
    const c = this.chunk;
    const skeleton = spec.kind === "skeleton";
    const links = spec.links ?? new Int32Array(0);
    const cellArray = (attributes: Record<string, unknown>) => json(perCell(this.shape, [...this.cells.keys()], attributes));
    const cell = /^0\/(vertices|vertex_fragments|vertex_attributes\/[^/]+|links\/0\/0\.0\.0|fragment_attributes\/object_id)\/c\/(\d+)\/(\d+)\/(\d+)$/.exec(key);
    if (cell !== null) return this.cellChunk(cell[1], this.cells.get(`${cell[2]}.${cell[3]}.${cell[4]}`));
    switch (key) {
      case "zarr.json":
        return json(
          group({
            zarr_vectors: {
              zv_version: "0.9.2",
              format_capabilities: [],
              chunk_shape: [c, c, c],
              bounds: [this.lo, this.hi],
              geometry_types: [spec.kind],
              links_convention: skeleton ? "implicit_sequential_with_branches" : "implicit_sequential",
              object_index_convention: "standard",
              cross_chunk_strategy: "explicit_links",
              coordinate_offset: this.offset,
              attribute_specs: { vertex: Object.fromEntries(spec.vertexAttributes.map((a) => [a.name, { dtype: "float32" }])) },
            },
            ...(skeleton ? { zarr_vectors_tools: { skeleton_layout: "linked_across_chunks" } } : {}),
            multiscales: [
              {
                version: "0.4",
                name: this.name,
                axes: ["x", "y", "z"].map((n) => ({ name: n, type: "space", ...(spec.unit ? { unit: spec.unit } : {}) })),
                datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1] }, { type: "translation", translation: [c / 2, c / 2, c / 2] }] }],
                metadata: { format: "zarr_vectors" },
              },
            ],
          }),
        );
      case "0/zarr.json":
        return json(
          group({
            zarr_vectors_level: {
              level: 0,
              vertex_count: this.vertices.length / 3,
              arrays_present: skeleton ? ["vertices", "links", "object_index"] : ["vertices", "vertex_attributes", ...(this.count > 0 ? ["object_index"] : [])],
              object_sparsity: 1,
              coarsening_method: "none",
              parent_level: null,
              fragments_tile: true,
            },
          }),
        );
      case "0/vertices/zarr.json":
        return cellArray({ zv_array: "vertices", dtype: "float32", encoding: "raw" });
      case "0/vertex_fragments/zarr.json":
        return cellArray({ zv_array: "vertex_fragments", encoding: "fragment_index_v1" });
      case "0/links/0/zarr.json":
        return json(group({ zv_array: "links_family", level_delta: 0, link_width: 2, directed: true, store: "canonical", sid_ndim: 3, num_links: links.length / 2, num_physical_records: links.length / 2 }));
      case "0/links/0/0.0.0/zarr.json":
        return cellArray({ zv_array: "links", dtype: "int32", offsets: [[0, 0, 0]], has_perm: false, link_width: 2, level_delta: 0 });
      case "0/object_index/zarr.json":
        return json(group({ zv_array: "object_index", num_objects: this.count, num_present: this.count, sid_ndim: 3, layout: "vlen_manifests_v2", object_ids_sorted: true }));
      case "0/object_index/manifests/zarr.json":
        return json(column(this.count, MANIFEST_ROWS, "variable_length_bytes", ""));
      case "0/object_index/object_ids/zarr.json":
        return json(column(this.count, COLUMN_ROWS, "int64", 0));
      case "0/object_attributes/segment_id/zarr.json":
        return json(column(this.count, COLUMN_ROWS, "uint64", U64_MAX, { zv_array: "object_attribute", name: "segment_id", dtype: "uint64", shape: [this.count], fill_sentinel_meaning: "absent" }));
      case "0/fragment_attributes/object_id/zarr.json":
        return cellArray({ zv_array: "fragment_attribute", name: "object_id", dtype: "uint64", row_shape: [] });
    }
    if (/^0\/(links|object_attributes|vertex_attributes|fragment_attributes)\/zarr\.json$/.test(key)) return json(group());
    const vertexAttribute = /^0\/vertex_attributes\/([^/]+)\/zarr\.json$/.exec(key);
    if (vertexAttribute !== null) {
      if (!spec.vertexAttributes.some((a) => a.name === vertexAttribute[1])) return undefined;
      return cellArray({ zv_array: "attribute", name: vertexAttribute[1], dtype: "float32", row_shape: [] });
    }
    const columnJson = /^0\/object_attributes\/([^/]+)\/zarr\.json$/.exec(key);
    if (columnJson !== null && spec.objectColumns.some((col) => col.name === columnJson[1])) {
      return json(column(this.count, COLUMN_ROWS, "float32", "NaN", { zv_array: "object_attribute", name: columnJson[1], dtype: "float32", shape: [this.count], fill_sentinel_meaning: "absent" }));
    }
    const chunk = /^0\/(object_index\/manifests|object_index\/object_ids|object_attributes\/[^/]+)\/c\/(\d+)$/.exec(key);
    if (chunk === null) return undefined;
    const first = Number(chunk[2]) * (chunk[1] === "object_index/manifests" ? MANIFEST_ROWS : COLUMN_ROWS);
    if (first >= this.count) return undefined;
    if (chunk[1] === "object_index/manifests") {
      // Object o is fragment o of cell (0, 0, 0): u32 1 block, int64 x3 cell, u8 mode 0, int64 fragment.
      const rows = Math.min(MANIFEST_ROWS, this.count - first);
      const out = new Uint8Array(4 + 4 * MANIFEST_ROWS + rows * 37);
      const view = new DataView(out.buffer);
      view.setUint32(0, MANIFEST_ROWS, true);
      let at = 4;
      for (let r = 0; r < MANIFEST_ROWS; ++r) {
        if (r >= rows) {
          view.setUint32(at, 0, true);
          at += 4;
          continue;
        }
        view.setUint32(at, 37, true);
        view.setUint32(at + 4, 1, true);
        view.setBigInt64(at + 8 + 25, BigInt(first + r), true);
        at += 4 + 37;
      }
      return out;
    }
    if (chunk[1] === "object_index/object_ids") {
      const ids = new BigInt64Array(COLUMN_ROWS);
      for (let i = 0; i < COLUMN_ROWS && first + i < this.count; ++i) ids[i] = BigInt(first + i);
      return bytesOf(ids);
    }
    if (chunk[1] === "object_attributes/segment_id") {
      const ids = new BigUint64Array(COLUMN_ROWS).fill(0xffffffffffffffffn);
      for (let i = 0; i < COLUMN_ROWS && first + i < this.count; ++i) ids[i] = BigInt(first + i + 1);
      return bytesOf(ids);
    }
    const values = spec.objectColumns.find((col) => `object_attributes/${col.name}` === chunk[1])?.values;
    if (values === undefined) return undefined;
    const out = new Float32Array(COLUMN_ROWS).fill(Number.NaN);
    out.set(values.subarray(first, first + COLUMN_ROWS));
    return bytesOf(out);
  }

  /** A cell's chunk of a per-cell array: its rows' vertices or values, its fragments, its links. */
  private cellChunk(array: string, rows: Uint32Array | undefined): Uint8Array | undefined {
    if (rows === undefined) return undefined;
    const { spec } = this;
    // Objects and links only ever come in one cell, holding every row in order.
    const whole = rows.length === this.vertices.length / 3;
    const gather = (values: Float32Array, width: number) => {
      if (whole) return values;
      const out = new Float32Array(rows.length * width);
      rows.forEach((v, i) => out.set(values.subarray(width * v, width * v + width), width * i));
      return out;
    };
    if (array === "vertices") return element(bytesOf(gather(this.vertices, 3)));
    if (array === "vertex_fragments") return element(fragmentIndex(spec.objectRows ?? [rows.length]));
    if (array === "links/0/0.0.0") return spec.links === undefined ? undefined : element(bytesOf(spec.links));
    if (array === "fragment_attributes/object_id") {
      if (this.count === 0) return undefined;
      const out = new BigUint64Array(this.count);
      for (let o = 0; o < this.count; ++o) out[o] = BigInt(o);
      return element(bytesOf(out));
    }
    const values = spec.vertexAttributes.find((a) => `vertex_attributes/${a.name}` === array)?.values;
    return values === undefined ? undefined : element(bytesOf(gather(values, 1)));
  }
}

/**
 * An SWC file's trees as a skeleton store: one object per tree, its nodes in
 * depth-first pre-order from the root.  Columns: nodes, cable length (the
 * sum of its edges' lengths) and branch points (nodes with two or more
 * children).
 */
export function skeletonStore(nodes: SwcNode[], name: string): CellStore {
  const index = new Map<number, number>();
  nodes.forEach((n, i) => index.set(n.id, i));
  const children = nodes.map(() => [] as number[]);
  const roots: number[] = [];
  nodes.forEach((n, i) => {
    const p = n.parent === -1 ? undefined : index.get(n.parent);
    if (p === undefined) roots.push(i);
    else children[p].push(i);
  });
  const order: number[] = [];
  const objectRows: number[] = [];
  const rowOf = new Int32Array(nodes.length).fill(-1);
  for (const root of roots) {
    const start = order.length;
    const stack = [root];
    while (stack.length > 0) {
      const i = stack.pop()!;
      rowOf[i] = order.length;
      order.push(i);
      for (let k = children[i].length - 1; k >= 0; --k) stack.push(children[i][k]);
    }
    objectRows.push(order.length - start);
  }
  if (order.length !== nodes.length) throw new Error("an SWC file whose nodes' parents form a cycle");
  const positions = new Float64Array(3 * order.length);
  const radius = new Float32Array(order.length);
  const compartment = new Float32Array(order.length);
  const pairs: number[] = [];
  const objects = objectRows.length;
  const cable = new Float32Array(objects);
  const branches = new Float32Array(objects);
  let object = 0;
  let objectEnd = objectRows[0];
  order.forEach((i, row) => {
    while (row >= objectEnd) objectEnd += objectRows[++object];
    const n = nodes[i];
    positions.set(n.position, 3 * row);
    radius[row] = n.radius;
    compartment[row] = n.type;
    if (children[i].length >= 2) branches[object] += 1;
    const p = n.parent === -1 ? undefined : index.get(n.parent);
    if (p === undefined) return;
    const q = nodes[p].position;
    cable[object] += Math.hypot(n.position[0] - q[0], n.position[1] - q[1], n.position[2] - q[2]);
    if (rowOf[p] !== row - 1) pairs.push(row, rowOf[p]);
  });
  return new CellStore(
    {
      kind: "skeleton",
      positions,
      objectRows,
      vertexAttributes: [
        { name: "compartment", values: compartment },
        { name: "radius", values: radius },
      ],
      objectColumns: [
        { name: "nodes", values: Float32Array.from(objectRows) },
        { name: "cable_length", values: cable },
        { name: "branch_points", values: branches },
      ],
      links: Int32Array.from(pairs),
      // SWC coordinates are in micrometres by convention.
      unit: "micrometer",
    },
    name,
  );
}

/**
 * A point table as a point store: each point an object (up to
 * MAX_POINT_OBJECTS; past that, the points in cells about eight across), the
 * other columns its values.  The unit is the x, y, z
 * columns' (x_um, …), else guessed as for meshes.
 */
export function pointStore(table: PointTable, name: string): CellStore {
  const n = table.positions.length / 3;
  const objects = n <= MAX_POINT_OBJECTS;
  let extent = 0;
  for (let k = 0; k < 3; ++k) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = k; i < table.positions.length; i += 3) {
      lo = Math.min(lo, table.positions[i]);
      hi = Math.max(hi, table.positions[i]);
    }
    extent = Math.max(extent, hi - lo);
  }
  return new CellStore(
    {
      kind: "point_cloud",
      positions: table.positions,
      objectRows: objects ? new Array<number>(n).fill(1) : undefined,
      // Too many to be objects: in cells, so a view reads only its own.
      cellsAcross: objects ? undefined : 8,
      vertexAttributes: table.columns,
      objectColumns: objects ? table.columns : [],
      // Else a guess, as for meshes.
      unit: table.unit ?? meshUnit(extent),
    },
    name,
  );
}
