/** laz-perf's browser-worker build, loaded the first time a LAZ file is read. */
import type { LazPerfModule } from "./laz.js";

let loading: Promise<LazPerfModule> | undefined;

export function lazPerf(): Promise<LazPerfModule> {
  return (loading ??= (async () => {
    const [{ createLazPerf }, { default: wasm }] = await Promise.all([import("laz-perf/lib/worker/index.js"), import("laz-perf/lib/worker/laz-perf.wasm?url")]);
    return (await createLazPerf({ locateFile: () => wasm })) as unknown as LazPerfModule;
  })());
}
