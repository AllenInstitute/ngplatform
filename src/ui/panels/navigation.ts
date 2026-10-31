/**
 * The View tab: where the views look, and how they are laid out.  Position
 * editing is Neuroglancer's own position widget, moved out of the viewer.
 */
import { LAYOUTS } from "../../engine/engine.js";
import { clear, h, icon } from "../dom.js";
import type { Workbench } from "../workbench.js";
import { length } from "./format.js";

const OPTIONS: [string, string][] = [
  ["showAxisLines", "Axis lines"],
  ["showScaleBar", "Scale bar"],
  ["showSlices", "Cross sections in 3D"],
  ["showDefaultAnnotations", "Bounding boxes"],
  ["wireFrame", "Wire frame"],
  ["enableAdaptiveDownsampling", "Adaptive downsampling"],
];

export function renderNavigationPanel(host: HTMLElement, wb: Workbench): () => void {
  const { engine } = wb;
  const position = h("div", { class: "ng-host position-host" });
  const zoomFacts = h("dl", { class: "facts" });
  const layouts = h("div", { class: "layout-grid", role: "group", "aria-label": "Layout" });
  const options = h("div", { class: "options" });

  host.append(
    h("div", { class: "section" }, h("h3", { class: "section-title" }, "Position"), position),
    h(
      "div",
      { class: "section" },
      h("h3", { class: "section-title" }, "Zoom"),
      zoomFacts,
      h(
        "div",
        { class: "row-actions" },
        h("button", { class: "btn outline small", type: "button", onclick: () => engine.zoom(0.5) }, icon("zoomin"), "In"),
        h("button", { class: "btn outline small", type: "button", onclick: () => engine.zoom(2) }, icon("zoomout"), "Out"),
        h("button", { class: "btn outline small", type: "button", onclick: () => engine.resetOrientation() }, icon("reset"), "Reset rotation"),
      ),
    ),
    h("div", { class: "section" }, h("h3", { class: "section-title" }, "Layout"), layouts),
    h("div", { class: "section" }, h("h3", { class: "section-title" }, "Display"), options),
  );
  const unmount = engine.mountPosition(position);

  const render = () => {
    const nav = engine.navigation();
    // A scale is the size of one screen pixel, in the first dimension's unit.
    const unitScale = nav.units[0] === "m" ? nav.scales[0] : undefined;
    const describe = (scale: number) => (unitScale !== undefined ? `${length(scale * unitScale)} per pixel` : `${scale.toPrecision(3)} per pixel`);
    clear(
      zoomFacts,
      h("dt", {}, "2D views"),
      h("dd", {}, describe(nav.crossSectionScale)),
      h("dt", {}, "3D view"),
      h("dd", {}, describe(nav.projectionScale)),
    );
    clear(
      layouts,
      ...LAYOUTS.map(([value, label]) =>
        h(
          "button",
          {
            class: "layout-btn",
            type: "button",
            "aria-pressed": String(nav.layout === value),
            onclick: () => wb.run("view.layout", { layout: value }),
          },
          label,
        ),
      ),
    );
    const values = engine.viewOptions();
    clear(
      options,
      ...OPTIONS.map(([key, label]) => {
        const box = h("input", { type: "checkbox" });
        box.checked = values[key] === true;
        box.addEventListener("change", () => engine.setViewOption(key, box.checked));
        return h("label", { class: "field check" }, box, h("span", {}, label));
      }),
    );
  };
  const offs = [engine.onNavigationChanged(render), engine.onStateChanged(render)];
  render();
  return () => {
    offs.forEach((off) => off());
    unmount();
  };
}
