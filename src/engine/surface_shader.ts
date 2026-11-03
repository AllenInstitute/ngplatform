/**
 * The shader for a surface drawn as Freeview draws one: curvature in two
 * greys (Freeview's binary curvature: sulci dark, gyri light), an overlay
 * (thickness, a statistic) on top where its magnitude passes a threshold,
 * in a colour map, and a parcellation's own colours over both.  The Render
 * tab's Surface controls write it into a Zarr Vectors layer's shader; the
 * threshold, the overlay's top and the parcellation's opacity are shader
 * controls, so dragging them recompiles nothing.
 *
 * The choices are kept in the first line (`// Surface: {…}`), so the
 * controls show them again; a shader edited by hand still reads back as
 * long as that line is there.  Pure text, no Neuroglancer: tested in Node.
 */
import { COLORMAPS } from "./colormaps.js";

export interface SurfaceLook {
  /** Another surface of the same vertices to draw them at (a vec3 attribute, `coords_inflated`), as zarr-vectors-tools keeps them. */
  position?: string;
  /** The attribute drawn as binary curvature (curv, or sulc), or none: the layer's colour. */
  curvature?: string;
  /** The overlay's attribute. */
  overlay?: string;
  /** The overlay's colour map: "heat" (Freeview's, by magnitude) or a map with a definition. */
  colormap?: string;
  /** The overlay's slider range and starting threshold and top. */
  range?: [number, number];
  threshold?: number;
  max?: number;
  /** The parcellation's attribute. */
  parcellation?: string;
  /** Colour the outlines in the 2-D views by the values too (else the layer's colour, as Freeview). */
  outlines?: boolean;
}

const HEADER = "// Surface: ";

/** Overlay colour maps offered: Freeview's heat, then the image layers' maps that are one function. */
export const SURFACE_COLORMAPS: { id: string; label: string }[] = [
  { id: "heat", label: "Heat (threshold, max)" },
  ...COLORMAPS.filter((m) => m.definition !== undefined).map((m) => ({ id: m.id, label: m.label })),
];

function num(v: number): string {
  const s = String(Number(v.toPrecision(4)));
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** The shader for `look`; `prop_<name>()` and `lut_<name>()` are the layer's (see dense_frontend.ts). */
export function surfaceShader(look: SurfaceLook): string {
  const lines = [`${HEADER}${JSON.stringify(look)}`];
  if (look.position !== undefined) lines.push(`#define ZV_POSITION ${look.position}`);
  const body: string[] = [];
  if (look.outlines !== true) {
    body.push(
      "#ifdef ZV_SECTION",
      "  // The outline on the 2-D views in the layer's colour, as Freeview draws it.",
      "  emitDefault();",
      "  return;",
      "#endif",
    );
  }
  body.push(
    look.curvature !== undefined
      ? `  vec3 colour = prop_${look.curvature}() > 0.0 ? vec3(0.38) : vec3(0.62);`
      : "  vec3 colour = segmentColor().rgb;",
  );
  if (look.overlay !== undefined) {
    const [lo, hi] = look.range ?? [0, 1];
    const span = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const step = num(span / 1000);
    const heat = (look.colormap ?? "heat") === "heat";
    // Heat is by magnitude, as Freeview's: the threshold and top run from 0.
    const sliderLo = heat ? 0 : lo;
    lines.push(
      `#uicontrol float threshold slider(min=${num(sliderLo)}, max=${num(heat ? span : hi)}, step=${step}, default=${num(look.threshold ?? sliderLo)})`,
      `#uicontrol float overlay_max slider(min=${num(sliderLo)}, max=${num(heat ? span : hi)}, step=${step}, default=${num(look.max ?? (heat ? span : hi))})`,
    );
    if (heat) {
      lines.push(`vec3 surfaceHeat(float t, bool negative) {
  // Freeview's heat: red to yellow above the threshold, blue to cyan below minus it.
  return negative ? mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), t) : mix(vec3(1.0, 0.0, 0.0), vec3(1.0, 1.0, 0.0), t);
}`);
      body.push(
        `  float value = prop_${look.overlay}();`,
        "  if (abs(value) >= threshold) {",
        "    colour = surfaceHeat(clamp((abs(value) - threshold) / max(overlay_max - threshold, 1e-6), 0.0, 1.0), value < 0.0);",
        "  }",
      );
    } else {
      const definition = COLORMAPS.find((m) => m.id === look.colormap)?.definition ?? "";
      lines.push(definition);
      body.push(
        `  float value = prop_${look.overlay}();`,
        "  if (value >= threshold) {",
        "    colour = colormap(clamp((value - threshold) / max(overlay_max - threshold, 1e-6), 0.0, 1.0));",
        "  }",
      );
    }
  }
  if (look.parcellation !== undefined) {
    lines.push("#uicontrol float parcellation_opacity slider(min=0, max=1, step=0.01, default=1)");
    body.push(`  vec4 parcel = lut_${look.parcellation}(prop_${look.parcellation}());`, "  colour = mix(colour, parcel.rgb, parcel.a * parcellation_opacity);");
  }
  body.push("  emitRGB(colour);");
  return `${lines.join("\n")}\nvoid main() {\n${body.join("\n")}\n}\n`;
}

/** The look a shader was written for, from its first line; undefined for any other shader. */
export function surfaceLookOf(shader: string): SurfaceLook | undefined {
  const first = shader.split("\n", 1)[0];
  if (!first.startsWith(HEADER)) return undefined;
  try {
    const look = JSON.parse(first.slice(HEADER.length));
    return look !== null && typeof look === "object" ? (look as SurfaceLook) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where an overlay's controls start, from its values: the slider spans
 * them, the threshold at the 25th percentile of the magnitude and the top at
 * the 98th for heat, else the 2nd and 98th percentiles.
 */
export function overlayRange(values: ArrayLike<number>, colormap = "heat"): Pick<SurfaceLook, "range" | "threshold" | "max"> {
  const finite: number[] = [];
  for (let i = 0; i < values.length; ++i) if (Number.isFinite(values[i])) finite.push(values[i]);
  if (finite.length === 0) return { range: [0, 1], threshold: 0, max: 1 };
  const heat = colormap === "heat";
  const sorted = (heat ? finite.map(Math.abs) : finite).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of finite) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { range: [lo, hi === lo ? lo + 1 : hi], threshold: at(heat ? 0.25 : 0.02), max: at(0.98) };
}
