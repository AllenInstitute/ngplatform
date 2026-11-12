/**
 * The Layers panel: the scene's datasets, each a card holding its settings
 * (./datasets.ts, ./layer.ts), in one scrolling column.
 */
import { h } from "../dom.js";
import type { Workbench } from "../workbench.js";
import { renderDatasetsPanel } from "./datasets.js";

export function renderLayersPanel(host: HTMLElement, wb: Workbench): () => void {
  const list = h("div", { class: "layers-list" });
  host.append(list);
  return renderDatasetsPanel(list, wb);
}
