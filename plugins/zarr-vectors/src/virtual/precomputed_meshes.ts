/**
 * Neuroglancer precomputed segment meshes as a virtual Zarr Vectors mesh
 * store: chosen segments' meshes served as a format 0.9.3 mesh store made
 * from them as its keys are asked for, nothing written.
 *
 * The layout is the app's large-mesh store's (src/virtual/vectors/mesh_cells.ts):
 * per level a grid of cells, per cell one vertex fragment and one face group
 * per object (`fragment_link_groups`), faces as cell-local int32 rows of
 * `links/0/0.0.0_0.0.0`, no cross-cell links, each level its own object
 * index.  What differs:
 *
 * - the objects are the segmentation's segments, with its ids (not 1…N), so
 *   a viewer's chosen segments and colours apply as they do to the
 *   segmentation;
 * - the levels are the meshes' own levels of detail (a multi-resolution
 *   mesh's LODs; a legacy mesh has one), store level 0 the finest kept;
 * - a level's cells are planned from the meshes' manifests alone: each
 *   stored fragment (an octree node of a multi-resolution mesh, a legacy
 *   mesh's fragment file) goes whole to the cell holding its box's centre,
 *   so its vertices can reach a little past the cell, as a face's do in
 *   mesh_cells.ts.  Opening the store reads no geometry; a cell's
 *   fragments are read and decoded when one of its keys is first asked
 *   for, and a few decoded cells are kept;
 * - a level's `vertex_count` is the planner's estimate (from the fragments'
 *   encoded sizes) until its cells are read.
 *
 * Coordinates are the segmentation volume's own (Neuroglancer's model space
 * of a precomputed volume: nanometres over the finest scale's resolution),
 * so the store sits where the segmentation layer's source does and can be
 * drawn through that layer's transform.  The format details (manifests,
 * quantized vertices, legacy fragments) are here, pure; reading them over
 * HTTP and decoding Draco is the caller's (plugins/luxar/precomputed_meshes.ts).
 */

import { AsyncLru } from "../util.js";

const MANIFEST_ROWS = 16384;
const COLUMN_ROWS = 65536;
const FACES = "links/0/0.0.0_0.0.0";
const FRAGMENT_INDEX_MAGIC = 0x5a564647; // 'ZVFG', as fragment_index.ts reads it
/** Decoded cells kept, by their bytes. */
const CELL_CACHE_BYTES = 192 * 1024 * 1024;

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const group = (attributes: Record<string, unknown> = {}) => ({ zarr_format: 3, node_type: "group", attributes });

// ----------------------------------------------------------- the formats

/** A multi-resolution (`neuroglancer_multilod_draco`) mesh's manifest, `<id>.index`. */
export interface MultilodManifest {
  /** The finest octree node's extent, "stored model" units. */
  chunkShape: [number, number, number];
  gridOrigin: [number, number, number];
  lodScales: number[];
  /** Per level of detail, added to its vertices. */
  vertexOffsets: [number, number, number][];
  /** Per level of detail: its nodes' octree positions, and each fragment's bytes from the start of the segment's fragment data. */
  lods: { positions: [number, number, number][]; offsets: number[]; sizes: number[] }[];
  /** The fragment data's length (in a shard, how far before the manifest it starts). */
  dataBytes: number;
}

