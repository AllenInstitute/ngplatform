/**
 * A large mesh served as a zarr-vectors 0.9.3 mesh store in cells, with
 * coarser levels (`mesh_levels.ts` makes them, in a worker of its own:
 * `mesh_levels_worker.ts`).
 *
 * Every level has the layout the one-cell store (`meshes.ts`) has, in many
 * cells: per cell, one vertex fragment and one face group per object
 * (`fragment_link_groups`), faces as cell-local int32 rows of
 * `links/0/0.0.0_0.0.0` in the file's winding, no cross-cell links (a
 * vertex on a border is stored in each cell whose faces use it). Level k's
 * cells are 2^k times level 0's, so the viewer uses the levels as a
 * multiscale mesh's levels of detail. Objects have ids from 1, and each
 * level has its own object index naming that level's fragments. Kept in
 * memory: every level's cells (level 0 is about the file's triangles and
 * vertices again, the coarser levels about 40% more on top).
 */
import type { MeshData } from "./mesh_files.js";
import { buildMeshLevels, meshLevelBuffers, type MeshLevel, type MeshLevels } from "./mesh_levels.js";
import { meshUnit, MeshStore } from "./meshes.js";
import type { SurfaceCompanions } from "./surfaces.js";
import { SPLIT_TRIANGLES } from "./mesh_levels.js";
import { fragmentIndex } from "./streamlines.js";

const MANIFEST_ROWS = 16384;
const COLUMN_ROWS = 65536;
const FACES = "links/0/0.0.0_0.0.0";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
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

/** A level as served: its grid and cells by key. */
interface Served {
  level: MeshLevel;
  origin: number[];
  shape: number[];
  cellByKey: Map<string, number>;
  nonempty: string[];
  /** Per object: its blocks (cell index, fragment), in cell order. */
  blocks: [number, number][][];
}

export class CellMeshStore {
  private readonly served: Served[];
  private readonly directories = new Set<string>();
  readonly count: number;

