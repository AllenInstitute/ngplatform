/**
 * The collections plugin: a Collections tab in the scene bar (a scene of the
 * plugin's own kind) whose viewer shows only a collection's images, each
 * placed by its transforms in the coordinate system chosen, and the
 * Collections panel beside it: the collection found for the workspace's
 * data (or opened by URL), the graph of its coordinate systems and the
 * transforms between them (click a system to view in it), its tree, and the
 * transforms as written.  In an ordinary scene the panel offers the
 * collections that scene's data belongs to.  The model is ./collection.ts.
 */
import type { PlatformContext, PluginModule } from "@ngplatform/sdk";
import { el } from "@ngplatform/sdk/dom";
import { describeTransform } from "@ngplatform/sdk/ome";
import { neuroglancer, physical } from "../registration/plugin.js";
import { chainInto, type CollectionNode, displayRangeOf, fieldWarp, firstLevel, graph, isCollection, type Mat4, members, parentGroups, placeInto, readCollection, sceneSystems } from "./collection.js";
import example from "./examples/srb_gallery.json";
import { COLLECTION_KIND, COLLECTIONS_PANEL } from "./manifest.js";

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else e.setAttribute(k, String(v));
  }
  e.append(...children);
  return e;
}

export const EXAMPLE_URL = "https://alleninstitute.github.io/ngplatform/collections/srb_gallery.json";

/** Millimetres in one unit of a coordinate system's axis. */
const MM: Record<string, number> = { meter: 1000, millimeter: 1, micrometer: 1e-3, nanometer: 1e-6 };

/** The contrast range an image (a Zarr group's URL) is shown with by default (`displayRangeOf`), read once per image. */
const ranges = new Map<string, Promise<[number, number] | undefined>>();
function displayRange(url: string): Promise<[number, number] | undefined> {
  let range = ranges.get(url);
  if (range === undefined) {
    const json = async (key: string): Promise<unknown> => {
      const response = await fetch(`${url}/${key}`).catch(() => undefined);
      return response?.ok ? response.json().catch(() => undefined) : undefined;
    };
    range = (async () => {
      const group = (await json("zarr.json")) ?? (await json(".zattrs"));
      const level = firstLevel(group);
      const array = level === undefined ? undefined : ((await json(`${level}/zarr.json`)) ?? (await json(`${level}/.zarray`)));
      return displayRangeOf(group, array);
    })();
    ranges.set(url, range);
  }
  return range;
}

