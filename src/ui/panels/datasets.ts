/**
 * The top of the Layers tab: what the active scene shows.
 *
 * One row per dataset, with its visibility, load state and where it is; a
 * dataset shown through several layers lists them beneath it.  Selecting a
 * row brings its controls up below (./layer.ts).  Datasets that other
 * scenes show are offered in the Open sheet and the Add a dataset sheet,
 * not here.  Below the list, up to three tools that are off but would serve
 * this data, the rest behind More.
 */
import type { LayerInfo } from "../../engine/engine.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { promptDialog, showMenu } from "../overlays.js";
import type { Workbench } from "../workbench.js";
import { sourceName } from "./format.js";
import { canExport, exportDataset } from "../export.js";
import { buildOverview, clearOverview, overviewUrl } from "../overview.js";

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

/** A dataset's source URL, whether stored as a string or as Neuroglancer's {url, …}. */
function sourceText(source: unknown): string {
  if (typeof source === "string") return source;
  const first = Array.isArray(source) ? source[0] : source;
  if (typeof first === "string") return first;
  const url = (first as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : "";
}

/** The Add menu: a dataset by URL, local data, or a new annotation layer. */
export function showAddMenu(anchor: HTMLElement, wb: Workbench): void {
  showMenu(anchor, [
    { label: "Dataset from a URL…", run: () => wb.run("dataset.add") },
    { label: "Local file or folder…", disabled: !wb.commands.available("dataset.addLocal"), run: () => wb.run("dataset.addLocal") },
    { label: "New annotation layer", run: () => wb.run("dataset.newAnnotations") },
  ]);
}

export function renderDatasetsPanel(host: HTMLElement, wb: Workbench): () => void {
  const { store, engine } = wb;
  /** "Local" for data on this computer; nothing for data from the web. */
  const where = (url: string) => (wb.localData.parse(url.replace(/^[a-z0-9+]+:\/\/(?=https?:)/, "")) !== undefined ? "Local" : "");
  const list = h("div", { class: "datasets" });
  const addButton = iconButton("plus", "Add data", () => showAddMenu(addButton, wb), { class: "btn icon", "aria-haspopup": "menu" });
  const permission = h(
    "div",
    { class: "note-bar", hidden: true },
    h("span", {}, "Local data needs your permission again."),
    h("button", { class: "btn small", type: "button", onclick: () => wb.run("dataset.reconnectLocal") }, "Allow access"),
  );
  const gone = h("div", { class: "note-bar", hidden: true });
  // Tools that are off but would serve this scene's data (src/ui/plugin_offers.ts).
  const tools = h("div", { class: "ds-offers", hidden: true });
  const actions = h("div", { class: "panel-actions" }, h("span", { class: "section-title" }, "Data"), addButton);
  host.append(actions, permission, gone, list, tools);

  /** The tools shown as buttons; the rest are behind More. */
  const SHOWN = 3;
  const renderOffers = () => {
    const items = wb.offers.list();
    tools.hidden = items.length === 0;
    const more = items.slice(SHOWN);
    const moreButton: HTMLButtonElement = h(
      "button",
      {
        class: "btn small outline",
        type: "button",
        "aria-haspopup": "menu",
        onclick: () => showMenu(moreButton, more.map((item) => ({ label: `Turn on ${item.name}`, detail: item.pitch, run: () => wb.offers.accept([item.id]) }))),
      },
      "More…",
    ) as HTMLButtonElement;
    clear(
      tools,
      h("span", { class: "ds-offers-title" }, "Tools for this data"),
      ...items.slice(0, SHOWN).map((item) =>
        h(
          "span",
          { class: "offer-chip" },
          h(
            "button",
            {
              class: "offer-on",
              type: "button",
              title: item.uses ? `This workspace uses ${item.name}, which is off. Turn it on.` : `Turn on ${item.name}: ${item.pitch}`,
              onclick: () => wb.offers.accept([item.id]),
            },
            icon("plus"),
            item.name,
          ),
          item.uses ? null : iconButton("close", `Not now: stop offering ${item.name}`, () => wb.offers.notNow([item.id]), { class: "btn icon offer-no" }),
        ),
      ),
      more.length ? moreButton : null,
    );
  };

  const render = () => {
    const localBase = `${wb.localData.base}local/`;
    permission.hidden = !(
      wb.localData.list().some((e) => e.needsPermission) && engine.layers().some((l) => l.sources.some((s) => s.includes(localBase)))
    );
    // Layers reading local data this tab no longer has (dropped or opened files are kept
    // only while the tab is open, unless the browser handed over a handle to remember).
    const lost = wb.localData.restored
      ? engine.layers().filter((l) => l.sources.some((s) => {
          const at = wb.localData.parse(s.replace(/^[a-z0-9+]+:\/\/(?=https?:)/, ""));
          return at !== undefined && !wb.localData.has(at.id);
        }))
      : [];
    gone.hidden = lost.length === 0;
    if (lost.length > 0) {
      clear(
        gone,
        h("span", {}, `${lost.map((l) => l.name).join(", ")}: closed with the tab. Open the files again (+ → Local file or folder) or drop them here.`),
      );
    }
    const entries = store.sceneDatasets();
    const layerInfo = new Map(engine.layers().map((l) => [l.name, l]));
    const selected = engine.selectedLayer();

    if (entries.length === 0) {
      clear(list, h("p", { class: "empty" }, "No data in this scene."));
    } else {
      clear(
        list,
        ...entries.map((entry, index) => {
          const { dataset } = entry;
          const layers = entry.layers.map((n) => layerInfo.get(n)).filter((l): l is LayerInfo => l !== undefined);
          const visible = layers.some((l) => l.visible);
          const isSelected = selected !== undefined && entry.layers.includes(selected);
          const select = () => store.selectDataset(dataset.id);
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
              ...(canExport(wb, dataset) ? [{ label: "Export as…", run: () => void exportDataset(wb, dataset) }] : []),
              ...((url) =>
                url === undefined
                  ? []
                  : [
                      { label: "Build its overview in the background", run: () => void buildOverview(wb, url, dataset.name) },
                      { label: "Clear its kept overview", run: () => void clearOverview(wb, url, dataset.name) },
                    ])(overviewUrl(wb, dataset)),
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
                // Keys on the row itself, not on its tick box or ⋯ button.
                if (e.target !== e.currentTarget) return;
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
            // Only where the data lives when that is this computer: the type is plain from the views.
            h("span", { class: "type" }, where(layers[0]?.sources[0] ?? sourceText(dataset.source))),
            iconButton("more", "More actions", (e) => {
              e.stopPropagation();
              menu(e.currentTarget as HTMLElement);
            }),
            ((url) => h("span", { class: "sub", title: url }, layers[0]?.error ?? sourceName(url)))(layers[0]?.sources[0] ?? sourceText(dataset.source)),
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
                  onclick: () => store.selectLayer(layer.name),
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
                h("span", { class: "type" }, where(layer.sources[0] ?? "")),
              ),
            ),
          );
          return h("div", { class: "ds-group" }, row, views);
        }),
      );
    }
  };

  const offs = [store.onChange(render), engine.onLayersChanged(render), engine.onSelectionChanged(render), wb.localData.onChange(render), wb.offers.onChange(renderOffers)];
  render();
  renderOffers();
  return () => offs.forEach((off) => off());
}