/** Reads a multi-resolution mesh manifest (Neuroglancer's meshes.md). */
export function decodeMultilodManifest(bytes: Uint8Array): MultilodManifest {
  if (bytes.byteLength < 28 || bytes.byteLength % 4 !== 0) throw new Error(`a mesh manifest of ${bytes.byteLength} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f32 = (at: number) => view.getFloat32(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const chunkShape: [number, number, number] = [f32(0), f32(4), f32(8)];
  const gridOrigin: [number, number, number] = [f32(12), f32(16), f32(20)];
  const n = u32(24);
  let at = 28;
  if (bytes.byteLength < at + 20 * n) throw new Error(`a mesh manifest of ${bytes.byteLength} bytes for ${n} levels of detail`);
  const lodScales = Array.from({ length: n }, (_, i) => f32(at + 4 * i));
  at += 4 * n;
  const vertexOffsets = Array.from({ length: n }, (_, i) => [f32(at + 12 * i), f32(at + 12 * i + 4), f32(at + 12 * i + 8)] as [number, number, number]);
  at += 12 * n;
  const counts = Array.from({ length: n }, (_, i) => u32(at + 4 * i));
  at += 4 * n;
  const total = counts.reduce((a, b) => a + b, 0);
  if (bytes.byteLength !== at + 16 * total) throw new Error(`a mesh manifest of ${bytes.byteLength} bytes for ${n} levels of detail and ${total} fragments`);
  let offset = 0;
  const lods = counts.map((count) => {
    // Positions are [3, count], C order: every x, then every y, then every z.
    const positions = Array.from({ length: count }, (_, i) => [u32(at + 4 * i), u32(at + 4 * (count + i)), u32(at + 4 * (2 * count + i))] as [number, number, number]);
    at += 12 * count;
    const sizes = Array.from({ length: count }, (_, i) => u32(at + 4 * i));
    at += 4 * count;
    const offsets = sizes.map((size) => ((offset += size), offset - size));
    return { positions, offsets, sizes };
  });
  return { chunkShape, gridOrigin, lodScales, vertexOffsets, lods, dataBytes: offset };
}

/** A node's box at a level of detail, "stored model" coordinates: grid_origin + position · chunk_shape · 2^lod, that size. */
export function nodeBox(m: MultilodManifest, lod: number, position: readonly number[]): { lower: number[]; upper: number[] } {
  const lower = [0, 1, 2].map((k) => m.gridOrigin[k] + position[k] * m.chunkShape[k] * 2 ** lod);
  return { lower, upper: lower.map((v, k) => v + m.chunkShape[k] * 2 ** lod) };
}

/**
 * A multi-resolution fragment's vertices, as Draco stores them (integers
 * below 2^bits, not dequantized), to "stored model" coordinates:
 * grid_origin + vertex_offsets[lod] + chunk_shape · 2^lod · (position + q / (2^bits − 1)).
 */
export function dequantize(q: ArrayLike<number>, m: MultilodManifest, lod: number, position: readonly number[], bits: number): Float64Array {
  const out = new Float64Array(q.length);
  const top = 2 ** bits - 1;
  const origin = [0, 1, 2].map((k) => m.gridOrigin[k] + m.vertexOffsets[lod][k] + m.chunkShape[k] * 2 ** lod * position[k]);
  const size = [0, 1, 2].map((k) => (m.chunkShape[k] * 2 ** lod) / top);
  for (let i = 0; i < q.length; ++i) out[i] = origin[i % 3] + size[i % 3] * q[i];
  return out;
}

/** A legacy mesh fragment file: u32 vertex count, float32 x y z per vertex, then u32 triangles to the end. */
export function decodeLegacyFragment(bytes: Uint8Array): { positions: Float32Array; triangles: Uint32Array } {
  if (bytes.byteLength < 4) throw new Error(`a mesh fragment of ${bytes.byteLength} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  const rest = bytes.byteLength - 4 - 12 * n;
  if (rest < 0 || rest % 12 !== 0) throw new Error(`a mesh fragment of ${bytes.byteLength} bytes for ${n} vertices`);
  const positions = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; ++i) positions[i] = view.getFloat32(4 + 4 * i, true);
  const triangles = new Uint32Array(rest / 4);
  for (let i = 0; i < triangles.length; ++i) triangles[i] = view.getUint32(4 + 12 * n + 4 * i, true);
  return { positions, triangles };
}

/** A 3 × 4 affine (row-major, as a precomputed mesh `info`'s `transform`) applied to x y z triples. */
export function applyAffine(affine: readonly number[], points: ArrayLike<number>): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    for (let r = 0; r < 3; ++r) out[i + r] = affine[4 * r] * x + affine[4 * r + 1] * y + affine[4 * r + 2] * z + affine[4 * r + 3];
  }
  return out;
}

