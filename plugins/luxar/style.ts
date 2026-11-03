/**
 * How a layer is drawn in the Luxar style, as kept in the workspace (this
 * plugin's state): one entry per layer that has it on.  Pure data and
 * small helpers, so they can be tested without a page.
 */

/**
 * How the light of overlapping lines combines:
 *  - glow: added up and tone mapped, hidden by what is in front (Luxar's "luminous");
 *  - glow-through: added up, drawn over everything (Luxar's "additive");
 *  - emission: emission and absorption, so dense bundles darken what is behind them (Luxar's "volumetric");
 *  - solid: opaque shaded tubes, the nearest wins (Luxar's "opaque").
 */
export type Blending = "glow" | "glow-through" | "emission" | "solid";

/**
 * What colours a line: its direction (RGB of |tangent|), its object, a
 * vertex attribute through a colormap, one colour, or its segment's colour
 * in the layer (as Neuroglancer colours it: a colour chosen for it, the
 * layer's default colour, or the layer's hash of its id).
 */
export type ColourBy = "direction" | "object" | "attribute" | "solid" | "segment";

export type Colormap = "viridis" | "magma" | "inferno" | "plasma" | "turbo" | "grey";

export type ToneMap = "aces-hue" | "aces" | "reinhard" | "clamp";

export interface LayerStyle {
  on: boolean;
  blending: Blending;
  colourBy: ColourBy;
  /** The vertex attribute coloured by, when `colourBy` is "attribute" (its id in the store). */
  attribute?: string;
  colormap: Colormap;
  /** The colormap's range; undefined follows what has loaded. */
  range?: [number, number];
  /** "#rrggbb", for `colourBy` "solid". */
  colour: string;
  /** Line width in CSS pixels; point diameter for point clouds. */
  width: number;
  /** Brightness in stops (powers of two) before tone mapping. */
  exposure: number;
  /** 0 (soft, cusped) .. 1 (hard edged): Luxar's line sharpness; 0.5 is a Gaussian. */
  sharpness: number;
  /** How much a dense bundle absorbs, in emission blending. */
  absorption: number;
  toneMap: ToneMap;
  /** In the 2-D views, lines within half this of the section show, fading out towards it (mm). */
  slab: number;
  /** About how many vertices to keep loaded for a view, in millions: more is finer and slower. */
  detail: number;
  /** Dim each line by how many times over the lines drawn cover the view, so dense views glow rather than turn white, and keep their brightness as levels change. */
  autoBrightness: boolean;
}

export const DEFAULT_STYLE: LayerStyle = {
  on: true,
  blending: "glow",
  colourBy: "direction",
  colormap: "viridis",
  colour: "#ffb347",
  width: 2,
  exposure: 0,
  sharpness: 0.5,
  absorption: 1,
  toneMap: "aces-hue",
  slab: 4,
  detail: 2,
  autoBrightness: true,
};

const BLENDINGS: Blending[] = ["glow", "glow-through", "emission", "solid"];
const COLOUR_BY: ColourBy[] = ["direction", "object", "attribute", "solid", "segment"];
const COLORMAPS: Colormap[] = ["viridis", "magma", "inferno", "plasma", "turbo", "grey"];
const TONE_MAPS: ToneMap[] = ["aces-hue", "aces", "reinhard", "clamp"];

export const BLENDING_LABELS: [Blending, string][] = [
  ["glow", "Glow (additive, behind things in front)"],
  ["glow-through", "Glow through (additive, over everything)"],
  ["emission", "Emission and absorption"],
  ["solid", "Solid tubes"],
];
export const COLOUR_LABELS: [ColourBy, string][] = [
  ["direction", "Direction (x red, y green, z blue)"],
  ["object", "Each object its own colour"],
  ["attribute", "An attribute, through a colormap"],
  ["solid", "One colour"],
  ["segment", "The layer's segment colours"],
];
export const COLORMAP_LABELS: [Colormap, string][] = COLORMAPS.map((c) => [c, c === "grey" ? "Grey" : c[0].toUpperCase() + c.slice(1)]);
export const TONE_LABELS: [ToneMap, string][] = [
  ["aces-hue", "ACES filmic, keeping colour"],
  ["aces", "ACES filmic (bright light turns white)"],
  ["reinhard", "Reinhard"],
  ["clamp", "None (clamp)"],
];

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const pick = <T extends string>(v: unknown, options: T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** A layer's style from saved state, every field checked and defaulted. */
export function readStyle(raw: unknown): LayerStyle {
  const s = (raw ?? {}) as Partial<LayerStyle>;
  const d = DEFAULT_STYLE;
  const range = Array.isArray(s.range) && s.range.length === 2 && s.range.every((v) => typeof v === "number" && Number.isFinite(v)) ? ([s.range[0], s.range[1]] as [number, number]) : undefined;
  return {
    on: s.on !== false,
    blending: pick(s.blending, BLENDINGS, d.blending),
    colourBy: pick(s.colourBy, COLOUR_BY, d.colourBy),
    attribute: typeof s.attribute === "string" ? s.attribute : undefined,
    colormap: pick(s.colormap, COLORMAPS, d.colormap),
    range,
    colour: typeof s.colour === "string" && /^#[0-9a-f]{6}$/i.test(s.colour) ? s.colour : d.colour,
    width: num(s.width, 0.5, 40, d.width),
    exposure: num(s.exposure, -12, 12, d.exposure),
    sharpness: num(s.sharpness, 0, 1, d.sharpness),
    absorption: num(s.absorption, 0, 20, d.absorption),
    toneMap: pick(s.toneMap, TONE_MAPS, d.toneMap),
    slab: num(s.slab, 0.01, 1000, d.slab),
    detail: num(s.detail, 0.1, 50, d.detail),
    autoBrightness: s.autoBrightness !== false,
  };
}

/** The plugin's state: styles by layer name. */
export interface Saved {
  layers: Record<string, LayerStyle>;
  /** Momentum on rotating the 3-D view (kept here so a link brings it back). */
  momentum: boolean;
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as { layers?: Record<string, unknown>; momentum?: unknown };
  const layers: Record<string, LayerStyle> = {};
  if (s.layers !== null && typeof s.layers === "object") {
    for (const [name, style] of Object.entries(s.layers)) layers[name] = readStyle(style);
  }
  return { layers, momentum: s.momentum === true };
}

/** "#rrggbb" to linear-ish 0..1 RGB (the colour as picked; the tone map works on it as light). */
export function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const COLORMAP_INDEX: Record<Colormap, number> = { viridis: 0, magma: 1, inferno: 2, plasma: 3, turbo: 4, grey: 5 };
export const TONE_INDEX: Record<ToneMap, number> = { aces: 0, reinhard: 1, clamp: 2, "aces-hue": 3 };
export const COLOUR_INDEX: Record<ColourBy, number> = { direction: 0, object: 1, attribute: 2, solid: 3, segment: 4 };

/**
 * What the worker puts in each vertex's fourth value, for a style: an
 * attribute's value, or an object's hashed hue.
 */
export function scalarOf(style: LayerStyle): string {
  if (style.colourBy === "attribute" && style.attribute !== undefined) return `attribute:${style.attribute}`;
  // Otherwise each object's colour key: what "object" needs, and what points coloured "by direction" use (a point has none).
  return "object";
}
