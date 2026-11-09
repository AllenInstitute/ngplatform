/**
 * The top of the Layers panel: what the active scene shows.
 *
 * One row per dataset, with its visibility, load state and where it is; a
 * dataset shown through several layers lists them beneath it.  Selecting a
 * row brings its controls up below (./layer.ts).  Datasets that other
 * scenes show are offered in the Open sheet and the Add a dataset sheet,
 * not here.  Below the list, up to three tools that are off but would serve
 * this data, the rest behind More.
 *
 * The list is drawn again only when what it shows changes (not on every
 * move of the views), and the control that had the keyboard keeps it.
 */
import type { LayerInfo } from "../../engine/engine.js";
import { checkbox, emptyState, type OnOff, region } from "../../sdk/dom.js";
import { clear, h, icon, iconButton } from "../dom.js";
import { promptDialog, showMenu } from "../overlays.js";
import type { Workbench } from "../workbench.js";
import { sourceName } from "./format.js";
import { canExport, exportDataset } from "../export.js";
import { buildOverview, clearOverview, overviewUrl } from "../overview.js";

/** A tick box that shows or hides a dataset or a view; a click on it does not select its row. */
function visibility(label: string, visible: boolean, onChange: (value: boolean) => void): OnOff {
  const box = checkbox(label, visible, onChange, { hideLabel: true });
  box.addEventListener("click", (e) => e.stopPropagation());
  return box;
}

/** The round marker of a dataset's or a view's load state: ready, loading, or failed (its error on hover). */
type Status = { state: "ok" | "busy" | "err"; text: string };

function statusOf(layers: LayerInfo[]): Status {
  const error = layers.find((l) => l.error !== undefined)?.error;
  if (error !== undefined) return { state: "err", text: error };
  return layers.every((l) => l.ready) ? { state: "ok", text: "Ready" } : { state: "busy", text: "Loading" };
}

const statusDot = (status: Status) => h("span", { class: `dot ${status.state}`, title: status.text });

