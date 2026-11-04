/**
 * The main thread's side of the annotations worker: an image layer's
 * levels, values at points, blocks on another grid, statistics in a region;
 * as promises, with progress and cancelling.  Also finding the store an
 * image layer reads.
 */
import type { Json, PlatformContext } from "@ngplatform/sdk";
import { layerSourceUrl } from "@ngplatform/sdk/sources";
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
import { storeOf } from "../volume-view/sources.js";
import type { Mat4 } from "./geometry.js";
import type { Region, Summary } from "./statistics.js";

export interface ImageLevel {
  size: [number, number, number];
  voxelToRas: Mat4;
  /** About how many mm a voxel is. */
  voxelSize: number;
  type: string;
}

/** The store an image (or segmentation) layer reads, as the volume reader opens it; undefined for formats it does not read. */
export function layerStore(ctx: PlatformContext, layer: string): string | undefined {
  return storeOf(layerSourceUrl(ctx.viewer.layerSpec(layer)));
}

/** Image layers in the scene whose voxels can be read. */
export function readableImages(ctx: PlatformContext, types = ["image"]): string[] {
  return ctx.viewer
    .layers()
    .filter((l) => types.includes(l.type) && layerStore(ctx, l.name) !== undefined)
    .map((l) => l.name);
}

export class Voxels {
  private readonly levelsCache = new Map<string, Promise<ImageLevel[]>>();
  // A worker that fails to start or dies (out of memory, say) answers nothing: every request fails, and the next starts a new one.
  private readonly rpc = new WorkerRpc(() => new Worker(new URL("./voxel_worker.ts", import.meta.url), { type: "module", name: "annotations" }), {
    stopped: (why) => `The reader stopped (${why}): try a smaller region or a coarser level.`,
    restart: true,
    onStopped: () => this.levelsCache.clear(),
  });

  private request<T>(message: object, options: { progress?: (done: number, total: number) => void; signal?: AbortSignal; transfer?: Transferable[] } = {}): Promise<T> {
    const { progress, ...rest } = options;
    return this.rpc.request<T>(message, { ...rest, progress: progress && ((msg) => progress(msg.done, msg.total)) });
  }

  /** An image's levels, finest first (asked once per store). */
  levels(store: string): Promise<ImageLevel[]> {
    let p = this.levelsCache.get(store);
    if (p === undefined) {
      p = this.request<{ levels: { size: [number, number, number]; voxelToRas: number[]; voxelSize: number; type: string }[] }>({ type: "open", store }).then((r) =>
        r.levels.map((l) => ({ ...l, voxelToRas: Float64Array.from(l.voxelToRas) })),
      );
      this.levelsCache.set(store, p);
      p.catch(() => this.levelsCache.delete(store));
    }
    return p;
  }

  async points(store: string, level: number, points: Float64Array, method: "nearest" | "linear", signal?: AbortSignal): Promise<Float64Array> {
    return (await this.request<{ values: Float64Array }>({ type: "points", store, level, points, method }, { signal, transfer: [points.buffer] })).values;
  }

  /** The image's values on another grid's block (nearest), `affine` taking that grid's voxels to the image level's. */
  async block(store: string, level: number, lo: number[], size: number[], affine?: Mat4, signal?: AbortSignal): Promise<Float32Array> {
    return (await this.request<{ data: Float32Array }>({ type: "block", store, level, lo, size, affine: affine && Array.from(affine) }, { signal })).data;
  }

  /**
   * A label image's values on another grid's block, as `block`, read exactly
   * (64-bit floats: labels above 2^24, which 32-bit floats would round; 64-bit
   * labels narrowed to 32 bits, an error past them).
   */
  async labels(store: string, level: number, lo: number[], size: number[], affine?: Mat4, signal?: AbortSignal): Promise<Float64Array> {
    return (await this.request<{ data: Float64Array }>({ type: "block", store, level, lo, size, affine: affine && Array.from(affine), exact: true }, { signal })).data;
  }

  async stats(store: string, level: number, box: { lo: number[]; hi: number[] }, region: Region, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Summary> {
    return (await this.request<{ summary: Summary }>({ type: "stats", store, level, lo: box.lo, hi: box.hi, region }, { progress, signal })).summary;
  }

  dispose(): void {
    this.rpc.dispose();
  }
}
