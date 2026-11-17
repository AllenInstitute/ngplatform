/**
 * Surfaces ready to trace: the BVH over the primitives (lbvh.ts) and their
 * normals in its order, built in a worker (geometry_worker.ts) so the page
 * does not stop while it is built, or here where there are no workers.
 */
import { type Bvh, buildLbvh } from "./lbvh.js";
import type { Primitives } from "./primitives.js";

export interface Surfaces {
  bvh: Bvh;
  /** Per sorted primitive: its corners' packed normals (primitives.ts). */
  normals: Uint32Array;
  /** Objects, in the numbering of the primitives' objects. */
  objectCount: number;
}

/** The surfaces of primitives: their BVH, their normals sorted as it sorts them. */
export function buildSurfaces(p: Primitives, objectCount: number, kinds?: Int32Array): Surfaces {
  const bvh = buildLbvh(p.prims, p.objects, kinds);
  const normals = new Uint32Array(4 * bvh.n);
  for (let i = 0; i < bvh.n; ++i) normals.set(p.normals.subarray(4 * bvh.order[i], 4 * bvh.order[i] + 4), 4 * i);
  return { bvh, normals, objectCount };
}

/** The message a geometry worker is sent, and what it answers. */
export interface BuildRequest {
  prims: Float32Array;
  objects: Int32Array;
  normals: Uint32Array;
  kinds?: Int32Array;
  objectCount: number;
}

let worker: Worker | undefined;
let next = 0;
const waiting = new Map<number, { resolve: (s: Surfaces) => void; reject: (e: Error) => void }>();

/** Builds the surfaces in a worker (the primitives' buffers are handed over); here where there are no workers. */
export function buildSurfacesAsync(req: BuildRequest): Promise<Surfaces> {
  if (typeof Worker === "undefined") return Promise.resolve(buildSurfaces(req, req.objectCount, req.kinds));
  if (worker === undefined) {
    worker = new Worker(new URL("./geometry_worker.ts", import.meta.url), { type: "module", name: "geometry" });
    worker.onmessage = (e: MessageEvent<{ id: number; surfaces?: Surfaces; error?: string }>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.surfaces) w?.resolve(e.data.surfaces);
      else w?.reject(new Error(e.data.error ?? "the geometry could not be built"));
    };
  }
  const id = ++next;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const buffers = [req.prims.buffer, req.objects.buffer, req.normals.buffer, ...(req.kinds ? [req.kinds.buffer] : [])] as ArrayBuffer[];
    worker!.postMessage({ id, req }, [...new Set(buffers)]);
  });
}
