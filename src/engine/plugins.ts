/**
 * The Neuroglancer plugins the platform loads: data sources packaged outside
 * Neuroglancer.  Each has a main-thread half, imported here, and worker
 * halves, imported by the platform's own worker scripts (./workers/), which
 * Neuroglancer starts instead of its defaults.
 *
 * To add one: import its main-thread module below and its worker modules in
 * ./workers/chunk_worker.ts and ./workers/async_worker.ts.
 */
import "neuroglancer-zarr-vectors";
import { setAsyncComputationWorkerFactory, setChunkWorkerFactory } from "./neuroglancer.js";

setChunkWorkerFactory(() => new Worker(new URL("./workers/chunk_worker.ts", import.meta.url), { type: "module" }));
setAsyncComputationWorkerFactory(() => new Worker(new URL("./workers/async_worker.ts", import.meta.url), { type: "module" }));
