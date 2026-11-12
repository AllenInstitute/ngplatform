/**
 * Neuroglancer precomputed volumes, for plugins that read them in their own
 * workers: the `info` file's scales, and their chunks (sharded or not) read
 * and decoded, x fastest, padded to the full chunk shape.  Images: any
 * integer or float type raw, uint8 as JPEG too, and uint32 or uint64 as
 * compressed_segmentation.  Segmentations: uint32 or uint64, raw or
 * compressed_segmentation, as 64-bit ids.
 *
 * Sharding is `neuroglancer_uint64_sharded_v1`, as Neuroglancer reads it
 * (src/datasource/precomputed/sharded.ts): a chunk's compressed Morton code,
 * hashed, picks a shard file and a minishard in it, whose index lists where
 * the chunk is.
 */
import { decodeChannels } from "neuroglancer/unstable/sliceview/compressed_segmentation/decode_uint64.js";
import { JpegDecoder } from "neuroglancer/unstable/third_party/jpgjs/jpg.js";
import { murmurHash3_x86_128Hash64Bits_Bigint } from "neuroglancer/unstable/util/hash.js";
import { gcsReadable } from "./sources.js";

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
  compressed_segmentation_block_size?: [number, number, number];
  sharding?: Sharding;
}

export interface Info {
  type: string;
  data_type: string;
  num_channels: number;
  scales: Scale[];
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

/** Gzipped bytes, inflated. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads part of a file over http(s); undefined when it is missing. */
export type RangeRead = (url: string, range?: { offset: number; length: number }, signal?: AbortSignal) => Promise<Uint8Array | undefined>;

export const httpRead: RangeRead = async (url, range, signal) => {
  const headers: Record<string, string> = {};
  if (range !== undefined) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  // Ranges skip the browser's HTTP cache: Chromium answers cached range reads of one URL (a shard) one at a time.
  const response = await fetch(gcsReadable(url), range === undefined ? { headers, signal } : { headers, signal, cache: "no-store" });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A server that ignores Range sends the whole file.
  if (range !== undefined && response.status === 200 && bytes.byteLength > range.length) return bytes.subarray(range.offset, range.offset + range.length);
  return bytes;
};

/** A JSON file over http(s); undefined when it is missing (404, or 403 as buckets answer). */
export async function httpJson(url: string, signal?: AbortSignal): Promise<any | undefined> {
  const response = await fetch(gcsReadable(url), { signal });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/** One scale of a precomputed volume, its chunks read as x-fastest blocks of the full chunk shape. */
export class PrecomputedScale {
  readonly chunk: [number, number, number];
  readonly grid: [number, number, number];
  constructor(
    readonly url: string,
    readonly scale: Scale,
    readonly dataType: string,
    private readonly read: RangeRead = httpRead,
  ) {
    this.chunk = scale.chunk_sizes[0];
    this.grid = [0, 1, 2].map((k) => Math.ceil(scale.size[k] / this.chunk[k])) as [number, number, number];
  }

  /** Chunk (x, y, z) of a uint8 image, or undefined where it has none. */
  async readChunk(position: [number, number, number], signal?: AbortSignal): Promise<Uint8Array | undefined> {
    if (this.dataType !== "uint8") throw new Error(`a ${this.dataType} image: its chunks are read with readValues`);
    return this.readValues(position, signal);
  }

  /**
   * Chunk (x, y, z) of an image, as its values' little-endian bytes (the
   * scale's data type, padded to the full chunk shape), or undefined where
   * it has none.
   */
  async readValues(position: [number, number, number], signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const { chunk, scale, dataType } = this;
    const width = ELEMENT_BYTES[dataType];
    if (width === undefined) throw new Error(`${dataType} values are not read (${Object.keys(ELEMENT_BYTES).join(", ")} only)`);
    const encoding = scale.encoding;
    if (encoding === "jpeg" && dataType !== "uint8") throw new Error(`a JPEG chunk of ${dataType} values (JPEG holds uint8 only)`);
    if (encoding === "compressed_segmentation" && dataType !== "uint32" && dataType !== "uint64") throw new Error(`compressed_segmentation of ${dataType} values (uint32 and uint64 only)`);
    if (encoding !== "raw" && encoding !== "jpeg" && encoding !== "compressed_segmentation") throw new Error(`the ${encoding} encoding is not read yet (raw, jpeg and compressed_segmentation only)`);
    const extent = this.extent(position);
    const bytes = await this.readBytes(position, signal);
    if (bytes === undefined) return undefined;
    const voxels = extent[0] * extent[1] * extent[2];
    let data: Uint8Array;
    if (encoding === "jpeg") {
      const decoder = new JpegDecoder();
      decoder.parse(bytes);
      if (decoder.width * decoder.height !== voxels) throw new Error(`a JPEG chunk of ${decoder.width} × ${decoder.height}, for ${extent.join(" × ")} voxels`);
      data = decoder.getData(decoder.width, decoder.height, false) as Uint8Array;
      if (decoder.numComponents !== 1) data = data.filter((_, i) => i % decoder.numComponents === 0);
    } else if (encoding === "compressed_segmentation") {
      const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~3)));
      const out = dataType === "uint64" ? new BigUint64Array(voxels) : new Uint32Array(voxels);
      decodeChannels(out as never, words, 0, [...extent, 1], scale.compressed_segmentation_block_size ?? [8, 8, 8]);
      data = new Uint8Array(out.buffer);
    } else {
      data = bytes;
      if (data.byteLength < voxels * width) throw new Error(`a raw chunk of ${data.byteLength} bytes, for ${voxels} ${dataType} voxels`);
    }
    return padBytes(data.subarray(0, voxels * width), extent, chunk, width);
  }

  /** Chunk (x, y, z) of a segmentation, as 64-bit ids, or undefined where it has none. */
  async readLabels(position: [number, number, number], signal?: AbortSignal): Promise<BigUint64Array | undefined> {
    const { chunk, scale } = this;
    const bytes = await this.readBytes(position, signal);
    if (bytes === undefined) return undefined;
    const extent = this.extent(position);
    const voxels = extent[0] * extent[1] * extent[2];
    let data: BigUint64Array;
    if (scale.encoding === "compressed_segmentation") {
      const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~3)));
      data = new BigUint64Array(voxels);
      if (this.dataType === "uint64") {
        decodeChannels(data, words, 0, [...extent, 1], scale.compressed_segmentation_block_size ?? [8, 8, 8]);
      } else {
        const narrow = decodeChannels(new Uint32Array(voxels), words, 0, [...extent, 1], scale.compressed_segmentation_block_size ?? [8, 8, 8]);
        for (let i = 0; i < voxels; ++i) data[i] = BigInt(narrow[i]);
      }
    } else if (scale.encoding === "raw") {
      const copy = bytes.slice(0, voxels * (this.dataType === "uint64" ? 8 : 4));
      if (this.dataType === "uint64") data = new BigUint64Array(copy.buffer);
      else if (this.dataType === "uint32") data = BigUint64Array.from(new Uint32Array(copy.buffer), (v) => BigInt(v));
      else throw new Error(`${this.dataType} is not a segmentation type`);
    } else {
      throw new Error(`the ${scale.encoding} encoding is not read for segmentations (raw and compressed_segmentation only)`);
    }
    return pad(data, extent, chunk, new BigUint64Array(chunk[0] * chunk[1] * chunk[2]));
  }

  /** The voxels of chunk (x, y, z) inside the volume. */
  extent(position: [number, number, number]): [number, number, number] {
    return [0, 1, 2].map((k) => Math.min(this.chunk[k], this.scale.size[k] - position[k] * this.chunk[k])) as [number, number, number];
  }

  /** A chunk's stored bytes, gzip and sharding undone; undefined when it has none. */
  private async readBytes(position: [number, number, number], signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const { chunk, scale } = this;
    if (scale.sharding !== undefined) return this.readSharded(chunkId(position, this.grid), signal);
    const offset = scale.voxel_offset ?? [0, 0, 0];
    const lo = [0, 1, 2].map((k) => position[k] * chunk[k]);
    const extent = this.extent(position);
    const name = [0, 1, 2].map((k) => `${offset[k] + lo[k]}-${offset[k] + lo[k] + extent[k]}`).join("_");
    return this.read(`${this.url}${scale.key}/${name}`, undefined, signal);
  }

  private sharded: ShardedReader | undefined;

  private readSharded(id: bigint, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    this.sharded ??= new ShardedReader(`${this.url}${this.scale.key}/`, this.scale.sharding!, this.read);
    return this.sharded.read(id, signal);
  }
}

