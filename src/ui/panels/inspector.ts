/**
 * The Inspector tab: the selected dataset and its controls.
 *
 * The controls are Neuroglancer's own, for the layer's type (Source,
 * Rendering, Segments, Annotations, …), mounted here instead of in a side
 * panel over the views.  Below them come sections the platform and plugins
 * contribute for the dataset.
 */
import type { InspectorTarget } from "../../sdk/types.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { promptDialog, showMenu } from "../overlays.js";
import type { Workbench } from "../workbench.js";
import { kindLabel } from "./format.js";

export function inspectorTarget(wb: Workbench): InspectorTarget {
  const name = wb.engine.selectedLayer();
  const layer = name === undefined ? undefined : wb.engine.layers().find((l) => l.name === name);
  const dataset = name === undefined ? undefined : wb.store.datasetOfLayer(name);
  return {
    dataset: dataset && { id: dataset.id, name: dataset.name, source: dataset.source, kind: dataset.kind },
    layer: layer && { ...layer, dataset: dataset?.id },
  };
}

export function renderInspectorPanel(host: HTMLElement, wb: Workbench): () => void {
  const { engine, store } = wb;
  const head = h("div", { class: "inspector-head" });
  const views = h("div", { class: "views" });
  const controls = h("div", { class: "ng-host layer-controls-host" });
  const sections = h("div", { class: "inspector-sections" });
  const empty = h(
    "div",
    { class: "empty-state" },
    h("p", { class: "empty" }, h("strong", {}, "Nothing selected. "), "Choose a dataset in the Datasets tab to see its controls here."),
  );
  host.append(empty, head, views, controls, sections);

  let mountedFor: { name: string; token: object | undefined } | undefined;
  let unmountControls: (() => void) | undefined;
  let sectionDisposers: (() => void)[] = [];
  let sectionsFor = "";

  const mountControls = (name: string | undefined) => {
    const token = name === undefined ? undefined : engine.layerToken(name);
    if (mountedFor?.name === name && mountedFor?.token === token) return;
    unmountControls?.();
    unmountControls = undefined;
    controls.replaceChildren();
    mountedFor = name === undefined ? undefined : { name, token };
    if (name !== undefined && token !== undefined) unmountControls = engine.mountLayerControls(controls, name);
  };

  const renderSections = (target: InspectorTarget) => {
    const signature = JSON.stringify([target.dataset?.id, target.dataset?.kind, target.layer?.name, target.layer?.type, wb.inspector.list().map((s) => s.id)]);
    if (signature === sectionsFor) return;
    sectionsFor = signature;
    sectionDisposers.splice(0).forEach((d) => d());
    sections.replaceChildren();
    if (target.layer === undefined) return;
    for (const section of wb.inspector.ordered()) {
      if (!wb.context.matches(section.when)) continue;
      const body = h("div", { class: "section-body" });
      const el = h("details", { class: "section inspector-section", open: true }, h("summary", { class: "section-title" }, section.title), body);
      sections.append(el);
      Promise.resolve(section.render(body, target)).then(
        (d) => {
          if (typeof d === "function") sectionDisposers.push(d);
          if (body.childElementCount === 0 && (body.textContent ?? "") === "") el.remove();
        },
        (e) => body.replaceChildren(h("p", { class: "empty error" }, `Failed: ${(e as Error).message}`)),
      );
    }
  };

  const render = () => {
    const target = inspectorTarget(wb);
    const { dataset, layer } = target;
    empty.hidden = layer !== undefined;
    head.hidden = views.hidden = layer === undefined;
    if (layer === undefined) {
      mountControls(undefined);
      renderSections(target);
      return;
    }
    const entry = store.sceneDatasets().find((d) => d.dataset.id === dataset?.id);
    const title = dataset?.name ?? layer.name;
    const visible = layer.visible;
    clear(
      head,
      h(
        "div",
        { class: "inspector-title" },
        h("span", { class: "eyebrow" }, kindLabel(layer.type !== "new" ? layer.type : dataset?.kind)),
        h(
          "button",
          {
            class: "title-button",
            type: "button",
            title: "Rename",
            onclick: async () => {
              if (dataset === undefined) return;
              const name = await promptDialog("Rename dataset", "Name", dataset.name);
              if (name !== undefined) store.renameDataset(dataset.id, name);
            },
          },
          title,
        ),
      ),
      iconButton(visible ? "eye" : "eye-off", visible ? "Hide" : "Show", () => store.setLayerVisible(layer.name, !visible)),
      iconButton("more", "More actions", (e) =>
        showMenu(e.currentTarget as HTMLElement, [
          { label: "Add another view of this dataset", disabled: dataset === undefined, run: () => dataset && store.addLayerView(dataset.id, layer.name) },
          {
            label: "Rename this view…",
            run: async () => {
              const name = await promptDialog("Rename view", "Name", layer.name);
              if (name !== undefined) store.renameLayer(layer.name, name);
            },
          },
          "-",
          { label: "Remove this view", danger: true, run: () => store.removeLayer(layer.name) },
        ]),
      ),
    );
    // A dataset shown through several layers: choose which one to control.
    if (entry !== undefined && entry.layers.length > 1) {
      clear(
        views,
        h("span", { class: "eyebrow" }, "View"),
        h(
          "div",
          { class: "segmented" },
          ...entry.layers.map((name) =>
            h("button", { type: "button", "aria-pressed": String(name === layer.name), onclick: () => store.selectLayer(name) }, name),
          ),
        ),
      );
    } else {
      clear(views);
    }
    if (layer.error !== undefined) {
      head.append(h("p", { class: "empty error" }, icon("close"), layer.error));
    }
    mountControls(layer.name);
    renderSections(target);
  };

  const offs = [
    engine.onSelectionChanged(render),
    engine.onLayersChanged(render),
    store.onChange(render),
    wb.inspector.onChange(() => {
      sectionsFor = "";
      render();
    }),
  ];
  render();
  return () => {
    offs.forEach((off) => off());
    unmountControls?.();
    sectionDisposers.forEach((d) => d());
  };
}
