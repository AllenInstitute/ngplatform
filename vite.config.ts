import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { defineConfig, type Plugin } from "vite";
import { neuroglancerCheck } from "./scripts/neuroglancer_pin.mjs";
import { contentSecurityPolicy } from "./src/platform/csp.js";
import type { BuildInfo } from "./src/platform/build_info.js";
import { type BuiltFile, shellFiles } from "./src/sw_parts.js";

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

const root = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/** This repository's commit, short, marked when the tree has uncommitted changes (CI's GITHUB_SHA when git cannot say). */
function commitOf(): string {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const commit = git("rev-parse", "--short=12", "HEAD");
    return git("status", "--porcelain", "--untracked-files=no") === "" ? commit : `${commit}+changes`;
  } catch {
    return process.env.GITHUB_SHA?.slice(0, 12) ?? "unknown";
  }
}

/**
 * What this build is (src/platform/build_info.ts), and a warning when the
 * Neuroglancer checkout beside this one is not at the commit package.json
 * pins: the build would then differ from CI's and the deploy's.
 */
function buildInfo(): BuildInfo {
  const check = neuroglancerCheck(root);
  for (const problem of check.problems) console.warn(`\x1b[33mwarning: Neuroglancer: ${problem}\x1b[0m`);
  return {
    version: pkg.version,
    commit: commitOf(),
    date: new Date().toISOString(),
    neuroglancer: { commit: check.commit ? `${check.commit.slice(0, 12)}${check.dirty ? "+changes" : ""}` : "unknown", pin: check.pin?.slice(0, 12) ?? "unknown" },
  };
}
const BUILD = buildInfo();

/**
 * The Content Security Policy (src/platform/csp.ts) in the built pages,
 * just after their charset (which must come in the first 1024 bytes) and
 * before anything it governs.  The dev server goes without (Vite there
 * injects styles inline and talks to the page over a socket).
 */
function contentSecurity(): Plugin {
  return {
    name: "ngplatform-content-security-policy",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}" />`;
        if (!/<meta charset="utf-8" \/>/.test(html)) throw new Error("index.html: no <meta charset> to put the Content-Security-Policy after");
        return html.replace(/<meta charset="utf-8" \/>/, (charset) => `${charset}\n    ${meta}`);
      },
    },
  };
}

/** The fonts served with the app (public/fonts), kept by the service worker with the page. */
const FONTS = readdirSync(new URL("./public/fonts/", import.meta.url)).filter((f) => /\.(woff2|css)$/.test(f)).map((f) => `fonts/${f}`);

/**
 * The service worker (src/sw.ts), bundled on its own into sw.js beside the
 * page: a classic script, as a service worker registered without
 * `type: "module"` must be.  Served from memory by the dev server.
 */
function serviceWorker(): Plugin {
  const bundle = async (precache: string[] = []) => {
    const out = await esbuild({
      entryPoints: [fileURLToPath(new URL("./src/sw.ts", import.meta.url))],
      bundle: true,
      format: "iife",
      target: "es2022",
      minify: true,
      write: false,
      alias: { "chunkmirage-web": chunkmirage.replace(/\/$/, "") },
      // The worker's version: a new build's worker drops the caches of older ones.
      // The files it keeps for the app to open offline (none from the dev server).
      define: {
        __SW_VERSION__: JSON.stringify(`${pkg.version}-${Date.now().toString(36)}`),
        __SW_PRECACHE__: JSON.stringify(precache),
      },
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
    async generateBundle(_options, output) {
      // The main page's build only (Vite builds each worker apart, through these plugins too).
      const files: BuiltFile[] = Object.values(output).map((f) =>
        f.type === "chunk"
          ? { fileName: f.fileName, type: "chunk", isEntry: f.isEntry, isDynamicEntry: f.isDynamicEntry, facadeModuleId: f.facadeModuleId, imports: f.imports, css: [...(f.viteMetadata?.importedCss ?? [])] }
          : { fileName: f.fileName, type: "asset" },
      );
      if (!files.some((f) => f.isEntry && /index\.html$/.test(f.facadeModuleId ?? ""))) return;
      this.emitFile({ type: "asset", fileName: "sw.js", source: await bundle(shellFiles(files, ["favicon.svg", ...FONTS])) });
    },
  };
}

/**
 * Zarr Vectors' Neuroglancer module is on by default, and main.ts waits for
 * it before it builds the shell; as a dynamic import it would start to
 * download only once the main bundle has run.  Listed as a module preload
 * in the page, it downloads alongside the main bundle.
 */
function preloadDefaultPlugin(): Plugin {
  return {
    name: "ngplatform-preload-default-plugin",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.bundle === undefined || !ctx.filename.endsWith("index.html")) return html;
        const chunks = Object.values(ctx.bundle).flatMap((c) => (c.type === "chunk" ? [c] : []));
        const entry = chunks.find((c) => c.isDynamicEntry && /zarr-vectors\/src\/register_default\.ts$/.test(c.facadeModuleId ?? ""));
        if (entry === undefined) return html;
        const files = [entry.fileName, ...entry.imports].filter((f) => !html.includes(`/${f}"`));
        return files.map((f) => ({ tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: `./${f}` }, injectTo: "head" as const }));
      },
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker(), preloadDefaultPlugin(), contentSecurity()],
  define: {
    __BUILD_INFO__: JSON.stringify(BUILD),
  },
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
    // Source maps beside the files but not linked from them: the page does
    // not load them, and a stack saved from Activity can be read against them.
    sourcemap: "hidden",
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
