/**
 * Track filtering: TrackVis-style track groups over a Zarr Vectors dataset.
 *
 * A group keeps the objects (streamlines, skeletons, points) that pass
 * through its regions (spheres and boxes, each AND, OR or NOT) and whose
 * attributes are in range.  Each group is a layer of the dataset, in its own
 * colour, so it shows and is switched on and off like any layer, here and in
 * the Datasets tab.  Regions are drawn in the views as annotations: drag one
 * with Alt to move it, and the group follows.
 *
 * Speed: region tests run in a worker (roi_worker.ts) on the store's own
 * level-0 geometry, reading only the chunks a region touches, once.  While a
 * region moves, a coarse level gives a preview at once; the exact answer
 * follows when it settles.  The passing objects are shown through each
 * layer's temporary visible set, never stored: the groups are the plugin's
 * state (in the link, undoable) and the answer is recomputed from them.
 *
 * It uses only the plugin API and the Zarr Vectors package's reader.
 */
import { storeUrlOfSource } from "neuroglancer-zarr-vectors/source-url";
import type { DatasetInfo, Disposer, Json, PlatformContext, PluginModule, SegmentProperties } from "../../sdk/types.js";
import { computeMask, countPassing, emptyFilter, type FilterSpec, histogram, isEmptyFilter, passingIds, tagCounts, toCsv } from "./filter.js";
import { FILTERING_PANEL } from "./manifest.js";
import { groupMask, type Roi, type RoiOp, type RoiShape, rowIndex, rowMask } from "./roi.js";
import { type Dimensions, previewLevel, RoiEngine, type RoiResult, type StoreInfo, toStore } from "./roi_client.js";

export interface Group {
  id: string;
  name: string;
  colour: string;
  rois: Roi[];
  filter: FilterSpec;
  /** The layer showing the group, once made. */
  layer?: string;
}

export interface Saved {
  dataset?: string;
  groups: Group[];
  /** The group being edited. */
  editing?: string;
}

const PALETTE = ["#e4572e", "#3fb6c9", "#d4a72c", "#8fd14f", "#b07cd8", "#f08bb3", "#5c8de8", "#e8b05c"];
const BINS = 40;
/** How long a region must stay put before the exact answer is computed. */
const EXACT_DELAY_MS = 150;

/** The saved state, from either version: v1 had one filter, which becomes a group. */
export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved> & { filter?: FilterSpec; active?: boolean };
  if (Array.isArray(s.groups)) {
    return {
      dataset: s.dataset,
      editing: s.editing,
      groups: s.groups.map((g, i) => ({
        id: String(g.id ?? `g${i}`),
        name: String(g.name ?? `Group ${i + 1}`),
        colour: String(g.colour ?? PALETTE[i % PALETTE.length]),
        rois: Array.isArray(g.rois) ? g.rois : [],
        filter: { ...emptyFilter(), ...(g.filter ?? {}) },
        layer: g.layer,
      })),
    };
  }
  const groups: Group[] = [];
  if (s.filter !== undefined && !isEmptyFilter({ ...emptyFilter(), ...s.filter })) {
    groups.push({ id: "g0", name: "Filtered", colour: PALETTE[0], rois: [], filter: { ...emptyFilter(), ...s.filter } });
  }
  return { dataset: s.dataset, groups, editing: groups[0]?.id };
}

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

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  return a !== 0 && (a < 0.01 || a >= 1e5) ? v.toExponential(2) : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const STYLE = `
.tf { display: grid; gap: 10px; }
.tf-intro { margin: 0; color: var(--muted); font-size: 12px; }
.tf-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tf-groups { display: grid; gap: 3px; }
.tf-group { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 5px 6px; border-radius: var(--r); border: 1px solid transparent; cursor: pointer; }
.tf-group:hover { background: var(--ink-3); }
.tf-group.editing { border-color: #4a3a22; background: var(--accent-soft); }
.tf-group .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.tf-group .count { font: 11px/1 var(--mono); color: var(--muted); white-space: nowrap; }
.tf-group .count.busy { color: var(--warn); }
.tf-swatch { width: 18px; height: 18px; padding: 0; border: 1px solid var(--line-strong); border-radius: 4px; background: none; cursor: pointer; }
.tf-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.tf-swatch::-webkit-color-swatch { border: 0; border-radius: 3px; }
.tf-swatch::-moz-color-swatch { border: 0; border-radius: 3px; }
.tf-editor { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
.tf-name { font: 600 14px/1.3 var(--ui); background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--text); padding: 2px 4px; min-width: 0; flex: 1; }
.tf-name:hover, .tf-name:focus { border-color: var(--line); background: var(--ink-0); }
.tf-status { font-size: 12px; color: var(--muted); }
.tf-status strong { color: var(--text); font: 600 16px/1 var(--mono); margin-right: 4px; }
.tf-roi { border: 1px solid var(--line); border-radius: var(--r); padding: 6px 8px; display: grid; gap: 5px; }
.tf-roi-head { display: flex; align-items: center; gap: 6px; }
.tf-roi-head .label { font-weight: 500; flex: 1; }
.tf-roi select { height: 24px; border-radius: 4px; border: 1px solid var(--line); background: var(--ink-0); color: var(--text); font: 600 11px/1 var(--mono); }
.tf-xyz { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.tf-xyz label { display: grid; gap: 1px; font-size: 10px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.06em; }
.tf-xyz input { width: 100%; box-sizing: border-box; height: 24px; border: 1px solid var(--line); border-radius: 4px; background: var(--ink-0); color: var(--text); font: 12px/1 var(--mono); padding: 0 4px; }
.tf-roi-status { font: 11px/1.3 var(--mono); color: var(--faint); }
.tf-prop { border: 1px solid var(--line); border-radius: var(--r); padding: 8px; display: grid; gap: 4px; }
.tf-prop.filtered { border-color: #4a3a22; }
.tf-prop-head { display: flex; align-items: baseline; gap: 6px; }
.tf-prop-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-range { margin-left: auto; font: 11px/1 var(--mono); color: var(--muted); white-space: nowrap; }
.tf-hist { width: 100%; height: 34px; display: block; }
.tf-hist .all { fill: var(--ink-4); }
.tf-hist .pass { fill: var(--accent); }
.tf-sliders { position: relative; height: 18px; }
.tf-sliders input { position: absolute; inset: 0; width: 100%; margin: 0; pointer-events: none; background: none; -webkit-appearance: none; appearance: none; height: 18px; }
.tf-sliders input::-webkit-slider-thumb { pointer-events: all; -webkit-appearance: none; width: 12px; height: 16px; border-radius: 3px; background: var(--accent); cursor: ew-resize; }
.tf-sliders input::-moz-range-thumb { pointer-events: all; width: 12px; height: 16px; border-radius: 3px; background: var(--accent); border: 0; cursor: ew-resize; }
.tf-sliders::before { content: ""; position: absolute; left: 0; right: 0; top: 8px; height: 2px; background: var(--line); }
.tf details > summary { cursor: pointer; list-style: none; }
.tf details > summary::-webkit-details-marker { display: none; }
.tf details[open] > summary { margin-bottom: 8px; }
.tf-tags { display: grid; gap: 2px; max-height: 220px; overflow: auto; }
.tf-tag { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.tf-tag:hover { background: var(--ink-3); }
.tf-tag input { margin: 0; accent-color: var(--accent); }
.tf-tag .count { font: 11px/1 var(--mono); color: var(--muted); }
`;

