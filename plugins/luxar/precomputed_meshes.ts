/**
 * A precomputed segmentation's meshes, for the segments a layer shows, read
 * as a virtual Zarr Vectors mesh store (../zarr-vectors/src/virtual/precomputed_meshes.ts)
 * that Luxar's reading worker opens as it opens any store: the layer's
 * meshes then take Luxar's mesh path (dense chunks, lit triangles in 3-D,
 * outlines in 2-D) with nothing converted or written.
 *
 * Its URL names the volume and the segments (`precomputed-meshes:<volume
 * url>#segments=<id>,<id>`); the worker reads the volume's `info` (the
 * `mesh` directory, the finest scale's resolution), the mesh directory's
 * `info`, and each segment's manifest:
 *
 * - `neuroglancer_multilod_draco`, sharded or not: `<id>.index` (or the
 *   shard entry for the id, its fragment data just before it in the same
 *   shard file), whose levels of detail become the store's levels.  The
 *   finest level kept is the finest whose fragments, estimated from their
 *   encoded sizes, come to at most `VERTEX_BUDGET` vertices over the
 *   segments; a segment with fewer levels gives its coarsest to the coarser
 *   ones.  A fragment is read (a range of the data file or shard) and
 *   decoded (Draco, by Neuroglancer's decoder) only when its cell is.
 * - legacy (`<id>:0` listing fragment files): one level, every fragment
 *   read at once, at most `LEGACY_BYTES` of them.
 *
 * Coordinates: a fragment's "stored model" positions through the mesh
 * `info`'s transform are nanometres; over the finest scale's resolution,
 * the volume's voxels, which is the space Neuroglancer gives the
 * segmentation layer's source.  So the layer's own transform places them.
 */
import { decodeMinishardIndex, gunzip, httpRead, type RangeRead, type Sharding, shardOf } from "@ngplatform/sdk/precomputed";
import { ShardIndexCache, type ZarrVectorsStoreAccess } from "neuroglancer-zarr-vectors/reader";
import {
  applyAffine,
  composeAffine,
  decodeLegacyFragment,
  decodeMultilodManifest,
  dequantize,
  type FragmentMesh,
  type MeshStorePlan,
  type MultilodManifest,
  nodeBox,
  type PlannedFragment,
  type PlannedLevel,
  PrecomputedMeshStore,
} from "../zarr-vectors/src/virtual/precomputed_meshes.js";

import { MAX_SEGMENTS } from "./mesh_layers.js";

export { PrecomputedMeshStore };
export { parseMeshStoreUrl } from "./mesh_layers.js";

/**
 * At most about this many vertices at the finest level read, over all the
 * segments (Luxar's Detail, 2 M by default, then picks among the levels).
 */
export const VERTEX_BUDGET = 8_000_000;
/**
 * Vertices per encoded byte of a Draco fragment (16-bit positions), for
 * the estimate: MICrONS v1300 measures 0.3 to 0.5 at its levels of detail.
 */
export const VERTICES_PER_BYTE = 0.4;
/** A legacy mesh's fragments are read whole when its store opens: at most this many bytes. */
export const LEGACY_BYTES = 256 * 1024 * 1024;

/** Decodes a Draco fragment without dequantizing: indices, and x y z per vertex as stored. */
export type DracoDecode = (bytes: Uint8Array, bits: number) => Promise<{ indices: Uint32Array | Uint16Array; vertexPositions: Uint32Array }>;

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function readJson(read: RangeRead, url: string): Promise<any | undefined> {
  const bytes = await read(url);
  return bytes === undefined ? undefined : JSON.parse(textOf(bytes));
}

/** A sharded mesh directory's entries by segment id, with where each starts in its shard file (the manifest's fragments end there). */
class ShardedManifests {
  private readonly minishards = new Map<string, Promise<ReturnType<typeof decodeMinishardIndex> | undefined>>();

  constructor(
    private readonly folder: string,
    private readonly sharding: Sharding,
    private readonly read: RangeRead,
  ) {}

