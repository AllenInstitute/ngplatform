/**
 * The worker halves of data type plugins, by plugin id. Neuroglancer's
 * chunk and async-computation workers (src/engine/workers/) load the
 * modules of the plugins that are on before their own contents.
 *
 * A data type plugin in ./index.ts lists its worker modules here too;
 * tests/catalogue.test.ts checks the two agree.
 */

export const CHUNK_WORKER_MODULES: Record<string, () => Promise<unknown>> = {
  "org.ngplatform.zarr-vectors": () => import("neuroglancer-zarr-vectors/backend"),
};

export const ASYNC_WORKER_MODULES: Record<string, () => Promise<unknown>> = {
  "org.ngplatform.zarr-vectors": () => import("neuroglancer-zarr-vectors/async_computation"),
};
