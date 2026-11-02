/**
 * Neuroglancer precomputed images for the volume view: the `info` file's
 * scales as levels, and their chunks (raw or JPEG, sharded or not) read and
 * decoded to uint8, x fastest, padded to the full chunk shape.
 *
 * Sharding is `neuroglancer_uint64_sharded_v1`, as Neuroglancer reads it
 * (src/datasource/precomputed/sharded.ts): a chunk's compressed Morton code,
 * hashed, picks a shard file and a minishard in it, whose index lists where
 * the chunk is.
 */
import { JpegDecoder } from "neuroglancer/unstable/third_party/jpgjs/jpg.js";
import { murmurHash3_x86_128Hash64Bits_Bigint } from "neuroglancer/unstable/util/hash.js";
import type { Mat4, VolumeLevel } from "./ome.js";

export interface Sharding {
  "@type": "neuroglancer_uint64_sharded_v1";
  preshift_bits: number;
  hash: "identity" | "murmurhash3_x86_128";
  minishard_bits: number;
  shard_bits: number;
  minishard_index_encoding?: "raw" | "gzip";
  data_encoding?: "raw" | "gzip";
}

export interface Scale {
  key: string;
  size: [number, number, number];
  resolution: [number, number, number];
  voxel_offset?: [number, number, number];
  chunk_sizes: [number, number, number][];
  encoding: string;
  sharding?: Sharding;
}

export interface Info {
  type: string;
  data_type: string;
  num_channels: number;
  scales: Scale[];
}

/**
 * A scale as a volume level: voxel (x, y, z) centres to millimetres, where
 * Neuroglancer puts them (voxel v spans [v, v + 1) after the offset, in
 * nanometres).
 */
export function scaleLevel(url: string, scale: Scale): VolumeLevel {
  const offset = scale.voxel_offset ?? [0, 0, 0];
  const mm = scale.resolution.map((r) => r * 1e-6);
  const m = new Float64Array(16) as Mat4;
  for (let k = 0; k < 3; ++k) {
    m[5 * k] = mm[k];
    m[4 * k + 3] = (offset[k] + 0.5) * mm[k];
  }
  m[15] = 1;
  return { url, path: scale.key, voxelToRas: m, voxelSize: (mm[0] + mm[1] + mm[2]) / 3, axes: ["z", "y", "x"] };
}

/** Neuroglancer's chunk id for a sharded scale: the grid position as a compressed Morton code. */
export function chunkId(position: number[], grid: number[]): bigint {
  const bits = grid.map((g) => Math.ceil(Math.log2(g)));
  let id = 0n;
  let written = 0n;
  for (let bit = 0; bit < Math.max(...bits); ++bit) {
    for (let d = 0; d < 3; ++d) {
      if (bit >= bits[d]) continue;
      id |= BigInt((position[d] >> bit) & 1) << written;
      written += 1n;
    }
  }
  return id;
}

/** Where a chunk id lives: its shard file's name and its minishard. */
export function shardOf(sharding: Sharding, id: bigint): { shard: string; minishard: number } {
  const input = id >> BigInt(sharding.preshift_bits);
  const hash = sharding.hash === "identity" ? input : murmurHash3_x86_128Hash64Bits_Bigint(0, input);
  const minishard = Number(hash & ((1n << BigInt(sharding.minishard_bits)) - 1n));
  const shard = (hash >> BigInt(sharding.minishard_bits)) & ((1n << BigInt(sharding.shard_bits)) - 1n);
  return { shard: `${shard.toString(16).padStart(Math.ceil(sharding.shard_bits / 4), "0")}.shard`, minishard };
}