  async manifest(id: bigint): Promise<{ bytes: Uint8Array; file: string; start: number } | undefined> {
    const { shard, minishard } = shardOf(this.sharding, id);
    const file = `${this.folder}${shard}`;
    const key = `${shard}#${minishard}`;
    let index = this.minishards.get(key);
    if (index === undefined) {
      index = this.minishard(file, minishard);
      index.catch(() => this.minishards.delete(key));
      this.minishards.set(key, index);
    }
    const entries = await index;
    const i = entries?.ids.indexOf(id) ?? -1;
    if (entries === undefined || i < 0) return undefined;
    const start = entries.starts[i];
    let bytes = await this.read(file, { offset: start, length: entries.ends[i] - start });
    if (bytes === undefined) return undefined;
    if (this.sharding.data_encoding === "gzip") bytes = await gunzip(bytes);
    return { bytes, file, start };
  }

  private async minishard(file: string, minishard: number) {
    const shardIndexSize = 16 * 2 ** this.sharding.minishard_bits;
    const at = await this.read(file, { offset: 16 * minishard, length: 16 });
    if (at === undefined) return undefined;
    const view = new DataView(at.buffer, at.byteOffset, 16);
    const start = Number(view.getBigUint64(0, true));
    const end = Number(view.getBigUint64(8, true));
    if (start === end) return undefined;
    let bytes = await this.read(file, { offset: shardIndexSize + start, length: end - start });
    if (bytes === undefined) return undefined;
    if (this.sharding.minishard_index_encoding === "gzip") bytes = await gunzip(bytes);
    return decodeMinishardIndex(bytes, shardIndexSize);
  }
}

/** A multi-resolution mesh of one segment: its manifest, and where its fragment data starts. */
interface SegmentMesh {
  object: number;
  manifest: MultilodManifest;
  file: string;
  start: number;
}

/** The power of two at or above v (at least 1). */
const ceilPow2 = (v: number) => 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(v, 1))));

/** A box's corners through an affine: the box around them. */
function boxThrough(affine: readonly number[], lower: number[], upper: number[]): { lower: number[]; upper: number[] } {
  const corners: number[] = [];
  for (let c = 0; c < 8; ++c) corners.push(c & 1 ? upper[0] : lower[0], c & 2 ? upper[1] : lower[1], c & 4 ? upper[2] : lower[2]);
  const p = applyAffine(affine, corners);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; ++i) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  return { lower: lo, upper: hi };
}

/**
 * Plans the store's levels from the segments' manifests (no geometry read):
 * store level i is level of detail `first + i`, each segment at its own
 * coarsest where it has fewer.  Exported for the tests.
 */
