// ESLint (flat config): the recommended JavaScript and typescript-eslint
// rules, less those the code does not follow on purpose (each says why).
// `npm run lint`.  Kept small so it passes; tighten a rule by fixing what
// it finds first.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "site/**",
      "node_modules/**",
      "**/node_modules/**",
      // Other repositories' code (a submodule) and the Python runner.
      "vendor/**",
      "runner/**",
      "docs/**",
      // What the e2e scripts write.
      "tests/e2e/screenshots/**",
      "tests/e2e/ui-audit/**",
      "plugins/*/dist/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // The `eslint-disable` comments kept for the rules other configurations (Neuroglancer's, zarr-vectors') turn on.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Browser, worker and Node globals the code uses; TypeScript checks
        // names in .ts files, so no-undef is off for them below.
        window: "readonly", document: "readonly", navigator: "readonly", location: "readonly", console: "readonly",
        process: "readonly", URL: "readonly", fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
      },
    },
    rules: {
      // Neuroglancer's internals and untyped JSON are reached through `any`
      // on purpose (docs/dev/neuroglancer-casts.md lists them).
      "@typescript-eslint/no-explicit-any": "off",
      // Unused names, except arguments named with a leading underscore and the
      // rest of a destructuring.  Warnings until the last few go (see the
      // report of `npm run lint`); then errors.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
      "prefer-const": ["warn", { destructuring: "all" }],
      // Comma sequences as statements (`if (big) (size = u64(v, p)), (p += 8);`)
      // are the code's style for a pair of updates.
      "@typescript-eslint/no-unused-expressions": "off",
      // Getters in object literals that close over their owner (`const hosts = this`).
      "@typescript-eslint/no-this-alias": "off",
      // A byte-order mark matched in a regular expression, and control
      // characters stripped from file names, are meant.
      "no-irregular-whitespace": ["error", { skipRegExps: true }],
      "no-control-regex": "off",
      // A physical constant written out in full (a parsec in metres).
      "no-loss-of-precision": "warn",
      "no-constant-condition": ["error", { checkLoops: false }],
      // An empty catch says in a comment why nothing is done.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // TypeScript checks the names; the e2e scripts' callbacks run in the browser (page.evaluate).
    files: ["**/*.ts", "tests/e2e/**"],
    rules: { "no-undef": "off" },
  },
);
