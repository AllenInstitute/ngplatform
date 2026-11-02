/** The main thread's side of the volume worker: requests as promises, with progress and cancel. */
import type { LevelInfo } from "./volume_worker.js";
import type { Region } from "./volume_reader.js";

export type { LevelInfo, Region };

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  progress?: (done: number, total: number) => void;
  partial?: (msg: any) => void;
}

export class VolumeClient {
  private worker = new Worker(new URL("./volume_worker.ts", import.meta.url), { type: "module", name: "volume view" });
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      if (msg.type === "progress") {
        p.progress?.(msg.done, msg.total);
      } else if (msg.type === "plane" && !msg.final) {
        p.partial?.(msg);
      } else {
        this.pending.delete(msg.id);
        if (msg.type === "error") p.reject(new Error(msg.message));
        else p.resolve(msg);
      }
    };
  }

  private request<T>(message: object, options: { progress?: Pending["progress"]; partial?: Pending["partial"]; signal?: AbortSignal } = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress: options.progress, partial: options.partial });
      options.signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      });
      this.worker.postMessage({ ...message, id });
    });
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
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
