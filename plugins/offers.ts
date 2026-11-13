/**
 * When to offer a tool plugin that is off: the data each one serves.
 *
 * The app looks at the active scene (layers, their types and sources, and
 * where needed a store's metadata, read once) and, for a plugin that is
 * off, asks its offer whether it applies. One that applies is listed in
 * the Layers panel with a button that turns it on; a `toast` offer is also
 * shown once in a toast. See src/ui/plugin_offers.ts.
 *
 * Kept apart from the plugins' code, which loads only when a plugin is on.
 */
import { isCollection, parentGroups } from "./collections/collection.js";
import { renderSource } from "./anatomical-rendering/view.js";
import { precomputedUrl } from "@ngplatform/sdk/sources";
import { omeZarrUrl } from "./volume-view/sources.js";

/** What an offer may look at in the active scene. */
export interface OfferScene {
  /** The scene's layers; `managed` when a plugin writes it (Track filtering's regions layer). */
  layers: { name: string; type: string; sources: string[]; managed?: boolean }[];
  /** Whether a layer's source has a time axis (a dimension in seconds, or named t). */
  hasTimeAxis(layer: string): boolean;
  /** Whether a layer has a lookup table (an atlas's names and colours). */
  hasLookupTable(layer: string): boolean;
  /** JSON at a URL, each read once a visit; undefined when it cannot be read. */
  json(url: string): Promise<unknown>;
  /** Whether a URL is data opened from this computer. */
  isLocal(url: string): boolean;
}

/** Whether an offer applies; "list": in the Layers panel only, never in a toast (a use worth offering, not pressing). */
export type Applies = boolean | "list";

export interface Offer {
  /** What it does for this data, in a few words after its name: "Track filtering: select streamlines through regions". */
  pitch: string;
  /** Also offered once in a toast (else only in the Layers panel). */
  toast: boolean;
  applies(scene: OfferScene): Applies | Promise<Applies>;
}

const VECTORS = /\|zarr-vectors:|^zarr-vectors:\/\/|\.zarrvectors\/?($|\|)/i;

const isVectors = (sources: string[]) => sources.some((s) => VECTORS.test(s));
const vectorLayers = (scene: OfferScene) => scene.layers.filter((l) => isVectors(l.sources));
const images = (scene: OfferScene) => scene.layers.filter((l) => l.type === "image");
/** Label volumes: segmentation layers that are not Zarr Vectors (which Neuroglancer shows as segmentation layers). */
const labelVolumes = (scene: OfferScene) => scene.layers.filter((l) => l.type === "segmentation" && !isVectors(l.sources));

