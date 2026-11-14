/**
 * Reduces slabs of an image level into the next coarser one (`runJob` in
 * ./slabs.ts) for the worker serving the image, which hands each finer slab
 * over, or says where in the file it is stored (then read here), and gets
 * its part of the coarser slab back (buffers transferred, not copied).  See
 * ./reduce_pool.ts.
 */
import { type ReduceJob, runJob } from "./slabs.js";

self.onmessage = async (event: MessageEvent<{ id: number; job: ReduceJob }>) => {
  const { id, job } = event.data;
  try {
    const done = await runJob(job);
    postMessage({ id, ...done }, { transfer: [done.part, done.finer].filter((s) => s !== undefined).map((s) => s.data.buffer as ArrayBuffer) });
  } catch (e) {
    postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
