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
  /**
   * In the 2-D views, lines within half this of the section show, fading
   * out towards it (mm); undefined follows the data's size (`autoSlab`), so
   * a slab suits EM in nanometres as well as a brain in millimetres.
   */
  slab?: number;
  /** About how many vertices to keep loaded for a view, in millions: more is finer and slower. */
  detail: number;
  /** Dim each line by how many times over the lines drawn cover the view, so dense views glow rather than turn white, and keep their brightness as levels change. */
  autoBrightness: boolean;
  /** Luxar's bloom: how much of the bright light, blurred, glows around it (0, off, to 3). */
  bloom: number;
  /**
   * Meshes in glow, 3-D: how far behind the nearest surface light still
   * shows (it fades by e over this share of the layer's extent), so a
   * folded surface reads as a surface; 0 adds every layer up as lines do.
   */
  glowDepth: number;
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
  detail: 2,
  autoBrightness: true,
  bloom: 0,
  glowDepth: 0.02,
};

const BLENDINGS: Blending[] = ["glow", "glow-through", "emission", "solid"];
const COLOUR_BY: ColourBy[] = ["direction", "object", "attribute", "solid", "segment"];
const COLORMAPS: Colormap[] = ["viridis", "magma", "inferno", "plasma", "turbo", "grey"];
const TONE_MAPS: ToneMap[] = ["aces-hue", "aces", "reinhard", "clamp"];

export const BLENDING_LABELS: [Blending, string][] = [
  ["glow", "Glow (behind what is in front)"],
  ["glow-through", "Glow through (over everything)"],
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

/**
 * A layer's style from saved state, every field checked and defaulted.
 * `legacy`: saved before the slab followed the data, when every style
 * saved the default of then, 4 mm, which is read as following the data.
 */
export function readStyle(raw: unknown, legacy = false): LayerStyle {
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
    slab: typeof s.slab === "number" && Number.isFinite(s.slab) && !(legacy && s.slab === LEGACY_SLAB) ? Math.min(MAX_SLAB, Math.max(MIN_SLAB, s.slab)) : undefined,
    detail: num(s.detail, 0.1, 50, d.detail),
    autoBrightness: s.autoBrightness !== false,
    bloom: num(s.bloom, 0, 3, d.bloom),
    glowDepth: num(s.glowDepth, 0, 0.5, d.glowDepth),
  };
}

/** The plugin's state: styles by layer name. */
export interface Saved {
  /** 2: the slab follows the data unless set (state without it is read as `readStyle`'s legacy). */
  version: 2;
  layers: Record<string, LayerStyle>;
  /** Momentum on rotating the 3-D view (kept here so a link brings it back). */
  momentum: boolean;
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as { version?: unknown; layers?: Record<string, unknown>; momentum?: unknown };
  const layers: Record<string, LayerStyle> = {};
  if (s.layers !== null && typeof s.layers === "object") {
    for (const [name, style] of Object.entries(s.layers)) layers[name] = readStyle(style, s.version !== 2);
  }
  return { version: 2, layers, momentum: s.momentum === true };
}

// ---------------------------------------------------------------- slab

/** The slab every style saved before it followed the data (mm). */
const LEGACY_SLAB = 4;
/** A slab is kept between these (mm): a tenth of a nanometre and ten metres. */
const MIN_SLAB = 1e-7;
const MAX_SLAB = 1e4;

/** What a store says of its size: its axes' units and scales and its bounds, in its own coordinates. */
export interface StoreSize {
  axisUnits: string[];
  axisScales: number[];
  bounds: { lower: number[]; upper: number[] };
}

/**
 * A store's size along each axis in millimetres: its bounds times its
 * scales, in metres (a unit with an SI prefix is read as metres), or with
 * no unit read as millimetres, as the 2-D views read a dimension without one.
 */
export function extentMm(store: StoreSize): number[] {
  return store.bounds.lower.map((lo, i) => {
    const scale = store.axisScales[i] ?? 1;
    return Math.abs((store.bounds.upper[i] ?? lo) - lo) * (store.axisUnits[i] === "m" ? scale * 1000 : scale);
  });
}

/**
 * The slab that follows the data (mm): a fortieth of its mean size, to one
 * significant figure: 4 mm for a human brain's tractogram, 30 µm for a
 * cubic millimetre of EM, a few µm for one cell's meshes.
 */
export function autoSlab(extent: number[]): number {
  const sizes = extent.filter((v) => Number.isFinite(v) && v > 0);
  if (sizes.length === 0) return LEGACY_SLAB;
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  return Math.min(MAX_SLAB, Math.max(MIN_SLAB, Number((mean / 40).toPrecision(1))));
}

/** A layer's slab (mm): the one set, or the one that follows the data. */
export function slabOf(style: LayerStyle, extent: number[]): number {
  return style.slab ?? autoSlab(extent);
}

/** How the slab's slider reads: in `unit` (`perUnit` mm each), from `min` to `max` by `step`. */
export interface SlabScale {
  unit: "mm" | "µm" | "nm";
  perUnit: number;
  min: number;
  max: number;
  step: number;
}

/** A 1, 2 or 5 times a power of ten, the nearest to `v` (as ratios). */
function nice(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return Number(((m < Math.sqrt(2) ? 1 : m < Math.sqrt(10) ? 2 : m < Math.sqrt(50) ? 5 : 10) * p).toPrecision(1));
}

/**
 * The slab's slider for data whose own slab is `auto` (mm): in the unit
 * that reads it in ones to hundreds, from about an eighth of it to ten
 * times it (0.5 to 40 mm for a brain; its number box takes any value).
 */
export function slabScale(auto: number): SlabScale {
  const [unit, perUnit] = auto >= 1 ? (["mm", 1] as const) : auto >= 1e-3 ? (["µm", 1e-3] as const) : (["nm", 1e-6] as const);
  const a = auto / perUnit;
  const step = nice(a / 8);
  return { unit, perUnit, min: step, max: Number((10 * a).toPrecision(3)), step };
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
