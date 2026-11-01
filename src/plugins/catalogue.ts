/**
 * Every plugin the app ships.  This list is how plugins are installed: a
 * plugin is a manifest plus its code, added here (and, for a data type, its
 * worker modules in src/engine/workers/plugins.ts), and built with the app.
 * The Plugins tab switches each on or off; a switch reloads the page with
 * the same link.
 */
import type { Manifest, PluginModule } from "../sdk/types.js";
import { TRACK_FILTERING_MANIFEST } from "./track_filtering/manifest.js";
import { VOLUME_VIEW_MANIFEST } from "./volume_view/manifest.js";

export interface CatalogueEntry {
  manifest: Manifest;
  /** A tool plugin's platform module, loaded the first time it is used. */
  load?: () => Promise<PluginModule>;
  /** A data type plugin's Neuroglancer main-thread module, loaded at start when it is on. */
  neuroglancer?: () => Promise<unknown>;
}

export const ZARR_VECTORS_MANIFEST: Manifest = {
  id: "org.ngplatform.zarr-vectors",
  name: "Zarr Vectors",
  version: "0.3.0",
  kind: "datatype",
  enabledByDefault: true,
  description:
    "Reads Zarr Vectors stores (format 0.9.0 to 0.9.4) into Neuroglancer: point clouds, lines, streamlines, skeletons, graphs and meshes, with multiscale levels and object attributes as segment properties. Sources look like https://…/store.zarrvectors/|zarr-vectors:",
  license: "Apache-2.0",
};

export const CATALOGUE: CatalogueEntry[] = [
  { manifest: ZARR_VECTORS_MANIFEST, neuroglancer: () => import("neuroglancer-zarr-vectors") },
  { manifest: TRACK_FILTERING_MANIFEST, load: async () => (await import("./track_filtering/plugin.js")).plugin },
  { manifest: VOLUME_VIEW_MANIFEST, load: async () => (await import("./volume_view/plugin.js")).plugin },
];