  constructor(
    private readonly data: MeshLevels,
    readonly name: string,
  ) {
    this.count = data.objects.length;
    this.served = data.levels.map((level) => {
      const origin = data.lo.map((v) => Math.floor(v / level.chunk));
      const shape = data.hi.map((v, k) => Math.floor(v / level.chunk) - origin[k] + 1);
      const cellByKey = new Map<string, number>();
      const blocks: [number, number][][] = Array.from({ length: this.count }, () => []);
      level.cells.forEach((cell, i) => {
        cellByKey.set(cell.at.map((v, k) => v - origin[k]).join("/"), i);
        cell.owners.forEach((o, f) => blocks[o].push([i, f]));
      });
      return { level, origin, shape, cellByKey, nonempty: level.cells.map((c) => c.at.join(".")), blocks };
    });
    const add = (path: string) => {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; ++i) this.directories.add(parts.slice(0, i).join("/"));
    };
    this.served.forEach((_, k) => {
      for (const a of ["vertices", "vertex_fragments", "link_fragments", FACES, "object_index/manifests", "object_index/object_ids"]) add(`${k}/${a}`);
    });
    for (const c of data.columns) add(`0/object_attributes/${c.name}`);
  }

  /** Builds the levels (in a worker of their own where there are workers) and serves them. */
  static async open(mesh: MeshData, name: string): Promise<CellMeshStore> {
    return new CellMeshStore(await meshLevelsOffThread(mesh), name);
  }

  /** The levels, for tests and measurements. */
  get levels(): MeshLevels {
    return this.data;
  }

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
    const { lo, hi, offset } = this.data;
    const c0 = this.served[0].level.chunk;
    const extent = Math.max(...hi.map((h, k) => h - lo[k]));
    return group({
      zarr_vectors: {
        zv_version: "0.9.3",
        format_capabilities: ["fragment_link_groups"],
        chunk_shape: [c0, c0, c0],
        bounds: [lo, hi],
        coordinate_offset: offset,
        geometry_types: ["mesh"],
        links_convention: "explicit",
        object_index_convention: "standard",
        cross_chunk_strategy: "explicit_links",
      },
      multiscales: [
        {
          version: "0.4",
          name: this.name,
          axes: ["x", "y", "z"].map((n) => ({ name: n, type: "space", unit: meshUnit(extent) })),
          datasets: this.served.map((s, k) => ({
            path: String(k),
            coordinateTransformations: [
              { type: "scale", scale: [1, 1, 1] },
              { type: "translation", translation: [s.level.chunk / 2, s.level.chunk / 2, s.level.chunk / 2] },
            ],
          })),
          metadata: { format: "zarr_vectors" },
        },
      ],
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

  private levelKey(k: number, s: Served, key: string): Uint8Array | undefined {
    const { level, origin, shape, nonempty } = s;
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
              vertex_count: level.vertexCount,
              arrays_present: ["vertices", "links", "object_index"],
              ...(k === 0
                ? { object_sparsity: 1, coarsening_method: "none", parent_level: null }
                : {
                    chunk_shape: [level.chunk, level.chunk, level.chunk],
                    object_sparsity: level.present / Math.max(1, this.count),
                    coarsening_method: "mesh_vertex_clustering",
                    parent_level: k - 1,
                    preserves_object_ids: true,
                    inherited_num_objects: this.count,
                    bin_shape: [level.bin, level.bin, level.bin],
                  }),
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
        return json(group({ zv_array: "links_family", level_delta: 0, link_width: 3, directed: false, store: "canonical", sid_ndim: 3, num_links: level.faceCount, num_physical_records: level.faceCount }));
      case `${FACES}/zarr.json`:
        return perCell({ zv_array: "links", dtype: "int32", offsets: [[0, 0, 0], [0, 0, 0]], has_perm: false, link_width: 3, level_delta: 0 });
      case "object_index/zarr.json":
        return json(group({ zv_array: "object_index", num_objects: this.count, num_present: level.present, sid_ndim: 3, layout: "vlen_manifests_v2", object_ids_sorted: true }));
      case "object_index/manifests/zarr.json":
        return json(column(this.count, MANIFEST_ROWS, "variable_length_bytes", ""));
      case "object_index/object_ids/zarr.json":
        return json(column(this.count, COLUMN_ROWS, "int64", 0));
    }
    if (k === 0 && key === "object_attributes/zarr.json") return json(group());
    const columnJson = /^object_attributes\/([^/]+)\/zarr\.json$/.exec(key);
    if (k === 0 && columnJson !== null && this.data.columns.some((c) => c.name === columnJson[1])) {
      return json(column(this.count, COLUMN_ROWS, "float32", "NaN", { zv_array: "object_attribute", name: columnJson[1], dtype: "float32", shape: [this.count], fill_sentinel_meaning: "absent" }));
    }
    const cellKey = /^(vertices|vertex_fragments|link_fragments|links\/0\/0\.0\.0_0\.0\.0)\/c\/(-?\d+\/-?\d+\/-?\d+)$/.exec(key);
    if (cellKey !== null) {
      const i = s.cellByKey.get(cellKey[2]);
      if (i === undefined) return undefined;
      const cell = level.cells[i];
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
    const chunk = /^(object_index\/manifests|object_index\/object_ids|object_attributes\/[^/]+)\/c\/(\d+)$/.exec(key);
    if (chunk === null) return undefined;
    const first = Number(chunk[2]) * (chunk[1] === "object_index/manifests" ? MANIFEST_ROWS : COLUMN_ROWS);
    if (first >= this.count) return undefined;
    if (chunk[1] === "object_index/manifests") return this.manifests(s, first);
    if (chunk[1] === "object_index/object_ids") {
      const ids = new BigInt64Array(COLUMN_ROWS);
      for (let i = 0; i < COLUMN_ROWS && first + i < this.count; ++i) ids[i] = BigInt(first + i + 1);
      return bytesOf(ids);
    }
    if (k !== 0) return undefined;
    const values = this.data.columns.find((c) => `object_attributes/${c.name}` === chunk[1])?.values;
    if (values === undefined) return undefined;
    const out = new Float32Array(COLUMN_ROWS).fill(Number.NaN);
    out.set(values.subarray(first, first + COLUMN_ROWS));
    return bytesOf(out);
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
        const c = s.level.cells[cell].at;
        for (let d = 0; d < 3; ++d) view.setBigInt64(at + 8 * d, BigInt(c[d]), true);
        view.setUint8(at + 24, 0);
        view.setBigInt64(at + 25, BigInt(fragment), true);
      });
      items.push(item);
    }
    const size = 4 + 4 * MANIFEST_ROWS + items.reduce((n, b) => n + b.byteLength, 0);
    const out = new Uint8Array(size);
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

/**
 * The levels of a mesh, made in a worker of their own so the worker serving
 * stores keeps answering meanwhile; where there are no workers, here.
 */
export function meshLevelsOffThread(mesh: MeshData): Promise<MeshLevels> {
  if (typeof Worker === "undefined" || typeof window !== "undefined" || !("importScripts" in globalThis)) return Promise.resolve(buildMeshLevels(mesh));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./mesh_levels_worker.ts", import.meta.url), { type: "module", name: "mesh levels" });
    worker.onmessage = (event: MessageEvent<{ levels?: MeshLevels; error?: string }>) => {
      worker.terminate();
      if (event.data.levels !== undefined) resolve(event.data.levels);
      else reject(new Error(event.data.error ?? "the mesh levels worker failed"));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "the mesh levels worker failed"));
    };
    worker.postMessage({ mesh }, [...new Set([mesh.positions.buffer, mesh.triangles.buffer, mesh.triangleObject.buffer])] as ArrayBuffer[]);
  });
}

export { meshLevelBuffers };

/**
 * A mesh file's store: past `SPLIT_TRIANGLES` triangles, in cells with
 * coarser levels; otherwise, and for a surface with values beside it, one
 * cell (`MeshStore`).
 */
export async function openMeshStore(mesh: MeshData, name: string, companions?: SurfaceCompanions, splitAbove = SPLIT_TRIANGLES): Promise<MeshStore | CellMeshStore> {
  const plain = companions === undefined || (companions.maps.length === 0 && Object.keys(companions.surfaces).length <= 1 && !companions.series?.length);
  if (plain && mesh.triangles.length / 3 > splitAbove) return CellMeshStore.open(mesh, name);
  return new MeshStore(mesh, name, companions);
}
