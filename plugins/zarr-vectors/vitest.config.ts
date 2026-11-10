import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Neuroglancer and the test tools are installed by the application this
// package sits in, and Neuroglancer may be a linked checkout elsewhere: its
// real path must be served too.  (Its exports do not include package.json,
// so it is found beside vitest.)  The application's node_modules may itself
// be a link to another checkout's, whose real path must be served as well.
const require = createRequire(import.meta.url);
const modules = path.resolve(path.dirname(require.resolve("vitest/package.json")), "..");
const neuroglancer = fs.realpathSync(path.join(modules, "neuroglancer"));
// The Neuroglancer this checkout links to, which may differ from the one beside
// vitest when node_modules is a directory of links into another checkout's.
const linked = path.resolve(import.meta.dirname, "../../node_modules/neuroglancer");
const allow = ["../..", fs.realpathSync(modules), neuroglancer];
if (fs.existsSync(linked)) allow.push(fs.realpathSync(linked));

// The decoders run through Neuroglancer's async-computation worker, which
// @vitest/web-worker runs in Node.
export default defineConfig({
  resolve: {
    conditions: ["neuroglancer/datasource:none_by_default", "neuroglancer/datasource/zarr:enabled"],
  },
  server: { fs: { allow } },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
    setupFiles: ["@vitest/web-worker"],
    testTimeout: 20000,
  },
});
