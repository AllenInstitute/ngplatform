import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { defineConfig, type Plugin } from "vite";

// Neuroglancer is consumed as TypeScript source (see package.json), following
// its own examples/vite configuration.  Plugins live in plugins/, one folder
// each, and import the platform as @ngplatform/sdk.
const sdk = fileURLToPath(new URL("./src/sdk/", import.meta.url));
// Neuroglancer's JPEG decoder is plain JavaScript, which its "./unstable/*.js"
// export (to TypeScript sources) does not reach.
const jpg = fileURLToPath(new URL("./node_modules/neuroglancer/src/third_party/jpgjs/jpg.js", import.meta.url));
const webWorker = fileURLToPath(new URL("./node_modules/web-worker/src/browser/index.js", import.meta.url));
// chunkmirage's browser engine, from its repository (a submodule: vendor/chunkmirage).
const chunkmirage = fileURLToPath(new URL("./vendor/chunkmirage/web/src/", import.meta.url));

/**
 * The service worker (src/sw.ts), bundled on its own into sw.js beside the
 * page: a classic script, as a service worker registered without
 * `type: "module"` must be.  Served from memory by the dev server.
 */
function serviceWorker(): Plugin {
  const bundle = async () => {
    const out = await esbuild({
      entryPoints: [fileURLToPath(new URL("./src/sw.ts", import.meta.url))],
      bundle: true,
      format: "iife",
      target: "es2022",
      minify: true,
      write: false,
      alias: { "chunkmirage-web": chunkmirage.replace(/\/$/, "") },
      resolveExtensions: [".ts", ".js"],
    });
    return out.outputFiles[0].text;
  };
  return {
    name: "ngplatform-service-worker",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/sw.js") return next();
        bundle().then(
          (text) => {
            res.setHeader("content-type", "text/javascript");
            res.end(text);
          },
          (e: Error) => next(e),
        );
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "sw.js", source: await bundle() });
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  // Relative asset URLs, so the built app can be served from any path: a
  // bucket prefix, GitHub Pages, or an artifact host.
  base: "",
  resolve: {
    alias: [
      { find: /^@ngplatform\/sdk$/, replacement: `${sdk}index.ts` },
      { find: /^@ngplatform\/sdk\/(.*)$/, replacement: `${sdk}$1.ts` },
      { find: /^neuroglancer\/unstable\/third_party\/jpgjs\/jpg\.js$/, replacement: jpg },
      { find: /^chunkmirage-web\/(.*)$/, replacement: `${chunkmirage}$1` },
      // geotiff's worker pool (chunkmirage reads GeoTIFFs with it) imports web-worker, whose
      // browser build the conditions above (Neuroglancer's, in place of Vite's defaults) miss.
      { find: /^web-worker$/, replacement: webWorker },
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
