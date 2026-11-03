/**
 * Every plugin the app ships, one folder each beside this file. This list is
 * how plugins are installed: a plugin is a manifest plus its code, added
 * here (and, for a data type, its worker modules in ./workers.ts), and built
 * with the app. The Plugins tab switches each on or off; a switch reloads
 * the page with the same link. See ./README.md.
 */
import type { Manifest, PluginModule, VirtualFormat } from "@ngplatform/sdk";
import { ANNOTATIONS_MANIFEST } from "./annotations/manifest.js";
import { LABEL_STORE_FORMAT } from "./annotations/segmentation/store_format.js";
import { COLLECTIONS_MANIFEST } from "./collections/manifest.js";
import { FILTERS_MANIFEST } from "./filters/manifest.js";
import { LUXAR_MANIFEST } from "./luxar/manifest.js";
import { REGISTRATION_MANIFEST } from "./registration/manifest.js";
import { TRACK_FILTERING_MANIFEST } from "./track-filtering/manifest.js";
import { VOLUME_VIEW_MANIFEST } from "./volume-view/manifest.js";
import { ZARR_VECTORS_MANIFEST } from "./zarr-vectors/manifest.js";

export interface CatalogueEntry {
  manifest: Manifest;
  /** A tool plugin's platform module, loaded the first time it is used. */
  load?: () => Promise<PluginModule>;
  /** A data type plugin's Neuroglancer main-thread module, loaded at start when it is on. */
  neuroglancer?: () => Promise<unknown>;
  /** Files a data type plugin reads in place as virtual stores, when it is on. */
  virtualFormats?: () => VirtualFormat[];
}

export const CATALOGUE: CatalogueEntry[] = [
  { manifest: ZARR_VECTORS_MANIFEST, neuroglancer: () => import("neuroglancer-zarr-vectors") },
  { manifest: TRACK_FILTERING_MANIFEST, load: async () => (await import("./track-filtering/plugin.js")).plugin },
  { manifest: VOLUME_VIEW_MANIFEST, load: async () => (await import("./volume-view/plugin.js")).plugin },
  // Label volumes drawn in the page are served the way local files are (see ./annotations/segmentation/store_format.ts).
  { manifest: ANNOTATIONS_MANIFEST, load: async () => (await import("./annotations/plugin.js")).plugin, virtualFormats: () => [LABEL_STORE_FORMAT] },
  { manifest: COLLECTIONS_MANIFEST, load: async () => (await import("./collections/plugin.js")).plugin },
  { manifest: FILTERS_MANIFEST, load: async () => (await import("./filters/plugin.js")).plugin },
  { manifest: REGISTRATION_MANIFEST, load: async () => (await import("./registration/plugin.js")).plugin },
  { manifest: LUXAR_MANIFEST, load: async () => (await import("./luxar/plugin.js")).plugin },
];