/** A Zarr Vectors store's URL (with a trailing /), from a source. */
function vectorsStore(source: string): string | undefined {
  if (!VECTORS.test(source)) return undefined;
  const base = source.replace(/\|.*$/, "").replace(/^zarr-vectors:\/\//, "");
  if (!/^https?:\/\//.test(base)) return undefined;
  return base.endsWith("/") ? base : `${base}/`;
}

/** Component counts of tensors (6), spherical harmonics (even orders 2 to 12) and peaks (3 × 3). */
const COMPONENTS = new Set([6, 9, 15, 28, 45, 66, 91]);

/** Whether an OME-Zarr image has an axis of components of a tensor's, SH's or peaks' size (its metadata only). */
async function hasOrientationAxis(scene: OfferScene, url: string): Promise<boolean> {
  const v3 = (await scene.json(`${url}zarr.json`)) as { attributes?: Record<string, unknown> } | undefined;
  const v2 = v3 === undefined ? ((await scene.json(`${url}.zattrs`)) as Record<string, unknown> | undefined) : undefined;
  const attributes = (v3?.attributes ?? v2) as { ome?: { multiscales?: unknown[] }; multiscales?: unknown[] } | undefined;
  const multiscale = (attributes?.ome?.multiscales ?? attributes?.multiscales)?.[0] as
    | { axes?: { name: string; type?: string }[]; coordinateSystems?: { axes: { name: string; type?: string }[] }[]; datasets?: { path: string }[] }
    | undefined;
  const axes = multiscale?.coordinateSystems?.[0]?.axes ?? multiscale?.axes ?? [];
  if (axes.length !== 4) return false;
  const component = axes.findIndex((a) => a.type === "channel" || a.name === "c");
  const path = multiscale?.datasets?.[0]?.path;
  if (component === -1 || path === undefined) return false;
  const array = ((await scene.json(`${url}${path}/zarr.json`)) ?? (await scene.json(`${url}${path}/.zarray`))) as { shape?: number[] } | undefined;
  return COMPONENTS.has(array?.shape?.[component] ?? 0);
}

/** Whether a precomputed segmentation layer's segments have meshes (its info names a mesh directory). */
async function hasPrecomputedMeshes(scene: OfferScene): Promise<boolean> {
  for (const l of labelVolumes(scene)) {
    const volume = precomputedUrl(l.sources[0]);
    if (volume === undefined) continue;
    const info = (await scene.json(`${volume}info`)) as { mesh?: unknown } | undefined;
    if (typeof info?.mesh === "string" && info.mesh !== "") return true;
  }
  return false;
}

/** By plugin id. */
export const OFFERS: Record<string, Offer> = {
  "org.ngplatform.track-filtering": {
    pitch: "select streamlines through regions",
    toast: true,
    applies: (scene) => vectorLayers(scene).length > 0,
  },
  "org.ngplatform.luxar": {
    pitch: "draw lines and segment meshes glowing, as Luxar does",
    toast: false,
    applies: async (scene) => vectorLayers(scene).length > 0 || (await hasPrecomputedMeshes(scene)),
  },
  "org.ngplatform.annotations": {
    pitch: "a table of annotations, with groups, values and comments",
    toast: true,
    // On an image, points or boxes are a common first step: listed, not toasted.
    applies: (scene) => scene.layers.some((l) => l.type === "annotation" && !l.managed) || (images(scene).length > 0 && "list"),
  },
  "org.ngplatform.segmentation": {
    pitch: "edit label volumes with a brush, fill and quick select",
    toast: true,
    // On an image, a new label volume on its grid: listed, not toasted.
    applies: (scene) => labelVolumes(scene).length > 0 || (images(scene).length > 0 && "list"),
  },
  "org.ngplatform.atlas": {
    pitch: "its regions as a tree: search, show, go to",
    toast: true,
    applies: (scene) => labelVolumes(scene).some((l) => scene.hasLookupTable(l.name)),
  },
  "org.ngplatform.filters": {
    pitch: "smooth, threshold or find vessels as you view",
    toast: false,
    applies: (scene) => images(scene).length > 0,
  },
  "org.ngplatform.anatomical-rendering": {
    pitch: "photorealistic, path-traced views on a GPU",
    toast: false,
    // What it reads: OME-Zarr, N5 and precomputed images.
    applies: (scene) => images(scene).some((l) => renderSource(l.sources[0]) !== undefined),
  },
  "org.ngplatform.registration": {
    pitch: "move one image onto another",
    toast: false,
    applies: (scene) => images(scene).length >= 2,
  },
  "org.ngplatform.time-series": {
    pitch: "plot a voxel's values over time",
    toast: true,
    async applies(scene) {
      if (images(scene).some((l) => scene.hasTimeAxis(l.name))) return true;
      // A CIFTI time series on a surface opened from this computer: its store's surface header lists it.
      for (const l of vectorLayers(scene)) {
        const store = l.sources.map(vectorsStore).find((s) => s !== undefined);
        if (store === undefined || !scene.isLocal(store)) continue;
        const header = (await scene.json(`${store}headers/surface/zarr.json`)) as { attributes?: { time_series?: object } } | undefined;
        if (header?.attributes?.time_series !== undefined && Object.keys(header.attributes.time_series).length > 0) return true;
      }
      return false;
    },
  },
  "org.ngplatform.orientations": {
    pitch: "draw tensors, ODFs or peaks as glyphs",
    toast: true,
    async applies(scene) {
      for (const l of images(scene)) {
        const url = omeZarrUrl(l.sources[0]);
        if (url !== undefined && (await hasOrientationAxis(scene, url))) return true;
      }
      return false;
    },
  },
  "org.ngplatform.collections": {
    pitch: "this image is part of an OME collection",
    toast: true,
    async applies(scene) {
      for (const l of images(scene)) {
        const url = omeZarrUrl(l.sources[0]);
        if (url === undefined || scene.isLocal(url)) continue;
        for (const group of parentGroups(url, 3)) if (isCollection(await scene.json(`${group}/zarr.json`))) return true;
      }
      return false;
    },
  },
};
