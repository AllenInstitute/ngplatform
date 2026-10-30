import { defineConfig } from "vite";

// Neuroglancer is consumed as TypeScript source from the fork (see
// package.json), following the fork's own examples/vite configuration.
export default defineConfig({
  // Relative asset URLs, so the built app can be served from any path: a
  // bucket prefix, GitHub Pages, or an artifact host.
  base: "",
  resolve: {
    conditions: [
      "neuroglancer/datasource:none_by_default",
      "neuroglancer/datasource/zarr-vectors:enabled",
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
      "node_modules/neuroglancer/src/main.bundle.js",
      "node_modules/neuroglancer/src/async_computation.bundle.js",
      "node_modules/neuroglancer/src/chunk_worker.bundle.js",
    ],
    // Neuroglancer's `new URL(..., import.meta.url)` workers defeat esbuild's
    // dependency pre-bundling.
    exclude: ["neuroglancer"],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
