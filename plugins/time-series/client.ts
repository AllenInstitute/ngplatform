/** The main thread's side of the time series worker: requests as promises, with progress and cancel. */
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
import type { ReadPlan, SeriesInfo } from "./reader.js";

export type { ReadPlan, SeriesInfo };

export class SeriesClient {
  private readonly rpc = new WorkerRpc(() => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "time series" }), {
    stopped: (why) => `the time series reader stopped: ${why}. Reload the page to try again`,
  });

  private request<T>(message: object, options: { progress?: (done: number, total: number) => void; signal?: AbortSignal; transfer?: Transferable[] } = {}): Promise<T> {
    const { progress, ...rest } = options;
    return this.rpc.request<T>(message, { ...rest, progress: progress && ((msg) => progress(msg.done, msg.total)) });
  }

  async open(url: string): Promise<SeriesInfo> {
    return (await this.request<{ info: SeriesInfo }>({ type: "open", url })).info;
  }

  /**
   * The mean time course of some voxels (each one's index along every axis,
   * in turn); `plan` reads a coarser level or fewer time points.
   */
  async mean(url: string, voxels: Int32Array, options: { progress?: (done: number, total: number) => void; signal?: AbortSignal; plan?: ReadPlan } = {}): Promise<Float32Array> {
    const { plan, ...rest } = options;
    return (await this.request<{ values: Float32Array }>({ type: "mean", url, voxels, plan }, { ...rest, transfer: [voxels.buffer] })).values;
  }

  /** The finest level's mean time course when the worker has every chunk it needs; else undefined. */
  async meanIfCached(url: string, voxels: Int32Array, signal?: AbortSignal): Promise<Float32Array | undefined> {
    return (await this.request<{ values: Float32Array | null }>({ type: "cached", url, voxels }, { signal, transfer: [voxels.buffer] })).values ?? undefined;
  }

  dispose(): void {
    this.rpc.dispose();
  }
}
