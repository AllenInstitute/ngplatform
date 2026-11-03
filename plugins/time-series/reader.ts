/**
 * Reading time courses from an OME-Zarr image with a time axis (a 4-D NIfTI
 * read in place has `t` first; OME-Zarr stores name it with type "time"):
 * the finest level's values along t at some voxels, averaged over them.
 *
 * Voxels are given in the array's axis order as the metadata names it (the
 * order Neuroglancer shows the source in); chunks stored transposed are read
 * in their stored order.  Each chunk is decoded to float32 once and kept in a
 * byte-bounded cache shared by every image, so moving within a chunk, or
 * pinning a voxel beside one already read, reads nothing again.  The worker
 * runs this; it is plain code, tested without one.
 */
import { httpAccess, openZarrArray, ShardIndexCache, ZarrArrayReader } from "neuroglancer-zarr-vectors/reader";
import { withZarr2 } from "../orientations/zarr2.js";
import { storedOrder } from "../volume-view/volume_reader.js";

export interface SeriesInfo {
  url: string;
  /** The finest level's array path. */
  path: string;
  name: string;
  /** Axis names, in the metadata's order. */
  axes: string[];
  /** The array's shape, in the same order. */
  shape: number[];
  /** Which axis is time. */
  timeAxis: number;
  /** The time axis's unit as the store gives it ("second", "millisecond"…), if any. */
  timeUnit?: string;
  type: string;
}

export type Progress = (done: number, total: number) => void;

const NUMERIC = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
  uint64: BigUint64Array,
  int64: BigInt64Array,
} as const;

const CONCURRENCY = 8;

