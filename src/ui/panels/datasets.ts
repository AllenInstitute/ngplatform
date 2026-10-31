/**
 * The Datasets tab: what the active scene shows.
 *
 * One row per dataset, with its visibility, load state and type; a dataset
 * shown through several layers lists them beneath it.  Selecting a row
 * brings its controls up in the Layer tab.  Datasets the workspace knows but
 * this scene does not show are listed below, ready to add.
 */
import type { LayerInfo } from "../../engine/engine.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { promptDialog, showMenu } from "../overlays.js";
import type { Workbench } from "../workbench.js";
import { kindLabel, shortSource } from "./format.js";

function checkbox(checked: boolean, label: string, onChange: (value: boolean) => void): HTMLElement {
  const box = h("input", { type: "checkbox", class: "vis", "aria-label": label, title: label });
  box.checked = checked;
  box.addEventListener("click", (e) => e.stopPropagation());
  box.addEventListener("change", () => onChange(box.checked));
  return box;
}

function statusDot(layers: LayerInfo[]): HTMLElement {
  const error = layers.find((l) => l.error !== undefined)?.error;
  if (error !== undefined) return h("span", { class: "dot err", title: error });
  const ready = layers.every((l) => l.ready);
  return h("span", { class: ready ? "dot ok" : "dot busy", title: ready ? "Ready" : "Loading" });
}