/** Chunks of a `neuroglancer_uint64_sharded_v1` folder, by id, minishard indexes read once each. */
export class ShardedReader {
  private readonly minishards = new Map<string, Promise<{ ids: bigint[]; starts: number[]; ends: number[] } | undefined>>();

  /** `folder`: the URL of the folder of shard files, ending in "/". */
  constructor(
    private readonly folder: string,
    private readonly sharding: Sharding,
    private readonly fetchRange: RangeRead = httpRead,
  ) {}

  async read(id: bigint, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const { shard, minishard } = shardOf(this.sharding, id);
    const file = `${this.folder}${shard}`;
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
    const bytes = await this.fetchRange(file, { offset: entries.starts[i], length: entries.ends[i] - entries.starts[i] }, signal);
    if (bytes === undefined) return undefined;
    return this.sharding.data_encoding === "gzip" ? gunzip(bytes) : bytes;
  }

  private async readMinishard(file: string, minishard: number, signal?: AbortSignal) {
    const shardIndexSize = 16 * 2 ** this.sharding.minishard_bits;
    const at = await this.fetchRange(file, { offset: 16 * minishard, length: 16 }, signal);
    if (at === undefined) return undefined;
    const view = new DataView(at.buffer, at.byteOffset, 16);
    const start = Number(view.getBigUint64(0, true));
    const end = Number(view.getBigUint64(8, true));
    if (start === end) return undefined;
    let bytes = await this.fetchRange(file, { offset: shardIndexSize + start, length: end - start }, signal);
    if (bytes === undefined) return undefined;
    if (this.sharding.minishard_index_encoding === "gzip") bytes = await gunzip(bytes);
    return decodeMinishardIndex(bytes, shardIndexSize);
  }
}

