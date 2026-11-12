/**
 * A dataset's controls in its card in the Layers panel (`datasetBody`), and
 * the layer selected (`layerTarget`, for the commands that act on it).
 */
import type { DatasetInfo, LayerInfo } from "../../sdk/types.js";
import { region } from "../../sdk/dom.js";
import { h } from "../dom.js";
import type { Workbench } from "../workbench.js";
import { signInControl } from "./auth.js";

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

/**
 * A dataset's card body (./datasets.ts): the controls of the layer it is
 * shown through (the selected one of its views, else its first), as the
 * layer's tabs (Rendering, Source, Annotations…); above them, only when the data is not public (or failed to
 * load), the sign-in the layer reads it with, as in Settings → Sign-in.
 * `update` brings it up to the state; the sign-in is drawn again only when
 * what it shows changes, so a move of the views does not close its
 * drop-down.
 */
export function datasetBody(wb: Workbench, datasetId: string): { element: HTMLElement; update(): void; dispose(): void } {
  const { engine, store } = wb;
  const signIn = region((key: SignInKey | undefined) => {
    if (key === undefined) return null;
    const control = signInControl(wb, key.layer, key.ok);
    return control === null ? null : h("div", { class: "layer-sign-in" }, h("span", {}, "Sign-in"), control);
  });
  const controls = h("div", { class: "ng-host layer-controls-host" });
  const element = h("div", { class: "ds-body" }, signIn, controls);

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

  /** What the sign-in drop-down is made from. */
  interface SignInKey {
    layer: string;
    ok: boolean;
    source: unknown;
    signIns: unknown;
  }

  const update = () => {
    const entry = store.sceneDatasets().find((d) => d.dataset.id === datasetId);
    const selected = engine.selectedLayer();
    const name = entry === undefined ? undefined : selected !== undefined && entry.layers.includes(selected) ? selected : entry.layers[0];
    const layer = name === undefined ? undefined : engine.layers().find((l) => l.name === name);
    signIn.update(
      layer === undefined
        ? undefined
        : {
            layer: layer.name,
            ok: layer.error === undefined,
            source: engine.layerSpec(layer.name)?.source,
            // The sign-ins the drop-down offers: the rules, the Google accounts and the providers.
            signIns: [wb.rules.list(), wb.google.accounts().map((a) => a.email), wb.google.defaultAccount(), wb.auth.list().map((p) => p.id)],
          },
    );
    mount(layer?.name);
  };

  return {
    element,
    update,
    dispose: () => {
      unmount?.();
      unmount = undefined;
      mountedFor = undefined;
    },
  };
}
