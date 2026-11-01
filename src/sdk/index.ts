/**
 * The plugin SDK: what a plugin imports from the platform, as
 * `@ngplatform/sdk` (types, and the manifest check) and
 * `@ngplatform/sdk/workers` (workers for a plugin's own worker code).
 * See plugins/README.md.
 */
export * from "./types.js";
export { checkManifest, MANIFEST_SCHEMA, PLATFORM_CONTEXT_KEYS } from "./manifest.js";
