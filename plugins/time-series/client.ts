/** The main thread's side of the time series worker: requests as promises, with progress and cancel. */
import type { ReadPlan, SeriesInfo } from "./reader.js";

export type { ReadPlan, SeriesInfo };

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  progress?: (done: number, total: number) => void;
}

export class SeriesClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "time series" });
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      if (msg.type === "progress") {
        p.progress?.(msg.done, msg.total);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
  }

  private request<T>(message: object, options: { progress?: Pending["progress"]; signal?: AbortSignal; transfer?: Transferable[] } = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress: options.progress });
      options.signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      });
      this.worker.postMessage({ ...message, id }, { transfer: options.transfer ?? [] });
    });
  }

  async open(url: string): Promise<SeriesInfo> {
    return (await this.request<{ info: SeriesInfo }>({ type: "open", url })).info;
  }

  /**
   * The mean time course of some voxels (each one's index along every axis,
   * in turn); `plan` reads a coarser level or fewer time points.
   */
  async mean(url: string, voxels: Int32Array, options: { progress?: Pending["progress"]; signal?: AbortSignal; plan?: ReadPlan } = {}): Promise<Float32Array> {
    const { plan, ...rest } = options;
    return (await this.request<{ values: Float32Array }>({ type: "mean", url, voxels, plan }, { ...rest, transfer: [voxels.buffer] })).values;
  }

  /** The finest level's mean time course when the worker has every chunk it needs; else undefined. */
  async meanIfCached(url: string, voxels: Int32Array, signal?: AbortSignal): Promise<Float32Array | undefined> {
    return (await this.request<{ values: Float32Array | null }>({ type: "cached", url, voxels }, { signal, transfer: [voxels.buffer] })).values ?? undefined;
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
