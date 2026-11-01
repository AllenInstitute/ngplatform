/**
 * Every plugin the app ships, one folder each beside this file. This list is
 * how plugins are installed: a plugin is a manifest plus its code, added
 * here (and, for a data type, its worker modules in ./workers.ts), and built
 * with the app. The Plugins tab switches each on or off; a switch reloads
 * the page with the same link. See ./README.md.
 */
import type { Manifest, PluginModule } from "@ngplatform/sdk";
import { TRACK_FILTERING_MANIFEST } from "./track-filtering/manifest.js";
import { VOLUME_VIEW_MANIFEST } from "./volume-view/manifest.js";
import { ZARR_VECTORS_MANIFEST } from "./zarr-vectors/manifest.js";

export interface CatalogueEntry {
  manifest: Manifest;
  /** A tool plugin's platform module, loaded the first time it is used. */
  load?: () => Promise<PluginModule>;
  /** A data type plugin's Neuroglancer main-thread module, loaded at start when it is on. */
  neuroglancer?: () => Promise<unknown>;
}

export const CATALOGUE: CatalogueEntry[] = [
  { manifest: ZARR_VECTORS_MANIFEST, neuroglancer: () => import("neuroglancer-zarr-vectors") },
  { manifest: TRACK_FILTERING_MANIFEST, load: async () => (await import("./track-filtering/plugin.js")).plugin },
  { manifest: VOLUME_VIEW_MANIFEST, load: async () => (await import("./volume-view/plugin.js")).plugin },
];
