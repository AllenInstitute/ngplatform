/**
 * The OME Collections plugin: an Add collection tab in the scene bar that
 * opens a sheet (make a collection of the scene's images, open one found
 * for the workspace's data, by address or from a file, or the example), and
 * a tab per collection (a scene of the plugin's own kind) whose viewer shows
 * only its images, each placed by its transforms in the coordinate system
 * chosen (label images as segmentations).  The Collection panel beside it:
 * the graph of its coordinate systems and the transforms between them
 * (click a system to view in it), and the collection built there: members,
 * systems and transforms added and removed, a member's placement taken from
 * the view, the JSON downloaded.  In an ordinary scene the panel offers the
 * collections that scene's data belongs to.  The model is ./collection.ts.
 */
import type { LayerTransform, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, card, checkbox, downloadBlob, el, emptyState, field, iconButton, numberInput, region, safeFileName, select, statusLine } from "@ngplatform/sdk/dom";
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
  isLabelImage,
  type Mat4,
  members,
  parentGroups,
  placeInto,
  placementOf,
  readCollection,
  sceneSystems,
  stepsMatrix,
  toSystemUnits,
  transformJson,
  unappliedKinds,
  UNITS,
  unitOf,
  zarrGroupUrl,
} from "./collection.js";
import example from "./examples/srb_gallery.json";
import { GRAPH, type GraphBox, layoutGraph, looseHeading, nextBox } from "./graph_view.js";
import { ADD_COLLECTION, COLLECTION_KIND, COLLECTIONS_PANEL } from "./manifest.js";
import { gcsReadable } from "@ngplatform/sdk/sources";

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

/** How long a read of a collection or an image's metadata may take before it is given up (ms). */
export const READ_TIMEOUT = 15_000;

/**
 * The JSON at `url`: undefined when it is not there (or not JSON); an
 * error, said plainly, when it fails or takes longer than READ_TIMEOUT.
 */
async function readJson(url: string, missing: "undefined" | "throw" = "undefined"): Promise<unknown> {
  try {
    const response = await fetch(gcsReadable(url), { signal: AbortSignal.timeout(READ_TIMEOUT) });
    if (!response.ok) {
      if (missing === "throw") throw new Error(`${response.status} ${response.statusText}`.trim());
      return undefined;
    }
    return missing === "throw" ? await response.json() : await response.json().catch(() => undefined);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new Error(`no answer in ${READ_TIMEOUT / 1000} s`);
    throw e;
  }
}

/** The URL a document read from `url` resolves its paths against (the page's, for one made here). */
const baseOf = (url: string | undefined): string => (url === undefined || url === "" ? location.href : /\.json$/i.test(url) ? url : `${url.replace(/\/$/, "")}/zarr.json`);

/** x, y, z values in the order of `axes` (z, y, x for an image's own space). */
const onAxes = (xyz: number[], axes: string[]): number[] => axes.map((n) => xyz[["x", "y", "z"].indexOf(n)] ?? 0);

/** Kinds of transform the panel writes, with what their value field asks for (an affine has its own grid). */
const KINDS: { type: string; label: string; hint: string }[] = [
  { type: "identity", label: "identity", hint: "" },
  { type: "translation", label: "translation", hint: "x y z, in the target's units" },
  { type: "scale", label: "scale", hint: "x y z" },
  { type: "affine", label: "affine", hint: "" },
  { type: "displacements", label: "displacement field", hint: "the field's Zarr group (URL)" },
];

/** Twelve numbers, rows x, y, z, each a b c t, from text (spaces, commas or semicolons between); undefined when it is not that. */
export function twelveNumbers(text: string): number[] | undefined {
  const numbers = text.split(/[\s,;[\]]+/).filter(Boolean).map(Number);
  return numbers.length === 12 && numbers.every(Number.isFinite) ? numbers : undefined;
}

/** How many images' metadata is kept (the oldest let go first); a collection opened lets go of the rest. */
export const GROUPS_KEPT = 256;

/** An image's metadata: its group's zarr.json (or .zattrs), read once per image while kept. */
const groups = new Map<string, Promise<unknown>>();
/** The Zarr version an image's metadata was found in (3: zarr.json, 2: .zattrs), once read. */
const versions = new Map<string, 2 | 3>();
function groupOf(url: string): Promise<unknown> {
  let group = groups.get(url);
  if (group === undefined) {
    const json = (key: string) => readJson(`${url}/${key}`).catch(() => undefined);
    group = (async () => {
      const v3 = await json("zarr.json");
      if (v3 !== undefined) versions.set(url, 3);
      const v2 = v3 === undefined ? await json(".zattrs") : undefined;
      if (v2 !== undefined) versions.set(url, 2);
      return v3 ?? v2;
    })();
    groups.set(url, group);
    for (const old of groups.keys()) {
      if (groups.size <= GROUPS_KEPT) break;
      groups.delete(old);
      versions.delete(old);
    }
  }
  return group;
}

/** How many images' metadata is kept now (for tests). */
export const groupsKept = (): number => groups.size;

/** How many members are placed at once. */
export const PLACED_AT_ONCE = 4;
/**
 * How long a member waits for the one before it to be added (ms), so the
 * layers keep the collection's order; after that, a member whose metadata
 * is slow no longer holds the others back, and is added when it comes.
 */
export const ORDER_WAIT = 2000;

