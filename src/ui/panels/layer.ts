/**
 * The bottom of the Layers panel: the selected dataset's controls, as
 * Neuroglancer's own layer tabs (Display, Source, Segments, Annotations…,
 * whatever its type has), directly editable.  A one-line header names the
 * dataset and, when it is shown through several layers, which one; below
 * it, only when the data is not public (or failed to load), the sign-in
 * the layer reads it with, as in Settings → Sign-in.  The header is drawn
 * again only when what it shows changes, so a move of the views does not
 * close its drop-down.
 */
import type { DatasetInfo, LayerInfo } from "../../sdk/types.js";
import { region } from "../../sdk/dom.js";
import { h } from "../dom.js";
import { promptDialog } from "../overlays.js";
import type { Workbench } from "../workbench.js";
import { signInControl } from "./auth.js";
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
  const head = region((key: HeadKey | undefined) => (key === undefined ? null : drawHead(key)), { class: "layer-head" });
  const controls = h("div", { class: "ng-host layer-controls-host" });
  const empty = h("p", { class: "empty" }, "Select a layer above.");
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

  /** Another view of the dataset (the next channel, say), on the tab the one shown now is on. */
  const pickView = (from: string, to: string) => {
    const tab = engine.layerSpec(from)?.tab;
    if (typeof tab === "string" && engine.layerSpec(to)?.tab !== tab) {
      store.patchState(
        (ng) => {
          const target = (ng.layers as { name?: string; tab?: string }[] | undefined)?.find((l) => l.name === to);
          if (target !== undefined) target.tab = tab;
        },
        { quiet: true },
      );
    }
    store.selectLayer(to);
  };

  /** What the header shows, and what its sign-in drop-down is made from. */
  interface HeadKey {
    dataset: { id: string; name: string } | undefined;
    layer: string;
    type: string;
    error: string | undefined;
    views: string[];
    source: unknown;
    signIns: unknown;
  }

  const drawHead = (key: HeadKey) => {
    const signIn = signInControl(wb, key.layer, key.error === undefined);
    return [
      h(
        "button",
        {
          class: "title-button",
          type: "button",
          title: "Rename the dataset",
          onclick: async () => {
            if (key.dataset === undefined) return;
            const name = await promptDialog("Rename dataset", "Name", key.dataset.name);
            if (name !== undefined) store.renameDataset(key.dataset.id, name);
          },
        },
        key.dataset?.name ?? key.layer,
      ),
      h("span", { class: "type" }, key.type),
      key.error !== undefined ? h("p", { class: "empty error" }, key.error) : null,
      key.views.length > 1
        ? h(
            "div",
            { class: "segmented views" },
            ...key.views.map((name) =>
              h("button", { type: "button", "aria-pressed": String(name === key.layer), onclick: () => pickView(key.layer, name) }, name),
            ),
          )
        : null,
      signIn !== null ? h("div", { class: "layer-sign-in" }, h("span", {}, "Sign-in"), signIn) : null,
    ];
  };

  const render = () => {
    const { dataset, layer } = layerTarget(wb);
    // Nothing to say with nothing in the scene: the list above says it.
    empty.hidden = layer !== undefined || store.sceneDatasets().length === 0;
    head.hidden = layer === undefined;
    if (layer === undefined) {
      head.update(undefined);
      mount(undefined);
      return;
    }
    const views = store.sceneDatasets().find((d) => d.dataset.id === dataset?.id)?.layers ?? [layer.name];
    head.update({
      dataset: dataset && { id: dataset.id, name: dataset.name },
      layer: layer.name,
      type: kindLabel(layer.type !== "new" ? layer.type : dataset?.kind),
      error: layer.error,
      views,
      source: engine.layerSpec(layer.name)?.source,
      // The sign-ins the drop-down offers: the rules, the Google accounts and the providers.
      signIns: [wb.rules.list(), wb.google.accounts().map((a) => a.email), wb.google.defaultAccount(), wb.auth.list().map((p) => p.id)],
    });
    mount(layer.name);
  };

  const offs = [engine.onSelectionChanged(render), engine.onLayersChanged(render), store.onChange(render)];
  render();
  return () => {
    offs.forEach((off) => off());
    unmount?.();
  };
}
