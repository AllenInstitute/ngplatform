import { defineConfig } from "vite";

// Neuroglancer is consumed as TypeScript source (see package.json), following
// its own examples/vite configuration.  Data sources outside Neuroglancer
// (packages/neuroglancer-zarr-vectors) are added by src/engine/plugins.ts.
export default defineConfig({
  // Relative asset URLs, so the built app can be served from any path: a
  // bucket prefix, GitHub Pages, or an artifact host.
  base: "",
  resolve: {
    conditions: [
      "neuroglancer/datasource:none_by_default",
      "neuroglancer/datasource/zarr:enabled",
      "neuroglancer/datasource/nifti:enabled",
      "neuroglancer/datasource/precomputed:enabled",
    ],
  },
  esbuild: {
    // Neuroglancer's sources use decorators.
    target: "es2022",
  },
  worker: {
    // Neuroglancer's workers use dynamic imports.
    format: "es",
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4 * 1024 * 1024,
    assetsDir: "assets",
  },
  server: {
    fs: { allow: [".."] },
  },
  optimizeDeps: {
    entries: [
      "index.html",
      "src/engine/workers/chunk_worker.ts",
      "src/engine/workers/async_worker.ts",
    ],
    // Neuroglancer's `new URL(..., import.meta.url)` workers defeat esbuild's
    // dependency pre-bundling.
    exclude: ["neuroglancer", "neuroglancer-zarr-vectors"],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
