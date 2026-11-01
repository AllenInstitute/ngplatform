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

export function workerName(plugins: string[], options: { revalidate?: boolean } = {}): string {
  return JSON.stringify(options.revalidate ? { plugins, revalidate: true } : { plugins });
}

/** Whether a worker was started to check every file with its server (a hard reset). */
export function workerRevalidates(name: string): boolean {
  try {
    return JSON.parse(name || "{}").revalidate === true;
  } catch {
    return false;
  }
}

/**
 * Makes `fetch` here check each response with its server (HTTP cache mode
 * "no-cache": a conditional request, answered 304 when unchanged), unless
 * a request asks for another mode.  For a hard reset, where data changed
 * after the browser cached it.
 */
export function revalidateFetches(scope: { fetch: typeof fetch }): void {
  const original = scope.fetch.bind(scope);
  scope.fetch = (input, init) => original(input, { cache: "no-cache", ...init });
}
