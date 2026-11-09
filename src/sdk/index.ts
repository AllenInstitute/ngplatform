/**
 * The plugin SDK: what a plugin imports from the platform, as
 * `@ngplatform/sdk` (types, the manifest check, and the parts a panel is
 * built from), `@ngplatform/sdk/dom` (those parts and the other DOM
 * helpers), `@ngplatform/sdk/workers` (workers for a plugin's own worker
 * code) and `@ngplatform/sdk/testing` (a stand-in document for panel
 * tests).  See plugins/README.md.
 */
export * from "./types.js";
export { checkManifest, MANIFEST_SCHEMA, PLATFORM_CONTEXT_KEYS } from "./manifest.js";
// The parts every panel is built from (plugins/README.md, "Building a panel").
export {
  type Action,
  card,
  type CardOptions,
  checkbox,
  el,
  emptyState,
  field,
  type FieldOptions,
  icon,
  iconButton,
  type IconName,
  info,
  type OnOff,
  type OnOffOptions,
  region,
  type Settable,
  slider,
  type Slider,
  type SliderOptions,
  statusLine,
  type StatusLine,
  toggle,
} from "./dom.js";