/** A precomputed volume's `info`, with one channel; `type`, when given, is the kind wanted ("image", "segmentation"). */
export async function readInfo(url: string, read: RangeRead = httpRead, signal?: AbortSignal, type?: string): Promise<Info> {
  const bytes = await read(`${url}info`, undefined, signal);
  if (bytes === undefined) throw new Error(`${url}: no info file`);
  const info = JSON.parse(new TextDecoder().decode(bytes)) as Info;
  const kind = (info as unknown as { "@type"?: string })["@type"];
  if (kind === "neuroglancer_skeletons") throw new Error(`${url}: precomputed skeletons, which have no spatial index to read a region from; use the segmentation volume of the same segments`);
  if (kind === "neuroglancer_multilod_draco" || kind === "neuroglancer_legacy_mesh") throw new Error(`${url}: precomputed meshes, which have no spatial index to read a region from; use the segmentation volume of the same segments`);
  if (type !== undefined && info.type !== type) throw new Error(`${url}: a precomputed ${info.type ?? "source"}, not ${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`);
  if (info.num_channels !== 1) throw new Error(`${url}: ${info.num_channels} channels (one only)`);
  return info;
}

/** Bytes a voxel of each image data type read takes. */
export const ELEMENT_BYTES: Record<string, number> = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, uint64: 8, int64: 8, float32: 4, float64: 8 };

/** Copies a chunk's `extent` of `width`-byte voxels into the full `chunk` shape, x fastest. */
function padBytes(data: Uint8Array, extent: number[], chunk: number[], width: number): Uint8Array {
  if (extent[0] === chunk[0] && extent[1] === chunk[1] && extent[2] === chunk[2]) return data;
  const out = new Uint8Array(chunk[0] * chunk[1] * chunk[2] * width);
  const row = extent[0] * width;
  for (let z = 0; z < extent[2]; ++z) {
    for (let y = 0; y < extent[1]; ++y) {
      const from = (z * extent[1] + y) * row;
      out.set(data.subarray(from, from + row), (z * chunk[1] + y) * chunk[0] * width);
    }
  }
  return out;
}

/** Copies a chunk's `extent` of voxels into the full `chunk` shape, x fastest. */
function pad<T extends Uint8Array | BigUint64Array>(data: T, extent: number[], chunk: number[], out: T): T {
  if (extent[0] === chunk[0] && extent[1] === chunk[1] && extent[2] === chunk[2]) return data;
  for (let z = 0; z < extent[2]; ++z) {
    for (let y = 0; y < extent[1]; ++y) {
      const from = (z * extent[1] + y) * extent[0];
      out.set(data.subarray(from, from + extent[0]) as never, (z * chunk[1] + y) * chunk[0]);
    }
  }
  return out;
}
