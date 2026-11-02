/**
 * Reading an OME-Zarr pyramid for the volume view:
 *
 * - a whole coarse level, for the solid brain (x fastest, as a 3-D texture
 *   wants it);
 * - sections: a level resampled onto a plane along one RAS axis, filled
 *   chunk by chunk as chunks arrive (each texel nearest its voxel), so
 *   memory stays at a few chunks however large the level, and partial
 *   images can be shown while the rest loads.
 *
 * Chunks are kept in a byte-bounded cache, so moving a section a little, or
 * drawing another through the same chunks, reads nothing again.  The volume
 * worker runs this; it is plain code, so it is tested without one.
 */
import { httpAccess, openZarrArray, ShardIndexCache, ZarrArrayReader } from "neuroglancer-zarr-vectors/reader";
import { invert, mergeLevels, parseOmeLevels, type VolumeLevel } from "./ome.js";
import { PrecomputedScale, readInfo, scaleLevel } from "./precomputed.js";
import { PRECOMPUTED } from "./sources.js";

export interface LevelInfo extends VolumeLevel {
  /** The array's shape and read-chunk shape, in its axis order. */
  shape: number[];
  chunk: number[];
  /** Voxels along x, y and z. */
  size: [number, number, number];
}

interface OpenLevel {
  info: LevelInfo;
  /** A read chunk, decoded, in the array's order and of the full chunk shape. */
  readChunk(index: number[]): Promise<Uint8Array | undefined>;
  /** The value where there is no chunk. */
  fill: number;
  /** For x, y, z: the array dimension it is. */
  dimOf: [number, number, number];
  grid: number[];
}

/** A voxel box of a level, x, y, z, from `lo` up to (not including) `hi`. */
export interface Region {
  lo: [number, number, number];
  hi: [number, number, number];
}

export type Progress = (done: number, total: number) => void;

const CONCURRENCY = 8;

/** Runs `work` on items, a few at a time, until done or `signal` aborts. */
async function each<T>(items: T[], signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length && !signal.aborted) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  signal.throwIfAborted();
}

