/**
 * The worker halves of data type plugins, by plugin id.  Neuroglancer starts
 * its workers from ./chunk_worker.ts and ./async_worker.ts, which load the
 * modules of the plugins named in the worker's `name` (set by
 * ../plugins.ts from the plugins that are on).
 *
 * A data type plugin in src/plugins/catalogue.ts lists its worker modules
 * here too; tests/catalogue.test.ts checks the two agree.
 */

export const CHUNK_WORKER_MODULES: Record<string, () => Promise<unknown>> = {
  "org.ngplatform.zarr-vectors": () => import("neuroglancer-zarr-vectors/backend"),
};

export const ASYNC_WORKER_MODULES: Record<string, () => Promise<unknown>> = {
  "org.ngplatform.zarr-vectors": () => import("neuroglancer-zarr-vectors/async_computation"),
};

/** The plugin ids a worker was started with (its `name`, as JSON). */
export function workerPlugins(name: string): string[] {
  try {
    const parsed = JSON.parse(name || "{}");
    return Array.isArray(parsed.plugins) ? parsed.plugins.map(String) : [];
  } catch {
    return [];
  }
}

export function workerName(plugins: string[]): string {
  return JSON.stringify({ plugins });
}
