/** The main thread's side of the volume worker: requests as promises, with progress and cancel. */
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
import type { LevelInfo } from "./volume_worker.js";
import type { Region } from "./volume_reader.js";

export type { LevelInfo, Region };

export class VolumeClient {
  private readonly rpc = new WorkerRpc(() => new Worker(new URL("./volume_worker.ts", import.meta.url), { type: "module", name: "volume view" }), {
    stopped: (why) => `the volume reader stopped: ${why}. Reload the page to try again`,
    // A plane's coarser passes come before the final one.
    interim: (msg) => msg.type === "plane" && !msg.final,
  });

  private request<T>(message: object, options: { progress?: (done: number, total: number) => void; partial?: (msg: any) => void; signal?: AbortSignal } = {}): Promise<T> {
    const { progress, partial, signal } = options;
    return this.rpc.request<T>(message, { signal, progress: (msg) => (msg.type === "progress" ? progress?.(msg.done, msg.total) : partial?.(msg)) });
  }

  open(stores: string[], space: string | undefined): Promise<{ levels: LevelInfo[]; name: string; description?: string }> {
    return this.request({ type: "open", stores, space });
  }

  volume(level: number, progress?: (done: number, total: number) => void, signal?: AbortSignal, region?: Region): Promise<{ data: Uint8Array; size: [number, number, number] }> {
    return this.request({ type: "volume", level, region }, { progress, signal });
  }

  plane(
    request: { level: number; axis: number; value: number; rect: number[]; texel: number },
    options: { progress?: (done: number, total: number) => void; partial?: (msg: { data: Uint8Array; width: number; height: number }) => void; signal?: AbortSignal } = {},
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    return this.request({ type: "plane", ...request }, options);
  }

  dispose(): void {
    this.rpc.dispose();
  }
}
