/**
 * The atlas plugin: the Atlas panel.  A segmentation layer and its lookup
 * table make a tree of regions (./hierarchy.ts); choosing a region shows it
 * and its descendants as the layer's segments, or goes to it; the region
 * under the cursor is named with its path.  The label image is counted once
 * in a worker (./label_worker.ts), for each region's volume and centre.
 *
 * The panel is built from the SDK's parts (plugins/README.md, "Building a
 * panel"), drawn once and then set in place from the state: the tree is
 * drawn again only when what it lists changes, not when a region is chosen.
 */
import type { LookupTableInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { button, card, checkbox, downloadBlob, el, emptyState, field, safeFileName, statusLine } from "@ngplatform/sdk/dom";
import { csv } from "@ngplatform/sdk/format";
import { layerSourceUrl } from "@ngplatform/sdk/sources";
import { Lru } from "@ngplatform/sdk/virtual";
import { apply, globalSpace, placement } from "../annotations/geometry.js";
import { storeOf } from "../volume-view/sources.js";
import { Atlas, KIND_TEXT, type Region } from "./hierarchy.js";
import { type Counted, LabelClient } from "./label_client.js";
import { ATLAS_PANEL } from "./manifest.js";

/** The tree's own look: rows with a caret, a swatch, the name, acronym and volume.  Everything else is the app's. */
const STYLE = `
.at-cursor { min-height: calc(2 * var(--ctl-h)); border: 1px solid var(--line); padding: var(--sp-3) var(--sp-4); display: grid; gap: var(--sp-1); align-content: start; }
.at-tree { max-height: 48vh; overflow: auto; border: 1px solid var(--line); padding: var(--sp-1) 0; }
.at-tree > .empty { padding: var(--sp-3) var(--sp-4); }
.at-node { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-3) var(--sp-1) 0; cursor: pointer; white-space: nowrap; }
.at-node:hover { background: var(--hover); }
.at-node[aria-selected="true"] { background: var(--select-soft); }
.at-node.at-match .at-name { font-weight: 600; }
.at-caret { width: 12px; flex: none; text-align: center; color: var(--faint); font-size: var(--fs-caption); }
.at-swatch { width: 10px; height: 10px; flex: none; border: 1px solid var(--swatch-line); }
.at-swatch.at-none { visibility: hidden; }
.at-name { flex: 1 1 auto; min-width: 8em; overflow: hidden; text-overflow: ellipsis; }
.at-acronym, .at-volume { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--faint); font: var(--fs-caption) var(--mono); }
.at-volume { padding-left: var(--sp-3); }
`;

const REGION_INFO =
  "Show only: the region and everything under it become the layer's visible segments. Add to shown adds them to those shown; Show all shows every segment again. " +
  "Go to moves the views to the region's voxel nearest its centre. Double-click a region in the tree to show only it and go to it.";

const VOLUMES_INFO =
  "The label image is counted once, in the background, at its finest level of at most 64 million voxels. A region's volume includes everything under it. " +
  "Save CSV writes every region's voxels and volume, its own and with its descendants.";

/** How many label images' counts are kept, the most recently used. */
const COUNTS_KEPT = 4;

/** A segment id from Neuroglancer's selected value of a segmentation layer. */
export function labelOf(selected: unknown): bigint | undefined {
  let v = (selected as { value?: unknown } | undefined)?.value;
  if (typeof v === "object" && v !== null) v = (v as { value?: unknown; key?: unknown }).value ?? (v as { key?: unknown }).key;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

/**
 * A length (power 1) or a volume (power 3) in millimetres, in the unit that
 * suits its size (m, mm, µm or nm), to about four significant figures.
 */
export function physicalText(mm: number, power: 1 | 3 = 1): string {
  const sup = power === 3 ? "³" : "";
  const a = Math.abs(mm);
  if (a === 0 || !Number.isFinite(mm)) return `${Number.isFinite(mm) ? 0 : "–"} mm${sup}`;
  const units: [string, number][] = [
    ["m", 1e3],
    ["mm", 1],
    ["µm", 1e-3],
    ["nm", 1e-6],
  ];
  // The largest unit the value is not too small in: a tenth of a length, a thousandth of a volume.
  const [name, size] = units.find(([, size]) => a >= (size * 0.1) ** power) ?? units[units.length - 1];
  return `${Number((mm / size ** power).toPrecision(4))} ${name}${sup}`;
}

/** An AbortError, as fetch and the worker give. */
const aborted = () => new DOMException("Aborted", "AbortError");
const isAbort = (e: unknown) => (e as Error | undefined)?.name === "AbortError";

/** `promise`, or an AbortError as soon as `signal` aborts (the work itself goes on, for whoever else waits on it). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(aborted());
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", stop), resolve(v)),
      (e) => (signal.removeEventListener("abort", stop), reject(e)),
    );
  });
}

/** What the panel asks of the label counter (./label_client.ts): a test gives its own. */
export type Counter = Pick<LabelClient, "count" | "centre" | "dispose">;

/** Where the count of the chosen layer's image stands. */
type CountState = { kind: "idle" } | { kind: "counting"; percent?: number } | { kind: "cancelled" } | { kind: "failed"; message: string } | { kind: "unreadable" };

export class AtlasPanel {
  private layer = "";
  private layers: string[] = [];
  /** The layer's table (its `lut://` URL), and the atlas made from it. */
  private table: string | undefined;
  private atlas: Atlas | undefined;
  /** Reading the table, or why it could not be read. */
  private tableState: { kind: "idle" } | { kind: "reading" } | { kind: "failed"; message: string; url: string | undefined } = { kind: "idle" };
  private query = "";
  private onlyPresent = true;
  private expanded = new Set<string>();
  private chosen: Region | undefined;
  /** The label image's counts, once read, and each region's voxels (with its descendants'). */
  private counted: Counted | undefined;
  private totals: Map<Region, number> | undefined;
  private countState: CountState = { kind: "idle" };
  /** The layer and store last counted or being counted. */
  private countingFor = "";
  private readonly counts = new Lru<Counted>(COUNTS_KEPT);
  /** The Go to under way: a new one, or Cancel, aborts it. */
  private going: AbortController | undefined;
  private catalogue: LookupTableInfo[];
  /** Bumped when what the tree lists may change: the atlas, the counts, the regions opened. */
  private treeGeneration = 0;
  private parts?: ReturnType<AtlasPanel["build"]>;

  constructor(
    private readonly ctx: PlatformContext,
    private readonly client: Counter = new LabelClient(),
  ) {
    this.catalogue = ctx.viewer.lookupTables.catalogue();
    this.layer = ctx.state.get<{ layer?: string }>()?.layer ?? "";
    ctx.subscriptions.push(
      ctx.viewer.onLayersChanged(() => this.sync()),
      ctx.viewer.onStateChanged(() => this.sync()),
      ctx.viewer.onCursorChanged(() => this.drawCursor()),
      ctx.state.onChanged(() => {
        const layer = ctx.state.get<{ layer?: string }>()?.layer;
        if (layer !== undefined && layer !== this.layer) this.choose(layer);
      }),
      () => this.going?.abort(),
      () => this.client.dispose(),
    );
    this.sync();
  }

  // ------------------------------------------------------------ model

  private storeOf(layer: string): string | undefined {
    return layer === "" ? undefined : storeOf(layerSourceUrl(this.ctx.viewer.layerSpec(layer)));
  }

  /** Follows the scene: the segmentation layers, the chosen one's table and store. */
  private sync(): void {
    this.layers = this.ctx.viewer
      .layers()
      .filter((l) => l.type === "segmentation")
      .map((l) => l.name);
    if (!this.layers.includes(this.layer)) {
      this.layer = this.layers.find((l) => this.ctx.viewer.lookupTables.of(l) !== undefined) ?? this.layers[0] ?? "";
      this.forgetCounts();
    }
    const table = this.layer === "" ? undefined : this.ctx.viewer.lookupTables.of(this.layer);
    if (table !== this.table) void this.load(table);
    const store = this.storeOf(this.layer);
    if (this.atlas !== undefined && store !== this.counted?.store && `${this.layer}|${store}` !== this.countingFor) void this.count();
    this.draw();
  }

  /** The counts and the region chosen belong to the last layer. */
  private forgetCounts(): void {
    this.counted = undefined;
    this.totals = undefined;
    this.chosen = undefined;
    this.countingFor = "";
    this.countState = { kind: "idle" };
    this.treeGeneration++;
  }

  private choose(layer: string): void {
    this.layer = layer;
    this.forgetCounts();
    this.table = undefined;
    this.atlas = undefined;
    if (this.ctx.state.get<{ layer?: string }>()?.layer !== layer) this.ctx.state.set({ layer });
    this.sync();
  }

  /** Reads the layer's table into an atlas. */
  private async load(table: string | undefined): Promise<void> {
    this.table = table;
    this.atlas = undefined;
    this.chosen = undefined;
    this.treeGeneration++;
    this.tableState = table === undefined ? { kind: "idle" } : { kind: "reading" };
    this.draw();
    if (table === undefined) return;
    try {
      const atlas = Atlas.fromTable(await this.ctx.viewer.lookupTables.load(table));
      if (this.table !== table) return;
      this.atlas = atlas;
      this.tableState = { kind: "idle" };
      this.expanded.clear();
      // A single root (the Allen ontology's "root") is opened, to show its parts.
      if (atlas.roots.length === 1) this.expanded.add(atlas.roots[0].key);
      this.treeGeneration++;
      // Counts of another layer's image are not this one's.
      const store = this.storeOf(this.layer);
      if (this.counted?.store !== store) this.counted = undefined;
      this.totals = this.counted && atlas.totals(this.voxelsPerValue(this.counted));
      if (this.counted === undefined && `${this.layer}|${store}` !== this.countingFor) void this.count();
    } catch (e) {
      if (this.table === table) this.tableState = { kind: "failed", message: (e as Error).message, url: table };
    }
    this.draw();
  }

  /** Gives the layer a table (or none), as Render › Lookup table would. */
  private async setTable(url: string | undefined): Promise<void> {
    this.tableState = url === undefined ? { kind: "idle" } : { kind: "reading" };
    this.draw();
    try {
      await this.ctx.viewer.lookupTables.apply(this.layer, url);
    } catch (e) {
      this.tableState = { kind: "failed", message: (e as Error).message, url };
    }
    this.sync();
  }

  private voxelsPerValue(counted: Counted): Map<bigint, number> {
    return new Map([...counted.labels].map(([v, s]) => [v, s.count]));
  }

  /**
   * Counts the label image's voxels, once per store (the last few stores'
   * counts are kept).  A count cancelled or failed is not started again by
   * itself, only when asked: Count again, Go to, or choosing the layer.
   */
  private async count(): Promise<Counted | undefined> {
    const layer = this.layer;
    const store = this.storeOf(layer);
    const key = `${layer}|${store}`;
    this.countingFor = key;
    // Still the count wanted: the same layer, reading the same store (its source may have changed meanwhile).
    const mine = () => this.layer === layer && this.countingFor === key;
    if (store === undefined) {
      this.countState = { kind: "unreadable" };
      this.drawVolumes();
      return undefined;
    }
    // A count kept settles at once: nothing to report meanwhile.
    if (this.counts.peek(store) === undefined) {
      this.countState = { kind: "counting" };
      this.drawVolumes();
    }
    const counted = this.counts.get(
      store,
      () =>
        this.ctx.jobs.run(`Counting the regions of ${layer}`, async (job) => {
          const controller = new AbortController();
          return this.client.count(
            store,
            (done, total) => {
              if (job.cancelled) controller.abort();
              job.progress(done / total, `${done} of ${total} chunks`);
              if (mine()) {
                this.countState = { kind: "counting", percent: Math.round((100 * done) / total) };
                this.drawVolumes();
              }
            },
            controller.signal,
          );
        }),
      () => 1,
    );
    try {
      const c = await counted;
      if (!mine()) return c;
      this.counted = c;
      this.countState = { kind: "idle" };
      this.totals = this.atlas?.totals(this.voxelsPerValue(c));
      this.treeGeneration++;
      this.draw();
      return c;
    } catch (e) {
      if (mine()) {
        this.countState = isAbort(e) ? { kind: "cancelled" } : { kind: "failed", message: (e as Error).message };
        this.drawVolumes();
      }
      return undefined;
    }
  }

  // ---------------------------------------------------------- actions

  /** Shows a region and its descendants: only them, or added to those shown. */
  private show(region: Region, mode: "only" | "add"): void {
    const values = this.atlas!.values(region).map(String);
    const layer = this.layer;
    this.ctx.viewer.patchState((ng) => {
      const spec = ((ng.layers as Record<string, unknown>[] | undefined) ?? []).find((l) => l.name === layer);
      if (spec === undefined) return;
      const wanted = new Set(values);
      // "!id" is a segment listed but hidden: shown now if it is one of the region's.
      const kept = mode === "add" ? ((spec.segments as string[] | undefined) ?? []).filter((s) => !wanted.has(s.replace(/^!/, ""))) : [];
      spec.segments = [...kept, ...values];
      spec.visible = true;
    });
  }

  private showAll(): void {
    const layer = this.layer;
    this.ctx.viewer.patchState((ng) => {
      const spec = ((ng.layers as Record<string, unknown>[] | undefined) ?? []).find((l) => l.name === layer);
      if (spec !== undefined) delete spec.segments;
    });
  }

  /**
   * Moves the views to the region's voxel nearest its centre, counting the
   * image first if it is not counted.  A new Go to, or Cancel, stops the
   * one under way.
   */
  async goTo(region: Region): Promise<void> {
    // The layer and table asked about: the answer is dropped if either changes meanwhile.
    const layer = this.layer;
    const atlas = this.atlas;
    if (atlas === undefined) return;
    this.going?.abort();
    const controller = new AbortController();
    this.going = controller;
    const { signal } = controller;
    const mine = () => this.going === controller;
    const status = this.parts?.goStatus;
    const report = (fn: () => void) => void (mine() && fn());
    const retry = { label: "Retry", run: () => void this.goTo(region) };
    this.drawGoing();
    report(() => status?.progress(`Going to ${region.name}…`));
    try {
      const counted = this.counted ?? (await abortable(this.count(), signal));
      if (this.layer !== layer || this.atlas !== atlas) return report(() => status?.clear());
      if (counted === undefined) return report(() => status?.error(`Could not go to ${region.name}: the label image is not counted.`, retry));
      const voxel = await this.client.centre(counted, atlas.values(region), signal, (done, total) =>
        report(() => status?.progress(`Going to ${region.name}… ${Math.round((100 * done) / total)}%`)),
      );
      if (!mine()) return;
      if (this.layer !== layer) return status?.clear();
      if (voxel === undefined) return status?.error(`${region.name} has no voxels in ${layer}.`);
      const space = globalSpace(this.ctx.viewer.getState());
      const placed = placement(this.ctx.viewer.layerTransform(layer), counted.voxelToRas, space);
      if (placed === undefined) return status?.error(`Can't go to ${region.name}: ${layer} has no x, y, z placement in the view.`);
      const at = apply(placed.voxelToGlobal, voxel);
      const position = space.names.map(() => NaN);
      placed.dims.forEach((d, r) => (position[d] = at[r]));
      this.ctx.viewer.setPosition(position);
      status?.clear();
    } catch (e) {
      // Cancelled: nothing to report.
      report(() => (isAbort(e) ? status?.clear() : status?.error(`Could not go to ${region.name}: ${(e as Error).message}`, retry)));
    } finally {
      if (mine()) this.going = undefined;
      this.drawGoing();
    }
  }

  private saveCsv(): void {
    const atlas = this.atlas;
    const counted = this.counted;
    if (atlas === undefined || counted === undefined || this.totals === undefined) return;
    const own = this.voxelsPerValue(counted);
    const rows: (string | number)[][] = [["value", "acronym", "name", "path", "voxels", "volume_mm3", "voxels_with_descendants", "volume_with_descendants_mm3"]];
    for (const r of atlas.all()) {
      const total = this.totals.get(r) ?? 0;
      const n = r.value === undefined ? 0 : (own.get(r.value) ?? 0);
      rows.push([r.value?.toString() ?? "", r.acronym ?? "", r.name, atlas.pathText(r, " > "), n, n * counted.voxelVolume, total, total * counted.voxelVolume]);
    }
    downloadBlob(new Blob([csv(rows)], { type: "text/csv" }), `${safeFileName(this.layer, "atlas")}_regions.csv`);
  }

  // ------------------------------------------------------------ views

  /** The panel's parts, made once per showing. */
  private build() {
    const empty = emptyState("No segmentation in this scene.", { label: "Open data…", run: () => void this.ctx.commands.invoke("dataset.add") });

    const layer = el("select", { class: "text-input", "aria-label": "Segmentation layer" });
    layer.addEventListener("change", () => this.choose(layer.value));
    // The catalogue's tables, grouped, and one more for a table of the layer's own (a file).
    const own = el("option", { value: "", hidden: true });
    const table = el("select", { class: "text-input", "aria-label": "Atlas" }, el("option", { value: "" }, "None"), own);
    for (const group of new Set(this.catalogue.map((t) => t.group))) {
      table.append(
        el("optgroup", { label: group }, ...this.catalogue.filter((t) => t.group === group).map((t) => el("option", { value: t.url }, t.fetched ? `${t.title} (downloaded)` : t.title))),
      );
    }
    table.addEventListener("change", () => void this.setTable(table.value === "" ? undefined : table.value));
    const kind = el("p", { class: "hint" });
    const tableStatus = statusLine();

    const cursor = el("div", { class: "at-cursor readout", "aria-live": "polite" });
    const noTable = emptyState("This layer has no lookup table.", { label: "Choose an atlas", run: () => table.focus() });
    const search = el("input", { class: "text-input", type: "search", placeholder: "Name, acronym or value", value: this.query });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.drawTree();
    });
    const only = checkbox("Only regions in the image", this.onlyPresent, (v) => {
      this.onlyPresent = v;
      // The filter needs the counts: a count cancelled starts again.
      if (v && this.counted === undefined && this.countState.kind !== "counting" && this.countState.kind !== "unreadable") void this.count();
      this.drawTree();
    });
    const tree = el("div", { class: "at-tree", role: "tree", "aria-label": "Regions" });
    // The region under the cursor, the search and the tree: shown once the layer has an atlas.
    const browse = el("div", { class: "stack" }, field("Under the cursor", cursor), field("Search", search), only, tree);
    const regionsBadge = el("span");

    const noChoice = emptyState("No region chosen.");
    const chosenName = el("div");
    const chosenPath = el("p", { class: "hint" });
    const chosenVolume = el("p", { class: "hint" });
    const act = (fn: (r: Region) => void) => () => void (this.chosen && fn(this.chosen));
    const goButton = button("Go to", act((r) => void this.goTo(r)));
    const cancelGo = button("Cancel", () => this.going?.abort());
    const goStatus = statusLine();
    const chosen = el(
      "div",
      { class: "stack" },
      chosenName,
      chosenPath,
      chosenVolume,
      el(
        "div",
        { class: "row" },
        button("Show only", act((r) => this.show(r, "only"))),
        button("Add to shown", act((r) => this.show(r, "add"))),
        button("Show all", () => this.showAll()),
        goButton,
      ),
      el("div", { class: "row" }, goStatus, cancelGo),
    );

    const grid = el("p", { class: "hint" });
    const saveCsv = button("Save CSV", () => this.saveCsv());
    const countStatus = statusLine();

    const cards = {
      atlas: card("atlas.atlas", "Atlas", { open: true }, el("div", { class: "grid-2" }, field("Layer", layer), field("Atlas", table)), kind, tableStatus),
      regions: card("atlas.regions", "Regions", { open: true, badge: regionsBadge }, noTable, browse),
      region: card("atlas.region", "Region", { open: true, info: REGION_INFO }, noChoice, chosen),
      volumes: card("atlas.volumes", "Volumes", { info: VOLUMES_INFO }, countStatus, el("div", { class: "row" }, grid, el("span", { class: "spacer" }), saveCsv)),
    };
    return { empty, layer, own, table, kind, tableStatus, cursor, noTable, browse, search, only, tree, regionsBadge, noChoice, chosen, chosenName, chosenPath, chosenVolume, goButton, cancelGo, goStatus, grid, saveCsv, countStatus, cards, rows: new Map<Region, HTMLElement>(), treeKey: "", layersKey: undefined as string | undefined };
  }

  render(host: HTMLElement): () => void {
    const parts = this.build();
    this.parts = parts;
    host.append(parts.empty, ...Object.values(parts.cards));
    this.draw();
    return () => {
      if (this.parts === parts) this.parts = undefined;
    };
  }

  /** Sets every part from the state. */
  private draw(): void {
    const p = this.parts;
    if (p === undefined) return;
    const none = this.layer === "";
    p.empty.hidden = !none;
    p.cards.atlas.hidden = none;
    p.cards.regions.hidden = none;
    p.cards.region.hidden = this.atlas === undefined;
    p.cards.volumes.hidden = this.atlas === undefined;
    this.drawHead();
    this.drawCursor();
    this.drawTree();
    this.drawChosen();
    this.drawVolumes();
    this.drawGoing();
  }

  private drawHead(): void {
    const p = this.parts;
    if (p === undefined) return;
    // The layer's options, replaced only when the layers change (an open select stays open).
    const key = this.layers.join("\n");
    if (p.layersKey !== key) {
      p.layersKey = key;
      p.layer.replaceChildren(...this.layers.map((name) => el("option", { value: name }, name)));
    }
    if (p.layer.value !== this.layer) p.layer.value = this.layer;
    p.table.disabled = this.layer === "";
    const custom = this.table !== undefined && !this.catalogue.some((t) => t.url === this.table);
    p.own.hidden = !custom;
    if (custom) {
      p.own.value = this.table!;
      p.own.textContent = this.ctx.viewer.lookupTables.title(this.table!);
    }
    const value = this.table ?? "";
    if (p.table.value !== value) p.table.value = value;
    p.kind.hidden = this.atlas === undefined;
    p.kind.textContent = this.atlas ? `Tree: ${KIND_TEXT[this.atlas.kind]}.` : "";
    const t = this.tableState;
    if (t.kind === "reading") p.tableStatus.progress("Reading the table…");
    else if (t.kind === "failed") p.tableStatus.error(`Could not read the table: ${t.message}`, { label: "Retry", run: () => void this.setTable(t.url) });
    else p.tableStatus.clear();
    p.regionsBadge.textContent = this.atlas ? this.atlas.size.toLocaleString() : "";
    p.noTable.hidden = this.layer === "" || this.table !== undefined;
    p.browse.hidden = this.atlas === undefined;
    p.only.set(this.onlyPresent);
  }

  private drawCursor(): void {
    const box = this.parts?.cursor;
    if (box === undefined) return;
    const atlas = this.atlas;
    const value = atlas && this.layer !== "" ? labelOf(this.ctx.viewer.cursor().values[this.layer]) : undefined;
    const region = value === undefined ? undefined : atlas!.regionOf(value);
    if (value === undefined || value === 0n) {
      box.replaceChildren(el("span", { class: "faint" }, "–"));
    } else if (region === undefined) {
      box.replaceChildren(el("span", {}, `${value} (not in the table)`));
    } else {
      const path = atlas!.path(region).slice(0, -1);
      box.replaceChildren(
        el("span", {}, region.name, region.acronym ? ` ${region.acronym}` : "", ` · ${value}`),
        el("span", { class: "hint" }, path.length > 0 ? path.map((r) => r.name).join(" › ") : "Top level"),
      );
    }
  }

  /** The tree: drawn again only when what it lists changes; choosing a region marks its row in place. */
  private drawTree(): void {
    const p = this.parts;
    if (p === undefined) return;
    const atlas = this.atlas;
    const key = `${this.treeGeneration}|${this.onlyPresent}|${this.query}`;
    if (atlas !== undefined && key !== p.treeKey) {
      p.treeKey = key;
      this.listRegions(atlas, p.tree, p.rows);
    }
    for (const [r, row] of p.rows) row.setAttribute("aria-selected", String(r === this.chosen));
  }

  private listRegions(atlas: Atlas, tree: HTMLElement, rows: Map<Region, HTMLElement>): void {
    const scroll = tree.scrollTop;
    rows.clear();
    const totals = this.onlyPresent ? this.totals : undefined;
    const searching = this.query.trim() !== "";
    const { matches, shown } = atlas.search(this.query);
    const volume = this.counted?.voxelVolume;
    const visit = (r: Region, depth: number) => {
      if (totals !== undefined && !totals.has(r)) return;
      if (searching && !shown.has(r)) return;
      const children = totals === undefined ? r.children : r.children.filter((c) => totals.has(c));
      const open = searching ? r.children.some((c) => shown.has(c)) : this.expanded.has(r.key);
      const n = this.totals?.get(r);
      const caret = el("span", { class: "at-caret" }, children.length === 0 ? "" : open ? "▾" : "▸");
      const row = el(
        "div",
        {
          class: `at-node${matches.has(r) ? " at-match" : ""}`,
          role: "treeitem",
          "aria-level": depth + 1,
          "aria-expanded": children.length === 0 ? undefined : String(open),
          // The indent is the row's depth; the swatch the region's own colour.
          style: `padding-left: ${4 + depth * 10}px`,
          title: atlas.pathText(r),
        },
        caret,
        el("span", r.colour ? { class: "at-swatch", style: `background: rgb(${r.colour.join(",")})` } : { class: "at-swatch at-none" }),
        el("span", { class: "at-name" }, r.name),
        r.acronym ? el("span", { class: "at-acronym" }, r.acronym) : null,
        n !== undefined && volume !== undefined ? el("span", { class: "at-volume" }, physicalText(n * volume, 3)) : null,
      );
      if (children.length > 0 && !searching) {
        caret.addEventListener("click", (e) => {
          e.stopPropagation();
          if (open) this.expanded.delete(r.key);
          else this.expanded.add(r.key);
          this.treeGeneration++;
          this.drawTree();
        });
      }
      row.addEventListener("click", () => this.pick(r));
      row.addEventListener("dblclick", () => {
        this.show(r, "only");
        void this.goTo(r);
      });
      rows.set(r, row);
      tree.append(row);
      if (open) for (const c of children) visit(c, depth + 1);
    };
    tree.replaceChildren();
    for (const r of atlas.roots) visit(r, 0);
    if (rows.size === 0) tree.append(el("p", { class: "empty" }, searching ? "No region matches." : "No regions in the image."));
    tree.scrollTop = scroll;
  }

  /** Chooses a region: its row marked, the Region card set. */
  pick(region: Region): void {
    this.chosen = region;
    this.drawTree();
    this.drawChosen();
  }

  private drawChosen(): void {
    const p = this.parts;
    if (p === undefined) return;
    const r = this.chosen;
    const atlas = this.atlas;
    p.noChoice.hidden = r !== undefined;
    p.chosen.hidden = r === undefined || atlas === undefined;
    if (r === undefined || atlas === undefined) return;
    p.chosenName.textContent = `${r.name}${r.acronym ? ` ${r.acronym}` : ""}${r.value !== undefined ? ` · ${r.value}` : ""}`;
    // Where it sits: the regions above it (none for one at the top).
    const above = atlas.path(r).slice(0, -1);
    p.chosenPath.hidden = above.length === 0;
    p.chosenPath.textContent = above.map((x) => x.name).join(" › ");
    const n = this.totals?.get(r) ?? (this.counted ? 0 : undefined);
    p.chosenVolume.hidden = n === undefined || this.counted === undefined;
    p.chosenVolume.textContent = n !== undefined && this.counted ? `${physicalText(n * this.counted.voxelVolume, 3)} (${n.toLocaleString()} voxels, with its descendants)` : "";
  }

  private drawGoing(): void {
    const p = this.parts;
    if (p === undefined) return;
    p.cancelGo.hidden = this.going === undefined;
  }

  private drawVolumes(): void {
    const p = this.parts;
    if (p === undefined) return;
    const s = this.countState;
    const again = { label: s.kind === "cancelled" ? "Count again" : "Retry", run: () => void this.count() };
    if (s.kind === "counting") p.countStatus.progress(`Counting the voxels…${s.percent === undefined ? "" : ` ${s.percent}%`}`);
    else if (s.kind === "cancelled") p.countStatus.error("Counting cancelled.", again);
    else if (s.kind === "failed") p.countStatus.error(`Could not count the voxels: ${s.message}`, again);
    else if (s.kind === "unreadable") p.countStatus.error("Volumes and Go to need an OME-Zarr, NIfTI, MGH or precomputed label image.");
    else p.countStatus.clear();
    const c = this.counted;
    p.grid.textContent = c ? `${c.size.join(" × ")} voxels of ${physicalText(Math.cbrt(c.voxelVolume))}${c.level > 0 ? ` (level ${c.level})` : ""}` : "";
    p.saveCsv.disabled = c === undefined || this.totals === undefined;
  }
}

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    const atlas = new AtlasPanel(ctx);
    ctx.ui.panel(ATLAS_PANEL, (host) => atlas.render(host));
  },
};
