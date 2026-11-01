import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Neuroglancer and the test tools are installed by the application this
// package sits in, and Neuroglancer may be a linked checkout elsewhere: its
// real path must be served too.  (Its exports do not include package.json,
// so it is found beside vitest.)
const require = createRequire(import.meta.url);
const neuroglancer = fs.realpathSync(path.resolve(path.dirname(require.resolve("vitest/package.json")), "../neuroglancer"));

// The decoders run through Neuroglancer's async-computation worker, which
// @vitest/web-worker runs in Node.
export default defineConfig({
  resolve: {
    conditions: ["neuroglancer/datasource:none_by_default", "neuroglancer/datasource/zarr:enabled"],
  },
  server: { fs: { allow: ["../..", neuroglancer] } },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
    setupFiles: ["@vitest/web-worker"],
    testTimeout: 20000,
  },
});
