import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Neuroglancer is consumed as TypeScript source (see package.json), following
// its own examples/vite configuration.  Plugins live in plugins/, one folder
// each, and import the platform as @ngplatform/sdk.
const sdk = fileURLToPath(new URL("./src/sdk/", import.meta.url));

export default defineConfig({
  // Relative asset URLs, so the built app can be served from any path: a
  // bucket prefix, GitHub Pages, or an artifact host.
  base: "",
  resolve: {
    alias: [
      { find: /^@ngplatform\/sdk$/, replacement: `${sdk}index.ts` },
      { find: /^@ngplatform\/sdk\/(.*)$/, replacement: `${sdk}$1.ts` },
    ],
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
    rollupOptions: {
      // The app, and plain Neuroglancer with the plugins' formats.
      input: { main: "index.html", neuroglancer: "neuroglancer.html" },
    },
  },
  server: {
    fs: { allow: [".."] },
  },
  optimizeDeps: {
    entries: [
      "index.html",
      "neuroglancer.html",
      "src/engine/workers/chunk_worker.ts",
      "src/engine/workers/async_worker.ts",
    ],
    // Neuroglancer's `new URL(..., import.meta.url)` workers defeat esbuild's
    // dependency pre-bundling.
    exclude: ["neuroglancer", "neuroglancer-zarr-vectors"],
  },
  test: {
    // The platform's tests, and each plugin's (zarr-vectors runs its own: see package.json).
    include: ["tests/**/*.test.ts", "plugins/*/tests/**/*.test.ts"],
    environment: "node",
  },
});
