/**
 * The shader a Zarr Vectors layer is coloured by (points, lines, meshes):
 * by its segments (the layer's own colours), by a group the vertex belongs
 * to (a tier of a taxonomy: each group in its stored colour or a palette's,
 * groups not chosen hidden), or by an attribute through a colour map
 * between a low and a high value, values outside that window hidden or
 * drawn at its ends.  The Display tab's Colour by controls write it
 * (inspector/colour_by.ts); the low and high are shader controls, so
 * dragging them recompiles nothing.
 *
 * The choices are kept in the first line (`// Colour by: {…}`), so the
 * controls show them again; a shader edited by hand still reads back as
 * long as that line is there.  Pure text, no Neuroglancer: tested in Node.
 */
import { COLORMAPS } from "./colormaps.js";

export interface ColourByLook {
  by: "segment" | "group" | "attribute";
  /** By group: the tier's index attribute (its shader id) and colour attribute (0xRRGGBB), and which groups show. */
  group?: {
    tier: string;
    attribute: string;
    colorAttribute?: string;
    /** "stored": each group's colour from the store; "palette": one per group from a fixed palette. */
    colours: "stored" | "palette";
    /** The groups shown, by index; undefined: all. */
    shown?: number[];
  };
  /** By attribute: its shader id, the colour map, the controls' range and the window. */
  attribute?: string;
  colormap?: string;
  range?: [number, number];
  low?: number;
  high?: number;
  /** Hide what lies outside [low, high] (else drawn in the map's end colours). */
  hideOutside?: boolean;
}

const HEADER = "// Colour by: ";

/** The colour maps offered: the image layers' maps that are one function. */
export const COLOUR_BY_COLORMAPS: { id: string; label: string }[] = COLORMAPS.filter((m) => m.definition !== undefined).map((m) => ({ id: m.id, label: m.label }));

function num(v: number): string {
  const s = String(Number(v.toPrecision(6)));
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Sorted indices as runs [first, last]: a list of groups as few comparisons as it allows. */
export function runs(indices: readonly number[]): [number, number][] {
  const sorted = [...new Set(indices.filter((i) => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && i === last[1] + 1) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

/** The most runs of shown groups a shader tests (past this, every group shows and the controls say so). */
export const MAX_RUNS = 256;

/** The shader for `look`; `prop_<id>()` reads the layer's attributes (dense_frontend.ts). */
export function colourShader(look: ColourByLook): string {
  const lines = [`${HEADER}${JSON.stringify(look)}`];
  const body: string[] = [];
  if (look.by === "group" && look.group !== undefined) {
    const g = look.group;
    body.push(`  float group = prop_${g.attribute}();`);
    const shown = g.shown === undefined ? undefined : runs(g.shown);
    if (shown !== undefined && shown.length <= MAX_RUNS) {
      lines.push(
        "bool zvShown(float group) {",
        "  int k = int(floor(group + 0.5));",
        ...shown.map(([a, b]) => (a === b ? `  if (k == ${a}) return true;` : `  if (k >= ${a} && k <= ${b}) return true;`)),
        "  return false;",
        "}",
      );
      body.push("  if (!zvShown(group)) discard;");
    }
    if (g.colours === "stored" && g.colorAttribute !== undefined) {
      lines.push(
        "vec3 zvPacked(float packed) {",
        "  // 0xRRGGBB, exact as a float up to 2^24.",
        "  float v = floor(packed + 0.5);",
        "  return vec3(floor(v / 65536.0), mod(floor(v / 256.0), 256.0), mod(v, 256.0)) / 255.0;",
        "}",
      );
      body.push(`  emitRGB(zvPacked(prop_${g.colorAttribute}()));`);
    } else {
      lines.push(
        "vec3 zvPalette(float group) {",
        "  // A colour per group: hues spread by the golden angle, two lightnesses alternating.",
        "  float k = floor(group + 0.5);",
        "  float h = fract(k * 0.61803398875);",
        "  vec3 c = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);",
        "  return mix(vec3(1.0), c, mod(k, 2.0) < 1.0 ? 0.75 : 0.55) * (mod(floor(k / 2.0), 2.0) < 1.0 ? 1.0 : 0.8);",
        "}",
      );
      body.push("  emitRGB(zvPalette(group));");
    }
  } else if (look.by === "attribute" && look.attribute !== undefined) {
    const [lo, hi] = look.range ?? [0, 1];
    const span = hi - lo || 1;
    const step = num(Math.abs(span) / 1000);
    lines.push(
      `#uicontrol float low slider(min=${num(lo)}, max=${num(hi)}, step=${step}, default=${num(look.low ?? lo)})`,
      `#uicontrol float high slider(min=${num(lo)}, max=${num(hi)}, step=${step}, default=${num(look.high ?? hi)})`,
    );
    const definition = COLORMAPS.find((m) => m.id === (look.colormap ?? "viridis"))?.definition ?? COLORMAPS.find((m) => m.definition !== undefined)?.definition ?? "";
    lines.push(definition);
    body.push(`  float value = prop_${look.attribute}();`);
    if (look.hideOutside) body.push("  if (!(value >= low && value <= high)) discard;");
    body.push("  emitRGB(colormap(clamp((value - low) / max(high - low, 1e-12), 0.0, 1.0)));");
  } else {
    body.push("  emitDefault();");
  }
  return `${lines.join("\n")}\nvoid main() {\n${body.join("\n")}\n}\n`;
}

/** The look a shader was written for, from its first line; undefined for any other shader. */
export function colourLookOf(shader: string): ColourByLook | undefined {
  const first = shader.split("\n", 1)[0];
  if (!first.startsWith(HEADER)) return undefined;
  try {
    const look = JSON.parse(first.slice(HEADER.length));
    return look !== null && typeof look === "object" && typeof look.by === "string" ? (look as ColourByLook) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where an attribute's controls start, from the values drawn: the sliders span them (finite ones), the
 * window from the 2nd to the 98th percentile.
 */
export function attributeRange(values: ArrayLike<number>): Pick<ColourByLook, "range" | "low" | "high"> {
  const finite: number[] = [];
  for (let i = 0; i < values.length; ++i) if (Number.isFinite(values[i])) finite.push(values[i]);
  if (finite.length === 0) return { range: [0, 1], low: 0, high: 1 };
  finite.sort((a, b) => a - b);
  const at = (q: number) => finite[Math.min(finite.length - 1, Math.floor(q * (finite.length - 1)))];
  const lo = finite[0];
  const hi = finite[finite.length - 1] === lo ? lo + 1 : finite[finite.length - 1];
  return { range: [lo, hi], low: at(0.02), high: Math.max(at(0.98), at(0.02)) };
}
