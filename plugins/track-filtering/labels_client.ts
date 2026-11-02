/** The main thread's side of ./labels_worker.ts: a region's segment ids as a promise, with progress and cancel. */
import type { NmRegion } from "./labels.js";

export interface LabelsResult {
  ids: BigUint64Array;
  /** The scale read, by its key. */
  level: string;
  chunks: number;
  voxels: number;
  ms: number;
}

interface Pending {
  resolve: (result: LabelsResult) => void;
  reject: (error: Error) => void;
  progress?: (done: number, total: number) => void;
}

export class LabelsEngine {
  private readonly worker = new Worker(new URL("./labels_worker.ts", import.meta.url), { type: "module", name: "segment regions" });
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** `url`: the precomputed segmentation, http(s), ending in "/". */
  constructor(readonly url: string) {
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      if (msg.type === "progress") return p.progress?.(msg.done, msg.total);
      this.pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg as LabelsResult);
    };
  }

  evaluate(region: NmRegion, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<LabelsResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      });
      this.worker.postMessage({ type: "evaluate", id, url: this.url, region });
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
