/**
 * The main thread's side of the annotations worker: an image layer's
 * levels, values at points, blocks on another grid, statistics in a region;
 * as promises, with progress and cancelling.  Also finding the store an
 * image layer reads.
 */
import type { Json, PlatformContext } from "@ngplatform/sdk";
import { layerSourceUrl } from "@ngplatform/sdk/sources";
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

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (done: number, total: number) => void };

export class Voxels {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly levelsCache = new Map<string, Promise<ImageLevel[]>>();

  private request<T>(message: object, options: { progress?: Pending["progress"]; signal?: AbortSignal; transfer?: Transferable[] } = {}): Promise<T> {
    if (this.worker === undefined) {
      this.worker = new Worker(new URL("./voxel_worker.ts", import.meta.url), { type: "module", name: "annotations" });
      this.worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;
        const p = this.pending.get(msg.id);
        if (p === undefined) return;
        if (msg.type === "progress") return p.progress?.(msg.done, msg.total);
        this.pending.delete(msg.id);
        if (msg.type === "error") p.reject(new Error(msg.message));
        else p.resolve(msg);
      };
      // A worker that fails to start or dies (out of memory, say) answers nothing: every request fails, and the next starts a new one.
      const failed = (why: string) => {
        this.worker?.terminate();
        this.worker = undefined;
        this.levelsCache.clear();
        for (const p of this.pending.values()) p.reject(new Error(why));
        this.pending.clear();
      };
      this.worker.onerror = (e) => {
        e.preventDefault();
        failed(`The reader stopped${e.message ? ` (${e.message})` : ""}: try a smaller region or a coarser level.`);
      };
      this.worker.onmessageerror = () => failed("The reader's answer could not be read.");
    }
    const id = this.nextId++;
    const worker = this.worker;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress: options.progress });
      options.signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      });
      worker.postMessage({ ...message, id }, options.transfer ?? []);
    });
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
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
