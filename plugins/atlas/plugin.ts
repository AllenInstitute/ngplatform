/**
 * The atlas plugin: the Atlas tab.  A segmentation layer and its lookup
 * table make a tree of regions (./hierarchy.ts); choosing a region shows it
 * and its descendants as the layer's segments, or goes to it; the region
 * under the cursor is named with its path.  The label image is counted once
 * in a worker (./label_worker.ts), for each region's volume and centre.
 */
import type { LookupTableInfo, PlatformContext, PluginModule } from "@ngplatform/sdk";
import { downloadBlob, el } from "@ngplatform/sdk/dom";
import { csv } from "@ngplatform/sdk/format";
import { apply, globalSpace, placement } from "../annotations/geometry.js";
import { fileName, physical } from "../annotations/ui.js";
import { layerStore } from "../annotations/voxels.js";
import { Atlas, KIND_TEXT, type Region } from "./hierarchy.js";
import { type Counted, LabelClient } from "./label_client.js";
import { ATLAS_PANEL } from "./manifest.js";

const STYLE = `
.at { display: grid; gap: 8px; padding: 10px 12px; font-size: 12px; }
.at-body { display: contents; }
.at-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.at-grid2 select { min-width: 0; width: 100%; }
.at-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.at-spacer { flex: 1; }
.at-faint { color: var(--faint); }
.at-cursor { border: 1px solid var(--line); padding: 6px 8px; display: grid; gap: 2px; min-height: 34px; }
.at-cursor-name { color: var(--text); }
.at-path { color: var(--faint); font-size: 11px; overflow-wrap: anywhere; }
.at-tree { max-height: 48vh; overflow: auto; border: 1px solid var(--line); padding: 2px 0; }
.at-node { display: flex; align-items: center; gap: 5px; padding: 1px 6px 1px 0; cursor: pointer; white-space: nowrap; }
.at-node:hover { background: var(--ink-3); }
.at-node.at-chosen { background: var(--select-soft); }
.at-node.at-match .at-name { font-weight: 600; }
.at-caret { width: 12px; flex: none; text-align: center; color: var(--faint); font-size: 10px; }
.at-swatch { width: 10px; height: 10px; flex: none; border: 1px solid rgba(255, 255, 255, 0.2); }
.at-name { flex: 1 1 auto; min-width: 8em; overflow: hidden; text-overflow: ellipsis; }
.at-node .at-acronym { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.at-acronym { color: var(--faint); font: 11px var(--mono); }
.at-volume { flex: 0 1 auto; min-width: 0; overflow: hidden; padding-left: 6px; color: var(--faint); font: 11px var(--mono); }
.at-chosen-box { border: 1px solid var(--line); padding: 6px 8px; display: grid; gap: 6px; }
`;