/** What the plugin keeps per scene: the collection a Collections tab shows, and the system it is viewed in. */
interface Saved {
  url?: string;
  system?: string;
}

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
.cl-found { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; }
.cl-graph { width: 100%; height: auto; display: block; }
.cl-graph .cl-sys { cursor: pointer; }
.cl-graph .cl-sys rect { fill: var(--ink-3); stroke: var(--line-strong); }
.cl-graph .cl-sys.on rect { stroke: var(--select); stroke-width: 2; }
.cl-graph .cl-sys:hover rect { fill: var(--ink-4); }
.cl-graph .cl-mem rect { fill: var(--ink-2); stroke: var(--line); }
.cl-graph .cl-mem.warped rect { stroke: var(--select); stroke-dasharray: 4 2; }
.cl-graph .cl-mem.hidden text { fill: var(--faint); }
.cl-tag { margin-left: 6px; padding: 0 5px; border: 1px dashed var(--select); border-radius: 3px; font: 10px var(--mono); color: var(--muted); }
.cl-tag.off { border-color: var(--line); color: var(--faint); }
.cl-graph text { fill: var(--text); font: 11px var(--ui); }
.cl-graph .cl-edge { stroke: var(--muted); fill: none; }
.cl-graph .cl-edge-label { fill: var(--faint); font: 10px var(--mono); }
`;

class Collections {
  private root: CollectionNode | undefined;
  private documentUrl = "";
  private error = "";
  private busy = false;
  /** Bumped by each open or choice of system: work for an older one stops at its next step. */
  private generation = 0;
  /** The address typed in the panel (kept while the panel is drawn again). */
  private typed = "";
  private update?: () => void;
  /** Collections found above the workspace's images: group URL to its name (null: none there). */
  private found = new Map<string, string | null>();
  private looking = new Set<string>();

  constructor(private readonly ctx: PlatformContext) {
    ctx.subscriptions.push(
      ctx.workspace.onChanged(() => {
        void this.follow();
        void this.discover();
        this.update?.();
      }),
    );
    void this.follow();
    void this.discover();
  }

  private inCollectionScene(): boolean {
    return this.ctx.workspace.scenes().find((s) => s.active)?.kind === COLLECTION_KIND;
  }

  private saved(): Saved {
    return this.ctx.state.get<Saved>() ?? {};
  }

  /** In a Collections tab, the collection it shows (read again after a reload or a scene switch). */
  private async follow(): Promise<void> {
    if (!this.inCollectionScene()) return;
    const { url } = this.saved();
    if (url === undefined || url === this.documentUrl || this.busy) return;
    if (!(await this.read(url)) || this.root === undefined) return;
    // The layers are the scene's already: which members are warped or hidden, for the panel.
    const system = this.saved().system;
    this.warped.clear();
    this.hidden.clear();
    if (system !== undefined) {
      for (const m of members(this.root)) {
        if (m.node.location === undefined || placeInto(this.root, m.node, system) !== undefined) continue;
        const steps = chainInto(this.root, m.node, system);
        (steps && fieldWarp(steps, 1) ? this.warped : this.hidden).add(m.node.name);
      }
    }
    this.update?.();
  }

  private async read(url: string): Promise<boolean> {
    this.busy = true;
    this.error = "";
    this.update?.();
    try {
      let doc: unknown = url === EXAMPLE_URL ? example : undefined;
      if (doc === undefined) {
        const base = url.replace(/\/$/, "");
        const response = await fetch(/\.json$/i.test(base) ? base : `${base}/zarr.json`);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        doc = await response.json();
      }
      this.root = readCollection(doc, /\.json$/i.test(url) ? url : `${url.replace(/\/$/, "")}/zarr.json`);
      this.documentUrl = url;
      return true;
    } catch (e) {
      this.error = `Could not read the collection: ${(e as Error).message}`;
      return false;
    } finally {
      this.busy = false;
      this.update?.();
    }
  }

  /**
   * Looks for collections above the workspace's images: a parent Zarr
   * group whose metadata is an OME collection.  Each group is asked once.
   */
  private async discover(): Promise<void> {
    const sources = this.ctx.workspace
      .datasets()
      .map((d) => (typeof d.source === "string" ? d.source : typeof (d.source as { url?: unknown })?.url === "string" ? (d.source as { url: string }).url : ""))
      .filter((s) => /^(zarr3?|zarr2|ome-zarr):\/\/|\.zarr\/?$/.test(s));
    for (const source of sources) {
      for (const group of parentGroups(source)) {
        if (this.found.has(group) || this.looking.has(group)) continue;
        this.looking.add(group);
        try {
          const response = await fetch(`${group}/zarr.json`);
          const doc = response.ok ? await response.json().catch(() => undefined) : undefined;
          this.found.set(group, doc !== undefined && isCollection(doc) ? readCollection(doc, `${group}/zarr.json`).name : null);
        } catch {
          this.found.set(group, null);
        } finally {
          this.looking.delete(group);
        }
        if (this.found.get(group)) this.update?.();
      }
    }
  }

  /** The collections found for the active scene's images (or, in a Collections tab, the workspace's). */
  private foundHere(): { url: string; name: string }[] {
    const scene = this.inCollectionScene() ? this.ctx.workspace.datasets() : this.ctx.workspace.sceneDatasets();
    const sources = scene.map((d) => (typeof d.source === "string" ? d.source : typeof (d.source as { url?: unknown })?.url === "string" ? (d.source as { url: string }).url : ""));
    const groups = new Set(sources.flatMap((s) => parentGroups(s)));
    return [...this.found].filter(([g, name]) => name && groups.has(g)).map(([url, name]) => ({ url, name: name! }));
  }

  /** Opens `url` in the Collections tab (made if there is none), showing its images. */
  async openInTab(url: string): Promise<void> {
    if (url === "") {
      this.error = "Enter a collection's address (its collection.json or Zarr group), or choose Example.";
      this.update?.();
      return;
    }
    const generation = ++this.generation;
    const tab = this.ctx.workspace.scenes().find((s) => s.kind === COLLECTION_KIND);
    if (tab === undefined) this.ctx.workspace.newScene({ name: "Collections", kind: COLLECTION_KIND });
    else if (!tab.active) this.ctx.workspace.switchScene(tab.id);
    if (!(await this.read(url)) || !this.current(generation)) return;
    const root = this.root!;
    const system = sceneSystems(root)[0]?.id;
    this.ctx.state.set<Saved>({ url, system });
    await this.show(system, generation);
  }

  /** Whether work begun for `generation` may go on: nothing newer was asked for, and the Collections tab is still the scene shown. */
  private current(generation: number): boolean {
    return generation === this.generation && this.inCollectionScene();
  }

  /** The tab's images: the collection's members, its other layers gone, each placed in `system`. */
  private async show(system: string | undefined, generation: number): Promise<void> {
    const root = this.root;
    if (root === undefined || !this.current(generation)) return;
    for (const layer of this.ctx.viewer.layers()) this.ctx.workspace.removeLayer(layer.name);
    for (const m of members(root)) {
      if (m.node.location === undefined) continue;
      await this.setSource(m.node.name, `zarr://${m.node.location.url}/`);
      if (!this.current(generation)) return;
    }
    await this.place(system, generation);
    if (!this.current(generation)) return;
    this.ctx.log.info(`Showing ${root.name} in the Collections tab.`);
  }

  /**
   * A member's layer showing `source` (the layer replaced when it shows
   * another), named after the member.  A warped layer (`warpedFrom`: the
   * member's image) is float32, whose default range would show it white:
   * it keeps the contrast the layer had, or takes the image's own.
   */
  private async setSource(layer: string, source: string, warpedFrom?: string): Promise<void> {
    const spec = this.ctx.viewer.layerSpec(layer) as { source?: unknown; shader?: unknown; shaderControls?: { normalized?: unknown } } | undefined;
    const now = typeof spec?.source === "string" ? spec.source : (spec?.source as { url?: string } | undefined)?.url;
    if (spec !== undefined && now === source) return;
    if (spec !== undefined) this.ctx.workspace.removeLayer(layer);
    const id = this.ctx.workspace.addDataset({ source, name: warpedFrom === undefined ? layer : `${layer} (warped)`, kind: "image" });
    const added = this.ctx.workspace.sceneDatasets().find((d) => d.id === id)?.layers.at(-1)?.name;
    // Members sharing an image are views of one dataset: name each layer after its member.
    if (added !== undefined && added !== layer) this.ctx.workspace.renameLayer(added, layer);
    if (warpedFrom === undefined) return;
    const kept = spec?.shaderControls?.normalized !== undefined ? spec.shaderControls : undefined;
    const range = kept === undefined ? await displayRange(warpedFrom) : undefined;
    if (kept === undefined && range === undefined && typeof spec?.shader !== "string") return;
    this.ctx.viewer.patchState(
      (ng) => {
        const l = ((ng as { layers?: Record<string, unknown>[] }).layers ?? []).find((x) => x.name === layer);
        if (l === undefined) return;
        if (typeof spec?.shader === "string") l.shader = spec.shader;
        if (kept !== undefined) l.shaderControls = structuredClone(kept);
        else if (range !== undefined) l.shaderControls = { ...((l.shaderControls as object) ?? {}), normalized: { range } };
      },
      { quiet: true },
    );
  }

  /** Members shown warped through a displacement field in the system viewed, and members hidden (no chain this can apply), by name. */
  private warped = new Set<string>();
  private hidden = new Set<string>();

  /**
   * Places each member's layer in `system`, by the chain of transforms to
   * it: affine chains as the layer's transform; a chain through a
   * displacement field as a layer computed as it is viewed (the member
   * resampled back through the chain), placed by the chain's affines; a
   * member with no chain is hidden.
   */
  private async place(system: string | undefined, generation: number): Promise<void> {
    const root = this.root;
    if (root === undefined || system === undefined || !this.current(generation)) return;
    const unit = MM[sceneSystems(root).find((s) => s.id === system)?.units.find((u) => u !== "") ?? "millimeter"] ?? 1;
    this.warped.clear();
    this.hidden.clear();
    for (const m of members(root)) {
      const layer = m.node.name;
      if (m.node.location === undefined) continue;
      const plain = `zarr://${m.node.location.url}/`;
      let placement = placeInto(root, m.node, system);
      let source = plain;
      if (placement === undefined) {
        const steps = chainInto(root, m.node, system);
        const shown = steps && fieldWarp(steps, unit);
        if (shown !== undefined) {
          placement = shown.placement;
          try {
            source = await this.ctx.workspace.computed.url({ source: plain, chunk: [64, 64, 64], warp: shown.warp });
            this.warped.add(layer);
          } catch (e) {
            this.ctx.log.error(`Could not warp ${layer}: ${(e as Error).message}`);
            placement = undefined;
          }
          if (!this.current(generation)) return;
        }
      }
      if (placement === undefined) this.hidden.add(layer);
      else await this.setSource(layer, source, this.warped.has(layer) ? m.node.location.url : undefined);
      if (!this.current(generation)) return;
      this.ctx.viewer.patchState(
        (ng) => {
          const spec = ((ng as { layers?: Record<string, unknown>[] }).layers ?? []).find((l) => l.name === layer);
          if (spec !== undefined) spec.visible = placement !== undefined;
        },
        { quiet: true },
      );
      if (placement !== undefined && !(await this.setPlacement(layer, placement, unit))) {
        // Not placed: hidden rather than shown in the wrong place.
        this.hidden.add(layer);
        this.ctx.viewer.patchState(
          (ng) => {
            const spec = ((ng as { layers?: Record<string, unknown>[] }).layers ?? []).find((l) => l.name === layer);
            if (spec !== undefined) spec.visible = false;
          },
          { quiet: true },
        );
      }
      if (!this.current(generation)) return;
    }
    this.update?.();
  }

  /** Sets a layer's transform to its own (from its metadata) followed by `placement` (in units of `unit` mm). */
  /** Whether it was placed: an image with other than x, y and z (channels, time) is not, yet. */
  private async setPlacement(layer: string, placement: Mat4, unit: number): Promise<boolean> {
    // Neuroglancer knows the layer's transform once it has read its metadata.
    for (let i = 0; i < 100; ++i) {
      const t = this.ctx.viewer.layerTransform(layer);
      const p = t && physical(t, t.defaultMatrix);
      if (t && !p) {
        this.ctx.log.error(`${layer} is not placed: only images with x, y and z alone can be placed (it has ${t.output.names.join(", ")}).`);
        return false;
      }
      if (t && p) {
        const order = ["x", "y", "z"].map((n) => t.output.names.indexOf(n));
        if (order.some((k) => k === -1)) return false;
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
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.ctx.log.error(`${layer} is not placed: its metadata did not load.`);
    return false;
  }

  private async choose(system: string): Promise<void> {
    const generation = ++this.generation;
    this.ctx.state.set<Saved>({ ...this.saved(), system });
    await this.place(system, generation);
  }

  /**
   * The coordinate systems as a graph: members on the left, the
   * collections' systems on the right, each transform an edge; the system
   * the tab is viewed in is outlined, and clicking one views in it.
   */
  private graphView(root: CollectionNode): SVGSVGElement {
    const systems = sceneSystems(root);
    const mems = members(root).map((m) => m.node);
    const g = graph(root);
    const keyOf = new Map<string, string>();
    for (const m of mems) for (const k of [m.id, m.name, ...m.systems.map((s) => s.id)]) if (k) keyOf.set(k, `m:${m.name}`);
    for (const s of systems) keyOf.set(s.id, `s:${s.id}`);
    const W = 300;
    const rowH = 26;
    const rows = Math.max(mems.length, systems.length, 1);
    const H = rows * rowH + 10;
    const at = new Map<string, { x: number; y: number }>();
    mems.forEach((m, i) => at.set(`m:${m.name}`, { x: 6, y: 5 + i * rowH + (rows - mems.length) * rowH * 0.5 }));
    systems.forEach((s, i) => at.set(`s:${s.id}`, { x: W - 116, y: 5 + i * rowH + (rows - systems.length) * rowH * 0.5 }));
    const chosen = this.saved().system;
    const box = (key: string, label: string, cls: string, onclick?: () => void) => {
      const p = at.get(key)!;
      return svg(
        "g",
        { class: cls, ...(onclick ? { onclick, role: "button", tabindex: 0 } : {}) },
        svg("rect", { x: p.x, y: p.y, width: 110, height: rowH - 6, rx: 4 }),
        svg("text", { x: p.x + 6, y: p.y + rowH / 2 + 1 }, label.length > 17 ? `${label.slice(0, 16)}…` : label),
        svg("title", {}, cls.includes("warped") ? `${label}: warped through a displacement field` : label),
      );
    };
    const edges = g.transforms.flatMap((t) => {
      const a = at.get(keyOf.get(t.input) ?? "");
      const b = at.get(keyOf.get(t.output) ?? "");
      if (!a || !b) return [];
      // A transform from a system to a member (as registration writes a field) runs right to left.
      const back = a.x > b.x;
      const ax = back ? a.x : a.x + 110;
      const ay = a.y + (rowH - 6) / 2;
      const bx = back ? b.x + 110 : b.x;
      const by = b.y + (rowH - 6) / 2;
      const same = a.x === b.x;
      const d = same ? `M${a.x + 110},${ay} C${a.x + 150},${ay} ${b.x + 150},${by} ${b.x + 110},${by}` : `M${ax},${ay} C${(ax + bx) / 2},${ay} ${(ax + bx) / 2},${by} ${bx},${by}`;
      // The label by the member's end, where edges into one system do not overlap.
      const label = same ? { x: a.x + 116, y: ay - 3 } : back ? { x: bx + 4, y: by + 11 } : { x: ax + 4, y: ay - 3 };
      return [svg("path", { class: "cl-edge", d, "marker-end": "url(#cl-arrow)" }), svg("text", { class: "cl-edge-label", ...label }, t.type)];
    });
    return svg(
      "svg",
      { class: "cl-graph", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Coordinate systems and transforms" },
      svg("defs", {}, svg("marker", { id: "cl-arrow", viewBox: "0 0 8 8", refX: 8, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, svg("path", { d: "M0,0 L8,4 L0,8 z", fill: "currentColor" }))),
      ...edges,
      ...mems.map((m) => box(`m:${m.name}`, m.name, `cl-mem${this.warped.has(m.name) ? " warped" : ""}${this.hidden.has(m.name) ? " hidden" : ""}`)),
      ...systems.map((s) => box(`s:${s.id}`, s.name ?? s.id, `cl-sys${s.id === chosen ? " on" : ""}`, () => void this.choose(s.id))),
    );
  }

  render(host: HTMLElement): () => void {
    const url = el("input", { class: "text-input", type: "text", placeholder: "https://…/collection.json or a Zarr group", "aria-label": "Collection address", spellcheck: "false" }) as HTMLInputElement;
    url.addEventListener("input", () => (this.typed = url.value));
    url.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.openInTab(url.value.trim());
    });
    const draw = () => {
      const tab = this.inCollectionScene();
      const root = tab ? this.root : undefined;
      const tree = (n: CollectionNode, depth: number): HTMLElement[] => [
        el(
          "div",
          { class: "cl-node", style: `padding-left: ${depth * 12}px` },
          el("span", { class: "cl-kind" }, n.type),
          el(
            "span",
            {},
            n.name,
            this.warped.has(n.name) ? el("span", { class: "cl-tag", title: "Resampled through the displacement field in its chain, computed as you view it" }, "warped") : null,
            this.hidden.has(n.name) ? el("span", { class: "cl-tag off", title: "No chain of transforms to this system that can be applied" }, "hidden") : null,
          ),
          n.location ? el("span", { class: "cl-where" }, n.location.url) : null,
        ),
        ...n.nodes.flatMap((c) => tree(c, depth + 1)),
      ];
      const g = root && graph(root);
      const found = this.foundHere();
      const chosen = root && sceneSystems(root).find((s) => s.id === this.saved().system);
      url.value = this.typed || this.documentUrl;
      host.replaceChildren(
        el(
          "div",
          { class: "cl" },
          found.length
            ? el(
                "div",
                { class: "cl-found" },
                el("span", {}, tab ? "Collections holding the workspace's images:" : "This scene's images belong to:"),
                ...found.map((f) =>
                  el(
                    "div",
                    { class: "cl-row" },
                    el("strong", {}, f.name),
                    el("button", { class: "btn small", type: "button", disabled: this.busy || (tab && f.url === this.documentUrl), onclick: () => void this.openInTab(f.url) }, tab ? "Show" : "Open in the Collections tab"),
                  ),
                ),
              )
            : null,
          el(
            "div",
            { class: "cl-row" },
            url,
            el("button", { class: "btn primary small", type: "button", disabled: this.busy, onclick: () => void this.openInTab(url.value.trim()) }, "Open"),
            el("button", { class: "btn outline small", type: "button", disabled: this.busy, onclick: () => void this.openInTab(EXAMPLE_URL) }, "Example"),
          ),
          this.error ? el("p", { class: "note error" }, this.error) : null,
          !root
            ? el(
                "p",
                { class: "note", title: "An OME-NGFF collection (RFC-8, draft): images, each placed by its transforms." },
                tab ? "No collection open. Open one by its address, or the example." : "Open a collection by its address, or the example. It opens in the Collections tab.",
              )
            : null,
          root ? el("h3", { class: "section-title" }, `${root.name}: coordinate systems`) : null,
          root ? this.graphView(root) : null,
          root ? el("p", { class: "note" }, chosen ? `Viewed in ${chosen.name ?? chosen.id} (${chosen.axes.join(", ")}${chosen.units.some(Boolean) ? `; ${[...new Set(chosen.units.filter(Boolean))].join(", ")}` : ""}). Click another system to view in it.` : "Click a system to view the images in it.") : null,
          root && this.warped.size
            ? el("p", { class: "note" }, `Warped through a displacement field (computed as you view it, placed by the chain's affines): ${[...this.warped].join(", ")}.`)
            : null,
          root && this.hidden.size ? el("p", { class: "note" }, `Hidden, with no chain of transforms to this system that can be applied: ${[...this.hidden].join(", ")}.`) : null,
          root ? el("h3", { class: "section-title" }, "Members") : null,
          root ? el("div", { class: "cl-tree" }, ...tree(root, 0)) : null,
          g && g.transforms.length ? el("h3", { class: "section-title" }, "Transforms") : null,
          g && g.transforms.length ? el("div", { class: "cl-table" }, ...g.transforms.flatMap((t) => [el("span", {}, `${t.input} → ${t.output}`), el("span", { class: "cl-value" }, describeTransform(t.raw))])) : null,
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