export function planMultilod(
  segments: SegmentMesh[],
  toStore: number[],
  bits: number,
  readRange: RangeRead,
  decode: DracoDecode,
  budget = VERTEX_BUDGET,
): { levels: PlannedLevel[]; lo: number[]; hi: number[] } {
  let lods = 0;
  for (const s of segments) lods = Math.max(lods, s.manifest.lods.length);
  const lodOf = (s: SegmentMesh, level: number) => Math.min(level, s.manifest.lods.length - 1);
  const bytesAt = (level: number) => segments.reduce((n, s) => n + s.manifest.lods[lodOf(s, level)].sizes.reduce((a, b) => a + b, 0), 0);
  let first = 0;
  while (first < lods - 1 && bytesAt(first) * VERTICES_PER_BYTE > budget) ++first;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const levels: PlannedLevel[] = [];
  let chunk = 1;
  for (let level = first; level < lods; ++level) {
    const fragments: PlannedFragment[] = [];
    let edge = 0;
    for (const s of segments) {
      const lod = lodOf(s, level);
      const { positions, offsets, sizes } = s.manifest.lods[lod];
      for (let i = 0; i < positions.length; ++i) {
        if (sizes[i] === 0) continue;
        const node = nodeBox(s.manifest, lod, positions[i]);
        const box = boxThrough(toStore, node.lower, node.upper);
        for (let k = 0; k < 3; ++k) {
          lo[k] = Math.min(lo[k], box.lower[k]);
          hi[k] = Math.max(hi[k], box.upper[k]);
          edge = Math.max(edge, box.upper[k] - box.lower[k]);
        }
        const position = positions[i];
        const offset = s.start - s.manifest.dataBytes + offsets[i];
        const length = sizes[i];
        const manifest = s.manifest;
        fragments.push({
          object: s.object,
          centre: [0, 1, 2].map((k) => (box.lower[k] + box.upper[k]) / 2),
          read: async (): Promise<FragmentMesh> => {
            const bytes = await readRange(s.file, { offset, length });
            if (bytes === undefined) throw new Error(`${s.file}: a mesh fragment is missing`);
            const decoded = await decode(bytes, bits);
            return { positions: applyAffine(toStore, dequantize(decoded.vertexPositions, manifest, lod, position, bits)), triangles: decoded.indices instanceof Uint32Array ? decoded.indices : Uint32Array.from(decoded.indices) };
          },
        });
      }
    }
    // Cells at least a node across at this level, and never smaller than a finer level's.
    chunk = Math.max(chunk, ceilPow2(edge));
    levels.push({ chunk, fragments, vertices: bytesAt(level) * VERTICES_PER_BYTE, label: `lod ${level}` });
  }
  return { levels, lo, hi };
}

/** Diagonal scaling as a 3 × 4 affine. */
const scaling = (s: number[]) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0];

/**
 * Opens the store of a precomputed segmentation's meshes for `ids`
 * (`volume`: the volume's http(s) URL, ending in "/").  Reads the infos and
 * the manifests; segments without a mesh are left out.
 */
export async function openPrecomputedMeshes(
  volume: string,
  ids: readonly bigint[],
  options: { decode: DracoDecode; read?: RangeRead; budget?: number },
): Promise<PrecomputedMeshStore> {
  const read = options.read ?? httpRead;
  const info = await readJson(read, `${volume}info`);
  if (info === undefined) throw new Error(`${volume}: no info file`);
  if (typeof info.mesh !== "string" || info.mesh === "") throw new Error(`${volume}: the segmentation has no meshes`);
  const resolution = (info.scales?.[0]?.resolution as number[] | undefined)?.map(Number) ?? [1, 1, 1];
  const meshUrl = new URL(`${info.mesh.replace(/\/$/, "")}/`, volume).href;
  const meshInfo = await readJson(read, `${meshUrl}info`).catch(() => undefined);
  const wanted = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_SEGMENTS);
  // Nanometres to the volume's voxels.
  const toVoxels = scaling(resolution.map((r) => 1 / r));
  const name = info.mesh;
  const kind = meshInfo?.["@type"] ?? "neuroglancer_legacy_mesh";
  let plan: MeshStorePlan;
  if (kind === "neuroglancer_multilod_draco") {
    const transform = Array.isArray(meshInfo.transform) && meshInfo.transform.length === 12 ? meshInfo.transform.map(Number) : scaling([1, 1, 1]);
    const bits = Number(meshInfo.vertex_quantization_bits ?? 10);
    const sharded = meshInfo.sharding !== undefined ? new ShardedManifests(meshUrl, meshInfo.sharding as Sharding, read) : undefined;
    const found = await Promise.all(
      wanted.map(async (id) => {
        if (sharded !== undefined) return sharded.manifest(id);
        const bytes = await read(`${meshUrl}${id}.index`);
        return bytes === undefined ? undefined : { bytes, file: `${meshUrl}${id}`, start: 0 };
      }),
    );
    const kept = wanted.filter((_, i) => found[i] !== undefined);
    const segments: SegmentMesh[] = [];
    found.forEach((f) => {
      if (f === undefined) return;
      const manifest = decodeMultilodManifest(f.bytes);
      // Unsharded, the data file starts at 0: fragment offsets count from there.
      segments.push({ object: segments.length, manifest, file: f.file, start: sharded !== undefined ? f.start : manifest.dataBytes });
    });
    const { levels, lo, hi } = planMultilod(segments, composeAffine(toVoxels, transform), bits, read, options.decode, options.budget);
    plan = { name, ids: kept, lo, hi, levels, scales: resolution, unit: "nanometer" };
  } else {
    plan = await planLegacy(meshUrl, wanted, toVoxels, read, name, resolution);
  }
  if (plan.ids.length === 0 || plan.levels.length === 0) throw new Error(`none of the ${wanted.length} segments has a mesh`);
  if (!plan.lo.every(Number.isFinite)) plan = { ...plan, lo: [0, 0, 0], hi: [1, 1, 1] };
  return new PrecomputedMeshStore(plan);
}

