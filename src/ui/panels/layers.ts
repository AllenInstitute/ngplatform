/**
 * The Layers panel: the scene's datasets (./datasets.ts) above the selected
 * layer's controls (./layer.ts), in one column.
 */
import { h } from "../dom.js";
import type { Workbench } from "../workbench.js";
import { renderDatasetsPanel } from "./datasets.js";
import { renderLayerPanel } from "./layer.js";

export function renderLayersPanel(host: HTMLElement, wb: Workbench): () => void {
  const list = h("div", { class: "layers-list" });
  const controls = h("div", { class: "layers-controls" });
  host.append(list, controls);
  const offs = [renderDatasetsPanel(list, wb), renderLayerPanel(controls, wb)];
  return () => offs.forEach((off) => off());
}
