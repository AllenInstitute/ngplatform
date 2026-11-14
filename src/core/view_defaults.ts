/**
 * The views' own look, as defaults for what the platform makes: a new
 * scene, an example, a layer added to a scene.  A near-black margin around
 * the sections (a black stage: the data floats) and the data's bounding box
 * in a dim grey rather than Neuroglancer's yellow.
 *
 * Only ever filled in where a state says nothing: a shared link or a saved
 * workspace keeps the settings it carries (and Neuroglancer's own defaults
 * where it carries none).  The colours are the view tokens of
 * src/ui/styles.css (--view-margin, --view-outline).
 */
import type { Json } from "./workspace.js";

/** Behind the sections, where there is no data: --view-margin. */
export const VIEW_MARGIN = "#0c0c0c";
/** A layer's bounding box (Neuroglancer's "default annotations"): --view-outline. */
export const VIEW_OUTLINE = "#666666";

/** The viewer settings a new scene starts with. */
export const VIEW_DEFAULTS: Readonly<Json> = Object.freeze({
  crossSectionBackgroundColor: VIEW_MARGIN,
});

/** Layer types whose bounding box is drawn in the layer's annotation colour, and has no other annotations of its own. */
const OUTLINED = new Set(["image", "segmentation"]);

/** A layer specification with the outline colour filled in, if it is an image or a segmentation that names none. */
export function withLayerDefaults(spec: Json): Json {
  if (!OUTLINED.has(String(spec.type)) || spec.annotationColor !== undefined) return spec;
  return { ...spec, annotationColor: VIEW_OUTLINE };
}

/** A new scene's or an example's state with the view defaults filled in where it says nothing. */
export function withViewDefaults(ng: Json): Json {
  const out: Json = { ...VIEW_DEFAULTS, ...ng };
  if (Array.isArray(ng.layers)) out.layers = ng.layers.map((l) => (l !== null && typeof l === "object" ? withLayerDefaults(l as Json) : l));
  return out;
}

/**
 * The light ground the views show in the light theme (unless Settings ›
 * View › Black views in the light theme is on): behind the sections
 * --view-margin's light value, the 3-D view white.  Shown, never saved: a
 * link keeps its own.
 */
export const VIEW_GROUND_LIGHT = { sections: "#f3f3f3", view3d: "#ffffff" } as const;

/** A colour #rrggbb as Neuroglancer's 0–1 RGB. */
export function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
