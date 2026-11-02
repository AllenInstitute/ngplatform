/**
 * The collections plugin: the Collections tab (open a collection, its tree,
 * coordinate systems and transforms) and a scene of its images, each placed
 * where the collection puts it.  The model is ./collection.ts.
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
import { describeTransform } from "@ngplatform/sdk/ome";
import { neuroglancer, physical } from "../registration/plugin.js";
import { type CollectionNode, graph, type Mat4, members, readCollection } from "./collection.js";
import example from "./examples/srb_gallery.json";
import { COLLECTIONS_PANEL } from "./manifest.js";

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const EXAMPLE_URL = "https://alleninstitute.github.io/ngplatform/collections/srb_gallery.json";

/** Millimetres in one unit of a coordinate system's axis. */
const MM: Record<string, number> = { meter: 1000, millimeter: 1, micrometer: 1e-3, nanometer: 1e-6 };

const STYLE = `
.cl { display: grid; gap: 10px; padding: 10px 12px; font-size: 12px; }
.cl-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cl-row input { flex: 1; min-width: 120px; }
.cl-tree { display: grid; gap: 2px; }
.cl-node { display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: baseline; }
.cl-kind { font: 11px var(--mono); color: var(--muted); }
.cl-where { grid-column: 2; color: var(--faint); font: 11px var(--mono); overflow-wrap: anywhere; }
.cl-table { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; }
.cl-table > :nth-child(odd) { color: var(--muted); }
.cl-value { font: 11px var(--mono); overflow-wrap: anywhere; }
`;

class Collections {
  private root: CollectionNode | undefined;
  private documentUrl = "";
  private error = "";
  private busy = false;
  private update?: () => void;

  constructor(private readonly ctx: PlatformContext) {}

  async open(url: string, document?: unknown): Promise<void> {
    this.busy = true;
    this.error = "";
    this.update?.();
    try {
      let doc = document;
      if (doc === undefined) {
        const base = url.replace(/\/$/, "");
        const response = await fetch(/\.json$/i.test(base) ? base : `${base}/zarr.json`);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        doc = await response.json();
      }
      this.root = readCollection(doc, /\.json$/i.test(url) ? url : `${url.replace(/\/$/, "")}/zarr.json`);
      this.documentUrl = url;
    } catch (e) {
      this.error = `Could not read the collection: ${(e as Error).message}`;
    } finally {
      this.busy = false;
      this.update?.();
    }
  }

  /** A scene of the collection's images, each placed where the collection puts it. */
  async showInScene(): Promise<void> {
    const root = this.root;
    if (root === undefined) return;
    // The collection's own space's unit (its first coordinate system's), in millimetres.
    const unit = MM[root.systems[0]?.units.find((u) => u !== "") ?? "millimeter"] ?? 1;
    this.ctx.workspace.newScene({ name: `Collection: ${root.name}` });
    const placed: { layer: string; placement?: Mat4 }[] = [];
    for (const m of members(root)) {
      if (m.node.location === undefined) continue;
      const id = this.ctx.workspace.addDataset({ source: `zarr://${m.node.location.url}/`, name: m.node.name, kind: "image" });
      const added = this.ctx.workspace.sceneDatasets().find((d) => d.id === id)?.layers.at(-1)?.name;
      // Members sharing an image are views of one dataset: name each layer after its member.
      const layer = added === undefined ? undefined : added === m.node.name ? added : this.ctx.workspace.renameLayer(added, m.node.name);
      if (layer !== undefined) placed.push({ layer, placement: m.placement });
    }
    // Place each once Neuroglancer knows its transform.
    for (const { layer, placement } of placed) {
      if (placement === undefined) continue;
      for (let i = 0; i < 100; ++i) {
        const t = this.ctx.viewer.layerTransform(layer);
        const p = t && physical(t, t.defaultMatrix);
        if (t && p) {
          const names = t.output.names;
          const order = ["x", "y", "z"].map((n) => names.indexOf(n));
          if (order.some((k) => k === -1)) break;
          // The placement in millimetres, in the layer's output order.
          const a = new Float64Array(16);
          a[15] = 1;
          order.forEach((r, i2) => {
            order.forEach((c, j) => (a[4 * r + c] = placement[4 * i2 + j]));
            a[4 * r + 3] = placement[4 * i2 + 3] * unit;
          });
          const out = new Float64Array(16);
          for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) out[4 * r + c] += a[4 * r + k] * p[4 * k + c];
          this.ctx.viewer.setLayerTransform(layer, neuroglancer(t, out));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    this.ctx.log.info(`Showed ${placed.length} image${placed.length === 1 ? "" : "s"} of ${root.name} in a scene of their own.`);
  }

  render(host: HTMLElement): () => void {
    const url = el("input", { type: "text", placeholder: "https://…/collection.json or a Zarr group", value: this.documentUrl }) as HTMLInputElement;
    const draw = () => {
      const root = this.root;
      const tree = (n: CollectionNode, depth: number): HTMLElement[] => [
        el(
          "div",
          { class: "cl-node", style: `padding-left: ${depth * 12}px` },
          el("span", { class: "cl-kind" }, n.type),
          el("span", {}, n.name),
          n.location ? el("span", { class: "cl-where" }, n.location.url) : null,
        ),
        ...n.nodes.flatMap((c) => tree(c, depth + 1)),
      ];
      const g = root && graph(root);
      const placed = root ? members(root) : [];
      host.replaceChildren(
        el(
          "div",
          { class: "cl" },
          el(
            "div",
            { class: "cl-row" },
            url,
            el("button", { class: "btn small", type: "button", disabled: this.busy, onclick: () => void this.open(url.value.trim()) }, "Open"),
            el("button", { class: "btn outline small", type: "button", disabled: this.busy, onclick: () => void this.open(EXAMPLE_URL, example) }, "Example"),
          ),
          this.error ? el("p", { class: "note err" }, this.error) : null,
          root ? el("h3", { class: "section-title" }, `Members of ${root.name}`) : el("p", { class: "note" }, "Open a collection (OME-NGFF RFC-8, draft) by its URL, or the example."),
          root ? el("div", { class: "cl-tree" }, ...tree(root, 0)) : null,
          root
            ? el(
                "button",
                { class: "btn small", type: "button", disabled: placed.length === 0, onclick: () => void this.showInScene() },
                `Show its ${placed.length} image${placed.length === 1 ? "" : "s"} in a new scene`,
              )
            : null,
          g && g.systems.length ? el("h3", { class: "section-title" }, "Coordinate systems") : null,
          g && g.systems.length ? el("div", { class: "cl-table" }, ...g.systems.flatMap((s) => [el("span", {}, `${s.id} (${s.node})`), el("span", { class: "cl-value" }, s.axes.join(", "))])) : null,
          g && g.transforms.length ? el("h3", { class: "section-title" }, "Transforms") : null,
          g && g.transforms.length ? el("div", { class: "cl-table" }, ...g.transforms.flatMap((t) => [el("span", {}, `${t.input} → ${t.output}`), el("span", { class: "cl-value" }, describeTransform(t.raw))])) : null,
          placed.some((m) => m.placement !== undefined) ? el("p", { class: "note" }, "Each image is placed by its transform into the collection's space when shown in a scene.") : null,
        ),
      );
    };
    this.update = draw;
    draw();
    return () => (this.update = undefined);
  }
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    const collections = new Collections(ctx);
    ctx.subscriptions.push(() => style.remove());
    ctx.ui.panel(COLLECTIONS_PANEL, (host) => collections.render(host));
  },
};
