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

/**
 * Loads each plugin on its own: one that fails to load is left out (of the
 * workers too) and the rest load.  Resolves to the failures, by plugin id.
 */
export async function loadDataTypePlugins(plugins: DataTypePlugin[], options: { revalidate?: boolean } = {}): Promise<Map<string, Error>> {
  const failed = new Map<string, Error>();
  for (const plugin of plugins) {
    try {
      await plugin.neuroglancer();
    } catch (e) {
      failed.set(plugin.id, e instanceof Error ? e : new Error(String(e)));
    }
  }
  const name = workerName(plugins.filter((p) => !failed.has(p.id)).map((p) => p.id), options);
  setChunkWorkerFactory(() => new Worker(new URL("./workers/chunk_worker.ts", import.meta.url), { type: "module", name }));
  setAsyncComputationWorkerFactory(() => new Worker(new URL("./workers/async_worker.ts", import.meta.url), { type: "module", name }));
  return failed;
}