/** Legacy meshes: every fragment of every segment read now, one level. */
async function planLegacy(meshUrl: string, ids: bigint[], toVoxels: number[], read: RangeRead, name: string, scales: number[]): Promise<MeshStorePlan> {
  const kept: bigint[] = [];
  const fragments: PlannedFragment[] = [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let edge = 0;
  let bytes = 0;
  let vertices = 0;
  for (const id of ids) {
    if (bytes > LEGACY_BYTES) break;
    const listing = await readJson(read, `${meshUrl}${id}:0`).catch(() => undefined);
    const names = Array.isArray(listing?.fragments) ? (listing.fragments as unknown[]).filter((f): f is string => typeof f === "string") : [];
    const meshes = (
      await Promise.all(
        names.map(async (f) => {
          // Names relative to the mesh directory (they often hold colons, which a URL would read as a scheme).
          const data = await read(`${meshUrl}${f}`);
          return data === undefined ? undefined : decodeLegacyFragment(data);
        }),
      )
    ).filter((m): m is FragmentMesh => m !== undefined && m.triangles.length > 0);
    if (meshes.length === 0) continue;
    const object = kept.length;
    kept.push(id);
    for (const m of meshes) {
      bytes += m.positions.byteLength + m.triangles.byteLength;
      vertices += m.positions.length / 3;
      const positions = applyAffine(toVoxels, m.positions);
      const flo = [Infinity, Infinity, Infinity];
      const fhi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; ++i) {
        flo[i % 3] = Math.min(flo[i % 3], positions[i]);
        fhi[i % 3] = Math.max(fhi[i % 3], positions[i]);
      }
      for (let k = 0; k < 3; ++k) {
        lo[k] = Math.min(lo[k], flo[k]);
        hi[k] = Math.max(hi[k], fhi[k]);
        edge = Math.max(edge, fhi[k] - flo[k]);
      }
      const mesh = { positions, triangles: m.triangles };
      fragments.push({ object, centre: [0, 1, 2].map((k) => (flo[k] + fhi[k]) / 2), read: async () => mesh });
    }
  }
  return { name, ids: kept, lo, hi, levels: [{ chunk: ceilPow2(edge), fragments, vertices, label: "legacy" }], scales, unit: "nanometer" };
}

/** The store as the Zarr Vectors reader reads one: keys, byte ranges of them, directory listings. */
export function storeAccess(store: PrecomputedMeshStore): ZarrVectorsStoreAccess {
  return {
    async read(key, options = {}) {
      const data = await store.get(key);
      if (data === undefined) return undefined;
      const r = options.byteRange;
      if (r === undefined) return data;
      return "suffixLength" in r ? data.subarray(Math.max(0, data.length - r.suffixLength)) : data.subarray(r.offset, r.offset + r.length);
    },
    async listDirectories(key) {
      return (store.list(`${key.replace(/\/$/, "")}/`) ?? []).filter((n) => n.endsWith("/")).map((n) => n.slice(0, -1));
    },
    shardIndexes: new ShardIndexCache(),
  };
}
