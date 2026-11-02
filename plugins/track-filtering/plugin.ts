/**
 * Track filtering: TrackVis-style track groups over any dataset that is not
 * an image: a Zarr Vectors store (streamlines, skeletons, points, meshes), a
 * segmentation volume (Neuroglancer precomputed) or an annotation layer.
 *
 * A group keeps the objects (streamlines, skeletons, points, segments,
 * annotations) that pass through its regions (spheres and boxes, each AND,
 * OR or NOT) and, for Zarr Vectors, whose attributes are in range.  Each group is a layer of the dataset, in its own
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
import type { DatasetInfo, Disposer, Json, PlatformContext, PluginModule, SegmentProperties } from "@ngplatform/sdk";
import { precomputedUrl } from "@ngplatform/sdk/sources";
import { annotationGeometry, annotationMeets } from "./annotation_regions.js";
import type { NmRegion } from "./labels.js";
import { LabelsEngine } from "./labels_client.js";
import { computeMask, countPassing, emptyFilter, type FilterSpec, histogram, isEmptyFilter, passingIds, tagCounts, toCsv } from "./filter.js";
import { FILTERING_PANEL } from "./manifest.js";
import { groupMask, type Roi, type RoiOp, type RoiShape, rowIndex, rowMask } from "./roi.js";
import { type Curves, type Dimensions, previewLevel, RoiEngine, type RoiResult, type StoreInfo, toStore } from "./roi_client.js";
import { fileName, millimetres, trkBody, trkHeader, trkSpace } from "./trk.js";
import { groupFiles, mergeGroups, type StoredGroup, withGroupsListed } from "./zv_groups.js";

/**
 * What other plugins (the volume view) see of the track groups:
 * `trackFiltering.groups`.
 */
export interface TrackGroupsService {
  /** The groups of the dataset being filtered; `version` changes when a group's answer does. */
  list(): { id: string; name: string; colour: string; visible: boolean; count: number; exact: boolean; version: number }[];
  onChanged(callback: () => void): Disposer;
  /**
   * A group's streamlines, whole, in RAS millimetres: from level 0 when that
   * is at most about `maxPoints` points, else from the finest sample level
   * that is.
   */
  curves(id: string, maxPoints: number, signal?: AbortSignal): Promise<{ positions: Float32Array; offsets: Uint32Array; level: number; streamlines: number }>;
}

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

/** Points per batch when saving .trk: about 48 MB of the file in memory at a time. */
const BATCH_POINTS = 4_000_000;
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

// ------------------------------------------------------------------ files

