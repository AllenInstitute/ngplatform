/**
 * Workers for plugins that run Neuroglancer code in a worker of their own.
 *
 * Neuroglancer decodes compressed chunks (zstd, blosc, gzip…) in an
 * async-computation worker. A plugin's own worker that reads chunks through
 * Neuroglancer's codecs hands it one, before reading anything:
 *
 *     import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
 *     import { asyncComputationWorker } from "@ngplatform/sdk/workers";
 *     setAsyncComputationWorkerFactory(() => asyncComputationWorker(["org.ngplatform.zarr-vectors"]));
 *
 * The ids name the data type plugins whose decoders the worker needs.
 */
import { workerName } from "../engine/workers/plugins.js";

export function asyncComputationWorker(plugins: string[]): Worker {
  return new Worker(new URL("../engine/workers/async_worker.ts", import.meta.url), { type: "module", name: workerName(plugins) });
}
