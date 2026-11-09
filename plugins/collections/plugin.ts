/**
 * The OME Collections plugin: an Add collection tab in the scene bar that
 * opens a sheet (make a collection of the scene's images, open one found
 * for the workspace's data, by address or from a file, or the example), and
 * a tab per collection (a scene of the plugin's own kind) whose viewer shows
 * only its images, each placed by its transforms in the coordinate system
 * chosen.  The Collection panel beside it: the graph of its coordinate
 * systems and the transforms between them (click a system to view in it),
 * and the collection built there: members, systems and transforms added and
 * removed, a member's placement taken from the view, the JSON downloaded.
 * In an ordinary scene the panel offers the collections that scene's data
 * belongs to.  The model is ./collection.ts.
 */
import type { LayerTransform, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { card, el } from "@ngplatform/sdk/dom";
import { describeTransform } from "@ngplatform/sdk/ome";
import { neuroglancer, physical } from "../registration/plugin.js";
import {
  chainInto,
  type CollectionNode,
  collectionFromScene,
  displayRangeOf,
  type Edit,
  editCollection,
  fieldWarp,
  firstLevel,
  graph,
  isCollection,
  type Mat4,
  members,
  parentGroups,
  placeInto,
  placementOf,
  readCollection,
  sceneSystems,
  toSystemUnits,
  transformJson,
  UNITS,
  zarrGroupUrl,
} from "./collection.js";
import example from "./examples/srb_gallery.json";
import { ADD_COLLECTION, COLLECTION_KIND, COLLECTIONS_PANEL } from "./manifest.js";

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

/** Millimetres in one unit of a coordinate system (its first axis with a unit; mm when none). */
const unitOf = (system: { units: string[] } | undefined): number => UNITS[system?.units.find((u) => u !== "") ?? "millimeter"] ?? 1;

/** The URL a document read from `url` resolves its paths against (the page's, for one made here). */
const baseOf = (url: string | undefined): string => (url === undefined || url === "" ? location.href : /\.json$/i.test(url) ? url : `${url.replace(/\/$/, "")}/zarr.json`);

/** x, y, z values in the order of `axes` (z, y, x for an image's own space). */
const onAxes = (xyz: number[], axes: string[]): number[] => axes.map((n) => xyz[["x", "y", "z"].indexOf(n)] ?? 0);

/** Kinds of transform the panel writes, with what their value field asks for. */
const KINDS: { type: string; label: string; hint: string }[] = [
  { type: "identity", label: "identity", hint: "" },
  { type: "translation", label: "translation", hint: "x y z, in the target's units" },
  { type: "scale", label: "scale", hint: "x y z" },
  { type: "affine", label: "affine", hint: "12 numbers: rows x, y, z, each a b c t" },
  { type: "displacements", label: "displacement field", hint: "the field's Zarr group (URL)" },
];

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

/**
 * What the plugin keeps per scene (a collection's tab): where the collection
 * was read from, the document as built here (once made or edited here), and
 * the system it is viewed in.
 */
interface Saved {
  url?: string;
  doc?: unknown;
  system?: string;
}

const STYLE = `
.cl { display: grid; gap: 10px; padding: 10px 12px; font-size: 12px; }
.cl-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cl-row input { flex: 1; min-width: 120px; }
.cl-row > .text-input { width: auto; flex: 1; min-width: 0; }
.cl-row > input.text-input { min-width: 90px; }
.cl-row > select.text-input { flex: 0 1 auto; }
.cl-member { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 2px 6px; align-items: center; min-height: 24px; }
.cl-url { grid-column: 1 / -1; color: var(--faint); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl-member + .cl-member { border-top: 1px solid var(--line); padding-top: 4px; }
.cl-kind { font: 11px var(--mono); color: var(--muted); }
.cl-where { color: var(--faint); font: 11px var(--mono); }
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
.cl-name { font: 600 13px var(--ui); background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 2px 4px; color: var(--text); min-width: 0; flex: 1; }
.cl-name:hover, .cl-name:focus { border-color: var(--line); }
.cl-list { display: grid; gap: 2px; }
.cl-item { display: flex; gap: 6px; align-items: center; min-height: 24px; }
.cl-item > :first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.cl-x { border: 0; background: transparent; color: var(--faint); cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1; }
.cl-x:hover { color: var(--text); }
.cl-add { display: grid; gap: 6px; padding: 8px; border: 1px dashed var(--line); border-radius: 6px; }
.cl-add select, .cl-add input { min-width: 0; }
.cl-add .cl-row > * { flex: 1; }
.cl-add .cl-row > button { flex: none; }
.cl-sheet { display: grid; gap: 14px; font-size: 13px; }
.cl-sheet section { display: grid; gap: 8px; }
.cl-sheet .cl-pick { display: grid; gap: 2px; max-height: 180px; overflow: auto; }
.cl-sheet .cl-pick label { display: grid; grid-template-columns: auto max-content minmax(0, 1fr); gap: 8px; align-items: baseline; }
.cl-sheet .cl-pick .cl-where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

class Collections {
  /** The collection the active tab shows, its document (as read, or as built here) and where it was read from ("" when made here). */
  private root: CollectionNode | undefined;
  private doc: unknown;
  private documentUrl = "";
  /** What `root` was read for (the tab's saved state), so it is read again only when that changes. */
  private loadedKey = "";
  private error = "";
  private busy = false;
  /** Bumped by each open, edit or choice of system: work for an older one stops at its next step. */
  private generation = 0;
  /** The address typed in the Add sheet (kept while it is drawn again). */
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
      ctx.state.onChanged(() => void this.follow()),
    );
    void this.follow();
    void this.discover();
  }

  private inCollectionScene(): boolean {
    return this.activeScene()?.kind === COLLECTION_KIND;
  }

  private activeScene() {
    return this.ctx.workspace.scenes().find((s) => s.active);
  }

  private saved(): Saved {
    return this.ctx.state.get<Saved>() ?? {};
  }

  private keyOf(saved: Saved): string {
    return `${this.activeScene()?.id}|${saved.url ?? ""}|${saved.system ?? ""}|${saved.doc === undefined ? "" : JSON.stringify(saved.doc)}`;
  }

  /**
   * In a collection's tab, the collection it shows, read again after a
   * reload, a switch of tab or an undo (the layers are the scene's already:
   * only which members are warped or hidden is worked out again).
   */
  private async follow(): Promise<void> {
    if (!this.inCollectionScene() || this.busy) return;
    const saved = this.saved();
    const key = this.keyOf(saved);
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    this.error = "";
    if (saved.doc !== undefined) {
      try {
        this.root = readCollection(saved.doc, baseOf(saved.url));
        this.doc = saved.doc;
        this.documentUrl = saved.url ?? "";
      } catch (e) {
        this.root = undefined;
        this.error = `Could not read the collection: ${(e as Error).message}`;
      }
    } else if (saved.url !== undefined) {
      const doc = await this.fetchDocument(saved.url);
      // Another tab, or another collection, while it was read: that one's turn.
      if (this.keyOf(this.saved()) !== key) {
        this.loadedKey = "";
        return void this.follow();
      }
      this.root = doc === undefined ? undefined : this.readOrSay(doc, saved.url);
      this.doc = doc;
      this.documentUrl = saved.url;
    } else {
      this.root = undefined;
      this.doc = undefined;
      this.documentUrl = "";
    }
    this.mark(saved.system);
    this.update?.();
  }

  /** Which members are warped through a field, and which hidden, in `system` (as `place` finds them, without placing). */
  private mark(system: string | undefined): void {
    this.warped.clear();
    this.hidden.clear();
    const root = this.root;
    if (root === undefined || system === undefined) return;
    for (const m of members(root)) {
      if (m.node.location === undefined || placeInto(root, m.node, system) !== undefined) continue;
      const steps = chainInto(root, m.node, system);
      (steps && fieldWarp(steps, 1) ? this.warped : this.hidden).add(m.node.name);
    }
  }

  /** The collection document at `url` (a .json file, or a Zarr group's zarr.json); undefined, with the error said, when it cannot be read. */
  private async fetchDocument(url: string): Promise<unknown> {
    if (url === EXAMPLE_URL) return example;
    this.busy = true;
    this.error = "";
    this.update?.();
    try {
      const response = await fetch(baseOf(url));
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (e) {
      this.error = `Could not read the collection at ${url}: ${(e as Error).message}`;
      return undefined;
    } finally {
      this.busy = false;
      this.update?.();
    }
  }

  private readOrSay(doc: unknown, url: string | undefined): CollectionNode | undefined {
    try {
      return readCollection(doc, baseOf(url));
    } catch (e) {
      this.error = `Could not read the collection: ${(e as Error).message}`;
      return undefined;
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

  /** The collections found for the workspace's images. */
  private foundHere(): { url: string; name: string }[] {
    const sources = this.ctx.workspace.datasets().map((d) => (typeof d.source === "string" ? d.source : typeof (d.source as { url?: unknown })?.url === "string" ? (d.source as { url: string }).url : ""));
    const groups = new Set(sources.flatMap((s) => parentGroups(s)));
    return [...this.found].filter(([g, name]) => name && groups.has(g)).map(([url, name]) => ({ url, name: name! }));
  }

  /** Opens the collection at `url` in a tab of its own; whether it could be read. */
  async openUrl(url: string): Promise<boolean> {
    if (url === "") {
      this.error = "Enter a collection's address (its collection.json or Zarr group), or choose the example.";
      this.update?.();
      return false;
    }
    const doc = await this.fetchDocument(url);
    return doc !== undefined && (await this.openDocument(doc, url));
  }

  /**
   * Opens a collection document in a new tab (a scene of the plugin's kind,
   * named after it) showing its images in its first coordinate system.
   * `url`: where it was read from (its paths are relative to it); none for
   * one made here, which the tab keeps whole.
   */
  async openDocument(doc: unknown, url?: string): Promise<boolean> {
    const root = this.readOrSay(doc, url);
    if (root === undefined) {
      this.update?.();
      return false;
    }
    const generation = ++this.generation;
    this.ctx.workspace.newScene({ name: root.name, kind: COLLECTION_KIND });
    const system = sceneSystems(root)[0]?.id;
    const saved: Saved = url === undefined ? { doc, system } : { url, system };
    this.root = root;
    this.doc = doc;
    this.documentUrl = url ?? "";
    this.loadedKey = this.keyOf(saved);
    this.ctx.state.set<Saved>(saved);
    await this.show(system, generation, []);
    return true;
  }

  /** Whether work begun for `generation` may go on: nothing newer was asked for, and a collection's tab is still the scene shown. */
  private current(generation: number): boolean {
    return generation === this.generation && this.inCollectionScene();
  }

  /** The tab's images: the layers of members no longer in it (`gone`) removed, each member's placed in `system`. */
  private async show(system: string | undefined, generation: number, gone: string[]): Promise<void> {
    const root = this.root;
    if (root === undefined || !this.current(generation)) return;
    for (const name of gone) if (this.ctx.viewer.layerSpec(name) !== undefined) this.ctx.workspace.removeLayer(name);
    await this.place(system, generation);
    if (!this.current(generation)) return;
    this.ctx.log.info(`Showing ${root.name} in its tab.`);
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
   * member with no chain is hidden (its layer there, not shown).
   */
  private async place(system: string | undefined, generation: number): Promise<void> {
    const root = this.root;
    if (root === undefined || system === undefined || !this.current(generation)) return;
    const unit = unitOf(sceneSystems(root).find((s) => s.id === system));
    this.warped.clear();
    this.hidden.clear();
    for (const m of members(root)) {
      const layer = m.node.name;
      if (m.node.location === undefined) continue;
      const plain = `zarr://${m.node.location.url}/`;
      let placement = placeInto(root, m.node, system);
      let source = plain;
      let warped = false;
      if (placement === undefined) {
        const steps = chainInto(root, m.node, system);
        const shown = steps && fieldWarp(steps, unit);
        if (shown !== undefined) {
          placement = shown.placement;
          try {
            source = await this.ctx.workspace.computed.url({ source: plain, chunk: [64, 64, 64], warp: shown.warp });
            warped = true;
          } catch (e) {
            this.ctx.log.error(`Could not warp ${layer}: ${(e as Error).message}`);
            placement = undefined;
          }
          if (!this.current(generation)) return;
        }
      }
      if (warped) this.warped.add(layer);
      if (placement === undefined) {
        this.hidden.add(layer);
        // There to be seen in the layer list, not shown.
        if (this.ctx.viewer.layerSpec(layer) === undefined) await this.setSource(layer, plain);
      } else await this.setSource(layer, source, warped ? m.node.location.url : undefined);
      if (!this.current(generation)) return;
      this.setVisible(layer, placement !== undefined);
      if (placement !== undefined && !(await this.setPlacement(layer, placement, unit))) {
        // Not placed: hidden rather than shown in the wrong place.
        this.hidden.add(layer);
        this.setVisible(layer, false);
      }
      if (!this.current(generation)) return;
    }
    this.update?.();
  }

  private setVisible(layer: string, visible: boolean): void {
    this.ctx.viewer.patchState(
      (ng) => {
        const spec = ((ng as { layers?: Record<string, unknown>[] }).layers ?? []).find((l) => l.name === layer);
        if (spec !== undefined) spec.visible = visible;
      },
      { quiet: true },
    );
  }

  /** A layer's transform, once Neuroglancer has read its metadata: as shown and as the image gives it (physical, mm), and its output axes; undefined when it has not x, y and z alone. */
  private async layerPlacement(layer: string): Promise<{ now: Mat4; own: Mat4; names: string[]; t: LayerTransform } | undefined> {
    for (let i = 0; i < 100; ++i) {
      const t = this.ctx.viewer.layerTransform(layer);
      if (t !== undefined) {
        const now = physical(t, t.matrix);
        const own = physical(t, t.defaultMatrix);
        if (now === undefined || own === undefined) {
          this.ctx.log.error(`${layer} is not placed: only images with x, y and z alone can be placed (it has ${t.output.names.join(", ")}).`);
          return undefined;
        }
        return { now: Array.from(now), own: Array.from(own), names: t.output.names, t };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    this.ctx.log.error(`${layer} is not placed: its metadata did not load.`);
    return undefined;
  }

  /** Sets a layer's transform to its own (from its metadata) followed by `placement` (in units of `unit` mm); whether it was placed. */
  private async setPlacement(layer: string, placement: Mat4, unit: number): Promise<boolean> {
    const at = await this.layerPlacement(layer);
    if (at === undefined) return false;
    const order = ["x", "y", "z"].map((n) => at.names.indexOf(n));
    if (order.some((k) => k === -1)) return false;
    // The placement in millimetres, in the layer's output order.
    const a = new Float64Array(16);
    a[15] = 1;
    order.forEach((r, i2) => {
      order.forEach((c, j) => (a[4 * r + c] = placement[4 * i2 + j]));
      a[4 * r + 3] = placement[4 * i2 + 3] * unit;
    });
    const p = at.own;
    const out = new Float64Array(16);
    for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) for (let k = 0; k < 4; ++k) out[4 * r + c] += a[4 * r + k] * p[4 * k + c];
    this.ctx.viewer.setLayerTransform(layer, neuroglancer(at.t, out));
    return true;
  }

  private async choose(system: string): Promise<void> {
    const generation = ++this.generation;
    const saved = { ...this.saved(), system };
    this.loadedKey = this.keyOf(saved);
    this.ctx.state.set<Saved>(saved);
    await this.place(system, generation);
  }

  // ------------------------------------------------------------- building

  /**
   * Changes the tab's collection: the document edited (kept whole with the
   * tab from now on), read again, and its images shown (the layers of
   * members gone removed, the rest placed again).
   */
  private async edit(change: Edit): Promise<void> {
    const before = this.root;
    if (this.doc === undefined || before === undefined) return;
    let doc: unknown;
    let root: CollectionNode;
    try {
      doc = editCollection(this.doc, change);
      root = readCollection(doc, baseOf(this.documentUrl));
    } catch (e) {
      this.error = `Could not change the collection: ${(e as Error).message}`;
      this.update?.();
      return;
    }
    this.error = "";
    const now = new Set(members(root).map((m) => m.node.name));
    const gone = members(before).map((m) => m.node.name).filter((n) => !now.has(n));
    const systems = sceneSystems(root);
    const kept = this.saved().system;
    const system = systems.some((s) => s.id === kept) ? kept : systems[0]?.id;
    const saved: Saved = { ...(this.documentUrl ? { url: this.documentUrl } : {}), doc, system };
    this.doc = doc;
    this.root = root;
    this.loadedKey = this.keyOf(saved);
    this.ctx.state.set<Saved>(saved);
    if (change.op === "rename") {
      const scene = this.activeScene();
      if (scene !== undefined) this.ctx.workspace.renameScene(scene.id, change.name);
    }
    this.update?.();
    await this.show(system, ++this.generation, gone);
  }

  /** The keys a transform may name a member by: its id, its name, its own systems. */
  private static keysOf(node: CollectionNode): Set<string> {
    return new Set([node.id, node.name, ...node.systems.map((s) => s.id)].filter((k): k is string => !!k));
  }

  /**
   * A member's placement as its layer is shown now (moved in the viewer),
   * written as its transform into the system viewed: the top collection's
   * transform from it to that system replaced, or one added.
   */
  private async fromView(node: CollectionNode): Promise<void> {
    const root = this.root;
    const id = this.saved().system;
    const system = root && sceneSystems(root).find((s) => s.id === id);
    if (root === undefined || system === undefined) return;
    const at = await this.layerPlacement(node.name);
    const mm = at && placementOf(at.now, at.own, at.names);
    if (mm === undefined) {
      this.ctx.ui.toast(`${node.name}'s placement could not be read from the view.`, "error");
      return;
    }
    let transform: any;
    try {
      transform = { ...transformJson(toSystemUnits(mm, unitOf(system)), system.axes), input: { id: node.id ?? node.name }, output: { id: system.id } };
    } catch (e) {
      this.ctx.ui.toast((e as Error).message, "error");
      return;
    }
    const keys = Collections.keysOf(node);
    const index = root.transforms.findIndex((t) => keys.has(t.input) && t.output === system.id);
    await this.edit(index === -1 ? { op: "addTransform", transform } : { op: "setTransform", index, transform });
  }

  /** The collection's JSON, as a file to save. */
  private download(): void {
    if (this.doc === undefined || this.root === undefined) return;
    const blob = new Blob([JSON.stringify(this.doc, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${this.root.name.replace(/[^\w.-]+/g, "_") || "collection"}.json` }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------- the sheet

  /** The Add collection sheet: from this scene, found, by address, from a file, the example. */
  showAddSheet(): void {
    this.ctx.ui.sheet(
      "Add a collection",
      (body, close) => {
        const said = el("p", { class: "note error" }) as HTMLElement;
        said.hidden = true;
        const attempt = (work: () => Promise<boolean>) => async () => {
          said.hidden = true;
          if (await work()) return close();
          said.textContent = this.error || "That could not be opened.";
          said.hidden = false;
        };
        const sections: HTMLElement[] = [this.fromSceneSection(attempt)];
        const found = this.foundHere();
        if (found.length)
          sections.push(
            el(
              "section",
              {},
              el("h3", { class: "section-title" }, "Holding this workspace's images"),
              ...found.map((f) =>
                el("div", { class: "cl-row" }, el("strong", { style: "flex: 1" }, f.name), el("button", { class: "btn outline small", type: "button", onclick: attempt(() => this.openUrl(f.url)) }, "Open")),
              ),
            ),
          );
        const url = el("input", { class: "text-input mono", type: "text", placeholder: "https://…/collection.json or a Zarr group", "aria-label": "Collection address", spellcheck: "false", value: this.typed }) as HTMLInputElement;
        url.addEventListener("input", () => (this.typed = url.value));
        const openTyped = attempt(() => this.openUrl(url.value.trim()));
        url.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void openTyped();
        });
        const file = el("input", { type: "file", accept: ".json,application/json", hidden: true }) as HTMLInputElement;
        file.addEventListener(
          "change",
          attempt(async () => {
            const f = file.files?.[0];
            if (f === undefined) return false;
            try {
              return await this.openDocument(JSON.parse(await f.text()));
            } catch (e) {
              this.error = `${f.name} is not a collection: ${(e as Error).message}`;
              return false;
            }
          }),
        );
        sections.push(
          el(
            "section",
            {},
            el("h3", { class: "section-title" }, "Open"),
            el("div", { class: "cl-row" }, url, el("button", { class: "btn primary small", type: "button", onclick: openTyped }, "Open")),
            el("div", { class: "cl-row" }, el("button", { class: "btn outline small", type: "button", onclick: () => file.click() }, "A .json file on this computer…"), file),
          ),
          el(
            "section",
            {},
            el("h3", { class: "section-title" }, "Example"),
            el(
              "div",
              { class: "example" },
              el("span", { class: "title" }, "SRB 2026a gallery"),
              el("span", { class: "desc" }, "The synchrotron reference brain template three times in one coordinate system: as it is, moved, and mirrored left to right."),
              el("button", { class: "btn outline", type: "button", onclick: attempt(() => this.openUrl(EXAMPLE_URL)) }, "Open"),
            ),
          ),
          said,
        );
        body.append(el("div", { class: "cl-sheet" }, ...sections));
      },
      { wide: true },
    );
  }

  /** The sheet's "From this scene": the scene's OME-Zarr images to choose from, the collection's name and its system's unit. */
  private fromSceneSection(attempt: (work: () => Promise<boolean>) => () => Promise<void>): HTMLElement {
    const title = el("h3", { class: "section-title" }, "From this scene");
    const scene = this.activeScene();
    if (scene === undefined || scene.kind !== undefined)
      return el("section", {}, title, el("p", { class: "note" }, "Switch to a scene first."));
    const layers = this.ctx.workspace.sceneDatasets().flatMap((d) => d.layers.map((l) => ({ name: l.name, url: zarrGroupUrl(l.sources[0] ?? d.source) })));
    const images = layers.filter((l): l is { name: string; url: string } => l.url !== undefined);
    if (images.length === 0)
      return el("section", {}, title, el("p", { class: "note" }, layers.length ? "No OME-Zarr images in this scene." : "This scene is empty."));
    const boxes = images.map((image) => ({ image, box: el("input", { type: "checkbox", checked: true }) as HTMLInputElement }));
    const name = el("input", { class: "text-input", type: "text", value: `${scene.name} collection`, "aria-label": "Collection name", title: "The collection's name (and its tab's)" }) as HTMLInputElement;
    const unit = el("select", { class: "text-input", "aria-label": "Unit of its coordinate system", title: "The unit of its coordinate system" }, ...Object.keys(UNITS).map((u) => el("option", { value: u, selected: u === "micrometer" }, u))) as HTMLSelectElement;
    const others = layers.length - images.length;
    return el(
      "section",
      {},
      title,
      el(
        "div",
        { class: "cl-pick" },
        ...boxes.map(({ image, box }) => el("label", {}, box, el("span", {}, image.name), el("span", { class: "cl-where" }, image.url))),
      ),
      others ? el("p", { class: "note" }, `${others} other layer${others === 1 ? "" : "s"} left out (not OME-Zarr).`) : null,
      el("div", { class: "cl-row" }, name, unit, el("button", { class: "btn primary small", type: "button", onclick: attempt(() => this.fromScene(name.value.trim() || scene.name, unit.value, boxes.filter((b) => b.box.checked).map((b) => b.image))) }, "Make the collection")),
    );
  }

  /** A collection of the active scene's `images`, each placed as the scene shows it, opened in a tab of its own. */
  private async fromScene(name: string, unit: string, images: { name: string; url: string }[]): Promise<boolean> {
    if (images.length === 0) {
      this.error = "Choose at least one image.";
      return false;
    }
    const placed = await Promise.all(
      images.map(async (image) => {
        const t = this.ctx.viewer.layerTransform(image.name);
        const now = t && physical(t, t.matrix);
        const own = t && physical(t, t.defaultMatrix);
        return { ...image, placement: now && own ? placementOf(Array.from(now), Array.from(own), t!.output.names) : undefined };
      }),
    );
    return this.openDocument(collectionFromScene(name, { name, unit }, placed));
  }

  // ------------------------------------------------------------- the panel

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

  private static removeButton(what: string, run: () => void): HTMLElement {
    return el("button", { class: "cl-x", type: "button", title: `Remove ${what}`, "aria-label": `Remove ${what}`, onclick: run }, "×");
  }

  /** The members: the tree, each of the top collection's removable and placeable from the view; and a member to add. */
  private membersView(root: CollectionNode): HTMLElement[] {
    const top = new Set(root.nodes);
    const system = this.saved().system;
    const tree = (n: CollectionNode, depth: number): HTMLElement[] => [
      el(
        "div",
        { class: "cl-member", style: `padding-left: ${depth * 12}px` },
        el(
          "span",
          {},
          el("span", { class: "cl-kind" }, `${n.type} `),
          n.name,
          this.warped.has(n.name) ? el("span", { class: "cl-tag", title: "Resampled through the displacement field in its chain, computed as you view it" }, "warped") : null,
          this.hidden.has(n.name) ? el("span", { class: "cl-tag off", title: "No chain of transforms to this system that can be applied" }, "hidden") : null,
        ),
        top.has(n) && n.location && system && !this.warped.has(n.name) && !this.hidden.has(n.name)
          ? el(
              "button",
              { class: "btn outline small", type: "button", title: "Write where this layer is now (moved in the viewer) as its transform into the system viewed", onclick: () => void this.fromView(n) },
              "From the view",
            )
          : null,
        top.has(n) ? Collections.removeButton(n.name, () => void this.edit({ op: "removeMember", id: n.id ?? n.name })) : null,
        n.location ? el("span", { class: "cl-url", title: n.location.url }, n.location.url) : null,
      ),
      ...n.nodes.flatMap((c) => tree(c, depth + 1)),
    ];
    // The workspace's OME-Zarr datasets not in the collection, to add; or an address.
    const inside = new Set(members(root).map((m) => m.node.location?.url));
    const choices = this.ctx.workspace
      .datasets()
      .map((d) => ({ name: d.name, url: zarrGroupUrl(d.source) }))
      .filter((d): d is { name: string; url: string } => d.url !== undefined && !inside.has(d.url));
    const pick = el(
      "select",
      { class: "text-input", "aria-label": "Dataset to add" },
      el("option", { value: "" }, choices.length ? "A dataset of the workspace…" : "An address below"),
      ...choices.map((c, i) => el("option", { value: String(i) }, c.name)),
    ) as HTMLSelectElement;
    const address = el("input", { class: "text-input mono", type: "text", placeholder: "or an OME-Zarr image's address", spellcheck: "false" }) as HTMLInputElement;
    const add = () => {
      const chosen = pick.value === "" ? undefined : choices[Number(pick.value)];
      const url = chosen?.url ?? zarrGroupUrl(address.value.trim()) ?? (/^https?:\/\//.test(address.value.trim()) ? address.value.trim().replace(/\/+$/, "") : undefined);
      if (url === undefined) return this.ctx.ui.toast("Choose a dataset, or enter an OME-Zarr image's address.", "error");
      const name = chosen?.name ?? url.split("/").pop()!.replace(/\.ome\.zarr$|\.zarr$/, "");
      void this.edit({ op: "addMember", name, url });
    };
    return [
      el("div", { class: "cl-list" }, ...tree(root, 0)),
      el(
        "div",
        { class: "cl-add" },
        el("div", { class: "cl-row" }, pick),
        el("div", { class: "cl-row" }, address, el("button", { class: "btn small", type: "button", onclick: add }, "Add member")),
      ),
    ];
  }

  /** The coordinate systems: each viewable and removable; and one to add. */
  private systemsView(root: CollectionNode): HTMLElement[] {
    const chosen = this.saved().system;
    const name = el("input", { class: "text-input", type: "text", placeholder: "Name, e.g. Atlas", "aria-label": "System name" }) as HTMLInputElement;
    const unit = el("select", { class: "text-input", "aria-label": "Unit" }, ...Object.keys(UNITS).map((u) => el("option", { value: u, selected: u === "micrometer" }, u))) as HTMLSelectElement;
    const add = () => {
      if (name.value.trim() === "") return this.ctx.ui.toast("Name the coordinate system.", "error");
      void this.edit({ op: "addSystem", name: name.value.trim(), unit: unit.value });
    };
    const own = new Set(root.systems.map((s) => s.id));
    return [
      el(
        "div",
        { class: "cl-list" },
        ...sceneSystems(root).map((s) =>
          el(
            "div",
            { class: "cl-item" },
            el("span", {}, el("strong", {}, s.name ?? s.id), el("span", { class: "cl-kind" }, ` ${s.axes.join(", ")}${s.units.some(Boolean) ? `; ${[...new Set(s.units.filter(Boolean))].join(", ")}` : ""}`)),
            s.id === chosen ? el("span", { class: "cl-tag" }, "viewed") : el("button", { class: "btn outline small", type: "button", onclick: () => void this.choose(s.id) }, "View in it"),
            own.has(s.id) ? Collections.removeButton(`${s.name ?? s.id} and its transforms`, () => void this.edit({ op: "removeSystem", id: s.id })) : null,
          ),
        ),
      ),
      el("div", { class: "cl-add" }, el("div", { class: "cl-row" }, name, unit, el("button", { class: "btn small", type: "button", onclick: add }, "Add system"))),
    ];
  }

  /** The transforms as written (the top collection's removable), and a relationship to add between a member or system and another. */
  private transformsView(root: CollectionNode): HTMLElement[] {
    const g = graph(root);
    const own = new Set(root.transforms.map((t) => t.raw));
    const ends = [
      ...members(root).map((m) => ({ id: m.node.id ?? m.node.name, label: m.node.name, axes: ["z", "y", "x"] })),
      ...sceneSystems(root).map((s) => ({ id: s.id, label: `${s.name ?? s.id} (system)`, axes: s.axes })),
    ];
    const options = (selected: number) => ends.map((e, i) => el("option", { value: String(i), selected: i === selected }, e.label));
    const firstSystem = ends.findIndex((e) => e.label.endsWith("(system)"));
    const from = el("select", { class: "text-input", "aria-label": "From" }, ...options(0)) as HTMLSelectElement;
    const to = el("select", { class: "text-input", "aria-label": "To" }, ...options(Math.max(firstSystem, 0))) as HTMLSelectElement;
    const kind = el("select", { class: "text-input", "aria-label": "Kind" }, ...KINDS.map((k) => el("option", { value: k.type }, k.label))) as HTMLSelectElement;
    const value = el("input", { class: "text-input mono", type: "text", spellcheck: "false", "aria-label": "Value" }) as HTMLInputElement;
    const hint = () => {
      const k = KINDS.find((x) => x.type === kind.value)!;
      value.placeholder = k.hint;
      value.hidden = k.hint === "";
    };
    kind.addEventListener("change", hint);
    hint();
    const add = () => {
      const a = ends[Number(from.value)];
      const b = ends[Number(to.value)];
      if (a === undefined || b === undefined || a.id === b.id) return this.ctx.ui.toast("Choose two different ends.", "error");
      let t: any;
      try {
        t = this.typedTransform(kind.value, value.value, b.axes);
      } catch (e) {
        return this.ctx.ui.toast((e as Error).message, "error");
      }
      void this.edit({ op: "addTransform", transform: { ...t, input: { id: a.id }, output: { id: b.id } } });
    };
    return [
      g.transforms.length
        ? el(
            "div",
            { class: "cl-list" },
            ...g.transforms.map((t) =>
              el(
                "div",
                { class: "cl-item" },
                el("span", {}, `${t.input} → ${t.output} `, el("span", { class: "cl-value" }, describeTransform(t.raw))),
                own.has(t.raw) ? Collections.removeButton(`${t.input} → ${t.output}`, () => void this.edit({ op: "removeTransform", index: root.transforms.findIndex((x) => x.raw === t.raw) })) : null,
              ),
            ),
          )
        : el("p", { class: "note" }, "No relationships yet."),
      el(
        "div",
        { class: "cl-add" },
        el("div", { class: "cl-row" }, from, el("span", { style: "flex: none" }, "→"), to),
        el("div", { class: "cl-row" }, kind, value, el("button", { class: "btn small", type: "button", onclick: add }, "Add relationship")),
      ),
    ];
  }

  /** A transform typed in the panel: numbers on x, y, z (or a field's address), written on the target's `axes`. */
  private typedTransform(type: string, text: string, axes: string[]): any {
    const numbers = text.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (numbers.some((n) => !Number.isFinite(n))) throw new Error("Numbers only, separated by spaces.");
    switch (type) {
      case "identity":
        return { type: "identity" };
      case "translation":
        if (numbers.length !== 3) throw new Error("A translation is three numbers: x y z.");
        return { type: "translation", translation: onAxes(numbers, axes) };
      case "scale":
        if (numbers.length !== 3) throw new Error("A scale is three numbers: x y z.");
        return { type: "scale", scale: onAxes(numbers, axes) };
      case "affine":
        if (numbers.length !== 12) throw new Error("An affine is twelve numbers: rows x, y, z, each a b c t.");
        return transformJson([...numbers, 0, 0, 0, 1], axes);
      case "displacements": {
        const url = text.trim();
        if (!/^https?:\/\//.test(url)) throw new Error("A displacement field is its Zarr group's address (https://…).");
        return { type: "displacements", path: url };
      }
    }
    throw new Error(`Unknown kind ${type}.`);
  }

  render(host: HTMLElement): () => void {
    const draw = () => {
      const tab = this.inCollectionScene();
      const root = tab ? this.root : undefined;
      const found = this.foundHere();
      const chosen = root && sceneSystems(root).find((s) => s.id === this.saved().system);
      const addButton = el("button", { class: "btn outline small", type: "button", onclick: () => this.showAddSheet() }, "Add collection…");
      if (root === undefined) {
        host.replaceChildren(
          el(
            "div",
            { class: "cl" },
            this.error ? el("p", { class: "note error" }, this.error) : null,
            !tab && found.length
              ? el(
                  "div",
                  { class: "cl-found" },
                  el("span", {}, "This workspace's images belong to:"),
                  ...found.map((f) => el("div", { class: "cl-row" }, el("strong", {}, f.name), el("button", { class: "btn small", type: "button", disabled: this.busy, onclick: () => void this.openUrl(f.url) }, "Open in a tab"))),
                )
              : null,
            el("p", { class: "note", title: "An OME-NGFF collection (RFC-8, draft): images, each placed by its transforms." }, this.busy ? "Reading the collection…" : "No collection open."),
            el("div", { class: "cl-row" }, addButton),
          ),
        );
        return;
      }
      const name = el("input", { class: "cl-name", type: "text", value: root.name, "aria-label": "Collection name", title: "Rename the collection" }) as HTMLInputElement;
      name.addEventListener("change", () => {
        const v = name.value.trim();
        if (v !== "" && v !== root.name) void this.edit({ op: "rename", name: v });
      });
      const copy = () =>
        void navigator.clipboard.writeText(JSON.stringify(this.doc, null, 2)).then(
          () => this.ctx.ui.toast("Copied the collection's JSON."),
          () => this.ctx.ui.toast("Could not copy.", "error"),
        );
      const edited = this.saved().doc !== undefined;
      host.replaceChildren(
        el(
          "div",
          { class: "cl" },
          el("div", { class: "cl-row" }, name),
          el(
            "div",
            { class: "cl-row" },
            el("button", { class: "btn outline small", type: "button", title: "Save the collection's JSON", onclick: () => this.download() }, "Download JSON"),
            el("button", { class: "btn outline small", type: "button", onclick: copy }, "Copy JSON"),
          ),
          // Where it came from, only when it came from somewhere (its changes stay with the tab: say so in the tooltip).
          this.documentUrl
            ? el(
                "p",
                { class: "note", title: edited ? "Changes are kept with this tab, not written back." : undefined },
                `${edited ? "Changed from" : "From"} ${this.documentUrl === EXAMPLE_URL ? "the example" : this.documentUrl}`,
              )
            : null,
          this.error ? el("p", { class: "note error" }, this.error) : null,
          this.graphView(root),
          chosen ? null : el("p", { class: "note" }, "Add a coordinate system to view the images in."),
          this.warped.size ? el("p", { class: "note" }, `Warped: ${[...this.warped].join(", ")}.`) : null,
          this.hidden.size ? el("p", { class: "note" }, `Hidden (no transform to this system): ${[...this.hidden].join(", ")}.`) : null,
          card("collections.members", "Members", { open: true, badge: String(members(root).length) }, ...this.membersView(root)),
          card("collections.systems", "Coordinate systems", { badge: String(sceneSystems(root).length) }, ...this.systemsView(root)),
          card("collections.relationships", "Relationships", { badge: String(graph(root).transforms.length) }, ...this.transformsView(root)),
          el("div", { class: "cl-row" }, addButton),
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
    ctx.subscriptions.push(ctx.commands.register(ADD_COLLECTION, () => collections.showAddSheet()));
    ctx.ui.panel(COLLECTIONS_PANEL, (host) => collections.render(host));
  },
};
