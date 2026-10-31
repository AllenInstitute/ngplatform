/**
 * The Layer tab: the selected dataset's controls, as Neuroglancer's own
 * layer tabs (Source, Render, Seg., Annotations…, whatever its type has),
 * at full height and directly editable.  A one-line header names the
 * dataset and, when it is shown through several layers, which one.
 */
import type { DatasetInfo, LayerInfo } from "../../sdk/types.js";
import { clear, h } from "../dom.js";
import { promptDialog } from "../overlays.js";
import type { Workbench } from "../workbench.js";
import { kindLabel } from "./format.js";

export interface LayerTarget {
  dataset: DatasetInfo | undefined;
  layer: LayerInfo | undefined;
}

/** The selected layer and the dataset it shows. */
export function layerTarget(wb: Workbench): LayerTarget {
  const name = wb.engine.selectedLayer();
  const layer = name === undefined ? undefined : wb.engine.layers().find((l) => l.name === name);
  const dataset = name === undefined ? undefined : wb.store.datasetOfLayer(name);
  return {
    dataset: dataset && { id: dataset.id, name: dataset.name, source: dataset.source, kind: dataset.kind },
    layer: layer && { ...layer, dataset: dataset?.id },
  };
}

export function renderLayerPanel(host: HTMLElement, wb: Workbench): () => void {
  const { engine, store } = wb;
  const head = h("div", { class: "layer-head" });
  const controls = h("div", { class: "ng-host layer-controls-host" });
  const empty = h(
    "div",
    { class: "empty-state" },
    h("p", { class: "empty" }, h("strong", {}, "No dataset selected. "), "Choose one in the Datasets tab to see its controls here."),
  );
  host.append(empty, head, controls);

  let mountedFor: { name: string; token: object | undefined } | undefined;
  let unmount: (() => void) | undefined;

  const mount = (name: string | undefined) => {
    const token = name === undefined ? undefined : engine.layerToken(name);
    if (mountedFor?.name === name && mountedFor?.token === token) return;
    unmount?.();
    unmount = undefined;
    controls.replaceChildren();
    mountedFor = name === undefined ? undefined : { name, token };
    if (name !== undefined && token !== undefined) unmount = engine.mountLayerControls(controls, name);
  };

  const render = () => {
    const { dataset, layer } = layerTarget(wb);
    empty.hidden = layer !== undefined;
    head.hidden = layer === undefined;
    if (layer === undefined) {
      mount(undefined);
      return;
    }
    const views = store.sceneDatasets().find((d) => d.dataset.id === dataset?.id)?.layers ?? [layer.name];
    clear(
      head,
      h(
        "button",
        {
          class: "title-button",
          type: "button",
          title: "Rename the dataset",
          onclick: async () => {
            if (dataset === undefined) return;
            const name = await promptDialog("Rename dataset", "Name", dataset.name);
            if (name !== undefined) store.renameDataset(dataset.id, name);
          },
        },
        dataset?.name ?? layer.name,
      ),
      h("span", { class: "type" }, kindLabel(layer.type !== "new" ? layer.type : dataset?.kind)),
      layer.error !== undefined ? h("p", { class: "empty error" }, layer.error) : null,
      views.length > 1
        ? h(
            "div",
            { class: "segmented views" },
            ...views.map((name) =>
              h("button", { type: "button", "aria-pressed": String(name === layer.name), onclick: () => store.selectLayer(name) }, name),
            ),
          )
        : null,
    );
    mount(layer.name);
  };

  const offs = [engine.onSelectionChanged(render), engine.onLayersChanged(render), store.onChange(render)];
  render();
  return () => {
    offs.forEach((off) => off());
    unmount?.();
  };
}
