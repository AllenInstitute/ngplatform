/**
 * Track filtering: a tool plugin over the Zarr Vectors data type.
 *
 * It filters a Zarr Vectors dataset's objects (streamlines, skeletons,
 * points) by their attributes and groups, which the data type exposes as
 * segment properties, and shows the objects that pass in a view of their own:
 * the same source without its full-resolution `objects` and `meshes`
 * subsources (which would otherwise load every passing object one by one),
 * drawing only the passing objects.  The filter is the plugin's state, so
 * it is in the link and undoable; the passing set is recomputed from it and
 * never stored.
 *
 * It uses only the plugin API (`PlatformContext`).
 */
import type { DatasetInfo, Disposer, PlatformContext, PluginModule, SegmentProperties } from "../../sdk/types.js";
import {
  computeMask,
  countPassing,
  emptyFilter,
  type FilterSpec,
  histogram,
  isEmptyFilter,
  passingIds,
  tagCounts,
  toCsv,
} from "./filter.js";
import { FILTERING_PANEL } from "./manifest.js";

interface Saved {
  dataset?: string;
  filter: FilterSpec;
  /** Showing the filtered view. */
  active: boolean;
  /** Hide the dataset's other views while the filtered one is shown. */
  hideOthers: boolean;
}

const BINS = 40;

// ------------------------------------------------------------------- DOM

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const STYLE = `
.tf { display: grid; gap: 12px; }
.tf-intro { margin: 0; color: var(--muted); font-size: 12px; }
.tf-summary { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.tf-summary strong { font: 600 20px/1 var(--mono); color: var(--text); }
.tf-summary span { color: var(--muted); }
.tf-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.tf-prop { border: 1px solid var(--line); border-radius: var(--r); padding: 8px; display: grid; gap: 4px; }
.tf-prop.filtered { border-color: #4a3a22; }
.tf-prop-head { display: flex; align-items: baseline; gap: 6px; }
.tf-prop-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-range { margin-left: auto; font: 11px/1 var(--mono); color: var(--muted); white-space: nowrap; }
.tf-hist { width: 100%; height: 38px; display: block; }
.tf-hist .all { fill: var(--ink-4); }
.tf-hist .pass { fill: var(--accent); }
.tf-sliders { position: relative; height: 18px; }
.tf-sliders input { position: absolute; inset: 0; width: 100%; margin: 0; pointer-events: none; background: none; accent-color: var(--accent); -webkit-appearance: none; appearance: none; height: 18px; }
.tf-sliders input::-webkit-slider-thumb { pointer-events: all; -webkit-appearance: none; width: 12px; height: 16px; border-radius: 3px; background: var(--accent); cursor: ew-resize; }
.tf-sliders input::-moz-range-thumb { pointer-events: all; width: 12px; height: 16px; border-radius: 3px; background: var(--accent); border: 0; cursor: ew-resize; }
.tf-sliders::before { content: ""; position: absolute; left: 0; right: 0; top: 8px; height: 2px; background: var(--line); }
.tf-tags { display: grid; gap: 2px; max-height: 240px; overflow: auto; }
.tf-tag { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.tf-tag:hover { background: var(--ink-3); }
.tf-tag input { margin: 0; accent-color: var(--accent); }
.tf-tag span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-tag .count { font: 11px/1 var(--mono); color: var(--muted); }
`;

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  return a !== 0 && (a < 0.01 || a >= 1e5) ? v.toExponential(2) : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ------------------------------------------------------------ controller