async function readJson(url: string, signal?: AbortSignal): Promise<any | undefined> {
  const response = await fetch(url, { signal });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/** A chunk's bytes (little-endian unless said) as float32. */
export function toFloat(bytes: Uint8Array, type: keyof typeof NUMERIC, bigEndian: boolean): Float32Array {
  const Type = NUMERIC[type];
  const size = Type.BYTES_PER_ELEMENT;
  const copy = bytes.slice(0, bytes.byteLength - (bytes.byteLength % size));
  if (bigEndian && size > 1) {
    for (let i = 0; i < copy.length; i += size) copy.subarray(i, i + size).reverse();
  }
  const typed = new Type(copy.buffer);
  if (typed instanceof Float32Array) return typed;
  const out = new Float32Array(typed.length);
  for (let i = 0; i < typed.length; ++i) out[i] = Number(typed[i]);
  return out;
}

/** The axes the first dataset is placed by (OME-Zarr 0.6's coordinate system, else 0.4/0.5's `axes`). */
function baseAxes(multiscale: any): { name: string; type?: string; unit?: string }[] {
  const systems: { name: string; axes: { name: string; type?: string; unit?: string }[] }[] = multiscale.coordinateSystems ?? [];
  const firstOutput = multiscale.datasets?.[0]?.coordinateTransformations?.[0]?.output;
  const outName = typeof firstOutput === "string" ? firstOutput : firstOutput?.name;
  return (systems.find((s) => s.name === outName) ?? systems[0])?.axes ?? multiscale.axes ?? [];
}

/** The time axis among an image's axes: of type "time", else named t; -1 when none. */
export function timeAxisOf(axes: { name: string; type?: string }[]): number {
  const typed = axes.findIndex((a) => a.type === "time");
  return typed !== -1 ? typed : axes.findIndex((a) => a.name === "t");
}

/** Decoded chunks, by key, up to a number of bytes; the least recently used go first. */
export class ChunkCache {
  private entries = new Map<string, Promise<Float32Array | undefined>>();
  private sizes = new Map<string, number>();
  private bytes = 0;

  constructor(private readonly limit = 256 * 1024 * 1024) {}

  get(key: string, load: () => Promise<Float32Array | undefined>): Promise<Float32Array | undefined> {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    // Shared by every request that wants it, so no one request cancels it.
    const pending = load().then((data) => {
      if (this.entries.get(key) === pending) this.remember(key, data?.byteLength ?? 0);
      return data;
    });
    pending.catch(() => this.entries.delete(key));
    this.entries.set(key, pending);
    return pending;
  }

  private remember(key: string, bytes: number): void {
    this.sizes.set(key, bytes);
    this.bytes += bytes;
    for (const [old] of this.entries) {
      if (this.bytes <= this.limit) break;
      if (old === key) continue;
      this.bytes -= this.sizes.get(old) ?? 0;
      this.sizes.delete(old);
      this.entries.delete(old);
    }
  }
}

export class SeriesReader {
  private reader: ZarrArrayReader | undefined;
  /** For each axis in the metadata's order, the array dimension (stored order) it is. */
  private dimOf: number[] = [];
  private chunk: number[] = [];
  private grid: number[] = [];
  private fill = 0;
  info: SeriesInfo | undefined;

  constructor(private readonly cache = new ChunkCache()) {}

  async open(url: string, signal?: AbortSignal): Promise<SeriesInfo> {
    const base = url.endsWith("/") ? url : `${url}/`;
    const group = (await readJson(`${base}zarr.json`, signal)) ?? (await readJson(`${base}.zattrs`, signal));
    if (group === undefined) throw new Error(`${base}: no zarr.json`);
    const attributes = group.attributes ?? group;
    const multiscale = (attributes.ome ?? attributes)?.multiscales?.[0];
    if (multiscale === undefined) throw new Error(`${base}: not an OME-Zarr image (no multiscales)`);
    const axes = baseAxes(multiscale);
    const timeAxis = timeAxisOf(axes);
    if (timeAxis === -1) throw new Error(`the image has no time axis (its axes are ${axes.map((a) => a.name).join(", ")})`);
    const path: string = multiscale.datasets?.[0]?.path;
    if (path === undefined) throw new Error(`${base}: the image has no datasets`);
    const names = axes.map((a) => a.name);
    // Zarr v2 arrays (OME-Zarr 0.4) read as v3; chunks stored transposed (a NIfTI read in place) in their stored order.
    const plain = withZarr2(httpAccess(base).read);
    const stored = await storedOrder(plain, path, names, signal);
    const read = stored?.read ?? plain;
    const storedAxes = stored?.axes ?? names;
    const array = await openZarrArray(read, path, signal);
    if (array === undefined) throw new Error(`${base}${path}: no array`);
    if (!(array.elementType in NUMERIC)) throw new Error(`${base}${path}: ${array.elementType} values are not read`);
    if (array.shape.length !== names.length) throw new Error(`${base}${path}: a ${array.shape.length}-D array for ${names.length} axes`);
    this.dimOf = names.map((n) => storedAxes.indexOf(n));
    this.chunk = array.readChunkShape;
    this.grid = array.shape.map((s, d) => Math.ceil(s / this.chunk[d]));
    const fill = Number(array.fillValue ?? 0);
    this.fill = Number.isFinite(fill) ? fill : 0;
    this.reader = new ZarrArrayReader(array, read, new ShardIndexCache());
    this.info = {
      url: base,
      path,
      name: String(multiscale.name ?? base),
      axes: names,
      shape: this.dimOf.map((d) => array.shape[d]),
      timeAxis,
      timeUnit: axes[timeAxis].unit,
      type: array.elementType,
    };
    return this.info;
  }

  private read(index: number[]): Promise<Float32Array | undefined> {
    const reader = this.reader!;
    const { array } = reader;
    return this.cache.get(`${this.info!.url}${this.info!.path}|${index.join(".")}`, async () => {
      const bytes = await reader.readChunk(index);
      return bytes === undefined ? undefined : toFloat(bytes, array.elementType as keyof typeof NUMERIC, array.bigEndian);
    });
  }

  /**
   * The mean over some voxels of their values at each time point (NaN
   * where none is inside the image).  `voxels` holds each voxel's index
   * along every axis, in the metadata's order, one after another (the time
   * axis's entry is ignored).
   */
  async mean(voxels: Int32Array, signal: AbortSignal, progress?: Progress): Promise<Float32Array> {
    const info = this.info;
    if (info === undefined || this.reader === undefined) throw new Error("no image is open");
    const { shape, timeAxis } = info;
    const rank = shape.length;
    const { dimOf, chunk, grid } = this;
    const td = dimOf[timeAxis];
    const nt = shape[timeAxis];
    const sum = new Float64Array(nt);
    const count = new Uint32Array(nt);
    // Strides within a chunk, in stored order.
    const strides = new Array<number>(rank);
    strides[rank - 1] = 1;
    for (let d = rank - 2; d >= 0; --d) strides[d] = strides[d + 1] * chunk[d + 1];
    // The voxels inside the image, by the chunk they fall in (time chunk 0).
    const byChunk = new Map<string, { index: number[]; offsets: number[] }>();
    const n = Math.floor(voxels.length / rank);
    for (let v = 0; v < n; ++v) {
      const index = new Array<number>(rank).fill(0);
      let offset = 0;
      let inside = true;
      for (let a = 0; a < rank; ++a) {
        if (a === timeAxis) continue;
        const i = voxels[v * rank + a];
        if (!(i >= 0 && i < shape[a])) inside = false;
        const d = dimOf[a];
        index[d] = Math.floor(i / chunk[d]);
        offset += (i - index[d] * chunk[d]) * strides[d];
      }
      if (!inside) continue;
      const key = index.join(".");
      let group = byChunk.get(key);
      if (group === undefined) byChunk.set(key, (group = { index, offsets: [] }));
      group.offsets.push(offset);
    }
    const work: { index: number[]; offsets: number[] }[] = [];
    for (let tc = 0; tc < grid[td]; ++tc) {
      for (const group of byChunk.values()) {
        const index = [...group.index];
        index[td] = tc;
        work.push({ index, offsets: group.offsets });
      }
    }
    let next = 0;
    let done = 0;
    const run = async () => {
      while (next < work.length && !signal.aborted) {
        const { index, offsets } = work[next++];
        const data = await this.read(index);
        if (signal.aborted) return;
        const t0 = index[td] * chunk[td];
        const t1 = Math.min(nt, t0 + chunk[td]);
        for (let t = t0; t < t1; ++t) {
          const at = (t - t0) * strides[td];
          for (const offset of offsets) {
            const x = data === undefined ? this.fill : data[at + offset];
            if (!Number.isFinite(x)) continue;
            sum[t] += x;
            count[t]++;
          }
        }
        progress?.(++done, work.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, run));
    signal.throwIfAborted();
    const out = new Float32Array(nt);
    for (let t = 0; t < nt; ++t) out[t] = count[t] > 0 ? sum[t] / count[t] : NaN;
    return out;
  }
}
