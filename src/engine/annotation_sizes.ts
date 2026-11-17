/**
 * An annotation layer's point size and line width as shader controls
 * (Neuroglancer sets both only from the shader): the `#uicontrol` sliders
 * and the calls that use them, added to a shader that lacks them. Both take
 * fractions of a pixel.
 */

export interface AnnotationSize {
  /** The control's name in the shader. */
  name: string;
  /** Neuroglancer's own size when the shader sets none. */
  fallback: number;
  min: number;
  max: number;
  step: number;
  /** The calls that apply it. */
  calls: string[];
}

export const ANNOTATION_SIZES = {
  point: { name: "point_size", fallback: 5, min: 0.5, max: 40, step: 0.1, calls: ["setPointMarkerSize", "setEndpointMarkerSize"] },
  line: { name: "line_width", fallback: 1, min: 0.1, max: 20, step: 0.05, calls: ["setLineWidth", "setBoundingBoxBorderWidth"] },
} satisfies Record<string, AnnotationSize>;

const control = (name: string) => new RegExp(`^\\s*#uicontrol\\s+\\w+\\s+${name}\\b.*$`, "m");

/** Whether `shader` has the size's control. */
export function hasSize(shader: string, size: AnnotationSize): boolean {
  return control(size.name).test(shader);
}

/** The default the shader's control gives (the fallback when it has none). */
export function sizeDefault(shader: string, size: AnnotationSize): number {
  const line = shader.match(control(size.name))?.[0];
  const v = Number(line?.match(/default\s*=\s*([-+.\deE]+)/)?.[1]);
  return Number.isFinite(v) ? v : size.fallback;
}

/**
 * `shader` with the size's control (its default `value`) and its calls at the start of main(); a control already
 * there gets `value` as its default. Unchanged when it has no main().
 */
export function withSize(shader: string, size: AnnotationSize, value: number): string {
  const v = +value.toFixed(4);
  const decl = `#uicontrol float ${size.name} slider(min=${size.min}, max=${size.max}, step=${size.step}, default=${v})`;
  if (hasSize(shader, size)) return shader.replace(control(size.name), decl);
  const main = /void\s+main\s*\(\s*\)\s*\{/.exec(shader);
  if (main === null) return shader;
  const at = main.index + main[0].length;
  const calls = size.calls.map((c) => `\n  ${c}(${size.name});`).join("");
  return `${decl}\n${shader.slice(0, at)}${calls}${shader.slice(at)}`;
}
