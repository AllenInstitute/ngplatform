/**
 * Every plugin the app ships, one folder each beside this file. This list is
 * how plugins are installed: a plugin is a manifest plus its code, added
 * here (and, for a data type, its worker modules in ./workers.ts), and built
 * with the app. The Plugins tab switches each on or off (a tool plugin
 * switches on at once; a data type, or switching off, reloads the page with
 * the same link). Only Zarr Vectors is on by default; the others are
 * offered when data they serve is opened (./offers.ts). See ./README.md.
 */
import type { Manifest, PluginModule, VirtualFormat } from "@ngplatform/sdk";
import { ANATOMICAL_RENDERING_MANIFEST } from "./anatomical-rendering/manifest.js";
import { ANNOTATIONS_MANIFEST } from "./annotations/manifest.js";
import { ATLAS_MANIFEST } from "./atlas/manifest.js";
import { COLLECTIONS_MANIFEST } from "./collections/manifest.js";
import { FILTERS_MANIFEST } from "./filters/manifest.js";
import { LUXAR_MANIFEST } from "./luxar/manifest.js";
import { ORIENTATIONS_MANIFEST } from "./orientations/manifest.js";
import { REGISTRATION_MANIFEST } from "./registration/manifest.js";
import { SEGMENTATION_MANIFEST } from "./segmentation/manifest.js";
import { LABEL_STORE_FORMAT } from "./segmentation/store_format.js";
import { TIME_SERIES_MANIFEST } from "./time-series/manifest.js";
import { TRACK_FILTERING_MANIFEST } from "./track-filtering/manifest.js";
import { ZARR_VECTORS_MANIFEST } from "./zarr-vectors/manifest.js";
import { type Offer, OFFERS } from "./offers.js";

/** What a plugin does, for grouping the Plugins tab. */
export type PluginGroup = "data" | "vectors" | "images" | "labels" | "annotation";

export const GROUP_TITLES: Record<PluginGroup, string> = {
  data: "Data types",
  vectors: "Tractograms and other vectors",
  images: "Images",
  labels: "Segmentations and atlases",
  annotation: "Annotation",
};

export interface CatalogueEntry {
  manifest: Manifest;
  /** A tool plugin's platform module, loaded the first time it is used. */
  load?: () => Promise<PluginModule>;
  /** A data type plugin's Neuroglancer main-thread module, loaded at start when it is on. */
  neuroglancer?: () => Promise<unknown>;
  /** Files a data type plugin reads in place as virtual stores, when it is on. */
  virtualFormats?: () => VirtualFormat[];
  /** One line in the Plugins tab. */
  summary: string;
  group: PluginGroup;
  /** When to offer it while it is off. */
  offer?: Offer;
}

const offer = (id: string) => OFFERS[id];

export const CATALOGUE: CatalogueEntry[] = [
  {
    manifest: ZARR_VECTORS_MANIFEST,
    neuroglancer: () => import("neuroglancer-zarr-vectors"),
    summary: "Opens Zarr Vectors stores, and tractograms, meshes, neurons and point tables as if they were one.",
    group: "data",
  },
  {
    manifest: TRACK_FILTERING_MANIFEST,
    load: async () => (await import("./track-filtering/plugin.js")).plugin,
    summary: "Selects the streamlines (or other objects) that pass through regions, as groups.",
    group: "vectors",
    offer: offer(TRACK_FILTERING_MANIFEST.id),
  },
  {
    manifest: LUXAR_MANIFEST,
    load: async () => (await import("./luxar/plugin.js")).plugin,
    summary: "Draws lines glowing, tone mapped, as the Luxar viewer does.",
    group: "vectors",
    offer: offer(LUXAR_MANIFEST.id),
  },
  {
    manifest: FILTERS_MANIFEST,
    load: async () => (await import("./filters/plugin.js")).plugin,
    summary: "Filters an image as it is viewed: smoothing, thresholds, vesselness, morphology.",
    group: "images",
    offer: offer(FILTERS_MANIFEST.id),
  },
  {
    manifest: ANATOMICAL_RENDERING_MANIFEST,
    load: async () => (await import("./anatomical-rendering/plugin.js")).plugin,
    summary: "Path-traced, photorealistic views of an image, on a GPU here or over SSH.",
    group: "images",
    offer: offer(ANATOMICAL_RENDERING_MANIFEST.id),
  },
  {
    manifest: REGISTRATION_MANIFEST,
    load: async () => (await import("./registration/plugin.js")).plugin,
    summary: "Moves an image onto another, by hand or from landmarks.",
    group: "images",
    offer: offer(REGISTRATION_MANIFEST.id),
  },
  {
    manifest: TIME_SERIES_MANIFEST,
    load: async () => (await import("./time-series/plugin.js")).plugin,
    summary: "Plots a voxel's values over time, and plays through time.",
    group: "images",
    offer: offer(TIME_SERIES_MANIFEST.id),
  },
  {
    manifest: ORIENTATIONS_MANIFEST,
    load: async () => (await import("./orientations/plugin.js")).plugin,
    summary: "Draws diffusion tensors, ODFs and peaks as glyphs over an image.",
    group: "images",
    offer: offer(ORIENTATIONS_MANIFEST.id),
  },
  {
    manifest: COLLECTIONS_MANIFEST,
    load: async () => (await import("./collections/plugin.js")).plugin,
    summary: "Shows an OME collection's images, placed by its transforms.",
    group: "images",
    offer: offer(COLLECTIONS_MANIFEST.id),
  },
  {
    manifest: SEGMENTATION_MANIFEST,
    load: async () => (await import("./segmentation/plugin.js")).plugin,
    // Label volumes drawn in the page are served the way local files are (see ./segmentation/store_format.ts).
    virtualFormats: () => [LABEL_STORE_FORMAT],
    summary: "Draws and edits label volumes: brush, fill, lasso, quick select.",
    group: "labels",
    offer: offer(SEGMENTATION_MANIFEST.id),
  },
  {
    manifest: ATLAS_MANIFEST,
    load: async () => (await import("./atlas/plugin.js")).plugin,
    summary: "An atlas's regions as a tree: search, show, go to, measure.",
    group: "labels",
    offer: offer(ATLAS_MANIFEST.id),
  },
  {
    manifest: ANNOTATIONS_MANIFEST,
    load: async () => (await import("./annotations/plugin.js")).plugin,
    summary: "A table of annotations with groups, values and comments; labels for figures; measurements.",
    group: "annotation",
    offer: offer(ANNOTATIONS_MANIFEST.id),
  },
];