// --------------------------------------------------------------- results

interface GroupResult {
  mask: Uint8Array | undefined;
  count: number;
  /** "exact": level 0; "preview": a coarse level's sample; "computing", "empty", "error". */
  state: "exact" | "preview" | "computing" | "empty" | "error" | "waiting";
  detail: string;
}

// ------------------------------------------------------------ controller

class TrackGroups {
  private saved: Saved;
  private props: SegmentProperties | undefined;
  private rowOf: ((id: bigint) => number | undefined) | undefined;
  private engine: RoiEngine | undefined;
  private engineUrl: string | undefined;
  private info: StoreInfo | undefined;
  private results = new Map<string, GroupResult>();
  private roiStatus = new Map<string, string>();
  private tokens = new Map<string, number>();
  private exactTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private layerWatches = new Map<string, Disposer>();
  private propsOff: Disposer | undefined;
  private watching: string | undefined;
  private commitTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while this plugin writes its own state, so the echo is ignored. */
  private writing = false;
  /** An evaluation waited for something (the store, the attributes, the coordinate space). */
  private waiting = false;
  /** Groups whose layer is being made (making one refreshes the workspace, which asks again). */
  private creating = new Set<string>();
  /** Region ids last written to the annotation layer: only these can be "deleted in a view". */
  private written = new Set<string>();
  private host: HTMLElement | undefined;
  private updaters: (() => void)[] = [];
  private built = "";
  private readonly offs: Disposer[] = [];

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.offs.push(
      ctx.state.onChanged(() => {
        // Undo, redo, a link: the groups changed from outside.
        if (this.writing || this.commitTimer !== undefined) return;
        this.saved = readSaved(ctx.state.get());
        this.evaluateAll();
        this.refresh();
      }),
      ctx.workspace.onChanged(() => this.refresh()),
      ctx.viewer.onStateChanged(() => this.readAnnotations()),
    );
    this.refresh();
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.propsOff?.();
    for (const off of this.layerWatches.values()) off();
    for (const t of this.exactTimers.values()) clearTimeout(t);
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.engine?.dispose();
  }

  // ------------------------------------------------------------ saving

  /** Saves now: one undo step. */
  private save(patch: Partial<Saved> = {}): void {
    this.saved = { ...this.saved, ...patch };
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
    this.write();
  }

  private write(): void {
    this.writing = true;
    try {
      this.ctx.state.set(this.saved);
    } finally {
      this.writing = false;
    }
  }

  /** Saves once changes stop for a moment (a drag is one undo step, not hundreds). */
  private saveSoon(): void {
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined;
      this.write();
    }, 400);
  }

  private updateGroup(id: string, edit: (g: Group) => Group, soon = false): void {
    this.saved = { ...this.saved, groups: this.saved.groups.map((g) => (g.id === id ? edit(g) : g)) };
    if (soon) this.saveSoon();
    else this.save();
  }

  // ----------------------------------------------------------- dataset

  private candidates() {
    return this.ctx.workspace.sceneDatasets().filter((d) => d.layers.some((l) => l.sources.some((s) => storeUrlOfSource(s) !== undefined)));
  }

  private dataset(): DatasetInfo | undefined {
    const candidates = this.candidates();
    const chosen = candidates.find((d) => d.id === this.saved.dataset);
    if (chosen !== undefined) return chosen;
    const selected = this.ctx.workspace.selectedDataset();
    return candidates.find((d) => d.id === selected?.id) ?? candidates[0];
  }

  private sourceOf(dataset: DatasetInfo): string | undefined {
    const source = dataset.source;
    if (typeof source === "string") return source;
    if (Array.isArray(source)) return typeof source[0] === "string" ? source[0] : (source[0] as { url?: string })?.url;
    return (source as { url?: string } | undefined)?.url;
  }

  private groupLayers(): Set<string> {
    return new Set(this.saved.groups.map((g) => g.layer).filter((l): l is string => l !== undefined));
  }

  /** The dataset's layers that are not groups: the "all tracks" views. */
  private baseLayers(dataset: DatasetInfo): string[] {
    const groups = this.groupLayers();
    const entry = this.ctx.workspace.sceneDatasets().find((d) => d.id === dataset.id);
    return (entry?.layers ?? []).map((l) => l.name).filter((n) => !groups.has(n) && n !== this.roiLayerName(dataset));
  }

  private layerInfo(name: string | undefined) {
    return name === undefined ? undefined : this.ctx.viewer.layers().find((l) => l.name === name);
  }

  private dims(): Dimensions | undefined {
    return this.ctx.viewer.getState().dimensions as Dimensions | undefined;
  }

  private viewCentre(): [number, number, number] {
    const p = this.ctx.viewer.getState().position as number[] | undefined;
    return [p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0];
  }

  // --------------------------------------------------------- following

  /** Follows the scene: which dataset, its store, its attributes, its layers. */
  private refresh(): void {
    const dataset = this.dataset();
    const base = dataset && this.baseLayers(dataset)[0];
    if (base !== this.watching) {
      this.propsOff?.();
      this.watching = base;
      this.propsOff = base === undefined ? undefined : this.ctx.viewer.onSegmentPropertiesChanged(base, () => this.loadProps());
      this.loadProps();
    }
    const source = dataset && this.sourceOf(dataset);
    const url = source && storeUrlOfSource(source);
    if (url !== this.engineUrl) {
      this.engine?.dispose();
      this.engine = undefined;
      this.info = undefined;
      this.engineUrl = url;
      if (url !== undefined) {
        const engine = new RoiEngine(url);
        this.engine = engine;
        engine.ready.then(
          (info) => {
            if (this.engine !== engine) return;
            this.info = info;
            this.evaluateAll();
            this.renderPanel();
          },
          (e) => this.ctx.log.error(`Could not open ${url} for region tests: ${(e as Error).message}`),
        );
      }
    }
    // Groups that came without a layer (from a link or an example) get one,
    // once the dataset is in the scene; a layer removed later stays removed.
    if (dataset !== undefined && this.dims() !== undefined) {
      for (const { id } of this.saved.groups) {
        const group = this.saved.groups.find((g) => g.id === id);
        if (group !== undefined && group.layer === undefined) this.ensureLayer(group);
      }
    }
    this.watchGroupLayers();
    this.writeAnnotations();
    if (this.waiting && this.props !== undefined && this.info !== undefined && this.dims() !== undefined) this.evaluateAll();
    this.renderPanel();
  }

  private loadProps(): void {
    const props = this.watching === undefined ? undefined : this.ctx.viewer.segmentProperties(this.watching);
    if (props === this.props || (props !== undefined && this.props !== undefined && props.ids === this.props.ids)) return;
    this.props = props;
    this.rowOf = props && rowIndex(props.ids);
    this.evaluateAll();
    this.renderPanel();
  }

  /** Re-applies a group's answer when its layer is made or replaced (undo, a colour change). */
  private watchGroupLayers(): void {
    const wanted = new Map(this.saved.groups.filter((g) => g.layer !== undefined).map((g) => [g.layer!, g.id]));
    for (const [layer, off] of this.layerWatches) {
      if (!wanted.has(layer)) {
        off();
        this.layerWatches.delete(layer);
      }
    }
    for (const [layer, groupId] of wanted) {
      if (this.layerWatches.has(layer)) continue;
      this.layerWatches.set(
        layer,
        this.ctx.viewer.onSegmentPropertiesChanged(layer, () => {
          const group = this.saved.groups.find((g) => g.id === groupId);
          if (group !== undefined) this.show(group);
        }),
      );
    }
  }

  // ------------------------------------------------------------ groups

  newGroup(): void {
    const n = this.saved.groups.length;
    const group: Group = { id: `g${Date.now().toString(36)}`, name: `Group ${n + 1}`, colour: PALETTE[n % PALETTE.length], rois: [], filter: emptyFilter() };
    this.save({ groups: [...this.saved.groups, group], editing: group.id, dataset: this.dataset()?.id });
    this.ensureLayer(group);
    this.ctx.ui.showPanel(FILTERING_PANEL);
  }

  private editing(): Group | undefined {
    return this.saved.groups.find((g) => g.id === this.saved.editing) ?? this.saved.groups[0];
  }

  private deleteGroup(group: Group): void {
    if (group.layer !== undefined && this.layerInfo(group.layer) !== undefined) this.ctx.workspace.removeLayer(group.layer);
    const groups = this.saved.groups.filter((g) => g.id !== group.id);
    this.results.delete(group.id);
    this.save({ groups, editing: this.saved.editing === group.id ? groups[0]?.id : this.saved.editing });
    this.writeAnnotations();
  }

  private renameGroup(group: Group, name: string): void {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === group.name) return;
    let layer = group.layer;
    if (layer !== undefined && this.layerInfo(layer) !== undefined) layer = this.ctx.workspace.renameLayer(layer, trimmed);
    this.updateGroup(group.id, (g) => ({ ...g, name: trimmed, layer }));
  }

  private recolour(group: Group, colour: string): void {
    this.updateGroup(group.id, (g) => ({ ...g, colour }));
    if (group.layer !== undefined) {
      const layer = group.layer;
      this.ctx.viewer.patchState((ng) => {
        const spec = (ng.layers as Json[] | undefined)?.find((l) => l.name === layer);
        if (spec !== undefined) spec.segmentDefaultColor = colour;
      });
    }
    this.writeAnnotations();
  }

  /** Makes the group's layer (a view of the dataset without per-object subsources). */
  private ensureLayer(stale: Group): string | undefined {
    // Making a layer refreshes the workspace, which makes the other groups'
    // layers then and there: the caller's copy of a group can be out of date.
    const group = this.saved.groups.find((g) => g.id === stale.id);
    if (group === undefined) return undefined;
    if (group.layer !== undefined && this.layerInfo(group.layer) !== undefined) return group.layer;
    if (this.creating.has(group.id)) return undefined;
    const dataset = this.dataset();
    const url = dataset && this.sourceOf(dataset);
    if (dataset === undefined || url === undefined) return undefined;
    this.creating.add(group.id);
    let layer: string;
    try {
      layer = this.ctx.workspace.addLayer(dataset.id, {
        name: group.name,
        type: "segmentation",
        source: { url, subsources: { objects: false, meshes: false } },
        notSelectedAlpha: 0,
        ignoreNullVisibleSet: false,
        segmentDefaultColor: group.colour,
      });
      this.saved = { ...this.saved, groups: this.saved.groups.map((g) => (g.id === group.id ? { ...g, layer } : g)) };
      this.save();
    } finally {
      this.creating.delete(group.id);
    }
    this.watchGroupLayers();
    this.show(this.saved.groups.find((g) => g.id === group.id)!);
    return layer;
  }

  private setGroupVisible(group: Group, visible: boolean): void {
    if (group.layer !== undefined && this.layerInfo(group.layer) !== undefined) this.ctx.viewer.setLayerVisible(group.layer, visible);
    else if (visible) this.ensureLayer(group);
    this.writeAnnotations();
  }

  // ------------------------------------------------------------- regions

  private addRoi(shape: RoiShape): void {
    let group = this.editing();
    if (group === undefined) {
      this.newGroup();
      group = this.editing();
      if (group === undefined) return;
    }
    // A fifth of a level-0 chunk, in global units: 5–6 mm on a typical tractogram.
    const info = this.info;
    const dims = this.dims();
    let size = 5;
    if (info !== undefined && dims !== undefined) {
      const stored = Math.min(...info.levels[0].chunkShape) / 6;
      const factor = (dims[info.axisNames[0]]?.[0] ?? 1) / (info.axisScales[0] || 1);
      size = Math.round((stored / factor) * 10) / 10;
    }
    const roi: Roi = {
      id: `r${Date.now().toString(36)}`,
      shape,
      center: this.viewCentre(),
      radius: size,
      size: [size * 2, size * 2, size * 2],
      op: group.rois.length === 0 ? "and" : "and",
    };
    this.updateGroup(group.id, (g) => ({ ...g, rois: [...g.rois, roi] }));
    this.ensureLayer(this.editing()!);
    this.writeAnnotations();
    this.evaluateGroup(this.editing()!);
    this.renderPanel();
  }

  private updateRoi(group: Group, roiId: string, patch: Partial<Roi>, soon = false): void {
    this.updateGroup(group.id, (g) => ({ ...g, rois: g.rois.map((r) => (r.id === roiId ? { ...r, ...patch } : r)) }), soon);
    this.writeAnnotations();
    this.evaluateGroup(this.saved.groups.find((g) => g.id === group.id)!);
  }

  private removeRoi(group: Group, roiId: string): void {
    this.updateGroup(group.id, (g) => ({ ...g, rois: g.rois.filter((r) => r.id !== roiId) }));
    this.writeAnnotations();
    this.evaluateGroup(this.saved.groups.find((g) => g.id === group.id)!);
  }

  // -------------------------------------------- regions in the viewer

  private roiLayerName(dataset: DatasetInfo): string {
    return `${dataset.name} regions`;
  }

  /** The annotations the regions layer should hold: the shown groups' regions, in their colours. */
  private desiredAnnotations(): Json[] {
    const out: Json[] = [];
    for (const group of this.saved.groups) {
      const shown = group.id === this.saved.editing || this.layerInfo(group.layer)?.visible === true;
      if (!shown) continue;
      group.rois.forEach((roi, i) => {
        const description = `${group.name}: ${roi.op.toUpperCase()} ${roi.shape} ${i + 1}`;
        if (roi.shape === "sphere") {
          out.push({ type: "ellipsoid", id: roi.id, center: [...roi.center], radii: [roi.radius, roi.radius, roi.radius], props: [group.colour], description });
        } else {
          const half = roi.size.map((s) => s / 2);
          out.push({
            type: "axis_aligned_bounding_box",
            id: roi.id,
            pointA: roi.center.map((c, k) => c - half[k]),
            pointB: roi.center.map((c, k) => c + half[k]),
            props: [group.colour],
            description,
          });
        }
      });
    }
    return out;
  }

  /** Writes the regions into their annotation layer, making it when needed. */
  private writeAnnotations(): void {
    const dataset = this.dataset();
    const dims = this.dims();
    if (dataset === undefined || dims === undefined) return;
    const name = this.roiLayerName(dataset);
    const desired = this.desiredAnnotations();
    const ng = this.ctx.viewer.getState();
    const layers = (ng.layers as Json[] | undefined) ?? [];
    const current = layers.find((l) => l.name === name);
    if (current === undefined && desired.length === 0) return;
    // Neuroglancer keeps coordinates as 32-bit floats: compare to a tolerance,
    // or every write would look like a change and be written again.
    const round = (v: unknown) => (Array.isArray(v) ? v.map((x) => Math.round(Number(x) * 1e3) / 1e3) : v);
    const normalise = (list: unknown) =>
      JSON.stringify(
        ((list as Json[] | undefined) ?? []).map((a) => [a.type, a.id, round(a.center), round(a.radii), round(a.pointA), round(a.pointB), a.props, a.description ?? ""]),
      );
    this.written = new Set(desired.map((a) => String(a.id)));
    if (current !== undefined && normalise(current.annotations) === normalise(desired)) return;
    this.ctx.viewer.patchState((state) => {
      const list = ((state.layers as Json[] | undefined) ?? []) as Json[];
      const spec = list.find((l) => l.name === name);
      if (spec !== undefined) {
        spec.annotations = desired;
        return;
      }
      list.push({
        type: "annotation",
        name,
        source: { url: "local://annotations", transform: { outputDimensions: dims } },
        annotationProperties: [{ id: "color", type: "rgb", default: "#e3a95e" }],
        shader: "void main() {\n  setColor(prop_color());\n}\n",
        annotations: desired,
      });
      state.layers = list;
    });
  }

  /**
   * Reads regions back from the annotation layer: one moved in a view moves
   * in its group, one deleted there is deleted, and an ellipsoid or box
   * drawn there joins the group being edited.
   */
  private readAnnotations(): void {
    const dataset = this.dataset();
    if (dataset === undefined) return;
    const spec = ((this.ctx.viewer.getState().layers as Json[] | undefined) ?? []).find((l) => l.name === this.roiLayerName(dataset));
    if (spec === undefined) return;
    const annotations = (spec.annotations as Json[] | undefined) ?? [];
    const byId = new Map(annotations.map((a) => [String(a.id), a]));
    // Deleted in a view: written there by this plugin, and gone now.  (A
    // region of a group just switched on is expected but not yet written.)
    const shownIds = this.written;
    // To the precision Neuroglancer keeps (32-bit floats).
    const tolerance = (v: number) => Math.max(1e-4, Math.abs(v) * 1e-5);
    const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance(v));
    let changed = false;
    const groups = this.saved.groups.map((group) => {
      let groupChanged = false;
      const rois: Roi[] = [];
      for (const roi of group.rois) {
        const a = byId.get(roi.id);
        if (a === undefined) {
          // Deleted in the view (only regions the layer was showing).
          if (shownIds.has(roi.id)) {
            changed = groupChanged = true;
            continue;
          }
          rois.push(roi);
          continue;
        }
        let next = roi;
        if (a.type === "ellipsoid" && Array.isArray(a.center) && Array.isArray(a.radii)) {
          const center = (a.center as number[]).slice(0, 3) as [number, number, number];
          const radius = Math.max(...(a.radii as number[]).slice(0, 3));
          if (!close(center, roi.center) || !close([radius], [roi.radius])) next = { ...roi, shape: "sphere", center, radius };
        } else if (a.type === "axis_aligned_bounding_box" && Array.isArray(a.pointA) && Array.isArray(a.pointB)) {
          const pa = a.pointA as number[];
          const pb = a.pointB as number[];
          const center = [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2) as [number, number, number];
          const size = [0, 1, 2].map((k) => Math.abs(pb[k] - pa[k])) as [number, number, number];
          if (!close(center, roi.center) || !close(size, roi.size)) next = { ...roi, shape: "box", center, size };
        }
        if (next !== roi) changed = groupChanged = true;
        rois.push(next);
      }
      return groupChanged ? { ...group, rois } : group;
    });
    // New shapes drawn with Neuroglancer's own tools join the edited group.
    const known = new Set(this.saved.groups.flatMap((g) => g.rois.map((r) => r.id)));
    const editing = this.editing();
    const drawn: Roi[] = [];
    for (const a of annotations) {
      const id = String(a.id);
      if (known.has(id) || editing === undefined) continue;
      if (a.type === "ellipsoid" && Array.isArray(a.center)) {
        drawn.push({ id, shape: "sphere", center: (a.center as number[]).slice(0, 3) as [number, number, number], radius: Math.max(...((a.radii as number[]) ?? [5]).slice(0, 3)), size: [10, 10, 10], op: "and" });
      } else if (a.type === "axis_aligned_bounding_box" && Array.isArray(a.pointA) && Array.isArray(a.pointB)) {
        const pa = a.pointA as number[];
        const pb = a.pointB as number[];
        drawn.push({
          id,
          shape: "box",
          center: [0, 1, 2].map((k) => (pa[k] + pb[k]) / 2) as [number, number, number],
          radius: 5,
          size: [0, 1, 2].map((k) => Math.abs(pb[k] - pa[k])) as [number, number, number],
          op: "and",
        });
      }
    }
    for (const id of [...this.written]) if (!byId.has(id)) this.written.delete(id);
    for (const roi of drawn) this.written.add(roi.id);
    if (!changed && drawn.length === 0) return;
    const next = groups.map((g) => (editing !== undefined && g.id === editing.id && drawn.length > 0 ? { ...g, rois: [...g.rois, ...drawn] } : g));
    const moved = next.filter((g, i) => g !== this.saved.groups[i]);
    this.saved = { ...this.saved, groups: next };
    // A drag sends many small moves: preview each, save when it stops.
    this.saveSoon();
    for (const g of moved) this.evaluateGroup(g);
    if (drawn.length > 0) this.writeAnnotations();
    this.renderPanel();
  }

  // -------------------------------------------------------- evaluation

  private evaluateAll(): void {
    this.waiting = false;
    for (const group of this.saved.groups) this.evaluateGroup(group, true);
  }

  /**
   * Works out a group's answer: a preview from a coarse level at once, then,
   * when its regions have stayed put a moment, the exact one from level 0.
   */
  private evaluateGroup(group: Group, exactNow = false): void {
    const props = this.props;
    const rowOf = this.rowOf;
    const dims = this.dims();
    const token = (this.tokens.get(group.id) ?? 0) + 1;
    this.tokens.set(group.id, token);
    const current = () => this.tokens.get(group.id) === token;
    if (props === undefined || rowOf === undefined) {
      this.waiting = true;
      this.setResult(group, { mask: undefined, count: 0, state: "waiting", detail: "Reading the objects' attributes…" });
      return;
    }
    const n = props.ids.length;
    const attributes = isEmptyFilter(group.filter) ? undefined : computeMask(props, group.filter);
    if (group.rois.length === 0) {
      if (attributes === undefined) {
        this.setResult(group, { mask: new Uint8Array(n), count: 0, state: "empty", detail: "Add a region or an attribute range to choose objects." });
      } else {
        this.setResult(group, { mask: attributes, count: countPassing(attributes), state: "exact", detail: "attributes only" });
      }
      return;
    }
    const engine = this.engine;
    const info = this.info;
    if (engine === undefined || info === undefined || dims === undefined) {
      this.waiting = true;
      this.setResult(group, { mask: undefined, count: 0, state: "waiting", detail: "Opening the store…" });
      return;
    }
    const geometries = group.rois.map((r) => toStore(r, dims, info));
    const combine = (results: RoiResult[]) =>
      groupMask(
        n,
        attributes,
        results.map((r, i) => ({ op: group.rois[i].op as RoiOp, rows: rowMask(n, r.ids, rowOf) })),
      );
    const preview = previewLevel(info);
    if (preview !== undefined && !exactNow) {
      this.setResult(group, { ...(this.results.get(group.id) ?? { mask: undefined, count: 0 }), state: "computing", detail: "Previewing…" });
      void Promise.all(geometries.map((g) => engine.evaluate(g, preview))).then(
        (results) => {
          if (!current()) return;
          const mask = combine(results);
          const sample = Math.round(100 * (info.levels[preview].vertexCount ?? 0) / (info.levels[0].vertexCount || 1));
          this.setResult(group, { mask, count: countPassing(mask), state: "preview", detail: `preview from level ${preview} (about ${sample}% of the vertices); exact to follow` });
        },
        () => {},
      );
    }
    const old = this.exactTimers.get(group.id);
    if (old !== undefined) clearTimeout(old);
    this.exactTimers.set(
      group.id,
      setTimeout(
        () => {
          this.exactTimers.delete(group.id);
          if (!current()) return;
          const progress = new Map<string, [number, number]>();
          const report = () => {
            let done = 0;
            let total = 0;
            for (const [d, t] of progress.values()) {
              done += d;
              total += t;
            }
            if (!current()) return;
            const prior = this.results.get(group.id);
            if (prior?.state === "exact") return;
            this.setResult(group, { ...(prior ?? { mask: undefined, count: 0 }), state: prior?.state === "preview" ? "preview" : "computing", detail: `exact: ${done} of ${total} chunks read` });
          };
          void Promise.all(
            geometries.map((g, i) =>
              engine.evaluate(g, 0, (done, total) => {
                progress.set(group.rois[i].id, [done, total]);
                report();
              }),
            ),
          ).then(
            (results) => {
              if (!current()) return;
              const mask = combine(results);
              results.forEach((r, i) => this.roiStatus.set(group.rois[i].id, `${r.ids.length.toLocaleString()} objects · ${r.chunks} chunk${r.chunks === 1 ? "" : "s"} · ${(r.ms / 1000).toFixed(r.ms < 1000 ? 2 : 1)} s`));
              const ms = Math.max(...results.map((r) => r.ms));
              this.setResult(group, { mask, count: countPassing(mask), state: "exact", detail: `exact, from level 0 in ${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s` });
            },
            (e) => {
              if (current()) this.setResult(group, { mask: undefined, count: 0, state: "error", detail: (e as Error).message });
            },
          );
        },
        exactNow ? 0 : EXACT_DELAY_MS,
      ),
    );
  }

  private setResult(group: Group, result: GroupResult): void {
    this.results.set(group.id, result);
    this.show(group);
    for (const update of this.updaters) update();
  }

  /** Shows a group's answer in its layer. */
  private show(group: Group): void {
    const result = this.results.get(group.id);
    const layer = this.saved.groups.find((g) => g.id === group.id)?.layer;
    if (layer === undefined || result?.mask === undefined || this.props === undefined) return;
    this.ctx.viewer.setTemporaryVisibleSegments(layer, passingIds(this.props, result.mask));
  }

  exportCsv(): void {
    const group = this.editing();
    const mask = group && this.results.get(group.id)?.mask;
    if (this.props === undefined || mask === undefined || group === undefined) {
      this.ctx.ui.toast("No group with objects to export.", "error");
      return;
    }
    const blob = new Blob([toCsv(this.props, mask)], { type: "text/csv" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${group.name}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.ctx.log.info(`Exported ${countPassing(mask).toLocaleString()} objects of ${group.name} as CSV.`);
  }

  addSphere(): void {
    this.addRoi("sphere");
  }

  addBox(): void {
    this.addRoi("box");
  }

  // ---------------------------------------------------------------- UI

  render(host: HTMLElement): Disposer {
    this.host = host;
    this.built = "";
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
    const editing = this.editing();
    const signature = JSON.stringify([
      this.candidates().map((d) => [d.id, d.name]),
      this.dataset()?.id,
      this.props?.ids.length,
      this.info !== undefined,
      this.saved.groups.map((g) => [g.id, g.name, g.colour, g.layer, g.rois.map((r) => [r.id, r.shape, r.op])]),
      editing?.id,
      editing?.filter.includeTags,
      editing !== undefined && isEmptyFilter(editing.filter),
    ]);
    if (signature === this.built && host.firstChild !== null) {
      for (const update of this.updaters) update();
      return;
    }
    this.built = signature;
    this.updaters = [];
    const root = el("div", { class: "tf" });
    host.replaceChildren(root);
    const dataset = this.dataset();
    if (dataset === undefined) {
      root.append(
        el("p", { class: "tf-intro" }, "Track groups select a Zarr Vectors dataset's objects by the regions they pass through and by their attributes. Each group is a layer of its own."),
        el("p", { class: "empty" }, el("strong", {}, "No Zarr Vectors dataset in this scene. "), "Add one in the Datasets tab."),
      );
      return;
    }

    // Dataset.
    const candidates = this.candidates();
    if (candidates.length > 1) {
      const select = el("select", { class: "text-input", "aria-label": "Dataset" });
      for (const d of candidates) select.append(el("option", { value: d.id }, d.name));
      select.value = dataset.id;
      select.addEventListener("change", () => this.save({ dataset: select.value }));
      root.append(el("label", { class: "field" }, el("span", {}, "Dataset"), select));
    } else {
      root.append(el("div", { class: "field" }, el("span", {}, "Dataset"), el("strong", {}, dataset.name)));
    }
    const bases = this.baseLayers(dataset);
    if (bases.length > 0) {
      const all = el("input", { type: "checkbox" }) as HTMLInputElement;
      all.addEventListener("change", () => bases.forEach((b) => this.ctx.viewer.setLayerVisible(b, all.checked)));
      this.updaters.push(() => {
        all.checked = bases.some((b) => this.layerInfo(b)?.visible);
      });
      root.append(el("label", { class: "field check" }, all, el("span", {}, "Show all objects (the unfiltered view)")));
    }

    // Groups.
    root.append(
      el(
        "div",
        { class: "tf-row" },
        el("h3", { class: "section-title", style: "margin:0;flex:1" }, "Track groups"),
        el("button", { class: "btn outline small", type: "button", onclick: () => this.newGroup() }, "+ New group"),
      ),
    );
    const list = el("div", { class: "tf-groups" });
    if (this.saved.groups.length === 0) {
      list.append(el("p", { class: "empty" }, "No groups yet. A new group starts empty: add regions and attribute ranges to choose its objects."));
    }
    for (const group of this.saved.groups) {
      const colour = el("input", { type: "color", class: "tf-swatch", value: group.colour, title: "Colour", "aria-label": `${group.name} colour` }) as HTMLInputElement;
      colour.addEventListener("click", (e) => e.stopPropagation());
      colour.addEventListener("change", () => this.recolour(group, colour.value));
      const eye = el("input", { type: "checkbox", title: "Show or hide this group", "aria-label": `Show ${group.name}` }) as HTMLInputElement;
      eye.addEventListener("click", (e) => e.stopPropagation());
      eye.addEventListener("change", () => this.setGroupVisible(group, eye.checked));
      const count = el("span", { class: "count" });
      this.updaters.push(() => {
        const info = this.layerInfo(group.layer);
        eye.checked = info?.visible === true;
        const r = this.results.get(group.id);
        count.textContent = r === undefined || r.mask === undefined ? "…" : `${r.count.toLocaleString()}${r.state === "preview" ? "~" : ""}`;
        count.className = r?.state === "exact" || r?.state === "empty" ? "count" : "count busy";
        count.title = r?.detail ?? "";
      });
      list.append(
        el(
          "div",
          { class: group.id === editing?.id ? "tf-group editing" : "tf-group", title: "Edit this group", onclick: () => this.save({ editing: group.id }) },
          colour,
          eye,
          el("span", { class: "name" }, group.name),
          count,
        ),
      );
    }
    root.append(list);

    if (editing === undefined) return;
    root.append(this.editor(editing));
    for (const update of this.updaters) update();
  }

  private editor(group: Group): HTMLElement {
    const props = this.props;
    const box = el("div", { class: "tf-editor" });
    const name = el("input", { class: "tf-name", value: group.name, "aria-label": "Group name", spellcheck: "false" }) as HTMLInputElement;
    name.addEventListener("change", () => this.renameGroup(group, name.value));
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
    });
    box.append(
      el(
        "div",
        { class: "tf-row" },
        name,
        el("button", { class: "btn small", type: "button", title: "Export this group's objects as CSV", onclick: () => this.exportCsv() }, "CSV"),
        el("button", { class: "btn small", type: "button", title: "Delete this group", onclick: () => this.deleteGroup(group) }, "Delete"),
      ),
    );
    const status = el("div", { class: "tf-status" });
    this.updaters.push(() => {
      const r = this.results.get(group.id);
      status.replaceChildren(
        el("strong", {}, r?.mask === undefined ? "–" : `${r.count.toLocaleString()}${r.state === "preview" ? "~" : ""}`),
        props === undefined ? "" : `of ${props.ids.length.toLocaleString()} objects · `,
        r?.detail ?? "",
      );
    });
    box.append(status);

    // Regions.
    box.append(
      el(
        "div",
        { class: "tf-row" },
        el("h3", { class: "section-title", style: "margin:0;flex:1" }, "Regions"),
        el("button", { class: "btn outline small", type: "button", title: "A sphere at the centre of the views", onclick: () => this.addRoi("sphere") }, "+ Sphere"),
        el("button", { class: "btn outline small", type: "button", title: "A box at the centre of the views", onclick: () => this.addRoi("box") }, "+ Box"),
      ),
    );
    if (group.rois.length === 0) {
      box.append(el("p", { class: "note" }, "A region is placed at the centre of the views. Alt-drag it in a view to move it; you can also draw ellipsoids and boxes there with Neuroglancer's annotation tools."));
    }
    group.rois.forEach((roi, i) => box.append(this.roiControl(group, roi, i)));

    // Attributes and groups.
    if (props !== undefined && props.numeric.length > 0) {
      const details = el("details", { open: !isEmptyFilter(group.filter) || group.rois.length === 0 });
      details.append(el("summary", { class: "section-title" }, "Attributes"));
      for (const column of props.numeric) details.append(this.rangeControl(group, props, column));
      box.append(details);
    }
    const tags = props?.tags;
    if (props !== undefined && tags !== undefined && tags.names.length > 0) {
      const details = el("details", { open: group.filter.includeTags.length > 0 });
      details.append(el("summary", { class: "section-title" }, "Stored groups"), el("p", { class: "note" }, "Ticked: keep objects in any ticked group."));
      const all = tagCounts(props);
      const list = el("div", { class: "tf-tags" });
      const counts: HTMLElement[] = [];
      tags.names.forEach((tag, i) => {
        const tick = el("input", { type: "checkbox" }) as HTMLInputElement;
        tick.checked = group.filter.includeTags.includes(tag);
        tick.addEventListener("change", () => {
          const include = new Set(group.filter.includeTags);
          if (tick.checked) include.add(tag);
          else include.delete(tag);
          this.updateGroup(group.id, (g) => ({ ...g, filter: { ...g.filter, includeTags: [...include] } }));
          this.evaluateGroup(this.saved.groups.find((g) => g.id === group.id)!, true);
        });
        const c = el("span", { class: "count" });
        counts.push(c);
        list.append(el("label", { class: "tf-tag", title: tags.descriptions[i] || tag }, tick, el("span", {}, tag), c));
      });
      this.updaters.push(() => {
        const mask = this.results.get(group.id)?.mask;
        const passing = mask === undefined ? undefined : tagCounts(props, mask);
        counts.forEach((c, i) => {
          c.textContent = passing === undefined ? `${all[i]}` : `${passing[i]} / ${all[i]}`;
        });
      });
      details.append(list);
      box.append(details);
    }
    return box;
  }

  private roiControl(group: Group, roi: Roi, index: number): HTMLElement {
    const current = () => this.saved.groups.find((g) => g.id === group.id)?.rois.find((r) => r.id === roi.id) ?? roi;
    const op = el("select", { "aria-label": "Operator", title: "AND: must pass through. OR: through one of the OR regions. NOT: must not." }) as HTMLSelectElement;
    for (const o of ["and", "or", "not"]) op.append(el("option", { value: o }, o.toUpperCase()));
    op.value = roi.op;
    op.addEventListener("change", () => this.updateRoi(group, roi.id, { op: op.value as RoiOp }));
    const number = (label: string, get: () => number, set: (v: number) => Partial<Roi>, step: number) => {
      const input = el("input", { type: "number", step, "aria-label": label }) as HTMLInputElement;
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) this.updateRoi(group, roi.id, set(v));
      });
      this.updaters.push(() => {
        if (document.activeElement !== input) input.value = String(Math.round(get() * 100) / 100);
      });
      return el("label", {}, label, input);
    };
    const c = (k: number) => (v: number) => {
      const center = [...current().center] as [number, number, number];
      center[k] = v;
      return { center };
    };
    const fields = el(
      "div",
      { class: "tf-xyz" },
      number("x", () => current().center[0], c(0), 0.5),
      number("y", () => current().center[1], c(1), 0.5),
      number("z", () => current().center[2], c(2), 0.5),
      roi.shape === "sphere"
        ? number("radius", () => current().radius, (v) => ({ radius: Math.max(0.1, v) }), 0.5)
        : number("width", () => current().size[0], (v) => ({ size: [Math.max(0.1, v), current().size[1], current().size[2]] }), 0.5),
    );
    const extra =
      roi.shape === "box"
        ? el(
            "div",
            { class: "tf-xyz" },
            number("height", () => current().size[1], (v) => ({ size: [current().size[0], Math.max(0.1, v), current().size[2]] }), 0.5),
            number("depth", () => current().size[2], (v) => ({ size: [current().size[0], current().size[1], Math.max(0.1, v)] }), 0.5),
          )
        : null;
    const status = el("div", { class: "tf-roi-status" });
    this.updaters.push(() => {
      status.textContent = this.roiStatus.get(roi.id) ?? "";
    });
    return el(
      "div",
      { class: "tf-roi" },
      el(
        "div",
        { class: "tf-roi-head" },
        el("span", { class: "label" }, `${roi.shape === "sphere" ? "Sphere" : "Box"} ${index + 1}`),
        op,
        el("button", { class: "btn small", type: "button", title: "Move it to the centre of the views", onclick: () => this.updateRoi(group, roi.id, { center: this.viewCentre() }) }, "Here"),
        el("button", { class: "btn small", type: "button", title: "Go to it", onclick: () => this.ctx.viewer.setPosition([...current().center]) }, "Go"),
        el("button", { class: "btn small", type: "button", title: "Remove it", "aria-label": "Remove", onclick: () => this.removeRoi(group, roi.id) }, "×"),
      ),
      fields,
      extra,
      status,
    );
  }

  /** A histogram and a two-handled range for one numeric attribute of the edited group. */
  private rangeControl(group: Group, props: SegmentProperties, column: SegmentProperties["numeric"][number]): HTMLElement {
    const { id, min, max } = column;
    const step = max > min ? (max - min) / 400 : 1;
    const ranges = () => this.saved.groups.find((g) => g.id === group.id)?.filter.ranges ?? {};
    const current = (): [number, number] => ranges()[id] ?? [min, max];
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
    const live = () => {
      let a = Number(lo.value);
      let b = Number(hi.value);
      if (a > b) [a, b] = [b, a];
      describe(a, b);
      const next = { ...ranges() };
      if (a <= min && b >= max) delete next[id];
      else next[id] = [a, b];
      this.updateGroup(group.id, (g) => ({ ...g, filter: { ...g.filter, ranges: next } }), true);
      this.evaluateGroup(this.saved.groups.find((g) => g.id === group.id)!);
    };
    for (const input of [lo, hi]) input.addEventListener("input", live);
    this.updaters.push(() => {
      const mask = this.results.get(group.id)?.mask;
      const passing = mask === undefined ? undefined : histogram(column.values, min, max, BINS, mask);
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
    const groups = new TrackGroups(ctx);
    ctx.subscriptions.push(() => groups.dispose());
    ctx.ui.panel(FILTERING_PANEL, (host) => groups.render(host));
    ctx.commands.register("trackFiltering.show", () => ctx.ui.showPanel(FILTERING_PANEL));
    ctx.commands.register("trackFiltering.newGroup", () => groups.newGroup());
    ctx.commands.register("trackFiltering.addSphere", () => groups.addSphere());
    ctx.commands.register("trackFiltering.addBox", () => groups.addBox());
    ctx.commands.register("trackFiltering.exportCsv", () => groups.exportCsv());
  },
};