/** A file being written in parts, in order; `writeAt` rewrites bytes already written (a header's count). */
interface SaveStream {
  write(part: ArrayBuffer): Promise<void>;
  writeAt(position: number, part: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SaveTarget {
  name: string;
  /** True when parts go straight to disk; false when they are held until a download. */
  streams: boolean;
  open(): Promise<SaveStream>;
}

interface Writable {
  write(data: ArrayBuffer | { type: "write"; position: number; data: ArrayBuffer }): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
type SavePicker = (options: unknown) => Promise<{ name: string; createWritable(): Promise<Writable> }>;

/**
 * Where a file goes: chosen in the browser's save dialog where it has one
 * (asked first, while the click still counts as the user's), written to
 * disk part by part; else a download, assembled from its parts at the end.
 * `undefined` when the dialog is cancelled.
 */
async function saveTarget(name: string, description: string, extension: string): Promise<SaveTarget | undefined> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker !== undefined) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description, accept: { "application/octet-stream": [extension] } }] });
      return {
        name: handle.name,
        streams: true,
        async open() {
          const writable = await handle.createWritable();
          return {
            write: (part) => writable.write(part),
            writeAt: (position, part) => writable.write({ type: "write", position, data: part }),
            close: () => writable.close(),
            abort: () => writable.abort(),
          };
        },
      };
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return undefined;
      // Not allowed here (a frame, a policy): download instead.
    }
  }
  return {
    name,
    streams: false,
    async open() {
      const parts: Uint8Array[] = [];
      let length = 0;
      return {
        async write(part) {
          parts.push(new Uint8Array(part));
          length += part.byteLength;
        },
        async writeAt(position, part) {
          // Only into what is held: the first part (a header) in practice.
          let start = 0;
          for (const p of parts) {
            if (position >= start && position + part.byteLength <= start + p.byteLength) {
              p.set(new Uint8Array(part), position - start);
              return;
            }
            start += p.byteLength;
          }
          throw new Error(`cannot rewrite bytes ${position}..${position + part.byteLength} of ${length}`);
        },
        async close() {
          const a = el("a", { href: URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" })), download: name });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        },
        async abort() {
          parts.length = 0;
        },
      };
    },
  };
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
.tf-group.editing { border-color: var(--select); background: var(--select-soft); }
.tf-group .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.tf-group .count { font: 11px/1 var(--mono); color: var(--muted); white-space: nowrap; }
.tf-group .count.busy { color: var(--warn); }
.tf-swatch { width: 18px; height: 18px; padding: 0; border: 1px solid var(--line-strong); border-radius: 0; background: none; cursor: pointer; }
.tf-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.tf-swatch::-webkit-color-swatch { border: 0; border-radius: 0; }
.tf-swatch::-moz-color-swatch { border: 0; border-radius: 0; }
.tf-editor { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
.tf-name { font: 600 14px/1.3 var(--ui); background: transparent; border: 1px solid transparent; border-radius: 0; color: var(--text); padding: 2px 4px; min-width: 0; flex: 1; }
.tf-name:hover, .tf-name:focus { border-color: var(--line); background: var(--ink-0); }
.tf-status { font-size: 12px; color: var(--muted); }
.tf-save { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tf-save select { height: 24px; border-radius: 0; border: 1px solid var(--line); background: var(--ink-0); color: var(--text); font: 12px/1 var(--ui); max-width: 210px; }
.tf-save-status { font: 11px/1.3 var(--mono); color: var(--faint); flex-basis: 100%; }
.tf-status strong { color: var(--text); font: 600 16px/1 var(--mono); margin-right: 4px; }
.tf-roi { border: 1px solid var(--line); border-radius: var(--r); padding: 6px 8px; display: grid; gap: 5px; }
.tf-roi-head { display: flex; align-items: center; gap: 6px; }
.tf-roi-head .label { font-weight: 500; flex: 1; }
.tf-roi select { height: 24px; border-radius: 0; border: 1px solid var(--line); background: var(--ink-0); color: var(--text); font: 600 11px/1 var(--mono); }
.tf-xyz { display: grid; gap: 2px; }
.tf-field { display: grid; grid-template-columns: 44px minmax(0, 1fr) 72px; align-items: center; gap: 6px; }
.tf-field > span { font-size: 10px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.06em; }
.tf-field input[type="range"] { width: 100%; margin: 0; accent-color: var(--accent); }
.tf-field input[type="number"] { width: 100%; box-sizing: border-box; height: 22px; border: 1px solid var(--line); border-radius: 0; background: var(--ink-0); color: var(--text); font: 12px/1 var(--mono); padding: 0 4px; }
.tf-roi-status { font: 11px/1.3 var(--mono); color: var(--faint); }
.tf-prop { border: 1px solid var(--line); border-radius: var(--r); padding: 8px; display: grid; gap: 4px; }
.tf-prop.filtered { border-color: #8a8a8a; }
.tf-prop-head { display: flex; align-items: baseline; gap: 6px; }
.tf-prop-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tf-range { margin-left: auto; font: 11px/1 var(--mono); color: var(--muted); white-space: nowrap; }
.tf-hist { width: 100%; height: 34px; display: block; }
.tf-hist .all { fill: var(--ink-4); }
.tf-hist .pass { fill: var(--accent); }
.tf-sliders { position: relative; height: 18px; }
.tf-sliders input { position: absolute; inset: 0; width: 100%; margin: 0; pointer-events: none; background: none; -webkit-appearance: none; appearance: none; height: 18px; }
.tf-sliders input::-webkit-slider-thumb { pointer-events: all; -webkit-appearance: none; width: 12px; height: 16px; border-radius: 0; background: var(--accent); cursor: ew-resize; }
.tf-sliders input::-moz-range-thumb { pointer-events: all; width: 12px; height: 16px; border-radius: 0; background: var(--accent); border: 0; cursor: ew-resize; }
.tf-sliders::before { content: ""; position: absolute; left: 0; right: 0; top: 8px; height: 2px; background: var(--line); }
.tf details > summary { cursor: pointer; list-style: none; }
.tf details > summary::-webkit-details-marker { display: none; }
.tf details[open] > summary { margin-bottom: 8px; }
.tf-tags { display: grid; gap: 2px; max-height: 220px; overflow: auto; }
.tf-tag { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 0; }
.tf-tag:hover { background: var(--ink-3); }
.tf-tag input { margin: 0; accent-color: var(--accent); }
.tf-tag .count { font: 11px/1 var(--mono); color: var(--muted); }
`;

// --------------------------------------------------------------- results

interface GroupResult {
  mask: Uint8Array | undefined;
  /** The passing objects, for datasets whose objects are not rows of segment properties (segments, annotations). */
  ids?: string[];
  count: number;
  /** "exact": level 0; "preview": a coarse level's sample; "computing", "empty", "error". */
  state: "exact" | "preview" | "computing" | "empty" | "error" | "waiting";
  detail: string;
}

// ------------------------------------------------------------ controller

/** What a dataset is to filtering. */
type Kind = "zarr-vectors" | "segmentation" | "annotations" | "precomputed-annotations";

/** Combines regions' answers: every AND, at least one OR (when there are any), no NOT. */
export function combineIds(results: { op: RoiOp; ids: string[] }[]): string[] {
  const ands = results.filter((r) => r.op === "and");
  const ors = results.filter((r) => r.op === "or");
  const nots = new Set(results.filter((r) => r.op === "not").flatMap((r) => r.ids));
  let keep: Set<string> | undefined;
  for (const r of ands) keep = keep === undefined ? new Set(r.ids) : new Set(r.ids.filter((id) => keep!.has(id)));
  if (ors.length > 0) {
    const any = new Set(ors.flatMap((r) => r.ids));
    keep = keep === undefined ? any : new Set([...keep].filter((id) => any.has(id)));
  }
  return [...(keep ?? [])].filter((id) => !nots.has(id));
}

class TrackGroups {
  private saved: Saved;
  private props: SegmentProperties | undefined;
  private rowOf: ((id: bigint) => number | undefined) | undefined;
  private engine: RoiEngine | undefined;
  private engineUrl: string | undefined;
  /** For a segmentation: the region tests on its volume. */
  private labels: LabelsEngine | undefined;
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
  /** Bumped when a group's answer changes, for the service's listeners. */
  private versions = new Map<string, number>();
  private serviceListeners = new Set<() => void>();
  private notifyQueued = false;
  /**
   * Groups' streamlines read so far (store coordinates), by group, answer
   * and level: what the volume view draws and a .trk save writes are one
   * read.  A read stops early only when everyone waiting on it has given up.
   */
  private curveCache = new Map<string, { promise: Promise<Curves>; controller: AbortController; waiting: number; progress: Set<(done: number, total: number) => void> }>();
  /** The .trk save in progress, if any. */
  private saving: { groupId: string; done: number; total: number; controller: AbortController } | undefined;
  /** Level saved from: 0 is every streamline. */
  private trkLevel = 0;
  /** What the last save of each group did. */
  private saved_ = new Map<string, string>();
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
        const saved = readSaved(ctx.state.get());
        // Undoing something else hands back the same groups: keep their answers.
        if (JSON.stringify(saved) === JSON.stringify(this.saved)) return;
        this.saved = saved;
        this.evaluateAll();
        this.refresh();
      }),
      ctx.workspace.onChanged(() => this.refresh()),
      ctx.viewer.onLayersChanged(() => this.notify()),
      ctx.viewer.onStateChanged(() => {
        this.readAnnotations();
        // An annotation dataset's groups follow its annotations as they are drawn.
        if (this.kind() !== "annotations") return;
        const now = JSON.stringify(this.baseAnnotations());
        if (now === this.annotationsSeen) return;
        this.annotationsSeen = now;
        this.evaluateAll();
      }),
    );
    this.refresh();
  }

  private annotationsSeen = "";
  /** For precomputed annotations: each group's passing annotations (id, type, points in the source's units, nm per unit). */
  private passingAnnotations = new Map<string, [string, { type: string; points: number[][]; nm: number[] }][]>();

  dispose(): void {
    this.offs.forEach((off) => off());
    this.propsOff?.();
    for (const off of this.layerWatches.values()) off();
    for (const t of this.exactTimers.values()) clearTimeout(t);
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.engine?.dispose();
    this.labels?.dispose();
  }

  // ------------------------------------------------------------ saving

  /** Saves now: one undo step. */
  private save(patch: Partial<Saved> = {}): void {
    this.saved = { ...this.saved, ...patch };
    this.notify();
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

  /** The scene's datasets that can be filtered: Zarr Vectors, segmentation volumes and annotation layers. */
  private candidates() {
    const entries = this.ctx.workspace.sceneDatasets();
    return entries.filter((d) => this.kindOf(d, entries) !== undefined);
  }

  /**
   * What a dataset is to filtering; undefined for images and what it cannot
   * test.  `entries`: the scene's datasets, when the caller has them (each
   * lookup serializes the viewer's state).
   */
  private kindOf(dataset: DatasetInfo, entries = this.ctx.workspace.sceneDatasets()): Kind | undefined {
    const entry = entries.find((d) => d.id === dataset.id);
    const layers = entry?.layers ?? [];
    if (layers.some((l) => l.sources.some((s) => storeUrlOfSource(s) !== undefined))) return "zarr-vectors";
    const groups = this.groupLayers();
    const own = layers.filter((l) => !groups.has(l.name) && l.name !== this.roiLayerName(dataset));
    if (own.some((l) => l.type === "segmentation" && l.sources.some((s) => precomputedUrl(s) !== undefined))) return "segmentation";
    if (own.some((l) => l.type === "annotation" && l.sources.some((s) => /^local:\/\/annotations/.test(s)))) return "annotations";
    if (own.some((l) => l.type === "annotation" && l.sources.some((s) => precomputedUrl(s) !== undefined))) return "precomputed-annotations";
    return undefined;
  }

  /** The kind of the dataset being filtered, as of the last refresh (the workspace's last change). */
  private kind(): Kind | undefined {
    return this.currentKind;
  }

  private currentKind: Kind | undefined;

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
    this.currentKind = dataset && this.kindOf(dataset);
    const base = dataset && this.baseLayers(dataset)[0];
    if (base !== this.watching) {
      this.propsOff?.();
      this.watching = base;
      this.propsOff = base === undefined ? undefined : this.ctx.viewer.onSegmentPropertiesChanged(base, () => this.loadProps());
      this.loadProps();
    }
    const source = dataset && this.sourceOf(dataset);
    const kind = this.currentKind;
    const url =
      source &&
      (kind === "zarr-vectors"
        ? storeUrlOfSource(source)
        : kind === "segmentation" || kind === "precomputed-annotations"
          ? precomputedUrl(source)
          : kind === "annotations"
            ? `annotations:${dataset!.id}`
            : undefined);
    if (url !== this.engineUrl) {
      this.engine?.dispose();
      this.engine = undefined;
      this.labels?.dispose();
      this.labels = undefined;
      this.info = undefined;
      this.engineUrl = url;
      if (url !== undefined && (kind === "segmentation" || kind === "precomputed-annotations")) {
        this.labels = new LabelsEngine(url);
        this.evaluateAll();
      } else if (url !== undefined && kind === "annotations") {
        this.evaluateAll();
      } else if (url !== undefined) {
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
    const dataset = this.dataset();
    this.save({ groups: [...this.saved.groups, group], editing: group.id, dataset: dataset?.id });
    this.ensureLayer(group);
    // Show all objects is off once there are groups: the groups are the view.
    if (n === 0 && dataset !== undefined) for (const base of this.baseLayers(dataset)) this.ctx.viewer.setLayerVisible(base, false);
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
    const kind = this.kindOf(dataset);
    this.creating.add(group.id);
    let layer: string;
    try {
      const spec: Json =
        kind === "annotations" || kind === "precomputed-annotations"
          ? { name: group.name, type: "annotation", source: "local://annotations", annotations: [], annotationColor: group.colour }
          : kind === "segmentation"
            ? { name: group.name, type: "segmentation", source: url, ignoreNullVisibleSet: false, segmentDefaultColor: group.colour }
            : {
                name: group.name,
                type: "segmentation",
                source: { url, subsources: { objects: false, meshes: false } },
                notSelectedAlpha: 0,
                ignoreNullVisibleSet: false,
                segmentDefaultColor: group.colour,
              };
      layer = this.ctx.workspace.addLayer(dataset.id, spec);
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
    // A fifth of a level-0 chunk, in global units: 5–6 mm on a typical
    // tractogram.  Without a store (a segmentation, annotations): about 40
    // screen pixels of the sections.
    const info = this.info;
    const dims = this.dims();
    const scale = Number((this.ctx.viewer.getState() as { crossSectionScale?: number }).crossSectionScale);
    let size = Number.isFinite(scale) && scale > 0 ? Number((scale * 40).toPrecision(2)) : 5;
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
    const kind = this.kind();
    if (kind === "segmentation" || kind === "annotations" || kind === "precomputed-annotations") return this.evaluateOther(group, kind);
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

  /** A region in nanometres, from the viewer's coordinates. */
  private toNm(roi: Roi, nm: [number, number, number]): NmRegion {
    return {
      shape: roi.shape,
      center: [0, 1, 2].map((k) => roi.center[k] * nm[k]) as [number, number, number],
      radius: roi.radius * nm[0],
      size: [0, 1, 2].map((k) => roi.size[k] * nm[k]) as [number, number, number],
    };
  }

  /** Each global axis's size in nanometres; undefined unless x, y and z are in metres. */
  private nmPerUnit(): [number, number, number] | undefined {
    const dims = this.dims();
    const axes = ["x", "y", "z"].map((name) => dims?.[name]);
    if (axes.some((a) => a === undefined || a[1] !== "m")) return undefined;
    return axes.map((a) => a![0] * 1e9) as [number, number, number];
  }

  /** The base annotation layer's annotations, for an annotation dataset. */
  private baseAnnotations(): Json[] {
    const dataset = this.dataset();
    const base = dataset && this.baseLayers(dataset).find((name) => this.layerInfo(name)?.type === "annotation");
    const spec = base === undefined ? undefined : this.ctx.viewer.layerSpec(base);
    return Array.isArray(spec?.annotations) ? (spec!.annotations as Json[]) : [];
  }

  /** A group of a segmentation's segments or of annotations: each region's objects, combined. */
  private evaluateOther(group: Group, kind: "segmentation" | "annotations" | "precomputed-annotations"): void {
    const token = (this.tokens.get(group.id) ?? 0) + 1;
    this.tokens.set(group.id, token);
    const current = () => this.tokens.get(group.id) === token;
    const nm = this.nmPerUnit();
    if (group.rois.length === 0) {
      this.setResult(group, { mask: undefined, ids: [], count: 0, state: "empty", detail: "Add a region to choose objects." });
      return;
    }
    if (nm === undefined) {
      this.waiting = true;
      this.setResult(group, { mask: undefined, count: 0, state: "waiting", detail: "Waiting for the view's x, y and z…" });
      return;
    }
    const regions = group.rois.map((r) => this.toNm(r, nm));
    if (kind === "annotations") {
      const geometry = annotationGeometry(this.baseAnnotations(), nm);
      const ids = combineIds(regions.map((region, i) => ({ op: group.rois[i].op, ids: geometry.filter((a) => annotationMeets(region, a)).map((a) => a.id) })));
      this.setResult(group, { mask: undefined, ids, count: ids.length, state: "exact", detail: `of ${geometry.length.toLocaleString()} annotations` });
      return;
    }
    const labels = this.labels;
    if (labels === undefined) {
      this.waiting = true;
      this.setResult(group, { mask: undefined, count: 0, state: "waiting", detail: "Opening the segmentation…" });
      return;
    }
    const prior = this.results.get(group.id);
    this.setResult(group, { ...(prior ?? { mask: undefined, count: 0 }), state: "computing", detail: kind === "segmentation" ? "Reading the regions' voxels…" : "Reading the regions' annotations…" });
    if (kind === "precomputed-annotations") {
      void Promise.all(regions.map((region) => labels.annotations(region))).then(
        (results) => {
          if (!current()) return;
          const ids = combineIds(results.map((r, i) => ({ op: group.rois[i].op, ids: r.ids })));
          // The passing annotations themselves, for the group's own layer.
          const keep = new Set(ids);
          const shown = new Map<string, { type: string; points: number[][]; nm: number[] }>();
          for (const r of results) r.ids.forEach((id, k) => keep.has(id) && shown.set(id, { type: r.annotationType, points: r.points[k], nm: r.nm }));
          this.passingAnnotations.set(group.id, [...shown.entries()]);
          results.forEach((r, i) => this.roiStatus.set(group.rois[i].id, `${r.ids.length.toLocaleString()} annotations · ${r.chunks} chunks · ${(r.ms / 1000).toFixed(r.ms < 1000 ? 2 : 1)} s`));
          this.setResult(group, { mask: undefined, ids, count: ids.length, state: "exact", detail: "annotations meeting the regions" });
        },
        (e) => {
          if (current()) this.setResult(group, { mask: undefined, count: 0, state: "error", detail: (e as Error).message });
        },
      );
      return;
    }
    const old = this.exactTimers.get(group.id);
    if (old !== undefined) clearTimeout(old);
    this.exactTimers.set(
      group.id,
      setTimeout(() => {
        this.exactTimers.delete(group.id);
        if (!current()) return;
        void Promise.all(regions.map((region) => labels.evaluate(region))).then(
          (results) => {
            if (!current()) return;
            const ids = combineIds(results.map((r, i) => ({ op: group.rois[i].op, ids: Array.from(r.ids, String) })));
            results.forEach((r, i) => this.roiStatus.set(group.rois[i].id, `${r.ids.length.toLocaleString()} segments · ${r.level} · ${r.chunks} chunk${r.chunks === 1 ? "" : "s"} · ${(r.ms / 1000).toFixed(r.ms < 1000 ? 2 : 1)} s`));
            const levels = [...new Set(results.map((r) => r.level))].join(", ");
            this.setResult(group, { mask: undefined, ids, count: ids.length, state: "exact", detail: `segments with a voxel in the regions (at ${levels})` });
          },
          (e) => {
            if (current()) this.setResult(group, { mask: undefined, count: 0, state: "error", detail: (e as Error).message });
          },
        );
      }, EXACT_DELAY_MS),
    );
  }

  private setResult(group: Group, result: GroupResult): void {
    this.results.set(group.id, result);
    this.versions.set(group.id, (this.versions.get(group.id) ?? 0) + 1);
    this.notify();
    this.show(group);
    for (const update of this.updaters) update();
  }

  /** Shows a group's answer in its layer. */
  private show(group: Group): void {
    const result = this.results.get(group.id);
    const layer = this.saved.groups.find((g) => g.id === group.id)?.layer;
    if (layer === undefined || result === undefined) return;
    if (result.ids !== undefined) {
      const kind = this.kind();
      if (kind === "precomputed-annotations") {
        // Copies in the viewer's coordinates, in a layer of the group's own.
        const nmPer = this.nmPerUnit();
        if (nmPer === undefined) return;
        const at = (p: number[], nm: number[]) => p.map((v, k) => (v * nm[k]) / nmPer[k]);
        const annotations = (this.passingAnnotations.get(group.id) ?? []).map(([id, a]) =>
          a.type === "point"
            ? { type: "point", id, point: at(a.points[0], a.nm) }
            : a.type === "ellipsoid"
              ? { type: "ellipsoid", id, center: at(a.points[0], a.nm), radii: at(a.points[1], a.nm) }
              : { type: a.type, id, pointA: at(a.points[0], a.nm), pointB: at(a.points[1], a.nm) },
        );
        this.ctx.viewer.patchState((ng) => {
          const target = (ng.layers as Json[] | undefined)?.find((l) => l.name === layer);
          if (target !== undefined) target.annotations = annotations;
        });
        return;
      }
      if (kind === "annotations") {
        // The group's layer holds copies of the passing annotations.
        const passing = new Set(result.ids);
        const annotations = this.baseAnnotations().filter((a) => passing.has(String(a.id)));
        const spec = this.ctx.viewer.layerSpec(layer);
        if (JSON.stringify(spec?.annotations ?? []) === JSON.stringify(annotations)) return;
        this.ctx.viewer.patchState((ng) => {
          const target = (ng.layers as Json[] | undefined)?.find((l) => l.name === layer);
          if (target !== undefined) target.annotations = annotations;
        });
      } else {
        this.ctx.viewer.setTemporaryVisibleSegments(layer, BigUint64Array.from(result.ids, (id) => BigInt(id)));
      }
      return;
    }
    if (result.mask === undefined || this.props === undefined) return;
    this.ctx.viewer.setTemporaryVisibleSegments(layer, passingIds(this.props, result.mask));
  }

  exportCsv(): void {
    const group = this.editing();
    const ids = group && this.results.get(group.id)?.ids;
    if (group !== undefined && ids !== undefined) {
      const blob = new Blob([["id", ...ids].join("\n") + "\n"], { type: "text/csv" });
      const a = el("a", { href: URL.createObjectURL(blob), download: `${group.name}.csv` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this.ctx.log.info(`Exported ${ids.length.toLocaleString()} ids of ${group.name} as CSV.`);
      return;
    }
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

  /**
   * Saves a group's streamlines as a .trk file: every one of them, whole,
   * from `level` (0 for all; a coarser level keeps a sample).  The worker
   * reads each chunk the group passes through once, reusing what it holds.
   */
  async saveTrk(group = this.editing(), level = this.trkLevel): Promise<void> {
    const dataset = this.dataset();
    const result = group && this.results.get(group.id);
    const { props, engine, info } = this;
    if (group === undefined || dataset === undefined || result?.mask === undefined || props === undefined || engine === undefined || info === undefined) {
      this.ctx.ui.toast("No group with streamlines to save.", "error");
      return;
    }
    if (this.saving !== undefined) {
      this.ctx.ui.toast("A save is already running.", "error");
      return;
    }
    if (result.state !== "exact") {
      this.ctx.ui.toast("The group's exact answer is still being worked out; save once it is.", "error");
      return;
    }
    const ids = passingIds(props, result.mask);
    if (ids.length === 0) {
      this.ctx.ui.toast(`${group.name} has no streamlines to save.`, "error");
      return;
    }
    const target = await saveTarget(fileName(`${dataset.name} ${group.name}${level > 0 ? ` level ${level}` : ""}`, ".trk"), "TrackVis tracks", ".trk");
    if (target === undefined) return;
    const controller = new AbortController();
    const saving = { groupId: group.id, done: 0, total: 0, controller };
    this.saving = saving;
    this.updateAll();
    const started = performance.now();
    const space = trkSpace(info);
    // Batches of about 4 M points (48 MB of the file) at a time, written as
    // they come, so memory stays the same whatever the group's size.  The
    // header's streamline count is written last.
    const total = info.levels[level]?.vertexCount ?? info.levels[0].vertexCount ?? 0;
    const perObject = total / Math.max(1, props.ids.length);
    const batch = Math.max(1, Math.floor(BATCH_POINTS / Math.max(1, perObject)));
    let stream: Awaited<ReturnType<SaveTarget["open"]>> | undefined;
    try {
      stream = await target.open();
      await stream.write(trkHeader(space, 0));
      let tracks = 0;
      let points = 0;
      let bytes = 1000;
      for (let from = 0; from < ids.length; from += batch) {
        controller.signal.throwIfAborted();
        const part = ids.subarray(from, Math.min(ids.length, from + batch));
        const progress = (done: number, chunks: number) => {
          saving.done = from + Math.round((done / Math.max(1, chunks)) * part.length);
          saving.total = ids.length;
          this.updateAll();
        };
        const curves =
          part.length === ids.length
            ? await this.readCurves(group.id, ids, level, progress, controller.signal)
            : await engine.curves(part, level, progress, controller.signal);
        const body = trkBody(curves, space);
        await stream.write(body);
        tracks += curves.offsets.length - 1;
        points += curves.positions.length / 3;
        bytes += body.byteLength;
      }
      const count = new ArrayBuffer(4);
      new DataView(count).setInt32(0, tracks, true);
      await stream.writeAt(988, count);
      await stream.close();
      stream = undefined;
      const seconds = (performance.now() - started) / 1000;
      const message =
        `Saved ${tracks.toLocaleString()} streamlines (${points.toLocaleString()} points, ` +
        `${(bytes / 2 ** 20).toFixed(1)} MB) to ${target.name} in ${seconds.toFixed(1)} s.`;
      this.saved_.set(group.id, message);
      this.ctx.log.info(`${group.name}: ${message}`);
    } catch (e) {
      await stream?.abort().catch(() => {});
      if (controller.signal.aborted) {
        this.saved_.set(group.id, "Save cancelled.");
      } else {
        this.saved_.set(group.id, `Save failed: ${(e as Error).message}`);
        this.ctx.ui.toast(`Could not save ${group.name}: ${(e as Error).message}`, "error");
      }
    } finally {
      this.saving = undefined;
      this.updateAll();
    }
  }

  private updateAll(): void {
    for (const update of this.updaters) update();
  }

  /** The dataset's store, when it is on this computer: where groups can be written. */
  private localStore(): { url: string; writable: boolean } | undefined {
    const dataset = this.dataset();
    const source = dataset && this.sourceOf(dataset);
    const url = source && storeUrlOfSource(source);
    if (url === undefined) return undefined;
    const at = this.ctx.workspace.local.locate(url);
    return at === undefined ? undefined : { url, writable: at.writable };
  }

  /**
   * Writes the groups into the dataset's own store (level 0's `groups`), so
   * the store carries them: other tools, and the viewer (as segment tags),
   * see them.  A stored group with the same name is replaced; others stay.
   */
  async saveGroupsToStore(): Promise<void> {
    const local = this.localStore();
    const { engine, props } = this;
    if (local === undefined || !local.writable) {
      this.ctx.ui.toast("Groups are written only into a local zarr-vectors folder (Chrome or Edge).", "error");
      return;
    }
    if (engine === undefined || props === undefined) {
      this.ctx.ui.toast("The dataset is still opening.", "error");
      return;
    }
    const groups = this.saved.groups.filter((g) => this.results.get(g.id)?.state === "exact");
    if (groups.length === 0) {
      this.ctx.ui.toast("No group has its exact answer yet.", "error");
      return;
    }
    try {
      const stored = await engine.groups(0);
      const mine: StoredGroup[] = [];
      let missing = 0;
      for (const group of groups) {
        const ids = passingIds(props, this.results.get(group.id)!.mask!);
        const mapped = await engine.objectIds(ids, 0);
        missing += mapped.missing;
        mine.push({ name: group.name, members: mapped.objectIds });
      }
      const merged = mergeGroups(
        stored.names.map((name, i) => ({ name, members: stored.members[i] })),
        mine,
      );
      const level = `${local.url}${stored.levelPath}/`;
      for (const [path, bytes] of groupFiles(merged)) await this.ctx.workspace.local.write(level + path, bytes);
      const levelJson = await (await fetch(`${level}zarr.json`, { cache: "no-store" })).text();
      await this.ctx.workspace.local.write(`${level}zarr.json`, withGroupsListed(levelJson));
      const message = `Wrote ${mine.length} group${mine.length === 1 ? "" : "s"} into ${stored.levelPath}/groups (${merged.length} in the store)${missing ? `; ${missing} objects had no object id and were left out` : ""}.`;
      this.ctx.log.info(message);
      this.ctx.ui.toast(message);
      await this.ctx.commands.invoke("view.reloadLayers");
    } catch (e) {
      this.ctx.ui.toast(`Could not write the groups: ${(e as Error).message}`, "error");
    }
  }

  // ----------------------------------------------------------- service

  /** Tells the service's listeners, once per turn however many changes. */
  private notify(): void {
    if (this.notifyQueued || this.serviceListeners.size === 0) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of [...this.serviceListeners]) listener();
    });
  }

  service(): TrackGroupsService {
    return {
      list: () =>
        this.saved.groups.map((g) => {
          const r = this.results.get(g.id);
          return {
            id: g.id,
            name: g.name,
            colour: g.colour,
            visible: this.layerInfo(g.layer)?.visible === true,
            count: r?.count ?? 0,
            exact: r?.state === "exact",
            version: this.versions.get(g.id) ?? 0,
          };
        }),
      onChanged: (callback) => {
        this.serviceListeners.add(callback);
        return () => this.serviceListeners.delete(callback);
      },
      curves: (id, maxPoints, signal) => this.groupCurves(id, maxPoints, signal),
    };
  }

  private groupCurves(id: string, maxPoints: number, signal?: AbortSignal) {
    const { props, engine, info } = this;
    const mask = this.results.get(id)?.mask;
    if (props === undefined || engine === undefined || info === undefined || mask === undefined) return Promise.reject(new Error("the group has no answer yet"));
    const ids = passingIds(props, mask);
    // Points at a level: its share of the streamlines, at the store's mean length.
    const total = info.levels[0].vertexCount ?? 0;
    const perObject = total / Math.max(1, props.ids.length);
    const estimate = (l: StoreInfo["levels"][number]) => ids.length * perObject * ((l.vertexCount ?? total) / Math.max(1, total));
    const level = info.levels.find((l) => estimate(l) <= maxPoints)?.index ?? info.levels[info.levels.length - 1].index;
    const scale = millimetres(info);
    const offset = info.coordinateOffset ?? [0, 0, 0];
    return this.readCurves(id, ids, level, undefined, signal).then((c) => {
      const positions = new Float32Array(c.positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; ++k) positions[i + k] = (c.positions[i + k] + (offset[k] ?? 0)) * scale[k];
      }
      return { positions, offsets: c.offsets, level, streamlines: c.ids.length };
    });
  }

  /** A group's streamlines at a level, read once and shared (see `curveCache`). */
  private readCurves(id: string, ids: BigUint64Array, level: number, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Curves> {
    const engine = this.engine!;
    const key = `${id}|${this.versions.get(id) ?? 0}|${level}|${ids.length}`;
    let entry = this.curveCache.get(key);
    if (entry === undefined) {
      const controller = new AbortController();
      const listeners = new Set<(done: number, total: number) => void>();
      const promise = engine.curves(ids, level, (done, total) => listeners.forEach((l) => l(done, total)), controller.signal);
      entry = { promise, controller, waiting: 0, progress: listeners };
      const created = entry;
      promise.catch(() => {
        if (this.curveCache.get(key) === created) this.curveCache.delete(key);
      });
      this.curveCache.set(key, entry);
      // A few groups' worth; the oldest go first.
      for (const [old, e] of this.curveCache) {
        if (this.curveCache.size <= 6) break;
        if (old !== key && e.waiting === 0) this.curveCache.delete(old);
      }
    }
    const shared = entry;
    shared.waiting++;
    if (progress) shared.progress.add(progress);
    return new Promise<Curves>((resolve, reject) => {
      let settled = false;
      const leave = () => {
        if (settled) return;
        settled = true;
        shared.waiting--;
        if (progress) shared.progress.delete(progress);
      };
      signal?.addEventListener("abort", () => {
        leave();
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        // Nobody else wants it: stop reading.
        if (shared.waiting === 0) {
          shared.controller.abort();
          this.curveCache.delete(key);
        }
      });
      shared.promise.then(
        (c) => {
          leave();
          resolve(c);
        },
        (e) => {
          leave();
          reject(e);
        },
      );
    });
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
        el("p", { class: "tf-intro" }, "Groups keep the objects that pass through regions: tracts, points, segments or annotations. Each group is a layer."),
        el("p", { class: "empty" }, el("strong", {}, "Nothing to filter in this scene. "), "Add tracts, a segmentation or annotations in Datasets."),
      );
      return;
    }

    // Dataset.
    const select = el("select", { class: "text-input", "aria-label": "Dataset" }) as HTMLSelectElement;
    for (const d of this.candidates()) select.append(el("option", { value: d.id }, d.name));
    select.value = dataset.id;
    select.addEventListener("change", () => this.save({ dataset: select.value }));
    root.append(el("label", { class: "field" }, el("span", {}, "Dataset"), select));
    const bases = this.baseLayers(dataset);
    if (bases.length > 0) {
      const all = el("input", { type: "checkbox" }) as HTMLInputElement;
      all.addEventListener("change", () => bases.forEach((b) => this.ctx.viewer.setLayerVisible(b, all.checked)));
      this.updaters.push(() => {
        all.checked = bases.some((b) => this.layerInfo(b)?.visible);
      });
      root.append(el("label", { class: "field check" }, all, el("span", {}, "Show all objects")));
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
    const local = this.localStore();
    if (local !== undefined) {
      root.append(
        el(
          "div",
          { class: "tf-row" },
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              disabled: !local.writable,
              title: local.writable ? "Write the groups into this store's groups (level 0)" : "This browser cannot write into folders: use Chrome or Edge",
              onclick: () => void this.saveGroupsToStore(),
            },
            "Save groups into the store",
          ),
          el("span", { class: "tf-roi-status" }, "on this computer"),
        ),
      );
    }
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
        count.textContent = r === undefined || (r.mask === undefined && r.ids === undefined) ? "…" : `${r.count.toLocaleString()}${r.state === "preview" ? "~" : ""}`;
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

  /** Save as .trk: the level to save from, progress, and cancel. */
  private saveControl(group: Group): HTMLElement {
    const info = this.info;
    const button = el("button", { class: "btn small", type: "button", onclick: () => void this.saveTrk(group) }, "Save .trk") as HTMLButtonElement;
    const cancel = el("button", { class: "btn outline small", type: "button", onclick: () => this.saving?.controller.abort() }, "Cancel") as HTMLButtonElement;
    const level = el("select", { "aria-label": "Streamlines to save" }) as HTMLSelectElement;
    const total = info?.levels[0]?.vertexCount;
    for (const l of info?.levels ?? [{ index: 0, vertexCount: undefined, chunkShape: [] }]) {
      const share = l.index === 0 || total === undefined || l.vertexCount === undefined ? undefined : (100 * l.vertexCount) / total;
      const label = l.index === 0 ? "All streamlines" : `Level ${l.index} sample${share === undefined ? "" : ` (about ${share >= 1 ? Math.round(share) : Number(share.toPrecision(1))}%)`}`;
      level.append(el("option", { value: String(l.index) }, label));
    }
    level.value = String(this.trkLevel);
    level.addEventListener("change", () => (this.trkLevel = Number(level.value)));
    const note = el("div", { class: "tf-save-status" });
    this.updaters.push(() => {
      const r = this.results.get(group.id);
      const busy = this.saving !== undefined;
      const mine = this.saving?.groupId === group.id;
      button.disabled = busy || r?.state !== "exact" || r.count === 0;
      button.title = r?.state === "exact" ? "Save this group's streamlines, whole, as a TrackVis .trk file" : "Available once the group's exact answer is in";
      level.disabled = busy;
      cancel.hidden = !mine;
      if (mine) {
        const s = this.saving!;
        note.textContent = s.total === 0 ? "Reading the group's manifests…" : `Writing streamlines: ${s.done.toLocaleString()} of ${s.total.toLocaleString()}`;
      } else {
        note.textContent = this.saved_.get(group.id) ?? "";
      }
      note.hidden = note.textContent === "";
    });
    return el("div", { class: "tf-save" }, button, level, cancel, note);
  }

  private editor(group: Group): HTMLElement {
    const kind = this.kind();
    // Attributes are Zarr Vectors' object columns.
    const props = kind === "zarr-vectors" ? this.props : undefined;
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
        el("strong", {}, r?.mask === undefined && r?.ids === undefined ? "–" : `${r!.count.toLocaleString()}${r!.state === "preview" ? "~" : ""}`),
        props === undefined ? "" : `of ${props.ids.length.toLocaleString()} objects · `,
        r?.detail ?? "",
      );
    });
    box.append(status);
    if (kind === "zarr-vectors") box.append(this.saveControl(group));

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
      box.append(el("p", { class: "note" }, "A region starts at the centre of the views; Alt-drag it to move it."));
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
    // Each value: a slider that moves the region as it is dragged, and a
    // box to type it (Enter, or Set, applies what is typed).
    const typed: (() => void)[] = [];
    const number = (label: string, get: () => number, set: (v: number) => Partial<Roi>, step: number, bounds: () => [number, number]) => {
      const slider = el("input", { type: "range", step, "aria-label": `${label} (slider)` }) as HTMLInputElement;
      const input = el("input", { type: "number", step, "aria-label": label }) as HTMLInputElement;
      const fit = () => {
        const [lo, hi] = bounds();
        const v = get();
        slider.min = String(Math.min(lo, v));
        slider.max = String(Math.max(hi, v));
      };
      slider.addEventListener("pointerdown", fit);
      slider.addEventListener("input", () => {
        const v = Number(slider.value);
        input.value = String(Math.round(v * 100) / 100);
        this.updateRoi(group, roi.id, set(v), true);
      });
      const apply = () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v !== get()) this.updateRoi(group, roi.id, set(v));
      };
      typed.push(apply);
      input.addEventListener("change", apply);
      this.updaters.push(() => {
        if (document.activeElement !== input) input.value = String(Math.round(get() * 100) / 100);
        if (document.activeElement !== slider) {
          fit();
          slider.value = String(get());
        }
      });
      return el("label", { class: "tf-field" }, el("span", {}, label), slider, input);
    };
    // The dataset's extent, in the view's coordinates, for the sliders.
    const extent = (k: number): [number, number] => {
      const info = this.info;
      const dims = this.dims();
      const name = info?.axisNames[k];
      if (info === undefined || dims === undefined || name === undefined) return [current().center[k] - 100, current().center[k] + 100];
      const global = dims[name]?.[0];
      const factor = global !== undefined && info.axisScales[k] > 0 ? global / info.axisScales[k] : 1;
      const offset = info.coordinateOffset?.[k] ?? 0;
      const a = (info.bounds.lower[k] + offset) / factor;
      const b = (info.bounds.upper[k] + offset) / factor;
      return [Math.min(a, b), Math.max(a, b)];
    };
    const span = (): [number, number] => [0.1, Math.max(...[0, 1, 2].map((k) => extent(k)[1] - extent(k)[0])) / 2];
    const c = (k: number) => (v: number) => {
      const center = [...current().center] as [number, number, number];
      center[k] = v;
      return { center };
    };
    const fields = el(
      "div",
      { class: "tf-xyz" },
      number("x", () => current().center[0], c(0), 0.5, () => extent(0)),
      number("y", () => current().center[1], c(1), 0.5, () => extent(1)),
      number("z", () => current().center[2], c(2), 0.5, () => extent(2)),
      roi.shape === "sphere"
        ? number("radius", () => current().radius, (v) => ({ radius: Math.max(0.1, v) }), 0.5, span)
        : number("width", () => current().size[0], (v) => ({ size: [Math.max(0.1, v), current().size[1], current().size[2]] }), 0.5, span),
    );
    const extra =
      roi.shape === "box"
        ? el(
            "div",
            { class: "tf-xyz" },
            number("height", () => current().size[1], (v) => ({ size: [current().size[0], Math.max(0.1, v), current().size[2]] }), 0.5, span),
            number("depth", () => current().size[2], (v) => ({ size: [current().size[0], current().size[1], Math.max(0.1, v)] }), 0.5, span),
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
        el("button", { class: "btn small", type: "button", title: "Apply the typed values", onclick: () => typed.forEach((apply) => apply()) }, "Set"),
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
    ctx.commands.register("trackFiltering.saveTrk", () => void groups.saveTrk());
    ctx.subscriptions.push(ctx.services.provide("trackFiltering.groups", groups.service()));
  },
};
