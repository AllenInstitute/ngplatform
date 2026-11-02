/** The main thread's side of ./labels_worker.ts: a region's segment ids (or annotations) as a promise, with progress and cancel. */
import type { NmRegion } from "./labels.js";

export interface AnnotationsResult {
  /** The passing annotations' ids, and their points in the source's coordinates. */
  ids: string[];
  points: number[][][];
  /** Neuroglancer's annotation type ("line", "point", …). */
  annotationType: string;
  /** nm per unit of the source's coordinates. */
  nm: number[];
  chunks: number;
  ms: number;
}

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

  /** Precomputed annotations at `this.url` meeting a region. */
  annotations(region: NmRegion, signal?: AbortSignal): Promise<AnnotationsResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as never, reject });
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      });
      this.worker.postMessage({ type: "annotations", id, url: this.url, region });
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }
}
