/** The main thread's side of ./labels_worker.ts: a region's segment ids (or annotations) as a promise, with progress and cancel. */
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
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

export class LabelsEngine {
  private readonly rpc = new WorkerRpc(() => new Worker(new URL("./labels_worker.ts", import.meta.url), { type: "module", name: "segment regions" }), {
    stopped: (why) => `the segment reader stopped: ${why}`,
    restart: true,
  });

  /** `url`: the precomputed segmentation, http(s), ending in "/". */
  constructor(readonly url: string) {}

  evaluate(region: NmRegion, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<LabelsResult> {
    return this.rpc.request<LabelsResult>({ type: "evaluate", url: this.url, region }, { signal, progress: progress && ((msg) => progress(msg.done, msg.total)) });
  }

  /** Precomputed annotations at `this.url` meeting a region. */
  annotations(region: NmRegion, signal?: AbortSignal): Promise<AnnotationsResult> {
    return this.rpc.request<AnnotationsResult>({ type: "annotations", url: this.url, region }, { signal });
  }

  dispose(): void {
    this.rpc.dispose();
  }
}