/** A segment id from Neuroglancer's selected value of a segmentation layer. */
function labelOf(selected: unknown): bigint | undefined {
  let v = (selected as { value?: unknown } | undefined)?.value;
  if (typeof v === "object" && v !== null) v = (v as { value?: unknown; key?: unknown }).value ?? (v as { key?: unknown }).key;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

class AtlasPanel {
  private layer = "";
  private layers: string[] = [];
  /** The layer's table (its `lut://` URL), and the atlas made from it. */
  private table: string | undefined;
  private atlas: Atlas | undefined;
  private note = "";
  private query = "";
  private onlyPresent = true;
  private expanded = new Set<string>();
  private chosen: Region | undefined;
  /** The label image's counts, once read, and each region's voxels (with its descendants'). */
  private counted: Counted | undefined;
  private totals: Map<Region, number> | undefined;
  private counting = "";
  /** The layer and store last counted or being counted. */
  private countingFor = "";
  private readonly countCache = new Map<string, Promise<Counted>>();
  private readonly client = new LabelClient();
  private catalogue: LookupTableInfo[];
  private parts?: { head: HTMLElement; body: HTMLElement; cursor: HTMLElement; tree: HTMLElement; chosen: HTMLElement; volumes: HTMLElement };

  constructor(private readonly ctx: PlatformContext) {
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
      () => this.client.dispose(),
    );
    this.sync();
  }

  // ------------------------------------------------------------ model

  /** Follows the scene: the segmentation layers, the chosen one's table and store. */
  private sync(): void {
    this.layers = this.ctx.viewer
      .layers()
      .filter((l) => l.type === "segmentation")
      .map((l) => l.name);
    const changedLayer = !this.layers.includes(this.layer);
    if (changedLayer) {
      this.layer = this.layers.find((l) => this.ctx.viewer.lookupTables.of(l) !== undefined) ?? this.layers[0] ?? "";
      this.counted = undefined;
      this.totals = undefined;
      this.chosen = undefined;
      // A count still going for the last layer says nothing about this one.
      this.counting = "";
    }
    const table = this.layer === "" ? undefined : this.ctx.viewer.lookupTables.of(this.layer);
    if (table !== this.table) void this.load(table);
    else if (changedLayer) this.draw();
    const store = this.layer === "" ? undefined : layerStore(this.ctx, this.layer);
    if (this.atlas !== undefined && store !== this.counted?.store && `${this.layer}|${store}` !== this.countingFor) void this.count();
  }

  private choose(layer: string): void {
    this.layer = layer;
    this.chosen = undefined;
    this.counted = undefined;
    this.totals = undefined;
    this.countingFor = "";
    this.table = undefined;
    this.atlas = undefined;
    if (this.ctx.state.get<{ layer?: string }>()?.layer !== layer) this.ctx.state.set({ layer });
    this.sync();
    this.draw();
  }

  /** Reads the layer's table into an atlas. */
  private async load(table: string | undefined): Promise<void> {
    this.table = table;
    this.atlas = undefined;
    this.chosen = undefined;
    this.note = table === undefined ? "" : "Reading the table…";
    this.draw();
    if (table === undefined) return;
    try {
      const atlas = Atlas.fromTable(await this.ctx.viewer.lookupTables.load(table));
      if (this.table !== table) return;
      this.atlas = atlas;
      this.note = "";
      this.expanded.clear();
      // A single root (the Allen ontology's "root") is opened, to show its parts.
      if (atlas.roots.length === 1) this.expanded.add(atlas.roots[0].key);
      // Counts of another layer's image are not this one's.
      const store = layerStore(this.ctx, this.layer);
      if (this.counted?.store !== store) this.counted = undefined;
      this.totals = this.counted && atlas.totals(this.voxelsPerValue(this.counted));
      if (this.counted === undefined && `${this.layer}|${store}` !== this.countingFor) void this.count();
    } catch (e) {
      if (this.table === table) this.note = `Could not read the table: ${(e as Error).message}`;
    }
    this.draw();
  }

  /** Gives the layer a table (or none), as its Render tab would. */
  private async setTable(url: string | undefined): Promise<void> {
    this.note = url === undefined ? "" : "Reading the table…";
    this.draw();
    try {
      await this.ctx.viewer.lookupTables.apply(this.layer, url);
    } catch (e) {
      this.note = `Could not read the table: ${(e as Error).message}`;
      this.draw();
    }
    this.sync();
  }

  private voxelsPerValue(counted: Counted): Map<bigint, number> {
    return new Map([...counted.labels].map(([v, s]) => [v, s.count]));
  }

  /** Counts the label image's voxels, once per store. */
  private async count(): Promise<Counted | undefined> {
    const layer = this.layer;
    const store = layerStore(this.ctx, layer);
    this.countingFor = `${layer}|${store}`;
    if (store === undefined) {
      this.counting = "Volumes and Go to need an OME-Zarr, NIfTI, MGH or precomputed label image.";
      this.drawVolumes();
      return undefined;
    }
    let counted = this.countCache.get(store);
    if (counted === undefined) {
      counted = this.ctx.jobs.run(`Counting the regions of ${layer}`, async (job) => {
        const controller = new AbortController();
        return this.client.count(
          store,
          (done, total) => {
            if (job.cancelled) controller.abort();
            job.progress(done / total, `${done} of ${total} chunks`);
            if (this.layer === layer) {
              this.counting = `Counting the voxels… ${Math.round((100 * done) / total)}%`;
              this.drawVolumes();
            }
          },
          controller.signal,
        );
      });
      this.countCache.set(store, counted);
      counted.catch(() => this.countCache.delete(store));
      this.counting = "Counting the voxels…";
      this.drawVolumes();
    }
    try {
      const c = await counted;
      if (this.layer !== layer) return c;
      this.counted = c;
      this.counting = "";
      this.totals = this.atlas?.totals(this.voxelsPerValue(c));
      this.draw();
      return c;
    } catch (e) {
      if (this.layer === layer) {
        this.counting = (e as Error).name === "AbortError" ? "Counting cancelled." : `Could not count the voxels: ${(e as Error).message}`;
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

  /** Moves the views to the region's voxel nearest its centre. */
  private async goTo(region: Region): Promise<void> {
    // The layer and table asked about: the answer is dropped if either changes meanwhile.
    const layer = this.layer;
    const atlas = this.atlas;
    if (atlas === undefined) return;
    const counted = this.counted ?? (await this.count());
    if (counted === undefined || this.layer !== layer || this.atlas !== atlas) return;
    let voxel: [number, number, number] | undefined;
    try {
      voxel = await this.client.centre(counted, atlas.values(region));
    } catch (e) {
      this.ctx.ui.toast(`Could not find ${region.name}: ${(e as Error).message}`, "error");
      return;
    }
    if (this.layer !== layer) return;
    if (voxel === undefined) {
      this.ctx.ui.toast(`${region.name} has no voxels in ${layer}.`);
      return;
    }
    const space = globalSpace(this.ctx.viewer.getState());
    const placed = placement(this.ctx.viewer.layerTransform(layer), counted.voxelToRas, space);
    if (placed === undefined) {
      this.ctx.ui.toast(`Can't go to ${region.name}: ${layer} has no x, y, z placement in the view.`, "error");
      return;
    }
    const at = apply(placed.voxelToGlobal, voxel);
    const position = space.names.map(() => NaN);
    placed.dims.forEach((d, r) => (position[d] = at[r]));
    this.ctx.viewer.setPosition(position);
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
    downloadBlob(new Blob([csv(rows)], { type: "text/csv" }), `${fileName(this.layer)}_regions.csv`);
  }

  // ------------------------------------------------------------ views

  render(host: HTMLElement): () => void {
    const search = el("input", { class: "text-input", type: "search", placeholder: "Search regions (name, acronym, value)", value: this.query, "aria-label": "Search regions" }) as HTMLInputElement;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.drawTree();
    });
    const only = el("input", { type: "checkbox", checked: this.onlyPresent }) as HTMLInputElement;
    only.addEventListener("change", () => {
      this.onlyPresent = only.checked;
      this.drawTree();
    });
    const cursor = el("div", { class: "at-cursor" });
    const tree = el("div", { class: "at-tree", role: "tree" });
    const chosen = el("div");
    const volumes = el("div", { class: "at-row" });
    // Everything but the head, hidden while the scene has no segmentation.
    const body = el("div", { class: "at-body" }, el("div", { class: "at-faint" }, "Under the cursor"), cursor, search, el("label", { class: "field check" }, only, el("span", {}, "Only regions in the image")), tree, chosen, volumes);
    this.parts = { head: el("div", { class: "at-grid2" }), body, cursor, tree, chosen, volumes };
    host.replaceChildren(el("div", { class: "at" }, this.parts.head, body));
    this.draw();
    return () => (this.parts = undefined);
  }

  private draw(): void {
    if (this.parts !== undefined) this.parts.body.hidden = this.layer === "";
    this.drawHead();
    this.drawCursor();
    this.drawTree();
    this.drawChosen();
    this.drawVolumes();
  }

  private drawHead(): void {
    const head = this.parts?.head;
    if (head === undefined) return;
    const layer = el("select", { class: "text-input", "aria-label": "Segmentation layer" }) as HTMLSelectElement;
    for (const name of this.layers) layer.append(el("option", { value: name }, name));
    layer.value = this.layer;
    layer.addEventListener("change", () => this.choose(layer.value));
    const table = el("select", { class: "text-input", "aria-label": "Atlas", disabled: this.layer === "" }) as HTMLSelectElement;
    table.append(el("option", { value: "" }, "None"));
    if (this.table !== undefined && !this.catalogue.some((t) => t.url === this.table)) table.append(el("option", { value: this.table }, this.ctx.viewer.lookupTables.title(this.table)));
    for (const group of new Set(this.catalogue.map((t) => t.group))) {
      table.append(
        el(
          "optgroup",
          { label: group },
          ...this.catalogue.filter((t) => t.group === group).map((t) => el("option", { value: t.url, title: t.description ?? "" }, t.fetched ? `${t.title} (downloaded)` : t.title)),
        ),
      );
    }
    table.value = this.table ?? "";
    table.addEventListener("change", () => void this.setTable(table.value === "" ? undefined : table.value));
    const status =
      this.layer === ""
        ? "Add a segmentation (a label image) to see its regions."
        : this.note || (this.atlas ? `${this.atlas.size.toLocaleString()} regions: ${KIND_TEXT[this.atlas.kind]}.` : "This layer has no lookup table: choose its atlas.");
    const note = el("p", { class: "note first", style: "grid-column: 1 / -1; margin: 0" }, status);
    // No segmentation: only the note.
    if (this.layer === "") head.replaceChildren(note);
    else head.replaceChildren(el("label", { class: "field" }, el("span", {}, "Layer"), layer), el("label", { class: "field" }, el("span", {}, "Atlas"), table), note);
  }

  private drawCursor(): void {
    const box = this.parts?.cursor;
    if (box === undefined) return;
    const atlas = this.atlas;
    const value = atlas && this.layer !== "" ? labelOf(this.ctx.viewer.cursor().values[this.layer]) : undefined;
    const region = value === undefined ? undefined : atlas!.regionOf(value);
    if (value === undefined || value === 0n) {
      box.replaceChildren(el("span", { class: "at-faint" }, "–"));
    } else if (region === undefined) {
      box.replaceChildren(el("span", { class: "at-cursor-name" }, `${value} (not in the table)`));
    } else {
      const path = atlas!.path(region).slice(0, -1);
      box.replaceChildren(
        el("span", { class: "at-cursor-name" }, region.name, region.acronym ? el("span", { class: "at-acronym" }, ` ${region.acronym}`) : null, el("span", { class: "at-faint" }, ` · ${value}`)),
        el("span", { class: "at-path" }, path.length > 0 ? path.map((r) => r.name).join(" › ") : "Top level"),
      );
    }
  }

  private drawTree(): void {
    const tree = this.parts?.tree;
    if (tree === undefined) return;
    const atlas = this.atlas;
    if (atlas === undefined) {
      tree.replaceChildren(el("p", { class: "note first", style: "margin: 6px 8px" }, "No regions yet."));
      return;
    }
    const scroll = tree.scrollTop;
    const totals = this.onlyPresent ? this.totals : undefined;
    const searching = this.query.trim() !== "";
    const { matches, shown } = atlas.search(this.query);
    const volume = this.counted?.voxelVolume;
    const rows: HTMLElement[] = [];
    const visit = (r: Region, depth: number) => {
      if (totals !== undefined && !totals.has(r)) return;
      if (searching && !shown.has(r)) return;
      const children = totals === undefined ? r.children : r.children.filter((c) => totals.has(c));
      const open = searching ? r.children.some((c) => shown.has(c)) : this.expanded.has(r.key);
      const n = this.totals?.get(r);
      const row = el(
        "div",
        { class: `at-node${r === this.chosen ? " at-chosen" : ""}${matches.has(r) ? " at-match" : ""}`, role: "treeitem", style: `padding-left: ${4 + depth * 10}px`, title: atlas.pathText(r) },
        el("span", { class: "at-caret" }, children.length === 0 ? "" : open ? "▾" : "▸"),
        el("span", { class: "at-swatch", style: r.colour ? `background: rgb(${r.colour.join(",")})` : "visibility: hidden" }),
        el("span", { class: "at-name" }, r.name),
        r.acronym ? el("span", { class: "at-acronym" }, r.acronym) : null,
        n !== undefined && volume !== undefined ? el("span", { class: "at-volume" }, physical(n * volume, 3)) : null,
      );
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("at-caret") && children.length > 0 && !searching) {
          if (open) this.expanded.delete(r.key);
          else this.expanded.add(r.key);
        } else {
          this.chosen = r;
          this.drawChosen();
        }
        this.drawTree();
      });
      row.addEventListener("dblclick", () => {
        this.show(r, "only");
        void this.goTo(r);
      });
      rows.push(row);
      if (open) for (const c of children) visit(c, depth + 1);
    };
    for (const r of atlas.roots) visit(r, 0);
    tree.replaceChildren(...(rows.length > 0 ? rows : [el("p", { class: "note first", style: "margin: 6px 8px" }, searching ? "No region matches." : "No regions in the image.")]));
    tree.scrollTop = scroll;
  }

  private drawChosen(): void {
    const box = this.parts?.chosen;
    if (box === undefined) return;
    const r = this.chosen;
    const atlas = this.atlas;
    if (r === undefined || atlas === undefined) {
      box.replaceChildren(el("p", { class: "note first", style: "margin: 0" }, "Choose a region to show it or go to it (double-click: both)."));
      return;
    }
    const n = this.totals?.get(r) ?? (this.counted ? 0 : undefined);
    const button = (label: string, onclick: () => void, title: string) => el("button", { class: "btn outline small", type: "button", title, onclick }, label);
    box.replaceChildren(
      el(
        "div",
        { class: "at-chosen-box" },
        el("div", {}, el("span", { class: "at-cursor-name" }, r.name), r.acronym ? el("span", { class: "at-acronym" }, ` ${r.acronym}`) : null, r.value !== undefined ? el("span", { class: "at-faint" }, ` · ${r.value}`) : null),
        el("div", { class: "at-path" }, atlas.pathText(r)),
        n !== undefined && this.counted ? el("div", { class: "at-faint" }, `${physical(n * this.counted.voxelVolume, 3)} (${n.toLocaleString()} voxels, with its descendants)`) : null,
        el(
          "div",
          { class: "at-row" },
          button("Show only", () => this.show(r, "only"), "Show this region and its descendants, and no other segments"),
          button("Add to shown", () => this.show(r, "add"), "Add this region and its descendants to the segments shown"),
          button("Show all", () => this.showAll(), "Show every segment again"),
          button("Go to", () => void this.goTo(r), "Move to this region's voxel nearest its centre"),
        ),
      ),
    );
  }

  private drawVolumes(): void {
    const box = this.parts?.volumes;
    if (box === undefined) return;
    const c = this.counted;
    if (this.counting !== "" || c === undefined) {
      box.replaceChildren(el("span", { class: "at-faint" }, this.counting));
      return;
    }
    const mm = Math.cbrt(c.voxelVolume);
    box.replaceChildren(
      el("span", { class: "at-faint" }, `Volumes from ${c.size.join(" × ")} voxels of ${physical(mm)}${c.level > 0 ? ` (level ${c.level})` : ""}.`),
      el("span", { class: "at-spacer" }),
      el("button", { class: "btn outline small", type: "button", disabled: this.atlas === undefined, onclick: () => this.saveCsv() }, "Save CSV"),
    );
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
