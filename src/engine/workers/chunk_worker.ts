/**
 * The chunk worker: Neuroglancer's own worker contents plus the worker
 * modules of the data type plugins that are on (named in this worker's
 * `name`).  Neuroglancer's contents load last, since they report the worker
 * ready; the main thread waits for that before sending anything.
 */
import { setAsyncComputationWorkerFactory } from "neuroglancer/unstable/worker_factories.js";
import { CHUNK_WORKER_MODULES, revalidateFetches, workerPlugins, workerRevalidates } from "./plugins.js";
// The platform's own scheme, gs+google:// (Google Cloud Storage with the Google sign-in of Settings › Sign-in).
import "../google_gcs.js";

if (workerRevalidates(self.name)) revalidateFetches(self);

for (const id of workerPlugins(self.name)) await CHUNK_WORKER_MODULES[id]?.();

// The chunk worker starts the async-computation workers itself.
const name = self.name;
setAsyncComputationWorkerFactory(() => new Worker(new URL("./async_worker.ts", import.meta.url), { type: "module", name }));

await import("neuroglancer/worker/chunk");