/** Two 3 × 4 affines composed: `a` after `b`. */
export function composeAffine(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(12).fill(0);
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 4; ++c) {
      let v = c === 3 ? a[4 * r + 3] : 0;
      for (let k = 0; k < 3; ++k) v += a[4 * r + k] * b[4 * k + c];
      out[4 * r + c] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------- the store

/** A fragment's triangles, in store coordinates. */
export interface FragmentMesh {
  positions: Float32Array;
  triangles: Uint32Array;
}

/** One stored fragment as planned: whose it is, where its box's centre is (store coordinates), and how to read it. */
export interface PlannedFragment {
  /** Index into the plan's ids. */
  object: number;
  centre: readonly number[];
  read: () => Promise<FragmentMesh>;
}

export interface PlannedLevel {
  /** The cells' edge, store units. */
  chunk: number;
  fragments: PlannedFragment[];
  /** About how many vertices the level has (exact once its cells are read). */
  vertices: number;
  /** What it is, for the store's metadata ("lod 2"). */
  label?: string;
}

export interface MeshStorePlan {
  name: string;
  /** The segments, ascending; object i is segment ids[i]. */
  ids: bigint[];
  /** The meshes' bounds, store coordinates. */
  lo: number[];
  hi: number[];
  /** Finest first. */
  levels: PlannedLevel[];
  /** A store unit's size along x, y, z, and its unit ("nanometer"), for the store's axes. */
  scales: number[];
  unit: string;
}

interface Cell {
  at: [number, number, number];
  /** The objects with fragments here, ascending, and their fragments. */
  owners: number[];
  fragments: PlannedFragment[][];
}

interface DecodedCell {
  vertices: Float32Array;
  faces: Int32Array;
  vertexCounts: number[];
  faceCounts: number[];
  bytes: number;
}

interface Served {
  plan: PlannedLevel;
  origin: number[];
  shape: number[];
  cells: Cell[];
  cellByKey: Map<string, number>;
  nonempty: string[];
  /** Per object: its blocks (cell index, fragment in the cell), in cell order. */
  blocks: [number, number][][];
  present: number;
}

/** Per fragment, its row range: the zarr-vectors fragment index (fragment_index_v1), every fragment present. */
export function fragmentIndex(counts: ArrayLike<number>): Uint8Array {
  const f = counts.length;
  const bitmap = 8 * Math.ceil(f / 64);
  const out = new Uint8Array(f === 0 ? 16 : 16 + bitmap + 16 * f + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, FRAGMENT_INDEX_MAGIC, true);
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

/** A cell's fragments read and put together: per object, its vertices, then its faces as rows of the cell. */
async function decodeCell(cell: Cell): Promise<DecodedCell> {
  const parts = await Promise.all(cell.fragments.map((list) => Promise.all(list.map((f) => f.read()))));
  const vertexCounts = parts.map((list) => list.reduce((n, p) => n + p.positions.length / 3, 0));
  const faceCounts = parts.map((list) => list.reduce((n, p) => n + p.triangles.length / 3, 0));
  const vertices = new Float32Array(3 * vertexCounts.reduce((a, b) => a + b, 0));
  const faces = new Int32Array(3 * faceCounts.reduce((a, b) => a + b, 0));
  let v = 0;
  let t = 0;
  for (const list of parts) {
    for (const p of list) {
      const n = p.positions.length / 3;
      vertices.set(p.positions, 3 * v);
      for (let j = 0; j < p.triangles.length; ++j) {
        const r = p.triangles[j];
        // A corner past the fragment's vertices would name another fragment's row.
        faces[t + j] = r < n ? v + r : v;
      }
      v += n;
      t += p.triangles.length;
    }
  }
  return { vertices, faces, vertexCounts, faceCounts, bytes: vertices.byteLength + faces.byteLength };
}

/** One vlen-bytes element. */
function element(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

function column(n: number, rows: number, dataType: string, fill: unknown): unknown {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [n],
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: [rows] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: fill,
    codecs: dataType === "variable_length_bytes" ? [{ name: "vlen-bytes", configuration: {} }] : [{ name: "bytes", configuration: { endian: "little" } }],
    attributes: {},
  };
}

export class PrecomputedMeshStore {
  private readonly served: Served[];
  private readonly directories = new Set<string>();
  /**
   * Decoded cells by level and cell, least recently asked for first, bounded
   * by their bytes; a cell still being read is never evicted, so its bytes
   * are counted once it is read and taken off once it goes.
   */
  private readonly decoded: AsyncLru<DecodedCell>;
  readonly count: number;

  constructor(
    readonly plan: MeshStorePlan,
    cacheBytes = CELL_CACHE_BYTES,
  ) {
    this.decoded = new AsyncLru<DecodedCell>(Infinity, cacheBytes, (c) => c.bytes);
    this.count = plan.ids.length;
    this.served = plan.levels.map((level) => {
      const byKey = new Map<string, Cell>();
      for (const f of level.fragments) {
        const at = [0, 1, 2].map((k) => Math.floor(f.centre[k] / level.chunk)) as [number, number, number];
        const key = at.join("/");
        let cell = byKey.get(key);
        if (cell === undefined) byKey.set(key, (cell = { at, owners: [], fragments: [] }));
        let i = cell.owners.indexOf(f.object);
        if (i === -1) {
          i = cell.owners.length;
          cell.owners.push(f.object);
          cell.fragments.push([]);
        }
        cell.fragments[i].push(f);
      }
      const cells = [...byKey.values()];
      // Objects ascending within a cell (fragment order), cells in a fixed order.
      for (const cell of cells) {
        const order = cell.owners.map((o, i) => [o, i]).sort((a, b) => a[0] - b[0]);
        cell.fragments = order.map(([, i]) => cell.fragments[i]);
        cell.owners = order.map(([o]) => o);
      }
      cells.sort((a, b) => a.at[2] - b.at[2] || a.at[1] - b.at[1] || a.at[0] - b.at[0]);
      // A loop, not Math.min over a spread: a level can have more cells than a call takes arguments.
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const c of cells) {
        for (let k = 0; k < 3; ++k) {
          lo[k] = Math.min(lo[k], c.at[k]);
          hi[k] = Math.max(hi[k], c.at[k]);
        }
      }
      const origin = [0, 1, 2].map((k) => (cells.length ? lo[k] : 0));
      const shape = [0, 1, 2].map((k) => (cells.length ? hi[k] - origin[k] + 1 : 1));
      const cellByKey = new Map<string, number>();
      const blocks: [number, number][][] = Array.from({ length: this.count }, () => []);
      cells.forEach((cell, i) => {
        cellByKey.set(cell.at.map((v, k) => v - origin[k]).join("/"), i);
        cell.owners.forEach((o, f) => blocks[o].push([i, f]));
      });
      return { plan: level, origin, shape, cells, cellByKey, nonempty: cells.map((c) => c.at.join(".")), blocks, present: blocks.filter((b) => b.length > 0).length };
    });
    const add = (path: string) => {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; ++i) this.directories.add(parts.slice(0, i).join("/"));
    };
    this.served.forEach((_, k) => {
      for (const a of ["vertices", "vertex_fragments", "link_fragments", FACES, "object_index/manifests", "object_index/object_ids"]) add(`${k}/${a}`);
    });
  }

  /** How many fragments each level reads in all, finest first. */
  get fragmentCounts(): number[] {
    return this.served.map((s) => s.plan.fragments.length);
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

  private root(): unknown {
    const { lo, hi, name, scales, unit } = this.plan;
    const c0 = this.served[0]?.plan.chunk ?? 1;
    return group({
      zarr_vectors: {
        zv_version: "0.9.3",
        format_capabilities: ["fragment_link_groups"],
        chunk_shape: [c0, c0, c0],
        bounds: [lo, hi],
        geometry_types: ["mesh"],
        links_convention: "explicit",
        object_index_convention: "standard",
        cross_chunk_strategy: "explicit_links",
      },
      multiscales: [
        {
          version: "0.4",
          name,
          axes: ["x", "y", "z"].map((n) => ({ name: n, type: "space", unit })),
          datasets: this.served.map((s, k) => ({
            path: String(k),
            coordinateTransformations: [
              { type: "scale", scale: scales },
              { type: "translation", translation: [0, 1, 2].map((d) => (s.plan.chunk / 2) * scales[d]) },
            ],
          })),
          metadata: { format: "zarr_vectors", source: "neuroglancer precomputed meshes" },
        },
      ],
      neuroglancer: { coordinate_space: { names: ["x", "y", "z"], units: [unit, unit, unit], scales } },
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (key === "zarr.json") return json(this.root());
    const m = /^(\d+)\/(.*)$/.exec(key);
    const k = m === null ? -1 : Number(m[1]);
    const s = this.served[k];
    if (s === undefined) return undefined;
    return this.levelKey(k, s, m![2]);
  }

  private async levelKey(k: number, s: Served, key: string): Promise<Uint8Array | undefined> {
    const { plan, origin, shape, nonempty } = s;
    const perCell = (attributes: Record<string, unknown>) =>
      json({
        zarr_format: 3,
        node_type: "array",
        shape,
        data_type: "variable_length_bytes",
        chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 1, 1] } },
        chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
        fill_value: "",
        codecs: [{ name: "vlen-bytes", configuration: {} }],
        attributes: { nonempty_chunks: nonempty, chunk_grid_origin: origin, ...attributes },
      });
    switch (key) {
      case "zarr.json":
        return json(
          group({
            zarr_vectors_level: {
              level: k,
              vertex_count: Math.round(plan.vertices),
              arrays_present: ["vertices", "links", "object_index"],
              chunk_shape: [plan.chunk, plan.chunk, plan.chunk],
              ...(k === 0
                ? { object_sparsity: 1, coarsening_method: "none", parent_level: null }
                : {
                    object_sparsity: this.served[k - 1].present > 0 ? s.present / this.served[k - 1].present : 1,
                    coarsening_method: "precomputed_mesh_lod",
                    parent_level: k - 1,
                    preserves_object_ids: true,
                    inherited_num_objects: this.count,
                  }),
              ...(plan.label !== undefined ? { source_level: plan.label } : {}),
              fragments_tile: true,
              fragment_link_groups: true,
            },
          }),
        );
      case "vertices/zarr.json":
        return perCell({ zv_array: "vertices", dtype: "float32", encoding: "raw" });
      case "vertex_fragments/zarr.json":
        return perCell({ zv_array: "vertex_fragments", encoding: "fragment_index_v1" });
      case "link_fragments/zarr.json":
        return perCell({ zv_array: "link_fragments", encoding: "fragment_index_v1" });
      case "links/zarr.json":
        return json(group());
      case "links/0/zarr.json":
        // No face count: the faces are known only once the cells are read.
        return json(group({ zv_array: "links_family", level_delta: 0, link_width: 3, directed: false, store: "canonical", sid_ndim: 3 }));
      case `${FACES}/zarr.json`:
        return perCell({ zv_array: "links", dtype: "int32", offsets: [[0, 0, 0], [0, 0, 0]], has_perm: false, link_width: 3, level_delta: 0 });
      case "object_index/zarr.json":
        return json(group({ zv_array: "object_index", num_objects: this.count, num_present: s.present, sid_ndim: 3, layout: "vlen_manifests_v2", object_ids_sorted: true }));
      case "object_index/manifests/zarr.json":
        return json(column(this.count, MANIFEST_ROWS, "variable_length_bytes", ""));
      case "object_index/object_ids/zarr.json":
        return json(column(this.count, COLUMN_ROWS, "int64", 0));
    }
    const cellKey = /^(vertices|vertex_fragments|link_fragments|links\/0\/0\.0\.0_0\.0\.0)\/c\/(-?\d+\/-?\d+\/-?\d+)$/.exec(key);
    if (cellKey !== null) {
      const i = s.cellByKey.get(cellKey[2]);
      if (i === undefined) return undefined;
      const cell = await this.cell(k, s, i);
      switch (cellKey[1]) {
        case "vertices":
          return element(bytesOf(cell.vertices));
        case "vertex_fragments":
          return element(fragmentIndex(cell.vertexCounts));
        case "link_fragments":
          return element(fragmentIndex(cell.faceCounts));
        default:
          return element(bytesOf(cell.faces));
      }
    }
    const chunk = /^(object_index\/manifests|object_index\/object_ids)\/c\/(\d+)$/.exec(key);
    if (chunk === null) return undefined;
    const first = Number(chunk[2]) * (chunk[1] === "object_index/manifests" ? MANIFEST_ROWS : COLUMN_ROWS);
    if (first >= this.count) return undefined;
    if (chunk[1] === "object_index/manifests") return this.manifests(s, first);
    // The segmentation's own ids (int64, as zarr-vectors stores them; ids past 2^63 wrap).
    const ids = new BigInt64Array(COLUMN_ROWS);
    for (let i = 0; i < COLUMN_ROWS && first + i < this.count; ++i) ids[i] = BigInt.asIntN(64, this.plan.ids[first + i]);
    return bytesOf(ids);
  }

  /** Bytes of the decoded cells kept. */
  get cachedBytes(): number {
    return this.decoded.size;
  }

  /** A cell's fragments read and put together, or kept from before. */
  private cell(k: number, s: Served, i: number): Promise<DecodedCell> {
    return this.decoded.get(`${k}/${i}`, () => decodeCell(s.cells[i]));
  }

  /** A chunk of manifests: per object, u32 blocks, then per block int64 x3 cell, u8 mode 0, int64 fragment. */
  private manifests(s: Served, first: number): Uint8Array {
    const rows = Math.min(MANIFEST_ROWS, this.count - first);
    const items: Uint8Array[] = [];
    for (let r = 0; r < rows; ++r) {
      const blocks = s.blocks[first + r];
      const item = new Uint8Array(4 + 33 * blocks.length);
      const view = new DataView(item.buffer);
      view.setUint32(0, blocks.length, true);
      blocks.forEach(([cell, fragment], b) => {
        const at = 4 + 33 * b;
        const c = s.cells[cell].at;
        for (let d = 0; d < 3; ++d) view.setBigInt64(at + 8 * d, BigInt(c[d]), true);
        view.setUint8(at + 24, 0);
        view.setBigInt64(at + 25, BigInt(fragment), true);
      });
      items.push(item);
    }
    const out = new Uint8Array(4 + 4 * MANIFEST_ROWS + items.reduce((n, b) => n + b.byteLength, 0));
    const view = new DataView(out.buffer);
    view.setUint32(0, MANIFEST_ROWS, true);
    let at = 4;
    for (let r = 0; r < MANIFEST_ROWS; ++r) {
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
}
