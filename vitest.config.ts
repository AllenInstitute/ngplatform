import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// The app's Vite configuration (aliases, conditions, the `test` options),
// and the DOM environment the UI modules' tests opt into with a first line
// of `// @vitest-environment dom` (tests/dom_environment.mjs: jsdom).
export default mergeConfig(
  viteConfig,
  defineConfig({
    // Neuroglancer's sources are wherever node_modules/neuroglancer links to
    // (beside the checkout in CI, elsewhere in a worktree); the tests may read them.
    server: { fs: { strict: false } },
    test: {
      alias: { "vitest-environment-dom": fileURLToPath(new URL("./tests/dom_environment.mjs", import.meta.url)) },
    },
  }),
);
