/** The dock panels: workspace, plugins, inspector, activity. */
import { fetchableUrl } from "../core/state_io.js";
import type { CursorInfo, LayerInfo, ViewerBridge } from "../core/viewer_bridge.js";
import { clear, h } from "./dom.js";

// -------------------------------------------------------------- workspace

interface StoreFacts {
  geometry: string;
  version: string;
  objects?: number;
  levels?: number;
  bounds?: string;
  chunk?: string;
  space?: string;
}

const storeFacts = new Map<string, Promise<StoreFacts | null>>();

/** The zarr-vectors store URL inside a layer source, if it is one we can fetch. */
function zarrVectorsStore(source: string): string | undefined {
  let url = source;
  if (url.startsWith("zarr-vectors://")) url = url.slice("zarr-vectors://".length);
  else if (/\|zarr-vectors:/.test(url)) url = url.split("|zarr-vectors:")[0];
  else return undefined;
  if (url.includes("|")) return undefined; // inside a zip or another adapter
  url = fetchableUrl(url);
  if (!/^https?:\/\//.test(url)) return undefined;
  return url.endsWith("/") ? url : url + "/";
}

function fmt(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

async function loadFacts(store: string): Promise<StoreFacts | null> {
  try {
    const root = await (await fetch(store + "zarr.json")).json();
    const zv = root?.attributes?.zarr_vectors ?? {};
    const facts: StoreFacts = {
      geometry: (zv.geometry_types ?? []).join(", ") || "unknown",
      version: String(zv.zv_version ?? "?"),
    };
    const ms = zv.multiscales ?? root?.attributes?.multiscales;
    const datasets = Array.isArray(ms) ? ms[0]?.datasets : ms?.datasets;
    if (Array.isArray(datasets)) facts.levels = datasets.length;
    if (Array.isArray(zv.bounds)) {
      const [lo, hi] = zv.bounds as number[][];
      facts.bounds = lo.map((l, i) => fmt(hi[i] - l)).join(" × ");
    }
    if (Array.isArray(zv.chunk_shape)) facts.chunk = (zv.chunk_shape as number[]).map((c) => fmt(c)).join(" × ");
    if (zv.crs?.input_space) facts.space = `${zv.crs.input_space} → ${zv.crs.output_space ?? "?"}`;
    try {
      const index = await (await fetch(store + "0/object_index/zarr.json")).json();
      const n = index?.attributes?.num_objects;
      if (typeof n === "number") facts.objects = n;
    } catch {
      // A store without an object index still has the root facts.
    }
    return facts;
  } catch {
    return null;
  }
}

function factsFor(store: string): Promise<StoreFacts | null> {
  let pending = storeFacts.get(store);
  if (pending === undefined) {
    pending = loadFacts(store);
    storeFacts.set(store, pending);
  }
  return pending;
}

function shortSource(url: string): string {
  return url.replace(/^https:\/\/storage\.googleapis\.com\//, "gs://").replace(/^.*\/examples\//, "bundled: examples/");
}

export function renderWorkspace(root: HTMLElement, bridge: ViewerBridge): void {
  const layers = bridge.layers();
  const selected = bridge.selectedLayer();
  if (layers.length === 0) {
    clear(
      root,
      h(
        "p",
        { class: "empty" },
        h("strong", {}, "No layers yet. "),
        "Open a Neuroglancer link, a state or a data URL, or start from an example.",
      ),
    );
    return;
  }
  const list = h(
    "ul",
    { class: "list" },
    ...layers.map((layer: LayerInfo) =>
      h(
        "li",
        {
          class: layer.name === selected ? "row selected" : "row",
          tabindex: 0,
          title: "Show this layer's controls",
          onclick: () => bridge.selectLayer(layer.name),
          onkeydown: (e: Event) => {
            if ((e as KeyboardEvent).key === "Enter") bridge.selectLayer(layer.name);
          },
        },
        h("span", { class: layer.ready ? "dot ok" : "dot busy", title: layer.ready ? "Ready" : "Loading" }),
        h("span", { class: "name" }, layer.name),
        h("span", { class: "type" }, layer.type + (layer.visible ? "" : " · hidden")),
        layer.sources.length ? h("span", { class: "sub" }, layer.sources.map(shortSource).join("\n")) : null,
      ),
    ),
  );
  const storesSection = h("div", { class: "section" });
  const stores = [...new Set(layers.flatMap((l) => l.sources).map(zarrVectorsStore).filter(Boolean))] as string[];
  clear(root, h("div", { class: "section" }, h("h3", { class: "section-title" }, "Layers"), list), stores.length ? storesSection : null);
  if (stores.length) {
    clear(storesSection, h("h3", { class: "section-title" }, "Zarr-vectors stores"));
    for (const store of stores) {
      const holder = h("div", {}, h("p", { class: "note" }, "Reading store metadata…"));
      storesSection.append(holder);
      factsFor(store).then((facts) => {
        if (facts === null) {
          clear(holder, h("p", { class: "note" }, "Could not read this store's metadata."));
          return;
        }
        const rows: [string, string | undefined][] = [
          ["Store", shortSource(store).replace(/\/$/, "").split("/").pop()],
          ["Geometry", facts.geometry],
          ["Objects", facts.objects?.toLocaleString()],
          ["Levels", facts.levels?.toString()],
          ["Extent", facts.bounds && facts.bounds + " mm"],
          ["Chunk", facts.chunk && facts.chunk + " mm"],
          ["Space", facts.space],
          ["Format", facts.version],
        ];
        clear(
          holder,
          h(
            "dl",
            { class: "facts" },
            ...rows.filter(([, v]) => v !== undefined).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v!)]),
          ),
        );
      });
    }
  }
}

