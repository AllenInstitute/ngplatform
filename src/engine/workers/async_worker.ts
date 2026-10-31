/**
 * An async-computation worker (decoding off the chunk worker): Neuroglancer's
 * own contents plus the decoders of the data type plugins that are on.
 * Neuroglancer's contents load last: they report the worker ready.
 */
import { ASYNC_WORKER_MODULES, workerPlugins } from "./plugins.js";

for (const id of workerPlugins(self.name)) await ASYNC_WORKER_MODULES[id]?.();

await import("neuroglancer/worker/async_computation");