async function readJson(url: string, signal?: AbortSignal): Promise<any | undefined> {
  const response = await fetch(url, { signal });
  if (response.status === 404 || response.status === 403) return undefined;
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

export class VolumeReader {
  private levels: OpenLevel[] = [];
  private cache = new Map<string, Promise<Uint8Array | undefined>>();
  private sizes = new Map<string, number>();
  private cached = 0;

  /** `cacheBytes`: decoded chunks kept, a few hundred megabytes at most. */
  constructor(private readonly cacheBytes = 256 * 1024 * 1024) {}

  private remember(key: string, bytes: number): void {
    this.sizes.set(key, bytes);
    this.cached += bytes;
    for (const [old] of this.cache) {
      if (this.cached <= this.cacheBytes) break;
      if (old === key) continue;
      this.cached -= this.sizes.get(old) ?? 0;
      this.sizes.delete(old);
      this.cache.delete(old);
    }
  }

  /** A read chunk of a level (in the array's order), decoded; shared and cached. */
  private chunk(level: OpenLevel, index: number[]): Promise<Uint8Array | undefined> {
    const key = `${level.info.url}${level.info.path}|${index.join(".")}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    // Shared by every request that wants it, so no one request cancels it.
    const pending = level.readChunk(index).then((data) => {
      this.remember(key, data?.byteLength ?? 0);
      return data;
    });
    pending.catch(() => this.cache.delete(key));
    this.cache.set(key, pending);
    return pending;
  }

  /** Opens the stores' levels (finest first), placed in `space` where they name it. */
  async open(stores: string[], space: string | undefined, signal?: AbortSignal): Promise<{ levels: LevelInfo[]; name: string; description?: string }> {
    if (stores.length === 1 && stores[0].startsWith(PRECOMPUTED)) return this.openPrecomputed(stores[0].slice(PRECOMPUTED.length), signal);
    const pyramids = await Promise.all(
      stores.map(async (store) => {
        const url = store.endsWith("/") ? store : `${store}/`;
        const group = (await readJson(`${url}zarr.json`, signal)) ?? (await readJson(`${url}.zattrs`, signal));
        if (group === undefined) throw new Error(`${url}: no zarr.json`);
        return parseOmeLevels(url, group, space);
      }),
    );
    const merged = mergeLevels(pyramids);
    // One access (and shard-index cache, keyed by path in the store) per store.
    const accesses = new Map<string, { access: ReturnType<typeof httpAccess>; shardIndexes: ShardIndexCache }>();
    this.levels = await Promise.all(
      merged.map(async (level): Promise<OpenLevel> => {
        let store = accesses.get(level.url);
        if (store === undefined) accesses.set(level.url, (store = { access: httpAccess(level.url), shardIndexes: new ShardIndexCache() }));
        const { access, shardIndexes } = store;
        const array = await openZarrArray(access.read, level.path, signal);
        if (array === undefined) throw new Error(`${level.url}${level.path}: no array`);
        if (array.elementType !== "uint8") throw new Error(`${level.url}${level.path}: ${array.elementType} images are not shown yet (uint8 only)`);
        const dimOf = [0, 1, 2].map((k) => level.axes.indexOf("xyz"[k])) as [number, number, number];
        const chunkShape = array.readChunkShape;
        const info: LevelInfo = {
          ...level,
          shape: array.shape,
          chunk: chunkShape,
          size: [array.shape[dimOf[0]], array.shape[dimOf[1]], array.shape[dimOf[2]]],
        };
        const reader = new ZarrArrayReader(array, access.read, shardIndexes);
        const fill = Number(array.fillValue ?? 0);
        return {
          info,
          readChunk: (index) => reader.readChunk(index),
          fill: Number.isFinite(fill) ? fill : 0,
          dimOf,
          grid: array.shape.map((s, d) => Math.ceil(s / chunkShape[d])),
        };
      }),
    );
    this.reset();
    return { levels: this.levels.map((l) => l.info), name: pyramids[0]?.name ?? "", description: pyramids.find((p) => p.description)?.description };
  }

  /** A Neuroglancer precomputed image: its scales, finest first, as arrays in z, y, x order. */
  private async openPrecomputed(url: string, signal?: AbortSignal): Promise<{ levels: LevelInfo[]; name: string }> {
    const info = await readInfo(url, undefined, signal);
    this.levels = info.scales
      .map((scale): OpenLevel => {
        const reader = new PrecomputedScale(url, scale, info.data_type);
        const [cx, cy, cz] = reader.chunk;
        const [sx, sy, sz] = scale.size;
        return {
          info: { ...scaleLevel(url, scale), shape: [sz, sy, sx], chunk: [cz, cy, cx], size: [sx, sy, sz] },
          readChunk: ([z, y, x]) => reader.readChunk([x, y, z]),
          fill: 0,
          dimOf: [2, 1, 0],
          grid: [reader.grid[2], reader.grid[1], reader.grid[0]],
        };
      })
      .sort((a, b) => a.info.voxelSize - b.info.voxelSize);
    this.reset();
    return { levels: this.levels.map((l) => l.info), name: url.replace(/\/$/, "").split("/").pop() ?? "" };
  }

  private reset(): void {
    this.cache.clear();
    this.sizes.clear();
    this.cached = 0;
  }

  /** A level, or the `region` of it, x fastest. */
  async volume(index: number, signal: AbortSignal, progress?: Progress, region?: Region): Promise<{ data: Uint8Array; size: [number, number, number] }> {
    const level = this.levels[index];
    const { chunk: cs, shape } = level.info;
    const { dimOf } = level;
    const lo = region?.lo ?? [0, 0, 0];
    const hi = region?.hi ?? level.info.size;
    const size = [0, 1, 2].map((k) => Math.max(0, hi[k] - lo[k])) as [number, number, number];
    const out = new Uint8Array(size[0] * size[1] * size[2]).fill(level.fill);
    // The box and the output's strides, per array dimension.
    const aLo = [0, 0, 0];
    const aHi = [0, 0, 0];
    const stride = [0, 0, 0];
    const outStride = [1, size[0], size[0] * size[1]];
    for (let k = 0; k < 3; ++k) {
      aLo[dimOf[k]] = Math.max(0, lo[k]);
      aHi[dimOf[k]] = Math.min(shape[dimOf[k]], hi[k]);
      stride[dimOf[k]] = outStride[k];
    }
    const outLo = [0, 0, 0];
    for (let k = 0; k < 3; ++k) outLo[dimOf[k]] = lo[k];
    const first = [0, 1, 2].map((d) => Math.floor(aLo[d] / cs[d]));
    const last = [0, 1, 2].map((d) => Math.ceil(aHi[d] / cs[d]) - 1);
    const indices: number[][] = [];
    for (let a = first[0]; a <= last[0]; ++a) for (let b = first[1]; b <= last[1]; ++b) for (let c = first[2]; c <= last[2]; ++c) indices.push([a, b, c]);
    let done = 0;
    await each(indices, signal, async (ci) => {
      const data = await this.chunk(level, ci);
      if (data !== undefined) {
        const origin = [0, 1, 2].map((d) => ci[d] * cs[d]);
        const from = [0, 1, 2].map((d) => Math.max(origin[d], aLo[d]));
        const to = [0, 1, 2].map((d) => Math.min(origin[d] + cs[d], aHi[d]));
        const run = to[2] - from[2];
        for (let i = from[0]; i < to[0]; ++i) {
          for (let j = from[1]; j < to[1]; ++j) {
            let src = ((i - origin[0]) * cs[1] + (j - origin[1])) * cs[2] + (from[2] - origin[2]);
            let dst = (i - outLo[0]) * stride[0] + (j - outLo[1]) * stride[1] + (from[2] - outLo[2]) * stride[2];
            if (stride[2] === 1) {
              out.set(data.subarray(src, src + run), dst);
            } else {
              for (let k = 0; k < run; ++k, ++src, dst += stride[2]) out[dst] = data[src];
            }
          }
        }
      }
      progress?.(++done, indices.length);
    });
    return { data: out, size };
  }

  /**
   * A section: the plane `axis` (0 = R, 1 = A, 2 = S) = `value` mm, over
   * `rect` = [u0, u1, v0, v1] mm along the other two axes in order, with
   * texels of about `texel` mm (at most 4096 a side), from a level.
   * `partial` gets copies of the image while it fills.
   */
  async plane(
    index: number,
    request: { axis: number; value: number; rect: number[]; texel: number },
    signal: AbortSignal,
    progress?: Progress,
    partial?: (image: { data: Uint8Array; width: number; height: number }) => void,
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const level = this.levels[index];
    const { dimOf, grid } = level;
    const { chunk: cs, shape } = level.info;
    const { axis, value, rect, texel } = request;
    const [uAxis, vAxis] = [0, 1, 2].filter((k) => k !== axis);
    const width = Math.max(1, Math.min(4096, Math.round((rect[1] - rect[0]) / texel)));
    const height = Math.max(1, Math.min(4096, Math.round((rect[3] - rect[2]) / texel)));
    const du = (rect[1] - rect[0]) / width;
    const dv = (rect[3] - rect[2]) / height;
    const toVoxel = invert(level.info.voxelToRas);
    const voxelAt = (u: number, v: number) => {
      const p = [0, 0, 0];
      p[axis] = value;
      p[uAxis] = u;
      p[vAxis] = v;
      return [0, 1, 2].map((r) => toVoxel[4 * r] * p[0] + toVoxel[4 * r + 1] * p[1] + toVoxel[4 * r + 2] * p[2] + toVoxel[4 * r + 3]);
    };
    // Texel (a, b)'s voxel: origin + a * stepU + b * stepV.
    const origin = voxelAt(rect[0] + du / 2, rect[2] + dv / 2);
    const atU = voxelAt(rect[0] + du / 2 + du, rect[2] + dv / 2);
    const atV = voxelAt(rect[0] + du / 2, rect[2] + dv / 2 + dv);
    const stepU = [0, 1, 2].map((k) => atU[k] - origin[k]);
    const stepV = [0, 1, 2].map((k) => atV[k] - origin[k]);
    const out = new Uint8Array(width * height).fill(level.fill);

    // Each texel's chunk (flat index in the grid, -1 outside) and its offset there.
    const chunkOf = new Int32Array(width * height).fill(-1);
    const offsetOf = new Uint32Array(width * height);
    const counts = new Map<number, number>();
    const stride = [cs[1] * cs[2], cs[2], 1];
    const e = [0, 0, 0];
    for (let b = 0; b < height; ++b) {
      for (let a = 0; a < width; ++a) {
        let inside = true;
        for (let k = 0; k < 3; ++k) {
          const x = Math.round(origin[k] + a * stepU[k] + b * stepV[k]);
          const d = dimOf[k];
          if (x < 0 || x >= shape[d]) {
            inside = false;
            break;
          }
          e[d] = x;
        }
        if (!inside) continue;
        const c0 = Math.floor(e[0] / cs[0]);
        const c1 = Math.floor(e[1] / cs[1]);
        const c2 = Math.floor(e[2] / cs[2]);
        const flat = (c0 * grid[1] + c1) * grid[2] + c2;
        const t = b * width + a;
        chunkOf[t] = flat;
        offsetOf[t] = (e[0] - c0 * cs[0]) * stride[0] + (e[1] - c1 * cs[1]) * stride[1] + (e[2] - c2 * cs[2]) * stride[2];
        counts.set(flat, (counts.get(flat) ?? 0) + 1);
      }
    }
    // Each chunk's texels, grouped.
    const lists = new Map<number, Uint32Array>();
    const filled = new Map<number, number>();
    for (const [flat, n] of counts) lists.set(flat, new Uint32Array(n));
    for (let t = 0; t < chunkOf.length; ++t) {
      const flat = chunkOf[t];
      if (flat < 0) continue;
      const at = filled.get(flat) ?? 0;
      lists.get(flat)![at] = t;
      filled.set(flat, at + 1);
    }
    // Nearest the plane's middle first.
    const coords = (flat: number) => [Math.floor(flat / (grid[1] * grid[2])), Math.floor(flat / grid[2]) % grid[1], flat % grid[2]];
    const order = [...lists.keys()];
    const middle = chunkOf[(height >> 1) * width + (width >> 1)];
    if (middle >= 0) {
      const m = coords(middle);
      const distance = (flat: number) => coords(flat).reduce((s, v, k) => s + (v - m[k]) ** 2, 0);
      order.sort((x, y) => distance(x) - distance(y));
    }
    let done = 0;
    let lastPartial = performance.now();
    await each(order, signal, async (flat) => {
      const data = await this.chunk(level, coords(flat));
      if (signal.aborted) return;
      if (data !== undefined) for (const t of lists.get(flat)!) out[t] = data[offsetOf[t]];
      progress?.(++done, order.length);
      if (partial !== undefined && done < order.length && performance.now() - lastPartial > 400) {
        lastPartial = performance.now();
        partial({ data: out.slice(), width, height });
      }
    });
    return { data: out, width, height };
  }
}