export function renderDatasetsPanel(host: HTMLElement, wb: Workbench): () => void {
  const { store, engine } = wb;
  const sceneTitle = h("span", { class: "scene-name" });
  const list = h("div", { class: "datasets" });
  const others = h("div", { class: "section" });
  const header = h(
    "div",
    { class: "panel-head" },
    h("div", { class: "panel-title" }, h("span", { class: "eyebrow" }, "Scene"), sceneTitle),
    h("button", { class: "btn outline small", type: "button", onclick: () => wb.run("dataset.add") }, icon("plus"), "Add"),
  );
  host.append(header, list, others);

  const render = () => {
    const scene = store.state().scenes.find((s) => s.id === store.state().activeScene);
    sceneTitle.textContent = scene?.name ?? "";
    const entries = store.sceneDatasets();
    const layerInfo = new Map(engine.layers().map((l) => [l.name, l]));
    const selected = engine.selectedLayer();

    if (entries.length === 0) {
      clear(
        list,
        h(
          "div",
          { class: "empty-state" },
          h("p", { class: "empty" }, h("strong", {}, "This scene shows no datasets. "), "Add one by URL, or open a link or an example."),
          h(
            "div",
            { class: "row-actions" },
            h("button", { class: "btn primary small", type: "button", onclick: () => wb.run("dataset.add") }, icon("plus"), "Add dataset"),
            h("button", { class: "btn outline small", type: "button", onclick: () => wb.run("workspace.open") }, icon("open"), "Open…"),
          ),
        ),
      );
    } else {
      clear(
        list,
        ...entries.map((entry, index) => {
          const { dataset } = entry;
          const layers = entry.layers.map((n) => layerInfo.get(n)).filter((l): l is LayerInfo => l !== undefined);
          const visible = layers.some((l) => l.visible);
          const isSelected = selected !== undefined && entry.layers.includes(selected);
          const type = layers[0]?.type && layers[0].type !== "new" ? layers[0].type : dataset.kind;
          const select = () => {
            store.selectDataset(dataset.id);
            wb.docks.show("layer");
          };
          const menu = (anchor: HTMLElement | { x: number; y: number }) =>
            showMenu(anchor, [
              { label: "Show controls", run: select },
              {
                label: "Rename…",
                run: async () => {
                  const name = await promptDialog("Rename dataset", "Name", dataset.name);
                  if (name !== undefined) store.renameDataset(dataset.id, name);
                },
              },
              { label: "Add another view of it", run: () => store.addLayerView(dataset.id, entry.layers[0]) },
              "-",
              { label: "Move up", disabled: index === 0, run: () => store.moveDataset(dataset.id, index - 1) },
              { label: "Move down", disabled: index === entries.length - 1, run: () => store.moveDataset(dataset.id, index + 1) },
              "-",
              { label: "Remove from scene", run: () => store.removeDatasetFromScene(dataset.id) },
              { label: "Delete from workspace…", danger: true, run: () => wb.run("dataset.delete", { id: dataset.id }) },
            ]);
          const row = h(
            "div",
            {
              class: isSelected ? "ds-row selected" : "ds-row",
              tabindex: 0,
              role: "button",
              "aria-pressed": String(isSelected),
              title: "Show this dataset's controls",
              onclick: select,
              ondblclick: async (e: Event) => {
                if ((e.target as HTMLElement).closest(".ds-name") === null) return;
                const name = await promptDialog("Rename dataset", "Name", dataset.name);
                if (name !== undefined) store.renameDataset(dataset.id, name);
              },
              oncontextmenu: (e: Event) => {
                e.preventDefault();
                const m = e as MouseEvent;
                menu({ x: m.clientX, y: m.clientY });
              },
              onkeydown: (e: Event) => {
                const k = (e as KeyboardEvent).key;
                if (k === "Enter") select();
                if (k === " ") {
                  e.preventDefault();
                  store.setDatasetVisible(dataset.id, !visible);
                }
              },
            },
            checkbox(visible, visible ? "Hide" : "Show", (v) => store.setDatasetVisible(dataset.id, v)),
            statusDot(layers),
            h("span", { class: "ds-name" }, dataset.name),
            h("span", { class: "type" }, kindLabel(type)),
            iconButton("more", "More actions", (e) => {
              e.stopPropagation();
              menu(e.currentTarget as HTMLElement);
            }),
            h("span", { class: "sub" }, layers[0]?.error ?? shortSource(layers[0]?.sources[0] ?? String(dataset.source ?? ""))),
          );
          if (entry.layers.length <= 1) return row;
          const views = h(
            "div",
            { class: "ds-layers" },
            ...layers.map((layer) =>
              h(
                "div",
                {
                  class: layer.name === selected ? "layer-row selected" : "layer-row",
                  tabindex: 0,
                  title: "Show this layer's controls",
                  onclick: () => {
                    store.selectLayer(layer.name);
                    wb.docks.show("layer");
                  },
                  oncontextmenu: (e: Event) => {
                    e.preventDefault();
                    const m = e as MouseEvent;
                    showMenu({ x: m.clientX, y: m.clientY }, [
                      {
                        label: "Rename view…",
                        run: async () => {
                          const name = await promptDialog("Rename view", "Name", layer.name);
                          if (name !== undefined) store.renameLayer(layer.name, name);
                        },
                      },
                      { label: "Duplicate view", run: () => store.addLayerView(dataset.id, layer.name) },
                      { label: "Remove view", danger: true, run: () => store.removeLayer(layer.name) },
                    ]);
                  },
                },
                checkbox(layer.visible, layer.visible ? "Hide view" : "Show view", (v) => store.setLayerVisible(layer.name, v)),
                statusDot([layer]),
                h("span", { class: "ds-name" }, layer.name),
                h("span", { class: "type" }, kindLabel(layer.type)),
              ),
            ),
          );
          return h("div", { class: "ds-group" }, row, views);
        }),
      );
    }

    const notShown = store.datasetsNotInScene();
    if (notShown.length === 0) {
      clear(others);
    } else {
      clear(
        others,
        h("h3", { class: "section-title" }, "In the workspace, not in this scene"),
        h(
          "div",
          { class: "list" },
          ...notShown.map((dataset) =>
            h(
              "div",
              { class: "ds-row other" },
              h("span", { class: "ds-icon" }, icon("database")),
              h("span", { class: "ds-name" }, dataset.name),
              h("span", { class: "type" }, kindLabel(dataset.kind)),
              iconButton("plus", `Add “${dataset.name}” to this scene`, () => store.showDataset(dataset.id)),
            ),
          ),
        ),
      );
    }
  };

  const offs = [store.onChange(render), engine.onLayersChanged(render), engine.onSelectionChanged(render)];
  render();
  return () => offs.forEach((off) => off());
}