class TrackFilter {
  private saved: Saved;
  private props: SegmentProperties | undefined;
  private mask: Uint8Array | undefined;
  private host: HTMLElement | undefined;
  private updaters: (() => void)[] = [];
  /** What the panel was last built for; it is rebuilt only when this changes. */
  private built = "";
  private propsOff: Disposer | undefined;
  private viewOff: Disposer | undefined;
  private watching: string | undefined;
  private watchingView: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = this.read();
    this.offs.push(
      // The filter changed: here, or by undo, redo or opening a link.
      ctx.state.onChanged(() => {
        this.saved = this.read();
        this.recompute();
        this.refresh();
      }),
      ctx.workspace.onChanged(() => this.refresh()),
    );
    this.refresh();
  }

  private read(): Saved {
    const s = this.ctx.state.get<Saved>();
    return {
      dataset: s?.dataset,
      filter: { ...emptyFilter(), ...(s?.filter ?? {}) },
      active: s?.active ?? false,
      hideOthers: s?.hideOthers ?? true,
    };
  }

  private save(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.propsOff?.();
    this.viewOff?.();
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  // ------------------------------------------------------- the dataset

  /** Zarr Vectors datasets in the active scene. */
  private candidates() {
    return this.ctx.workspace
      .sceneDatasets()
      .filter((d) => d.layers.some((l) => l.sources.some((s) => /\|zarr-vectors:|^zarr-vectors:\/\/|\.zarrvectors\/?$/.test(s))));
  }

  private dataset(): DatasetInfo | undefined {
    const candidates = this.candidates();
    const chosen = candidates.find((d) => d.id === this.saved.dataset);
    if (chosen !== undefined) return chosen;
    const selected = this.ctx.workspace.selectedDataset();
    return candidates.find((d) => d.id === selected?.id) ?? candidates[0];
  }

  private viewName(dataset: DatasetInfo): string {
    return `${dataset.name} (filtered)`;
  }

  /** The layer whose segment properties are read: any view but the filtered one. */
  private baseLayer(dataset: DatasetInfo): string | undefined {
    const entry = this.ctx.workspace.sceneDatasets().find((d) => d.id === dataset.id);
    return entry?.layers.find((l) => l.name !== this.viewName(dataset))?.name ?? entry?.layers[0]?.name;
  }

  private sourceUrl(dataset: DatasetInfo): string | undefined {
    const source = dataset.source;
    if (typeof source === "string") return source;
    if (Array.isArray(source)) return typeof source[0] === "string" ? source[0] : (source[0] as { url?: string })?.url;
    return (source as { url?: string } | undefined)?.url;
  }

  // -------------------------------------------------------- recompute

  /** Follows the scene: which dataset, its properties, and the filtered view. */
  private refresh(): void {
    const dataset = this.dataset();
    const base = dataset && this.baseLayer(dataset);
    if (base !== this.watching) {
      this.propsOff?.();
      this.watching = base;
      this.propsOff = base === undefined ? undefined : this.ctx.viewer.onSegmentPropertiesChanged(base, () => this.loadProps());
      this.loadProps();
    }
    const view = dataset && this.viewName(dataset);
    if (view !== this.watchingView) {
      this.viewOff?.();
      this.watchingView = view;
      // Fires when the view's layer is created or replaced (undo, a scene
      // switch): its temporary visible set starts empty and is filled again.
      this.viewOff = view === undefined ? undefined : this.ctx.viewer.onSegmentPropertiesChanged(view, () => this.apply());
    }
    this.renderPanel();
  }

  private loadProps(): void {
    const props = this.watching === undefined ? undefined : this.ctx.viewer.segmentProperties(this.watching);
    if (props === this.props || (props !== undefined && this.props !== undefined && props.ids === this.props.ids)) return;
    this.props = props;
    this.recompute();
    this.renderPanel();
  }

  private recompute(): void {
    this.mask = this.props === undefined ? undefined : computeMask(this.props, this.saved.filter);
    for (const update of this.updaters) update();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.apply(), 120);
  }

  /** Shows the passing objects in the filtered view (creating it), or hides the view. */
  private apply(): void {
    const dataset = this.dataset();
    if (dataset === undefined) return;
    const view = this.viewName(dataset);
    const entry = this.ctx.workspace.sceneDatasets().find((d) => d.id === dataset.id);
    const hasView = entry?.layers.some((l) => l.name === view) ?? false;
    if (!this.saved.active || this.mask === undefined || this.props === undefined) {
      if (hasView && !this.saved.active) {
        this.ctx.workspace.removeLayer(view);
        for (const l of entry?.layers ?? []) if (l.name !== view) this.ctx.viewer.setLayerVisible(l.name, true);
      }
      return;
    }
    if (!hasView) {
      const url = this.sourceUrl(dataset);
      if (url === undefined) return;
      this.ctx.workspace.addLayer(dataset.id, {
        name: view,
        type: "segmentation",
        source: { url, subsources: { objects: false, meshes: false } },
        notSelectedAlpha: 0,
      });
    }
    for (const l of entry?.layers ?? []) {
      if (l.name !== view) this.ctx.viewer.setLayerVisible(l.name, !this.saved.hideOthers);
    }
    this.ctx.viewer.setTemporaryVisibleSegments(view, passingIds(this.props, this.mask));
  }

  // ------------------------------------------------------------ actions

  clear(): void {
    this.save({ filter: emptyFilter(), active: false });
  }

  async exportCsv(): Promise<void> {
    if (this.props === undefined || this.mask === undefined) {
      this.ctx.ui.toast("No Zarr Vectors dataset with attributes to export.", "error");
      return;
    }
    const blob = new Blob([toCsv(this.props, this.mask)], { type: "text/csv" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${this.dataset()?.name ?? "objects"}-filtered.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.ctx.log.info(`Exported ${countPassing(this.mask).toLocaleString()} objects as CSV.`);
  }

  // ---------------------------------------------------------------- UI

  render(host: HTMLElement): Disposer {
    this.host = host;
    this.renderPanel();
    return () => {
      this.host = undefined;
      this.updaters = [];
      this.built = "";
    };
  }

  private renderPanel(): void {
    const host = this.host;
    if (host === undefined) return;
    const signature = JSON.stringify([
      this.candidates().map((d) => [d.id, d.name]),
      this.dataset()?.id,
      this.props?.ids.length,
      this.props?.numeric.map((p) => p.id),
      this.props?.tags?.names,
      this.saved.active,
      this.saved.hideOthers,
      this.saved.filter.includeTags,
      isEmptyFilter(this.saved.filter),
    ]);
    if (signature === this.built && host.firstChild !== null) {
      for (const update of this.updaters) update();
      return;
    }
    this.built = signature;
    this.updaters = [];
    const root = el("div", { class: "tf" });
    host.replaceChildren(root);
    const candidates = this.candidates();
    const dataset = this.dataset();
    root.append(
      el(
        "p",
        { class: "tf-intro" },
        "Keep the objects whose attributes fall in the ranges you set and that belong to the groups you tick. The ones that pass show in their own view of the dataset; the filter is saved with the link.",
      ),
    );
    if (dataset === undefined) {
      root.append(el("p", { class: "empty" }, el("strong", {}, "No Zarr Vectors dataset in this scene. "), "Add one in the Datasets tab."));
      return;
    }
    if (candidates.length > 1) {
      const select = el("select", { class: "text-input", "aria-label": "Dataset" });
      for (const d of candidates) select.append(el("option", { value: d.id }, d.name));
      select.value = dataset.id;
      select.addEventListener("change", () => this.save({ dataset: select.value, filter: emptyFilter(), active: false }));
      root.append(el("label", { class: "field" }, el("span", {}, "Dataset"), select));
    } else {
      root.append(el("div", { class: "field" }, el("span", {}, "Dataset"), el("strong", {}, dataset.name)));
    }
    const props = this.props;
    if (props === undefined) {
      root.append(el("p", { class: "note" }, "Reading the objects' attributes…"));
      return;
    }

    // Summary and actions.
    const total = props.ids.length;
    const count = el("strong");
    const summary = el("div", { class: "tf-summary" }, count, el("span", {}, `of ${total.toLocaleString()} objects pass`));
    this.updaters.push(() => {
      count.textContent = this.mask === undefined ? "–" : countPassing(this.mask).toLocaleString();
    });
    const show = el(
      "button",
      { class: this.saved.active ? "btn outline small" : "btn primary small", type: "button", onclick: () => this.save({ active: !this.saved.active }) },
      this.saved.active ? "Stop showing" : "Show only these",
    );
    const reset = el("button", { class: "btn small", type: "button", disabled: isEmptyFilter(this.saved.filter), onclick: () => this.clear() }, "Reset");
    const csv = el("button", { class: "btn small", type: "button", onclick: () => void this.exportCsv() }, "Export CSV");
    const hide = el("input", { type: "checkbox" }) as HTMLInputElement;
    hide.checked = this.saved.hideOthers;
    hide.addEventListener("change", () => this.save({ hideOthers: hide.checked }));
    root.append(
      summary,
      el("div", { class: "tf-actions" }, show, reset, csv),
      el("label", { class: "field check" }, hide, el("span", {}, "Hide the unfiltered view while showing")),
    );

    // Numeric attributes.
    if (props.numeric.length > 0) root.append(el("h3", { class: "section-title" }, "Attributes"));
    for (const column of props.numeric) root.append(this.rangeControl(props, column));

    // Groups and categories.
    const tags = props.tags;
    if (tags !== undefined && tags.names.length > 0) {
      root.append(el("h3", { class: "section-title" }, "Groups"), el("p", { class: "note" }, "Ticked: keep objects in any ticked group."));
      const all = tagCounts(props);
      const list = el("div", { class: "tf-tags" });
      const counts: HTMLElement[] = [];
      tags.names.forEach((name, i) => {
        const box = el("input", { type: "checkbox" }) as HTMLInputElement;
        box.checked = this.saved.filter.includeTags.includes(name);
        box.addEventListener("change", () => {
          const include = new Set(this.saved.filter.includeTags);
          if (box.checked) include.add(name);
          else include.delete(name);
          this.save({ filter: { ...this.saved.filter, includeTags: [...include] } });
        });
        const c = el("span", { class: "count" });
        counts.push(c);
        list.append(el("label", { class: "tf-tag", title: tags.descriptions[i] || name }, box, el("span", {}, name), c));
      });
      this.updaters.push(() => {
        const passing = this.mask === undefined ? undefined : tagCounts(props, this.mask);
        counts.forEach((c, i) => {
          c.textContent = passing === undefined ? `${all[i]}` : `${passing[i]} / ${all[i]}`;
        });
      });
      root.append(list);
    }
    for (const update of this.updaters) update();
  }

  /** A histogram and a two-handled range for one numeric attribute. */
  private rangeControl(props: SegmentProperties, column: SegmentProperties["numeric"][number]): HTMLElement {
    const { id, min, max } = column;
    const step = max > min ? (max - min) / 400 : 1;
    const current = (): [number, number] => this.saved.filter.ranges[id] ?? [min, max];
    const [lo0, hi0] = current();
    const lo = el("input", { type: "range", min, max, step, value: lo0, "aria-label": `${id} minimum` }) as HTMLInputElement;
    const hi = el("input", { type: "range", min, max, step, value: hi0, "aria-label": `${id} maximum` }) as HTMLInputElement;
    const label = el("span", { class: "tf-range" });
    const block = el("div", { class: "tf-prop" });
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "tf-hist");
    svg.setAttribute("viewBox", `0 0 ${BINS} 1`);
    svg.setAttribute("preserveAspectRatio", "none");
    const all = histogram(column.values, min, max, BINS);
    const peak = Math.max(1, ...all);
    const bars = (counts: Uint32Array, cls: string) =>
      Array.from(counts, (n, b) => {
        const r = document.createElementNS(svgNs, "rect");
        const height = n / peak;
        r.setAttribute("x", String(b + 0.08));
        r.setAttribute("width", "0.84");
        r.setAttribute("y", String(1 - height));
        r.setAttribute("height", String(height));
        r.setAttribute("class", cls);
        return r;
      });
    svg.append(...bars(all, "all"));
    const passGroup = document.createElementNS(svgNs, "g");
    svg.append(passGroup);

    const describe = (a: number, b: number) => {
      label.textContent = `${fmt(a)} – ${fmt(b)}`;
      block.classList.toggle("filtered", a > min || b < max);
    };
    describe(lo0, hi0);
    // Dragging updates the count live; letting go saves (one undo step).
    const live = () => {
      let a = Number(lo.value);
      let b = Number(hi.value);
      if (a > b) [a, b] = [b, a];
      describe(a, b);
      const ranges = { ...this.saved.filter.ranges };
      if (a <= min && b >= max) delete ranges[id];
      else ranges[id] = [a, b];
      this.saved = { ...this.saved, filter: { ...this.saved.filter, ranges } };
      this.recompute();
    };
    const commit = () => this.save({ filter: this.saved.filter });
    for (const input of [lo, hi]) {
      input.addEventListener("input", live);
      input.addEventListener("change", commit);
    }
    this.updaters.push(() => {
      const passing = this.mask === undefined ? undefined : histogram(column.values, min, max, BINS, this.mask);
      passGroup.replaceChildren(...(passing === undefined ? [] : bars(passing, "pass")));
      const [a, b] = current();
      if (document.activeElement !== lo) lo.value = String(a);
      if (document.activeElement !== hi) hi.value = String(b);
      describe(a, b);
    });
    block.append(
      el("div", { class: "tf-prop-head" }, el("span", { class: "tf-prop-name", title: column.description ?? id }, id), label),
      svg,
      el("div", { class: "tf-sliders" }, lo, hi),
    );
    return block;
  }
}

// ---------------------------------------------------------------- plugin

export const plugin: PluginModule = {
  activate(ctx) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    const filter = new TrackFilter(ctx);
    ctx.subscriptions.push(() => filter.dispose());
    ctx.ui.panel(FILTERING_PANEL, (host) => filter.render(host));
    ctx.commands.register("trackFiltering.show", () => ctx.ui.showPanel(FILTERING_PANEL));
    ctx.commands.register("trackFiltering.clear", () => filter.clear());
    ctx.commands.register("trackFiltering.exportCsv", () => filter.exportCsv());
  },
};