// ---------------------------------------------------------------- plugins

const PLANNED = [
  {
    name: "Tractography",
    stage: "planned",
    text: "Track groups built from sphere, box, slab, disk and mask regions with AND, OR and NOT; length and attribute filters; statistics, density maps and movies.",
  },
  {
    name: "Layer statistics",
    stage: "planned",
    text: "The example plugin: a histogram of the visible image data, computed in Python in the browser.",
  },
];

export function renderPlugins(root: HTMLElement): void {
  clear(
    root,
    h(
      "div",
      { class: "section" },
      h("h3", { class: "section-title" }, "Installed"),
      h("p", { class: "empty" }, "None in this preview. Plugins add panels to these docks and commands to the palette."),
    ),
    h(
      "div",
      { class: "section" },
      h("h3", { class: "section-title" }, "Coming next"),
      h(
        "div",
        { class: "list" },
        ...PLANNED.map((p) =>
          h(
            "div",
            { class: "plugin" },
            h("div", { class: "plugin-head" }, h("span", { class: "plugin-name" }, p.name), h("span", { class: "chip" }, p.stage)),
            h("p", { class: "empty" }, p.text),
          ),
        ),
      ),
    ),
  );
}

// -------------------------------------------------------------- inspector

function physical(cursor: CursorInfo, i: number): [string, string] {
  const value = cursor.position[i];
  const unit = cursor.units[i];
  const scale = cursor.scales[i];
  if (unit === "m" && Number.isFinite(value)) {
    const metres = value * scale;
    const abs = Math.abs(metres);
    if (abs >= 1e-3 || abs === 0) return [fmt(metres * 1e3, 2), "mm"];
    if (abs >= 1e-6) return [fmt(metres * 1e6, 2), "µm"];
    return [fmt(metres * 1e9, 1), "nm"];
  }
  return [Number.isFinite(value) ? fmt(value, 2) : "–", unit || ""];
}

export function renderSelection(root: HTMLElement, bridge: ViewerBridge): void {
  const name = bridge.selectedLayer();
  const layer = bridge.layers().find((l) => l.name === name);
  if (layer === undefined) {
    clear(root, h("p", { class: "empty" }, "Select a layer in the layer bar, or in the Workspace list, to see it here."));
    return;
  }
  const rows: [string, string][] = [
    ["Name", layer.name],
    ["Type", layer.type],
    ["Shown", layer.visible ? "yes" : "no"],
    ["State", layer.ready ? "ready" : "loading"],
    ...layer.sources.map((s, i): [string, string] => [i === 0 ? "Source" : "", shortSource(s)]),
  ];
  clear(root, h("dl", { class: "facts" }, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
}

export function renderCursor(coords: HTMLElement, values: HTMLElement, cursor: CursorInfo): void {
  if (!cursor.active || cursor.position.length === 0) {
    clear(coords, h("p", { class: "empty" }, "Move the pointer over a view."));
    clear(values);
    return;
  }
  clear(
    coords,
    h(
      "div",
      { class: "coords" },
      ...cursor.names.map((axis, i) => {
        const [value, unit] = physical(cursor, i);
        return h(
          "div",
          { class: "coord" },
          h("div", { class: `axis axis-${i}` }, axis),
          h("div", { class: "value" }, value, " ", h("span", { class: "unit" }, unit)),
        );
      }),
    ),
  );
  const entries = Object.entries(cursor.values).filter(([, v]) => v !== undefined && v !== null);
  clear(
    values,
    entries.length === 0
      ? h("p", { class: "note" }, "Nothing under the pointer.")
      : h("pre", { class: "value-json" }, entries.map(([layer, v]) => `${layer}: ${JSON.stringify(v, null, 1)}`).join("\n")),
  );
}

// --------------------------------------------------------------- activity

export type LogLevel = "info" | "ok" | "error";

export class ActivityLog {
  readonly element = h("ol", { class: "log", "aria-live": "polite" });

  add(message: string, level: LogLevel = "info"): void {
    const time = new Date().toLocaleTimeString(undefined, { hour12: false });
    this.element.prepend(h("li", {}, h("time", {}, time), h("span", { class: level === "info" ? "" : level }, message)));
    while (this.element.childElementCount > 200) this.element.lastElementChild?.remove();
  }
}