/** A minishard index: chunk ids and their absolute byte ranges in the shard file. */
export function decodeMinishardIndex(bytes: Uint8Array, shardIndexSize: number): { ids: bigint[]; starts: number[]; ends: number[] } {
  const n = bytes.byteLength / 24;
  if (!Number.isInteger(n)) throw new Error(`a minishard index of ${bytes.byteLength} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids: bigint[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let id = 0n;
  let end = shardIndexSize;
  for (let i = 0; i < n; ++i) {
    id += view.getBigUint64(8 * i, true);
    const start = end + Number(view.getBigUint64(8 * (n + i), true));
    end = start + Number(view.getBigUint64(8 * (2 * n + i), true));
    ids.push(id);
    starts.push(start);
    ends.push(end);
  }
  return { ids, starts, ends };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads part of a file over http(s); undefined when it is missing. */
export type RangeRead = (url: string, range?: { offset: number; length: number }, signal?: AbortSignal) => Promise<Uint8Array | undefined>;

export const httpRead: RangeRead = async (url, range, signal) => {
  const headers: Record<string, string> = {};
  if (range !== undefined) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  const response = await fetch(url, { headers, signal });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A server that ignores Range sends the whole file.
  if (range !== undefined && response.status === 200 && bytes.byteLength > range.length) return bytes.subarray(range.offset, range.offset + range.length);
  return bytes;
};

/** One scale of a precomputed image, its chunks read as uint8 x-fastest blocks of the full chunk shape. */
export class PrecomputedScale {
  readonly chunk: [number, number, number];
  readonly grid: [number, number, number];
  private readonly minishards = new Map<string, Promise<{ ids: bigint[]; starts: number[]; ends: number[] } | undefined>>();

  constructor(
    readonly url: string,
    readonly scale: Scale,
    readonly dataType: string,
    private readonly read: RangeRead = httpRead,
  ) {
    this.chunk = scale.chunk_sizes[0];
    this.grid = [0, 1, 2].map((k) => Math.ceil(scale.size[k] / this.chunk[k])) as [number, number, number];
    if (dataType !== "uint8") throw new Error(`${dataType} precomputed images are not drawn yet (uint8 only)`);
    if (scale.encoding !== "raw" && scale.encoding !== "jpeg") throw new Error(`the ${scale.encoding} encoding is not read yet (raw and jpeg only)`);
  }

  /** Chunk (x, y, z) of the grid, or undefined where the image has none. */
  async readChunk(position: [number, number, number], signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const { chunk, scale } = this;
    const offset = scale.voxel_offset ?? [0, 0, 0];
    const lo = [0, 1, 2].map((k) => position[k] * chunk[k]);
    const extent = [0, 1, 2].map((k) => Math.min(chunk[k], scale.size[k] - lo[k]));
    let bytes: Uint8Array | undefined;
    if (scale.sharding === undefined) {
      const name = [0, 1, 2].map((k) => `${offset[k] + lo[k]}-${offset[k] + lo[k] + extent[k]}`).join("_");
      bytes = await this.read(`${this.url}${scale.key}/${name}`, undefined, signal);
    } else {
      bytes = await this.readSharded(chunkId(position, this.grid), signal);
    }
    if (bytes === undefined) return undefined;
    const voxels = extent[0] * extent[1] * extent[2];
    let data: Uint8Array;
    if (scale.encoding === "jpeg") {
      const decoder = new JpegDecoder();
      decoder.parse(bytes);
      if (decoder.width * decoder.height !== voxels) throw new Error(`a JPEG chunk of ${decoder.width} × ${decoder.height}, for ${extent.join(" × ")} voxels`);
      data = decoder.getData(decoder.width, decoder.height, false) as Uint8Array;
      if (decoder.numComponents !== 1) data = data.filter((_, i) => i % decoder.numComponents === 0);
    } else {
      data = bytes;
      if (data.byteLength < voxels) throw new Error(`a raw chunk of ${data.byteLength} bytes, for ${voxels} voxels`);
    }
    if (extent[0] === chunk[0] && extent[1] === chunk[1] && extent[2] === chunk[2]) return data.subarray(0, voxels);
    // An edge chunk: pad to the full shape.
    const out = new Uint8Array(chunk[0] * chunk[1] * chunk[2]);
    for (let z = 0; z < extent[2]; ++z) {
      for (let y = 0; y < extent[1]; ++y) {
        const from = (z * extent[1] + y) * extent[0];
        out.set(data.subarray(from, from + extent[0]), (z * chunk[1] + y) * chunk[0]);
      }
    }
    return out;
  }

  private async readSharded(id: bigint, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const sharding = this.scale.sharding!;
    const { shard, minishard } = shardOf(sharding, id);
    const file = `${this.url}${this.scale.key}/${shard}`;
    const key = `${shard}#${minishard}`;
    let index = this.minishards.get(key);
    if (index === undefined) {
      index = this.readMinishard(file, minishard, signal);
      index.catch(() => this.minishards.delete(key));
      this.minishards.set(key, index);
    }
    const entries = await index;
    if (entries === undefined) return undefined;
    const i = entries.ids.indexOf(id);
    if (i === -1) return undefined;
    const bytes = await this.read(file, { offset: entries.starts[i], length: entries.ends[i] - entries.starts[i] }, signal);
    if (bytes === undefined) return undefined;
    return sharding.data_encoding === "gzip" ? gunzip(bytes) : bytes;
  }

  private async readMinishard(file: string, minishard: number, signal?: AbortSignal) {
    const sharding = this.scale.sharding!;
    const shardIndexSize = 16 * 2 ** sharding.minishard_bits;
    const at = await this.read(file, { offset: 16 * minishard, length: 16 }, signal);
    if (at === undefined) return undefined;
    const view = new DataView(at.buffer, at.byteOffset, 16);
    const start = Number(view.getBigUint64(0, true));
    const end = Number(view.getBigUint64(8, true));
    if (start === end) return undefined;
    let bytes = await this.read(file, { offset: shardIndexSize + start, length: end - start }, signal);
    if (bytes === undefined) return undefined;
    if (sharding.minishard_index_encoding === "gzip") bytes = await gunzip(bytes);
    return decodeMinishardIndex(bytes, shardIndexSize);
  }
}

export async function readInfo(url: string, read: RangeRead = httpRead, signal?: AbortSignal): Promise<Info> {
  const bytes = await read(`${url}info`, undefined, signal);
  if (bytes === undefined) throw new Error(`${url}: no info file`);
  const info = JSON.parse(new TextDecoder().decode(bytes)) as Info;
  if (info.type !== "image") throw new Error(`${url}: a precomputed ${info.type}, not an image`);
  if (info.num_channels !== 1) throw new Error(`${url}: ${info.num_channels} channels (one only)`);
  return info;
}
