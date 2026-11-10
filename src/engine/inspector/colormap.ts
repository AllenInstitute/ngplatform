/**
 * An image layer's colour map, in its Display tab: a menu that writes the
 * shader for the chosen map (../colormaps.ts), keeping the contrast range.
 * "Custom" is whatever else the shader says, and choosing it changes
 * nothing.
 */
import { colormapOf, colormapShader, COLORMAPS } from "../colormaps.js";
import { DataType, type ImageUserLayer } from "../neuroglancer.js";
import { el, type Scope, type Watch } from "./ui.js";

const SIGNED = new Set<number>([DataType.INT8, DataType.INT16, DataType.INT32, DataType.FLOAT32]);

export function colormapControl(scope: Scope, layer: ImageUserLayer): HTMLSelectElement {
  const shader = layer.fragmentMain as Watch<string>;
  const dataType = layer.dataType as Watch<number | undefined>;
  const options = () => ({ signed: dataType.value !== undefined && SIGNED.has(dataType.value) });
  const select = el(
    "select",
    { class: "text-input", "aria-label": "Colour map" },
    ...COLORMAPS.map((m) => el("option", { value: m.id }, m.label)),
    el("option", { value: "" }, "Custom"),
  ) as HTMLSelectElement;
  select.addEventListener("change", () => {
    if (select.value === "") return;
    const text = colormapShader(select.value, shader.value, options());
    if (text !== undefined && text !== shader.value) shader.value = text;
  });
  scope.watch([shader, dataType], () => {
    select.value = colormapOf(shader.value, options()) ?? "";
  });
  return select;
}
