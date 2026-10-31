/**
 * The chunk worker: Neuroglancer's own worker contents plus the backend
 * modules of the Neuroglancer plugins the platform loads (data sources
 * packaged outside Neuroglancer).  Neuroglancer's contents are imported
 * last, since they report the worker ready; the whole script still runs
 * before the worker handles its first message.
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import "neuroglancer-zarr-vectors/backend";

// The chunk worker starts the async-computation workers itself.
setAsyncComputationWorkerFactory(() => new Worker(new URL("./async_worker.ts", import.meta.url), { type: "module" }));

import "neuroglancer/worker/chunk";
