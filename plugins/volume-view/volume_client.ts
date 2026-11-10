/** The main thread's side of the volume worker: requests as promises, with progress and cancel. */
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
import type { LevelInfo } from "./volume_worker.js";
import type { Region } from "./volume_reader.js";
import { withSharedChunks } from "./chunk_host.js";

export type { LevelInfo, Region };

export class VolumeClient {
  private readonly rpc = new WorkerRpc(() => withSharedChunks(new Worker(new URL("./volume_worker.ts", import.meta.url), { type: "module", name: "volume view" })), {
    stopped: (why) => `the volume reader stopped: ${why}. Reload the page to try again`,
  });

  private request<T>(message: object, options: { progress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<T> {
    const { progress, signal } = options;
    return this.rpc.request<T>(message, { signal, progress: (msg) => msg.type === "progress" && progress?.(msg.done, msg.total) });
  }

  open(stores: string[], space: string | undefined): Promise<{ levels: LevelInfo[]; name: string; description?: string }> {
    return this.request({ type: "open", stores, space });
  }

  volume(level: number, progress?: (done: number, total: number) => void, signal?: AbortSignal, region?: Region): Promise<{ data: Uint8Array; size: [number, number, number] }> {
    return this.request({ type: "volume", level, region }, { progress, signal });
  }

  dispose(): void {
    this.rpc.dispose();
  }
}