/** Runs `run` on each item, at most `limit` at once, in their order. */
async function eachAtOnce<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The contrast range an image (a Zarr group's URL) is shown with by default (`displayRangeOf`). */
async function displayRange(url: string): Promise<[number, number] | undefined> {
  const group = await groupOf(url);
  const level = firstLevel(group);
  const json = (key: string) => readJson(`${url}/${key}`).catch(() => undefined);
  const array = level === undefined ? undefined : ((await json(`${level}/zarr.json`)) ?? (await json(`${level}/.zarray`)));
  return displayRangeOf(group, array);
}

/**
 * What the plugin keeps per scene (a collection's tab): where the collection
 * was read from, the document as built here (once made or edited here), and
 * the system it is viewed in.
 */
export interface Saved {
  url?: string;
  doc?: unknown;
  system?: string;
}

const STYLE = `
.cl-name { font-weight: 600; font-size: var(--fs-control); }
.cl-grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.cl-member { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--sp-1) var(--sp-3); align-items: center; min-height: var(--ctl-h); }
.cl-member + .cl-member, .cl-nest + .cl-member { border-top: 1px solid var(--line); padding-top: var(--sp-2); }
.cl-member > .hint, .cl-url { grid-column: 1 / -1; }
.cl-nest { padding-left: var(--sp-5); }
.cl-url { color: var(--faint); font: var(--fs-caption) var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl-kind { font: var(--fs-caption) var(--mono); color: var(--muted); }
.cl-value { font: var(--fs-caption) var(--mono); overflow-wrap: anywhere; }
.cl-graph { width: 100%; height: auto; display: block; }
.cl-graph .cl-node { cursor: pointer; outline: none; }
.cl-graph .cl-sys rect { fill: var(--ink-3); stroke: var(--line-strong); }
.cl-graph .cl-sys.on rect { stroke: var(--select); stroke-width: 2; }
.cl-graph .cl-node:hover rect { fill: var(--ink-4); }
.cl-graph .cl-mem rect, .cl-graph .cl-more rect { fill: var(--ink-2); stroke: var(--line); }
.cl-graph .cl-more rect { stroke-dasharray: 2 2; }
.cl-graph .cl-mem.warped rect { stroke: var(--select); stroke-dasharray: 4 2; }
.cl-graph .cl-mem.hidden text { fill: var(--faint); }
.cl-graph .cl-node:focus-visible rect { stroke: var(--accent); stroke-width: 2; }
.cl-graph text { fill: var(--text); font-family: var(--ui); font-size: var(--fs-caption); }
.cl-graph text.cl-how { fill: var(--faint); font-family: var(--mono); }
.cl-graph .cl-edge { stroke: var(--muted); fill: none; }
.cl-graph .cl-spine { stroke: var(--line-strong); fill: none; }
.cl-tag { margin-left: var(--sp-3); padding: 0 var(--sp-2); border: 1px dashed var(--select); font: var(--fs-caption) var(--mono); color: var(--muted); }
.cl-tag.off { border-color: var(--line); color: var(--faint); }
.cl-tag.warn { border-color: var(--warn); }
.cl-item { display: flex; gap: var(--sp-3); align-items: center; min-height: var(--ctl-h); }
.cl-add { display: grid; gap: var(--sp-3); padding-top: var(--sp-4); border-top: 1px dashed var(--line); }
.cl-add .row > .text-input { flex: 1 1 90px; width: auto; min-width: 0; }
.cl-matrix { display: grid; grid-template-columns: auto repeat(4, minmax(0, 1fr)); gap: var(--sp-2); align-items: center; }
.cl-matrix > .num-input { width: 100%; }
.cl-matrix > span { color: var(--faint); font: var(--fs-caption) var(--mono); text-align: center; }
.cl-sheet { display: grid; gap: var(--sp-6); }
.cl-sheet section { display: grid; gap: var(--sp-4); }
.cl-pick { display: grid; gap: var(--sp-1); max-height: 180px; overflow: auto; }
.cl-pick > div { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sp-4); align-items: center; }
.cl-where { color: var(--faint); font: var(--fs-caption) var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

/** Why a member is hidden in a system: the transforms on its way that cannot be applied, or that nothing joins it to the system. */
function hiddenWhy(root: CollectionNode, node: CollectionNode): string {
  const kinds = unappliedKinds(root, node);
  return kinds.length ? `${kinds.join(", ")} transforms are not applied here` : "no transform to this system";
}

export class Collections {
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
  /** Members shown warped through a displacement field in the system viewed; members hidden, by name, with why. */
  private warped = new Set<string>();
  private hidden = new Map<string, string>();
  /** The graph's groups shown in full, the box last focused in it, and the graph drawn. */
  private graphOpen = new Set<string>();
  private graphFocus = "";
  private graphEl: SVGSVGElement | undefined;

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
  async follow(): Promise<void> {
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
      if (steps !== undefined && stepsMatrix(steps) !== undefined) continue;
      if (steps && fieldWarp(steps, 1)) {
        if (this.ctx.viewer.layerSpec(m.node.name)?.type === "segmentation") this.hidden.set(m.node.name, "a label image is not warped through a field");
        else this.warped.add(m.node.name);
      } else this.hidden.set(m.node.name, hiddenWhy(root, m.node));
    }
  }

  /** The collection document at `url` (a .json file, or a Zarr group's zarr.json); undefined, with the error said, when it cannot be read. */
  private async fetchDocument(url: string): Promise<unknown> {
    if (url === EXAMPLE_URL) return example;
    this.busy = true;
    this.error = "";
    this.update?.();
    try {
      return await readJson(baseOf(url), "throw");
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

  /** The workspace's datasets' sources, as text. */
  private sources(): string[] {
    return this.ctx.workspace.datasets().map((d) => (typeof d.source === "string" ? d.source : typeof (d.source as { url?: unknown })?.url === "string" ? (d.source as { url: string }).url : ""));
  }

  /**
   * Looks for collections above the workspace's images: a parent Zarr
   * group whose metadata is an OME collection.  Each group is asked once;
   * one that does not answer in time is said in the log.
   */
  async discover(): Promise<void> {
    const sources = this.sources().filter((s) => /^(zarr3?|zarr2|ome-zarr):\/\/|\.zarr\/?$/.test(s));
    for (const source of sources) {
      for (const group of parentGroups(source)) {
        if (this.found.has(group) || this.looking.has(group)) continue;
        this.looking.add(group);
        try {
          const doc = await readJson(`${group}/zarr.json`);
          this.found.set(group, doc !== undefined && isCollection(doc) ? readCollection(doc, `${group}/zarr.json`).name : null);
        } catch (e) {
          this.found.set(group, null);
          this.ctx.log.error(`Looking for a collection at ${group}: ${(e as Error).message}.`);
        } finally {
          this.looking.delete(group);
        }
        if (this.found.get(group)) this.update?.();
      }
    }
  }

  /** The collections found for the workspace's images. */
  private foundHere(): { url: string; name: string }[] {
    const groups = new Set(this.sources().flatMap((s) => parentGroups(s)));
    return [...this.found].filter(([g, name]) => name && groups.has(g)).map(([url, name]) => ({ url, name: name! }));
  }

  /**
   * Opens the collection at `url` in a tab of its own; whether it could be
   * read.  `wait`: also wait for its members to be placed (the Add
   * collection sheet closes once it is read, the members follow).
   */
  async openUrl(url: string, wait = true): Promise<boolean> {
    if (url === "") {
      this.error = "Enter a collection's address (its collection.json or Zarr group), or choose the example.";
      this.update?.();
      return false;
    }
    const doc = await this.fetchDocument(url);
    return doc !== undefined && (await this.openDocument(doc, url, wait));
  }

  /**
   * Opens a collection document in a new tab (a scene of the plugin's kind,
   * named after it) showing its images in its first coordinate system.
   * `url`: where it was read from (its paths are relative to it); none for
   * one made here, which the tab keeps whole.
   */
  async openDocument(doc: unknown, url?: string, wait = true): Promise<boolean> {
    const root = this.readOrSay(doc, url);
    if (root === undefined) {
      this.update?.();
      return false;
    }
    const generation = ++this.generation;
    // Images of the collections opened before are let go of.
    groups.clear();
    versions.clear();
    this.ctx.workspace.newScene({ name: root.name, kind: COLLECTION_KIND });
    const system = sceneSystems(root)[0]?.id;
    const saved: Saved = url === undefined ? { doc, system } : { url, system };
    this.root = root;
    this.doc = doc;
    this.documentUrl = url ?? "";
    this.loadedKey = this.keyOf(saved);
    this.ctx.state.set<Saved>(saved);
    const placing = this.show(system, generation, []);
    if (wait) await placing;
    else
      placing.catch((e) => {
        this.error = `Could not place the collection's members: ${(e as Error).message}`;
        this.update?.();
      });
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

  /** Whether a member is a label image: by its node, its place in a `labels` group, or its image's metadata. */
  private async isLabel(node: CollectionNode): Promise<boolean> {
    const url = node.location?.url ?? "";
    return node.label === true || isLabelImage(undefined, url) || isLabelImage(await groupOf(url));
  }

  /**
   * A member's layer showing `source` as `kind` (an image, or a label
   * image's segmentation; the layer replaced when it shows another), named
   * after the member.  A warped layer (`warpedFrom`: the member's image) is
   * float32, whose default range would show it white: it keeps the
   * contrast the layer had, or takes the image's own.
   */
  private async setSource(layer: string, source: string, kind: "image" | "segmentation", warpedFrom?: string): Promise<void> {
    const spec = this.ctx.viewer.layerSpec(layer) as { type?: string; source?: unknown; shader?: unknown; shaderControls?: { normalized?: unknown } } | undefined;
    const now = typeof spec?.source === "string" ? spec.source : (spec?.source as { url?: string } | undefined)?.url;
    if (spec !== undefined && now === source && (spec.type === undefined || spec.type === kind)) return;
    if (spec !== undefined) this.ctx.workspace.removeLayer(layer);
    const id = this.ctx.workspace.addDataset({ source, name: warpedFrom === undefined ? layer : `${layer} (warped)`, kind });
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

  /**
   * Places each member's layer in `system`, by the chain of transforms to
   * it: affine chains as the layer's transform; a chain through a
   * displacement field as a layer computed as it is viewed (the member
   * resampled back through the chain), placed by the chain's affines; a
   * member with no chain is hidden (its layer there, not shown), with why.
   * Label images are segmentation layers, and are not warped.
   */
  private async place(system: string | undefined, generation: number): Promise<void> {
    const root = this.root;
    if (root === undefined || system === undefined || !this.current(generation)) return;
    const unit = unitOf(sceneSystems(root).find((s) => s.id === system)).mm;
    this.warped.clear();
    this.hidden.clear();
    const placed = members(root).filter((m) => m.node.location !== undefined);
    // Members are placed a few at once.  Each waits for the one before it to
    // be added, so the layers keep the collection's order, but only for a
    // while: one whose metadata is slow is then passed by.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => (timer = setTimeout(resolve, ORDER_WAIT)));
    const added = placed.map(() => {
      let done!: () => void;
      const promise = new Promise<void>((resolve) => (done = resolve));
      return { promise, done };
    });
    try {
      await eachAtOnce(placed, PLACED_AT_ONCE, async (m, i) => {
        const turn = () => (i === 0 ? Promise.resolve() : Promise.race([added[i - 1].promise, waited]));
        try {
          await this.placeMember(root, m.node, system, unit, generation, turn, added[i].done);
        } catch (e) {
          if (!this.current(generation)) return;
          this.hidden.set(m.node.name, `it could not be shown: ${(e as Error).message}`);
          this.ctx.log.error(`Could not show ${m.node.name}: ${(e as Error).message}`);
        } finally {
          added[i].done();
        }
      });
    } finally {
      clearTimeout(timer);
    }
    if (!this.current(generation)) return;
    this.update?.();
  }

  /**
   * Places one member's layer in `system` (see `place`): `turn` settles when
   * its layer may be added, and `addedNow` is called once it is.
   */
  private async placeMember(
    root: CollectionNode,
    node: CollectionNode,
    system: string,
    unit: number,
    generation: number,
    turn: () => Promise<void>,
    addedNow: () => void,
  ): Promise<void> {
    const layer = node.name;
    const location = node.location;
    if (location === undefined) return;
    const kind = (await this.isLabel(node)) ? "segmentation" : "image";
    // Named by the Zarr version its metadata (read already) was found in: Neuroglancer then looks for no other's.
    await groupOf(location.url);
    const version = versions.get(location.url);
    const plain = `${version === undefined ? "zarr" : `zarr${version}`}://${location.url}/`;
    if (!this.current(generation)) return;
    let placement = placeInto(root, node, system);
    let source = plain;
    let warped = false;
    let why = "";
    if (placement === undefined) {
      const steps = chainInto(root, node, system);
      placement = steps && stepsMatrix(steps);
      const shown = placement === undefined && steps !== undefined ? fieldWarp(steps, unit) : undefined;
      if (shown !== undefined && kind === "segmentation") why = "a label image is not warped through a field";
      else if (shown !== undefined) {
        placement = shown.placement;
        try {
          source = await this.ctx.workspace.computed.url({ source: plain, chunk: [64, 64, 64], warp: shown.warp });
          warped = true;
        } catch (e) {
          why = `it could not be warped: ${(e as Error).message}`;
          this.ctx.log.error(`Could not warp ${layer}: ${(e as Error).message}`);
          placement = undefined;
        }
        if (!this.current(generation)) return;
      }
      if (placement === undefined && why === "") why = hiddenWhy(root, node);
    }
    await turn();
    if (!this.current(generation)) return;
    if (warped) this.warped.add(layer);
    if (placement === undefined) {
      this.hidden.set(layer, why);
      // There to be seen in the layer list, not shown.
      if (this.ctx.viewer.layerSpec(layer) === undefined) await this.setSource(layer, plain, kind);
    } else await this.setSource(layer, source, kind, warped ? location.url : undefined);
    addedNow();
    if (!this.current(generation)) return;
    this.setVisible(layer, placement !== undefined);
    if (placement !== undefined) {
      const notPlaced = await this.setPlacement(layer, placement, unit, () => this.current(generation));
      if (notPlaced !== "" && this.current(generation)) {
        // Not placed: hidden rather than shown in the wrong place.
        this.hidden.set(layer, notPlaced);
        this.setVisible(layer, false);
      }
    }
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

  /**
   * A layer's transform, once Neuroglancer has read its metadata: as shown
   * and as the image gives it (physical, mm), and its output axes; or why
   * it cannot be placed (it has not x, y and z alone, or its metadata did
   * not load).
   */
  private async layerPlacement(layer: string, still: () => boolean = () => true): Promise<{ now: Mat4; own: Mat4; names: string[]; t: LayerTransform } | string> {
    for (let i = 0; i < 100 && still(); ++i) {
      const t = this.ctx.viewer.layerTransform(layer);
      if (t !== undefined) {
        const now = physical(t, t.matrix);
        const own = physical(t, t.defaultMatrix);
        if (now === undefined || own === undefined) return `only images with x, y and z alone are placed (it has ${t.output.names.join(", ")})`;
        return { now: Array.from(now), own: Array.from(own), names: t.output.names, t };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return "its metadata did not load";
  }

  /** Sets a layer's transform to its own (from its metadata) followed by `placement` (in units of `unit` mm); "" when placed, else why not. */
  private async setPlacement(layer: string, placement: Mat4, unit: number, still: () => boolean = () => true): Promise<string> {
    const at = await this.layerPlacement(layer, still);
    if (!still()) return "";
    if (typeof at === "string") {
      this.ctx.log.error(`${layer} is not placed: ${at}.`);
      return at;
    }
    const order = ["x", "y", "z"].map((n) => at.names.indexOf(n));
    if (order.some((k) => k === -1)) return `it has no ${["x", "y", "z"].filter((_, i) => order[i] === -1).join(", ")} axis`;
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
    return "";
  }

  async choose(system: string): Promise<void> {
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
  async edit(change: Edit): Promise<void> {
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
  async fromView(node: CollectionNode): Promise<void> {
    const root = this.root;
    const id = this.saved().system;
    const system = root && sceneSystems(root).find((s) => s.id === id);
    if (root === undefined || system === undefined) return;
    const at = await this.layerPlacement(node.name);
    const mm = typeof at === "string" ? undefined : placementOf(at.now, at.own, at.names);
    if (mm === undefined) {
      this.ctx.ui.toast(`${node.name}'s placement could not be read from the view${typeof at === "string" ? `: ${at}` : ""}.`, "error");
      return;
    }
    let transform: any;
    try {
      transform = { ...transformJson(toSystemUnits(mm, unitOf(system).mm), system.axes), input: { id: node.id ?? node.name }, output: { id: system.id } };
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
    downloadBlob(new Blob([JSON.stringify(this.doc, null, 2)], { type: "application/json" }), `${safeFileName(this.root.name, "collection")}.json`);
  }

  // ------------------------------------------------------------- the sheet

  /** The Add collection sheet: from this scene, found, by address, from a file, the example. */
  showAddSheet(): void {
    this.ctx.ui.sheet(
      "Add a collection",
      (body, close) => {
        const said = statusLine();
        const attempt = (work: () => Promise<boolean>) => async () => {
          said.clear();
          if (await work()) return close();
          said.error(this.error || "That could not be opened.");
        };
        const sections: HTMLElement[] = [this.fromSceneSection(attempt)];
        const found = this.foundHere();
        if (found.length)
          sections.push(
            el(
              "section",
              {},
              el("h3", { class: "section-title" }, "Holding this workspace's images"),
              ...found.map((f) => el("div", { class: "row" }, el("strong", { class: "cl-grow" }, f.name), button("Open", attempt(() => this.openUrl(f.url, false))))),
            ),
          );
        const url = el("input", { class: "text-input mono cl-grow", type: "text", placeholder: "https://…/collection.json or a Zarr group", "aria-label": "Collection address", spellcheck: "false", value: this.typed }) as HTMLInputElement;
        url.addEventListener("input", () => (this.typed = url.value));
        const openTyped = attempt(() => this.openUrl(url.value.trim(), false));
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
              return await this.openDocument(JSON.parse(await f.text()), undefined, false);
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
            el("div", { class: "row" }, url, button("Open", openTyped, undefined, "btn outline small")),
            el("div", { class: "row" }, button("A .json file on this computer…", () => file.click()), file),
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
              button("Open", attempt(() => this.openUrl(EXAMPLE_URL, false)), undefined, "btn outline"),
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
    if (scene === undefined || scene.kind !== undefined) return el("section", {}, title, el("p", { class: "hint" }, "Switch to a scene first."));
    const layers = this.ctx.workspace.sceneDatasets().flatMap((d) => d.layers.map((l) => ({ name: l.name, url: zarrGroupUrl(l.sources[0] ?? d.source) })));
    const images = layers.filter((l): l is { name: string; url: string } => l.url !== undefined);
    if (images.length === 0) return el("section", {}, title, el("p", { class: "hint" }, layers.length ? "No OME-Zarr images in this scene." : "This scene is empty."));
    const boxes = images.map((image) => ({ image, box: checkbox(image.name, true, () => {}) }));
    const name = el("input", { class: "text-input", type: "text", value: `${scene.name} collection` }) as HTMLInputElement;
    let unitChosen = "micrometer";
    const unit = select(Object.keys(UNITS).map((u) => [u, u]), unitChosen, (u) => (unitChosen = u));
    const others = layers.length - images.length;
    return el(
      "section",
      {},
      title,
      el("div", { class: "cl-pick" }, ...boxes.map(({ image, box }) => el("div", {}, box, el("span", { class: "cl-where" }, image.url)))),
      others ? el("p", { class: "hint" }, `${others} other layer${others === 1 ? "" : "s"} left out (not OME-Zarr).`) : null,
      el("div", { class: "row" }, field("Name", name), field("Unit", unit)),
      el(
        "div",
        { class: "row" },
        button(
          "Make the collection",
          attempt(() => this.fromScene(name.value.trim() || scene.name, unitChosen, boxes.filter((b) => b.box.input.checked).map((b) => b.image))),
          undefined,
          "btn primary small",
        ),
      ),
    );
  }

  /** A collection of the active scene's `images`, each placed as the scene shows it, opened in a tab of its own. */
  private async fromScene(name: string, unit: string, images: { name: string; url: string }[]): Promise<boolean> {
    if (images.length === 0) {
      this.error = "Choose at least one image.";
      return false;
    }
    const placed = images.map((image) => {
      const t = this.ctx.viewer.layerTransform(image.name);
      const now = t && physical(t, t.matrix);
      const own = t && physical(t, t.defaultMatrix);
      return { ...image, placement: now && own ? placementOf(Array.from(now), Array.from(own), t!.output.names) : undefined };
    });
    return this.openDocument(collectionFromScene(name, { name, unit }, placed), undefined, false);
  }

  // ------------------------------------------------------------- the panel

  /**
   * The coordinate systems as a graph (laid out by ./graph_view.ts): a
   * group per system, its members below it, the system the tab is viewed in
   * outlined.  One box at a time takes the focus (a roving tabindex): the
   * arrow keys, Home and End move between boxes; Enter or Space, like a
   * click, views in a system, selects a member's layer, or opens a group
   * folded past `SHOWN` members.
   */
  private graphView(root: CollectionNode): SVGSVGElement {
    const chosen = this.saved().system;
    const layout = layoutGraph(
      {
        systems: sceneSystems(root),
        members: members(root).map(({ node: m }) => ({
          name: m.name,
          keys: [m.id, m.name, ...m.systems.map((s) => s.id)].filter((k): k is string => !!k),
          warped: this.warped.has(m.name),
          hidden: this.hidden.has(m.name),
        })),
        transforms: graph(root).transforms,
      },
      this.graphOpen,
      chosen,
    );
    const { boxes } = layout;
    // The box that takes the focus: the one last focused, if it is still drawn.
    let current = Math.max(0, boxes.findIndex((b) => b.key === this.graphFocus));
    const act = (b: GraphBox) => {
      if (b.kind === "system") void this.choose(b.system!);
      else if (b.kind === "member") this.ctx.workspace.selectLayer(b.member!);
      else if (b.group !== undefined) {
        if (!this.graphOpen.delete(b.group)) this.graphOpen.add(b.group);
        this.update?.();
      }
    };
    const nodes = boxes.map((b, i) => {
      const cls = `cl-node cl-${b.kind === "system" ? "sys" : b.kind === "member" ? "mem" : "more"}${b.kind === "system" && b.system === chosen ? " on" : ""}${b.warped ? " warped" : ""}${b.hidden ? " hidden" : ""}`;
      const g = svg(
        "g",
        { class: cls, role: "button", tabindex: i === current ? 0 : -1, "aria-label": b.label, "data-key": b.key },
        svg("rect", { x: b.x, y: b.y, width: b.w, height: b.h }),
        svg("text", { x: b.x + 6, y: b.y + GRAPH.line }, b.lines[0]),
        ...(b.lines[1] ? [svg("text", { class: "cl-how", x: b.x + 6, y: b.y + 2 * GRAPH.line + 1 }, b.lines[1])] : []),
        svg("title", {}, b.title),
      );
      g.addEventListener("click", () => {
        this.graphFocus = b.key;
        act(b);
      });
      g.addEventListener("focus", () => {
        current = i;
        this.graphFocus = b.key;
      });
      return g;
    });
    const move = (to: number) => {
      nodes[current].setAttribute("tabindex", "-1");
      nodes[to].setAttribute("tabindex", "0");
      current = to;
      this.graphFocus = boxes[to].key;
      nodes[to].focus();
    };
    const loose = looseHeading(layout);
    const view = svg(
      "svg",
      { class: "cl-graph", viewBox: `0 0 ${layout.width} ${layout.height}`, role: "group", "aria-label": "Coordinate systems and their members: arrow keys move, Enter chooses" },
      svg("defs", {}, svg("marker", { id: "cl-arrow", viewBox: "0 0 8 8", refX: 8, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, svg("path", { d: "M0,0 L8,4 L0,8 z", fill: "currentColor" }))),
      ...layout.spines.map((p) => svg("path", { class: "cl-spine", d: p.d })),
      ...layout.arcs.map((p) => svg("path", { class: "cl-edge", d: p.d, "marker-end": "url(#cl-arrow)" })),
      ...(loose ? [svg("text", { class: "cl-how", x: loose.x, y: loose.y }, "Joined to no system")] : []),
      ...nodes,
    );
    view.addEventListener("keydown", (e) => {
      const b = boxes[current];
      if (b === undefined) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        act(b);
        return;
      }
      const to = nextBox(boxes, current, e.key);
      if (to === undefined) return;
      e.preventDefault();
      move(to);
    });
    // Drawn again (a system chosen, a group opened) while a box had the focus: the same box takes it back.
    const had = this.graphEl !== undefined && this.graphEl.contains(document.activeElement);
    this.graphEl = view;
    if (had && nodes[current]) queueMicrotask(() => nodes[current].focus());
    return view;
  }

  /** The member tree: each of the top collection's removable and placeable from the view; why one is hidden; a label image tagged. */
  private memberRows(root: CollectionNode): HTMLElement[] {
    const top = new Set(root.nodes);
    const system = this.saved().system;
    const tree = (n: CollectionNode): HTMLElement[] => {
      const why = this.hidden.get(n.name);
      const labels = this.ctx.viewer.layerSpec(n.name)?.type === "segmentation";
      const rows: HTMLElement[] = [
        el(
          "div",
          { class: "cl-member" },
          el(
            "span",
            { class: "cl-grow" },
            el("span", { class: "cl-kind" }, `${n.type} `),
            n.name,
            labels ? el("span", { class: "cl-tag off" }, "labels") : null,
            this.warped.has(n.name) ? el("span", { class: "cl-tag" }, "warped") : null,
            why !== undefined ? el("span", { class: "cl-tag off" }, "hidden") : null,
          ),
          top.has(n) && n.location && system && !this.warped.has(n.name) && why === undefined ? button("From the view", () => void this.fromView(n)) : null,
          top.has(n) ? iconButton("close", `Remove ${n.name}`, () => void this.edit({ op: "removeMember", id: n.id ?? n.name })) : null,
          n.location ? el("span", { class: "cl-url", title: n.location.url }, n.location.url) : null,
          why ? el("p", { class: "hint" }, `Hidden: ${why}.`) : null,
        ),
      ];
      const children = n.nodes.flatMap(tree);
      if (children.length) rows.push(el("div", { class: "cl-nest" }, ...children));
      return rows;
    };
    return tree(root);
  }

  /** The coordinate systems: each viewable and removable, its unit said when it is not one OME-NGFF names. */
  private systemRows(root: CollectionNode): HTMLElement[] {
    const chosen = this.saved().system;
    const own = new Set(root.systems.map((s) => s.id));
    return sceneSystems(root).map((s) => {
      const unknown = unitOf(s).unknown;
      return el(
        "div",
        { class: "cl-item" },
        el(
          "span",
          { class: "cl-grow" },
          el("strong", {}, s.name ?? s.id),
          el("span", { class: "cl-kind" }, ` ${s.axes.join(", ")}${s.units.some(Boolean) ? `; ${[...new Set(s.units.filter(Boolean))].join(", ")}` : ""}`),
          unknown !== undefined ? el("span", { class: "cl-tag warn" }, `unit '${unknown}' read as mm`) : null,
        ),
        s.id === chosen ? el("span", { class: "cl-tag" }, "viewed") : button("View in it", () => void this.choose(s.id)),
        own.has(s.id) ? iconButton("close", `Remove ${s.name ?? s.id} and its transforms`, () => void this.edit({ op: "removeSystem", id: s.id })) : null,
      );
    });
  }

  /** The transforms as written, the top collection's removable. */
  private transformRows(root: CollectionNode): HTMLElement[] {
    const g = graph(root);
    if (g.transforms.length === 0) return [el("p", { class: "hint" }, "No relationships yet.")];
    const own = new Set(root.transforms.map((t) => t.raw));
    return g.transforms.map((t) =>
      el(
        "div",
        { class: "cl-item" },
        el("span", { class: "cl-grow" }, `${t.input} → ${t.output} `, el("span", { class: "cl-value" }, describeTransform(t.raw))),
        own.has(t.raw) ? iconButton("close", `Remove ${t.input} → ${t.output}`, () => void this.edit({ op: "removeTransform", index: root.transforms.findIndex((x) => x.raw === t.raw) })) : null,
      ),
    );
  }

  /** The ends a relationship may join: members (their own space, z, y, x) and the collections' systems. */
  private endsOf(root: CollectionNode): { id: string; label: string; axes: string[] }[] {
    return [
      ...members(root).map((m) => ({ id: m.node.id ?? m.node.name, label: m.node.name, axes: ["z", "y", "x"] })),
      ...sceneSystems(root).map((s) => ({ id: s.id, label: `${s.name ?? s.id} (system)`, axes: s.axes })),
    ];
  }

  /** A transform typed in the panel: numbers on x, y, z (or a field's address; an affine's twelve, rows x, y, z), written on the target's `axes`. */
  typedTransform(type: string, text: string, axes: string[], affine?: number[]): any {
    const numbers = text.split(/[\s,;]+/).filter(Boolean).map(Number);
    switch (type) {
      case "identity":
        return { type: "identity" };
      case "translation":
      case "scale":
        if (numbers.some((n) => !Number.isFinite(n))) throw new Error("Numbers only, separated by spaces.");
        if (numbers.length !== 3) throw new Error(`A ${type} is three numbers: x y z.`);
        return { type, [type]: onAxes(numbers, axes) };
      case "affine":
        if (affine === undefined || affine.length !== 12 || !affine.every(Number.isFinite)) throw new Error("An affine is twelve numbers: rows x, y, z, each a b c t.");
        return transformJson([...affine, 0, 0, 0, 1], axes);
      case "displacements": {
        const url = text.trim();
        if (!/^https?:\/\//.test(url)) throw new Error("A displacement field is its Zarr group's address (https://…).");
        return { type: "displacements", path: url };
      }
    }
    throw new Error(`Unknown kind ${type}.`);
  }

  /**
   * The panel, drawn once and brought up to date in place: with no
   * collection, the ones found and an empty state; in a collection's tab,
   * its name, the graph and the Members, Coordinate systems and
   * Relationships cards (their lists regions, their add forms kept, so a
   * change never loses what is being typed or chosen).
   */
  render(host: HTMLElement): () => void {
    const status = statusLine();
    const addSheet = () => this.showAddSheet();

    // No collection open.
    const found = region((key: { list: { url: string; name: string }[]; busy: boolean }) =>
      key.list.length
        ? [
            el("p", { class: "hint" }, "This workspace's images belong to:"),
            ...key.list.map((f) => el("div", { class: "row" }, el("strong", { class: "cl-grow" }, f.name), Object.assign(button("Open in a tab", () => void this.openUrl(f.url)), { disabled: key.busy }))),
          ]
        : null,
    { class: "stack" });
    const closed = el("div", { class: "stack" }, found, emptyState("No collection open.", { label: "Add collection…", run: addSheet }));

    // A collection open: its name, the JSON, the graph.
    const name = el("input", { class: "text-input cl-name", type: "text", "aria-label": "Collection name" }) as HTMLInputElement;
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (v !== "" && v !== this.root?.name) void this.edit({ op: "rename", name: v });
    });
    const copy = () =>
      void navigator.clipboard.writeText(JSON.stringify(this.doc, null, 2)).then(
        () => this.ctx.ui.toast("Copied the collection's JSON."),
        () => this.ctx.ui.toast("Could not copy.", "error"),
      );
    const graphRegion = region((_key: unknown) => (this.root ? this.graphView(this.root) : null));
    const noSystem = el("p", { class: "hint" }, "Add a coordinate system to view the images in.");

    // Members: the tree, and one to add (a dataset of the workspace, or an address).
    const memberList = region((_key: unknown) => (this.root ? this.memberRows(this.root) : null), { class: "stack" });
    let choices: { name: string; url: string }[] = [];
    let picked: HTMLSelectElement | undefined;
    const pick = region((key: { name: string; url: string }[]) => {
      choices = key;
      return (picked = select([["", key.length ? "A dataset of the workspace…" : "An address below"], ...key.map((c, i): [string, string] => [String(i), c.name])], "", () => {}, "Dataset to add"));
    }, { class: "row" });
    const address = el("input", { class: "text-input mono", type: "text", placeholder: "or an image's address", "aria-label": "Image address", spellcheck: "false" }) as HTMLInputElement;
    const addMember = () => {
      const chosen = picked?.value ? choices[Number(picked.value)] : undefined;
      const typed = address.value.trim();
      const url = chosen?.url ?? zarrGroupUrl(typed) ?? (/^https?:\/\//.test(typed) ? typed.replace(/\/+$/, "") : undefined);
      if (url === undefined) return this.ctx.ui.toast("Choose a dataset, or enter an OME-Zarr image's address.", "error");
      const member = chosen?.name ?? url.split("/").pop()!.replace(/\.ome\.zarr$|\.zarr$/, "");
      address.value = "";
      void this.edit({ op: "addMember", name: member, url });
    };
    const membersCard = card(
      "collections.members",
      "Members",
      { open: true, badge: "0" },
      memberList,
      el("div", { class: "cl-add" }, pick, el("div", { class: "row" }, address, button("Add member", addMember, undefined, "btn small"))),
    );

    // Coordinate systems, and one to add.
    const systemList = region((_key: unknown) => (this.root ? this.systemRows(this.root) : null), { class: "stack" });
    const systemName = el("input", { class: "text-input", type: "text", placeholder: "Name, e.g. Atlas", "aria-label": "System name" }) as HTMLInputElement;
    let systemUnit = "micrometer";
    const unit = select(Object.keys(UNITS).map((u) => [u, u]), systemUnit, (u) => (systemUnit = u), "Unit");
    const addSystem = () => {
      if (systemName.value.trim() === "") return this.ctx.ui.toast("Name the coordinate system.", "error");
      const v = systemName.value.trim();
      systemName.value = "";
      void this.edit({ op: "addSystem", name: v, unit: systemUnit });
    };
    const systemsCard = card(
      "collections.systems",
      "Coordinate systems",
      { badge: "0" },
      systemList,
      el("div", { class: "cl-add" }, el("div", { class: "row" }, systemName, unit, button("Add system", addSystem, undefined, "btn small"))),
    );

    // Relationships, and one to add: its ends, its kind, and its value (an affine's in a 3 × 4 grid).
    const transformList = region((_key: unknown) => (this.root ? this.transformRows(this.root) : null), { class: "stack" });
    let ends: { id: string; label: string; axes: string[] }[] = [];
    let from: HTMLSelectElement | undefined;
    let to: HTMLSelectElement | undefined;
    const endsRegion = region((key: { id: string; label: string; axes: string[] }[]) => {
      ends = key;
      const options = key.map((e, i): [string, string] => [String(i), e.label]);
      const firstSystem = Math.max(key.findIndex((e) => e.label.endsWith("(system)")), 0);
      from = select(options, "0", () => {}, "From");
      to = select(options, String(firstSystem), () => {}, "To");
      return [from, el("span", { "aria-hidden": "true" }, "→"), to];
    }, { class: "row" });
    let kindChosen = KINDS[0].type;
    const value = el("input", { class: "text-input mono", type: "text", spellcheck: "false", "aria-label": "Value" }) as HTMLInputElement;
    const cells = Array.from({ length: 12 }, (_, i) => numberInput(i % 5 === 0 ? 1 : 0, () => {}, { "aria-label": `Row ${"xyz"[Math.floor(i / 4)]}, ${"abct"[i % 4]}` }));
    const paste = el("input", { class: "text-input mono", type: "text", spellcheck: "false", placeholder: "or paste 12 numbers, row by row", "aria-label": "Paste twelve numbers" }) as HTMLInputElement;
    paste.addEventListener("change", () => {
      if (paste.value.trim() === "") return;
      const numbers = twelveNumbers(paste.value);
      if (numbers === undefined) return this.ctx.ui.toast("Paste twelve numbers: rows x, y, z, each a b c t.", "error");
      numbers.forEach((v, i) => (cells[i].value = String(v)));
      paste.value = "";
    });
    const matrix = el(
      "div",
      { class: "stack" },
      el("div", { class: "cl-matrix", role: "group", "aria-label": "Affine, rows x, y, z" }, el("span"), ...["a", "b", "c", "t"].map((c) => el("span", {}, c)), ...[0, 1, 2].flatMap((r) => [el("span", {}, "xyz"[r]), ...cells.slice(4 * r, 4 * r + 4)])),
      paste,
    );
    const showKind = () => {
      const k = KINDS.find((x) => x.type === kindChosen)!;
      value.placeholder = k.hint;
      value.hidden = k.hint === "";
      matrix.hidden = k.type !== "affine";
    };
    const kind = select(KINDS.map((k) => [k.type, k.label]), kindChosen, (v) => ((kindChosen = v), showKind()), "Kind");
    showKind();
    const addTransform = () => {
      const a = ends[Number(from?.value)];
      const b = ends[Number(to?.value)];
      if (a === undefined || b === undefined || a.id === b.id) return this.ctx.ui.toast("Choose two different ends.", "error");
      let t: any;
      try {
        t = this.typedTransform(kindChosen, value.value, b.axes, cells.map((c) => Number(c.value)));
      } catch (e) {
        return this.ctx.ui.toast((e as Error).message, "error");
      }
      void this.edit({ op: "addTransform", transform: { ...t, input: { id: a.id }, output: { id: b.id } } });
    };
    const transformsCard = card(
      "collections.relationships",
      "Relationships",
      { badge: "0" },
      transformList,
      el("div", { class: "cl-add" }, endsRegion, el("div", { class: "row" }, kind, value), matrix, el("div", { class: "row" }, button("Add relationship", addTransform, undefined, "btn small"))),
    );

    const open = el(
      "div",
      { class: "stack" },
      name,
      el("div", { class: "row" }, button("Download JSON", () => this.download()), button("Copy JSON", copy)),
      graphRegion,
      noSystem,
      membersCard,
      systemsCard,
      transformsCard,
      el("div", { class: "row" }, button("Add collection…", addSheet)),
    );
    host.append(closed, open, status);

    const badge = (c: HTMLElement, n: number) => {
      const b = c.querySelector(".card-badge");
      if (b !== null && b.textContent !== String(n)) b.textContent = String(n);
    };
    const sync = () => {
      const tab = this.inCollectionScene();
      const root = tab ? this.root : undefined;
      if (this.busy) status.progress("Reading the collection…");
      else if (this.error) status.error(this.error);
      else status.clear();
      closed.hidden = root !== undefined;
      open.hidden = root === undefined;
      found.update({ list: tab ? [] : this.foundHere(), busy: this.busy });
      if (root === undefined) return;
      if (name.ownerDocument.activeElement !== name && name.value !== root.name) name.value = root.name;
      const system = this.saved().system;
      const labels = members(root).filter((m) => this.ctx.viewer.layerSpec(m.node.name)?.type === "segmentation").map((m) => m.node.name);
      const key = { doc: this.doc, url: this.documentUrl, system, warped: [...this.warped], hidden: [...this.hidden], labels };
      graphRegion.update({ ...key, open: [...this.graphOpen] });
      noSystem.hidden = sceneSystems(root).some((s) => s.id === system);
      memberList.update(key);
      systemList.update(key);
      transformList.update(key);
      const inside = new Set(members(root).map((m) => m.node.location?.url));
      pick.update(
        this.ctx.workspace
          .datasets()
          .map((d) => ({ name: d.name, url: zarrGroupUrl(d.source) }))
          .filter((d): d is { name: string; url: string } => d.url !== undefined && !inside.has(d.url)),
      );
      endsRegion.update(this.endsOf(root));
      badge(membersCard, members(root).length);
      badge(systemsCard, sceneSystems(root).length);
      badge(transformsCard, graph(root).transforms.length);
    };
    this.update = sync;
    sync();
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
