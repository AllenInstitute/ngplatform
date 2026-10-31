/**
 * Loads the data type plugins that are on: their Neuroglancer main-thread
 * modules now, and their worker modules in the workers, which Neuroglancer
 * starts from the platform's own scripts (./workers/) with the plugins named.
 * Runs before the viewer exists, once per page load.
 */
import { setAsyncComputationWorkerFactory, setChunkWorkerFactory } from "./neuroglancer.js";
import { workerName } from "./workers/plugins.js";

export interface DataTypePlugin {
  id: string;
  /** The plugin's Neuroglancer main-thread module (registers its data source). */
  neuroglancer: () => Promise<unknown>;
}

export async function loadDataTypePlugins(plugins: DataTypePlugin[]): Promise<void> {
  for (const plugin of plugins) await plugin.neuroglancer();
  const name = workerName(plugins.map((p) => p.id));
  setChunkWorkerFactory(() => new Worker(new URL("./workers/chunk_worker.ts", import.meta.url), { type: "module", name }));
  setAsyncComputationWorkerFactory(() => new Worker(new URL("./workers/async_worker.ts", import.meta.url), { type: "module", name }));
}
