/**
 * Which plugins a worker loads. Neuroglancer starts its workers from
 * ./chunk_worker.ts and ./async_worker.ts, which load the modules (listed in
 * plugins/workers.ts) of the plugins named in the worker's `name`, set by
 * ../plugins.ts from the plugins that are on.
 */

export { ASYNC_WORKER_MODULES, CHUNK_WORKER_MODULES } from "../../../plugins/workers.js";

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