/** A dataset's source URL, whether stored as a string or as Neuroglancer's {url, …}. */
function sourceText(source: unknown): string {
  if (typeof source === "string") return source;
  const first = Array.isArray(source) ? source[0] : source;
  if (typeof first === "string") return first;
  const url = (first as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : "";
}

/** A dataset's row in the list, and its views when it is shown through several layers. */
interface Row {
  id: string;
  name: string;
  visible: boolean;
  selected: boolean;
  status: Status;
  where: string;
  url: string;
  sub: string;
  views: { name: string; visible: boolean; selected: boolean; status: Status; where: string }[];
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
  const list = region((rows: Row[]) => drawRows(rows), { class: "datasets" });
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
        h("span", {}, `${lost.map((l) => l.name).join(", ")}: closed with the tab. Open the files again (Add data → Local file or folder…) or drop them here.`),
      );
    }
    // The list, drawn again only when what it shows has changed; the control that had the keyboard keeps it.
    const focused = [...focusable].find(([, e]) => e === document.activeElement)?.[0];
    if (list.update(rows()) && focused !== undefined) focusable.get(focused)?.focus();
  };

  /** What the list shows, as plain data. */
  const rows = (): Row[] => {
    const layerInfo = new Map(engine.layers().map((l) => [l.name, l]));
    const selected = engine.selectedLayer();
    return store.sceneDatasets().map((entry) => {
      const { dataset } = entry;
      const layers = entry.layers.map((n) => layerInfo.get(n)).filter((l): l is LayerInfo => l !== undefined);
      const url = layers[0]?.sources[0] ?? sourceText(dataset.source);
      return {
        id: dataset.id,
        name: dataset.name,
        visible: layers.some((l) => l.visible),
        selected: selected !== undefined && entry.layers.includes(selected),
        status: statusOf(layers),
        // Only where the data lives when that is this computer: the type is plain from the views.
        where: where(url),
        url,
        sub: layers[0]?.error ?? sourceName(url),
        views:
          entry.layers.length <= 1
            ? []
            : layers.map((layer) => ({ name: layer.name, visible: layer.visible, selected: layer.name === selected, status: statusOf([layer]), where: where(layer.sources[0] ?? "") })),
      };
    });
  };

  const rename = async (id: string) => {
    const dataset = store.dataset(id);
    if (dataset === undefined) return;
    const name = await promptDialog("Rename dataset", "Name", dataset.name);
    if (name !== undefined) store.renameDataset(id, name);
  };

  /** A dataset's menu, from the state when it is opened. */
  const menu = (id: string, anchor: HTMLElement | { x: number; y: number }) => {
    const entries = store.sceneDatasets();
    const index = entries.findIndex((e) => e.dataset.id === id);
    const dataset = store.dataset(id);
    if (index < 0 || dataset === undefined) return;
    const url = overviewUrl(wb, dataset);
    showMenu(anchor, [
      { label: "Show controls", run: () => store.selectDataset(id) },
      { label: "Rename…", run: () => void rename(id) },
      { label: "Add another view of it", run: () => store.addLayerView(id, entries[index].layers[0]) },
      ...(canExport(wb, dataset) ? [{ label: "Export as…", run: () => void exportDataset(wb, dataset) }] : []),
      ...(url === undefined
        ? []
        : [
            { label: "Build its overview in the background", run: () => void buildOverview(wb, url, dataset.name) },
            { label: "Clear its kept overview", run: () => void clearOverview(wb, url, dataset.name) },
          ]),
      "-",
      { label: "Move up", disabled: index === 0, run: () => store.moveDataset(id, index - 1) },
      { label: "Move down", disabled: index === entries.length - 1, run: () => store.moveDataset(id, index + 1) },
      "-",
      { label: "Remove from scene", run: () => store.removeDatasetFromScene(id) },
      { label: "Delete from workspace…", danger: true, run: () => wb.run("dataset.delete", { id }) },
    ]);
  };

  const viewMenu = (id: string, name: string, at: { x: number; y: number }) =>
    showMenu(at, [
      {
        label: "Rename view…",
        run: async () => {
          const renamed = await promptDialog("Rename view", "Name", name);
          if (renamed !== undefined) store.renameLayer(name, renamed);
        },
      },
      { label: "Duplicate view", run: () => store.addLayerView(id, name) },
      { label: "Remove view", danger: true, run: () => store.removeLayer(name) },
    ]);

  const at = (e: Event) => {
    e.preventDefault();
    const m = e as MouseEvent;
    return { x: m.clientX, y: m.clientY };
  };

  const empty = emptyState("No data in this scene.", { label: "Add data…", run: () => showAddMenu(empty.querySelector("button")!, wb) });

  /** The controls of the list that take the keyboard, by a key that names the dataset or view. */
  const focusable = new Map<string, HTMLElement>();
  const focusKey = <E extends HTMLElement>(e: E, key: string): E => {
    focusable.set(key, e);
    return e;
  };

  const drawRows = (rows: Row[]) => {
    focusable.clear();
    if (rows.length === 0) return empty;
    return rows.map((row) => {
      const select = () => store.selectDataset(row.id);
      const shown = visibility(`Show ${row.name}`, row.visible, (v) => store.setDatasetVisible(row.id, v));
      focusKey(shown.input, `vis:${row.id}`);
      const head = h(
        "div",
        {
          class: row.selected ? "ds-row selected" : "ds-row",
          tabindex: 0,
          role: "button",
          "aria-pressed": String(row.selected),
          onclick: select,
          ondblclick: (e: Event) => {
            if ((e.target as HTMLElement).closest(".ds-name") !== null) void rename(row.id);
          },
          oncontextmenu: (e: Event) => menu(row.id, at(e)),
          onkeydown: (e: Event) => {
            // Keys on the row itself, not on its tick box or ⋯ button.
            if (e.target !== e.currentTarget) return;
            const k = (e as KeyboardEvent).key;
            if (k === "Enter") select();
            if (k === " ") {
              e.preventDefault();
              store.setDatasetVisible(row.id, !row.visible);
            }
          },
        },
        shown,
        statusDot(row.status),
        h("span", { class: "ds-name" }, row.name),
        h("span", { class: "type" }, row.where),
        focusKey(
          iconButton("more", "More actions", (e) => {
            e.stopPropagation();
            menu(row.id, e.currentTarget as HTMLElement);
          }),
          `more:${row.id}`,
        ),
        h("span", { class: "sub", title: row.url }, row.sub),
      );
      focusKey(head, `row:${row.id}`);
      if (row.views.length === 0) return head;
      const views = h(
        "div",
        { class: "ds-layers" },
        ...row.views.map((view) => {
          const viewShown = visibility(`Show ${view.name}`, view.visible, (v) => store.setLayerVisible(view.name, v));
          focusKey(viewShown.input, `vis-view:${view.name}`);
          return focusKey(
            h(
              "div",
              {
                class: view.selected ? "layer-row selected" : "layer-row",
                tabindex: 0,
                onclick: () => store.selectLayer(view.name),
                oncontextmenu: (e: Event) => viewMenu(row.id, view.name, at(e)),
              },
              viewShown,
              statusDot(view.status),
              h("span", { class: "ds-name" }, view.name),
              h("span", { class: "type" }, view.where),
            ),
            `view:${view.name}`,
          );
        }),
      );
      return h("div", { class: "ds-group" }, head, views);
    });
  };

  const offs = [store.onChange(render), engine.onLayersChanged(render), engine.onSelectionChanged(render), wb.localData.onChange(render), wb.offers.onChange(renderOffers)];
  render();
  renderOffers();
  return () => offs.forEach((off) => off());
}
