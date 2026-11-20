/**
 * An async-computation worker (decoding off the chunk worker): Neuroglancer's
 * own contents plus the decoders of the data type plugins that are on.
 * Neuroglancer's contents load last: they report the worker ready. A plugin's
 * `afterNeuroglancer` then runs, for handlers that take the place of its own.
 */
import { ASYNC_WORKER_MODULES, workerPlugins } from "./plugins.js";

for (const id of workerPlugins(self.name)) await ASYNC_WORKER_MODULES[id]?.();

await import("neuroglancer/worker/async_computation");

// A plugin's handlers in place of Neuroglancer's for the same requests (zarr-vectors' zstd): registered again after
// Neuroglancer's, before any request can come (messages wait for this module's microtasks).
for (const id of workerPlugins(self.name)) ((await ASYNC_WORKER_MODULES[id]?.()) as { afterNeuroglancer?: () => void } | undefined)?.afterNeuroglancer?.();
