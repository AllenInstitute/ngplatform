/**
 * Label volumes being edited, and the tools that draw in them: what the
 * Segmentation tab (./panel.ts) and the tool bar over the views
 * (./toolbar.ts) show and change.
 *
 *  - A new segmentation layer: an empty label volume on the grid of an
 *    image or a segmentation (a level of it: the same voxels and
 *    placement), or a copy of a segmentation's labels; or a NIfTI label
 *    image opened to edit.
 *  - Tools, in the views (./painter.ts): Move (Neuroglancer's own), a
 *    brush (a ball, or its disc in the section), an eraser, fills of the
 *    section and of a box round the click, a picker, and quick select
 *    (./quick_select.ts: by threshold, or by MobileSAM, ./sam_model.ts),
 *    spread to neighbouring sections.  Brush and fills can be limited to
 *    an intensity range of an image.
 *  - Segments (./segments.ts): the active one, new ones, names, colours,
 *    shown or hidden, gone to, merged and deleted; and their groups
 *    (./segment_groups.ts), kept in the plugin's per-scene state.
 *  - Undo and redo of strokes; Save as NIfTI or OME-Zarr (./save.ts).
 *  - A segmentation too large to copy edited in place, copy-on-write
 *    (./cow_volume.ts): its chunks read from it until edited; every tool
 *    first reads the chunks it may reach (`ready`); its edits saved alone
 *    (and opened again over it) or the whole volume saved as a job.
 *
 * The volume lives in the page (./label_volume.ts) and shows as a
 * segmentation layer that reads it as an OME-Zarr store (./session.ts).
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { mmOf, toGlobal, toVoxel, voxelEdges } from "../annotations/geometry.js";
import { space as spaceOf } from "../annotations/scene.js";
import { download, el, fileName, fmt } from "../annotations/ui.js";
import { type ImageLevel, layerStore, readableImages, sourceUrl, type Voxels } from "../annotations/voxels.js";
import { zipFiles } from "../registration/volume_io.js";
import { storeOf } from "../volume-view/sources.js";
import { CowVolume, type Original } from "./cow_volume.js";
import { chooseUndo, Stroke } from "./history.js";
import { ballReach, ballShape, dabsBetween, fillOutline, floodFill, type ImageBlock, inRange, interpolate, type Paint, paintBall, relabel, sameLabel, type Vec3, voxelIndex } from "./kernels.js";
import { discard, type KeptInfo, kept, restore, restoreInto } from "./keep.js";
import { CHUNK, LABEL_ARRAYS, LABEL_MAX, type LabelType, LabelVolume } from "./label_volume.js";
import { BRUSHING, DRAWING, EDITING, PREVIEWING, SEGMENTATION_PANEL, SELECTING } from "./manifest.js";
import { Painter, type ViewPoint } from "./painter.js";
import { maskCount, PreviewOverlay } from "./preview.js";
import { type Mask, type Prompt, type QuickSelectMethod, type QuickSelectRequest, QuickSelectRegistry } from "./quick_select.js";
import { layerWindow, sectionAxes, sectionBounds, stackMasks } from "./sam.js";
import { SamModel, samMethod } from "./sam_model.js";
import { cropped, editsZarr, niftiBytes, niftiGz, omeZarr, readEdits, type SavedLabel, writeWhole } from "./save.js";
import { addGroup, assign, editGroup, groupOf, members, readGroups, removeGroup, type SegmentationSaved, type VolumeGroups } from "./segment_groups.js";
import { isVisible, nextSegment, type SegmentRow, segmentRows, type SegmentsState, withVisibility } from "./segments.js";
import { type Reference, Session } from "./session.js";
import { brushes, cycle, draws, stepRadius, type Tool, TOOLS } from "./tools.js";

/** A NIfTI holds every voxel: beyond this, save the painted box only. */
export const MAX_NIFTI = 2 * 2 ** 30;
/** Voxels read to open a label image or copy a segmentation. */
export const MAX_COPY = 512 * 2 ** 20;
/** The block a copy is read in, in voxels. */
const COPY_BLOCK: Vec3 = [256, 256, 64];
/** Edited in place, a tool reads at most this many bytes of chunks before it runs (256 chunks of 64³ at 32 bits). */
export const MAX_REACH_BYTES = 256 * 2 ** 20;

/** The chunks a tool may read at once in a volume edited in place. */
export function reachChunks(volume: LabelVolume): number {
  return Math.floor(MAX_REACH_BYTES / (CHUNK ** 3 * LABEL_ARRAYS[volume.type].BYTES_PER_ELEMENT));
}

/**
 * The largest box round `seed` within `lo`..`hi` (an axis one voxel thick,
 * a section's, kept as it is) that touches at most `max` chunks, and
 * whether it is smaller than the box asked for.
 */
export function capBox(seed: Vec3, lo: Vec3, hi: Vec3, max: number, chunksIn: (lo: Vec3, hi: Vec3) => number): { lo: Vec3; hi: Vec3; capped: boolean } {
  if (chunksIn(lo, hi) <= max) return { lo, hi, capped: false };
  const box = (r: number) => ({
    lo: lo.map((v, k) => (hi[k] - v <= 1 ? v : Math.max(v, seed[k] - r))) as Vec3,
    hi: hi.map((v, k) => (v - lo[k] <= 1 ? v : Math.min(v, seed[k] + r + 1))) as Vec3,
  });
  let a = 0;
  let b = Math.max(...hi.map((v, k) => v - lo[k]));
  while (a < b) {
    const m = Math.ceil((a + b) / 2);
    const t = box(m);
    if (chunksIn(t.lo, t.hi) <= max) a = m;
    else b = m - 1;
  }
  return { ...box(a), capped: true };
}

/** The label volumes this plugin has open, for other plugins (Annotations' Statistics). */
export interface LabelVolumes {
  readonly sessions: readonly Session[];
}

/** What New makes: a label volume on a layer's grid, empty or (a segmentation's) a copy of its labels. */
export interface NewLayer {
  layer: string;
  level: number;
  type: LabelType;
  name: string;
  copy: boolean;
  /** Edit the segmentation in place (copy-on-write over its finest level) rather than copy it. */
  inPlace?: boolean;
}

type FilePicker = {
  showSaveFilePicker?(o?: unknown): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle>;
};

export class Editor implements LabelVolumes {
  readonly sessions: Session[] = [];
  current: Session | undefined;
  /** The current volume is being edited: the tool bar shows and the tools' keys work. */
  editing = false;
  readonly quickSelect = new QuickSelectRegistry();
  /** Quick select's model (AI (MobileSAM)): its files, the runtime, the last timings. */
  readonly sam = new SamModel();
  private readonly painter: Painter;
  private readonly previewOverlay: PreviewOverlay;
  private readonly offs: Disposer[] = [];
  private readonly listeners = new Set<() => void>();

  // Tool settings (this visit).
  tool: Tool = "move";
  fill3d = false;
  /** The active segment. */
  value = 1;
  radius = 5;
  unit: "mm" | "µm" | "voxels" = "voxels";
  /** The radius is still the one chosen for the volume's size (none set by hand). */
  private autoRadius = true;
  shape: "ball" | "disc" = "disc";
  overwrite: "all" | "empty" = "all";
  eraseOnly = false;
  /** The lasso paints the active segment, or erases (as Erase does: any segment, or the active one only). */
  lassoErase = false;
  limit = false;
  low = 0;
  high = 255;
  fillBy: "image" | "label" = "label";
  reach = 32;
  method = "threshold";
  tolerance = 0.1;
  /** Quick select shows its mask first (Enter paints it, Escape drops it), or paints at once. */
  quickMode: "preview" | "paint" = "preview";
  /** Quick select's mask waiting to be accepted or cancelled; `axis` is the section's normal when it came from a 2-D view. */
  pending: { session: Session; mask: Mask; voxels: number; axis?: number } | undefined;
  /** A model method looks at least this many voxels across round the prompt. */
  quickContext = 256;
  /** What quick select is doing while it takes a while (a download, an embedding, spreading), and how far along. */
  quickStatus: { text: string; fraction?: number } | undefined;
  /** For a method that refines: the prompts given in one section so far (a box, clicks wanted or not). */
  quickPrompts: { session: Session; method: string; axis: number; index: number; box?: { lo: Vec3; hi: Vec3 }; points: { at: Vec3; positive: boolean }[] } | undefined;
  /** Spread goes this many sections each way. */
  spreadCount = 5;
  saveFormat: "nii.gz" | "zarr" = "nii.gz";
  saveCrop = false;
  /** Edited in place: save the edits only, or the whole volume (a job). */
  saveInPlace: "edits" | "whole" = "edits";
  /** What the last save (or the one under way) said. */
  note = "";
  /** Label volumes kept in this browser and not open now. */
  keptHere: KeptInfo[] = [];

  /** Work on the volume in order (a stroke's dabs may wait for image values). */
  private queue: Promise<void> = Promise.resolve();
  private brushing: Brushing | undefined;
  private last: Vec3 | undefined;
  private lastNormal: Vec3 | undefined;
  /** The voxel axis across the 2-D view last drawn in: interpolation runs along it. */
  private axis = 2;
  private quickStart: { voxel: Vec3; axis?: number; negative: boolean } | undefined;
  private quickAbort: AbortController | undefined;
  private quickEnd: Vec3 | undefined;
  /** The lasso's outline being drawn: the section (across `axis`, at `index`) and its points (u, w) in voxels. */
  private lasso: { session: Session; axis: number; index: number; points: [number, number][] } | undefined;
  private countsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Volumes already looked for after a reload. */
  private readonly sought = new Set<string>();

  constructor(
    private readonly ctx: PlatformContext,
    private readonly voxels: Voxels,
  ) {
    this.painter = new Painter(ctx, {
      down: (p, e) => this.down(p, e),
      drag: (p) => this.drag(p),
      up: () => this.up(),
      ring: (p) => this.ring(p),
      boxDrag: () => this.tool === "quick",
      pathDrag: () => this.tool === "lasso",
      wheel: (notches) => {
        if (!brushes(this.tool)) return false;
        this.brushSize(notches);
        return true;
      },
    });
    this.previewOverlay = new PreviewOverlay(ctx, {
      preview: () => {
        const p = this.pending?.session === this.current ? this.pending : undefined;
        const q = this.quickPrompts?.session === this.current ? this.quickPrompts : undefined;
        const placement = this.current?.placement();
        if ((p === undefined && q === undefined) || placement === undefined) return undefined;
        return { mask: p?.mask, placement, colour: this.current!.colour(this.value), points: q && { axis: q.axis, index: q.index, points: q.points } };
      },
    });
    this.offs.push(
      ctx.services.provide("segmentation.quickSelect", this.quickSelect),
      ctx.services.provide("segmentation.labelVolumes", this as LabelVolumes),
      this.quickSelect.onChanged(() => this.changed()),
      this.quickSelect.register(samMethod(this.sam)),
      this.sam.onChanged(() => this.changed()),
    );
    const c = ctx.commands;
    c.register("segmentation.newLayer", () => ctx.ui.showPanel(SEGMENTATION_PANEL));
    c.register("segmentation.openNifti", () => this.pickNifti());
    c.register("segmentation.save", () => this.save());
    c.register("segmentation.tool", ({ tool, fill3d }: { tool: Tool; fill3d?: boolean }) => {
      if (!TOOLS.some((t) => t.id === tool)) return;
      if (fill3d !== undefined) this.fill3d = fill3d;
      this.setTool(tool);
    });
    c.register("segmentation.cycleTool", ({ step }: { step?: number }) => this.setTool(cycle(this.tool, step ?? 1)));
    c.register("segmentation.brushSize", ({ notches }: { notches?: number }) => this.brushSize(notches ?? 1));
    c.register("segmentation.newSegment", () => this.newSegment());
    c.register("segmentation.undo", () => this.undo(false));
    c.register("segmentation.redo", () => this.undo(true));
    c.register("segmentation.interpolate", () => this.interpolate());
    c.register("segmentation.stopEditing", () => this.setEditing(false));
    c.register("segmentation.acceptPreview", () => this.acceptPreview());
    c.register("segmentation.cancelPreview", () => this.cancelPreview());
    // Each scene shows its own label volumes, as if it were a viewer of its
    // own: a layer removed (or another scene shown) ends editing the volume
    // it showed, and the scene's first volume becomes the current one.  A
    // label layer whose volume went with a reload comes back from the browser.
    this.offs.push(
      ctx.viewer.onLayersChanged(() => {
        const here = this.inScene();
        if (this.pending !== undefined && !here.includes(this.pending.session)) this.cancelPreview();
        if (this.current !== undefined && !here.includes(this.current)) {
          this.current = here[0];
          if (this.current) this.value = this.rows()[0]?.value ?? 1;
          if (this.editing) this.setEditing(this.current !== undefined);
        } else if (this.current === undefined && here.length) {
          this.current = here[0];
          this.value = this.rows()[0]?.value ?? 1;
        }
        void this.restoreLost();
        this.changed();
      }),
      // Groups are in the workspace state: undo, redo and another scene change them.
      ctx.state.onChanged(() => this.changed()),
    );
    void this.restoreLost();
    void this.refreshKept();
  }

  /** The label volumes the active scene shows (a layer reads its store). */
  inScene(): Session[] {
    const sources = this.ctx.viewer.layers().flatMap((l) => l.sources);
    return this.sessions.filter((s) => sources.some((source) => source.includes(s.fileName)));
  }

  /** Calls back when anything shown changes. */
  onChanged(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const l of this.listeners) l();
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.painter.dispose();
    this.previewOverlay.dispose();
    this.sam.dispose();
    for (const s of this.sessions) s.dispose();
    clearTimeout(this.countsTimer);
  }

  // ------------------------------------------------------------ tools

  setTool(tool: Tool): void {
    if (draws(tool) && this.current === undefined) {
      this.ctx.ui.toast("Make a segmentation layer first (Segmentation tab).");
      this.ctx.ui.showPanel(SEGMENTATION_PANEL);
      return;
    }
    if (tool !== this.tool) this.cancelPreview();
    this.tool = tool;
    if (draws(tool)) this.editing = true;
    this.apply();
  }

  /** Shows or hides the tool bar; hidden, the views are Neuroglancer's again. */
  setEditing(on: boolean): void {
    if (on && this.current === undefined) on = false;
    this.editing = on;
    if (!on) {
      this.tool = "move";
      this.cancelPreview();
    }
    else if (this.current) this.ctx.workspace.selectLayer(this.current.layer);
    this.apply();
  }

  /** Puts the tool and editing state into the painter and the context keys. */
  private apply(): void {
    const drawing = this.editing && draws(this.tool);
    this.painter.active = drawing;
    this.ctx.context.set(EDITING, this.editing);
    this.ctx.context.set(DRAWING, drawing);
    this.ctx.context.set(BRUSHING, drawing && brushes(this.tool));
    this.painter.refresh();
    this.changed();
  }

  brushSize(notches: number): void {
    this.setRadius(stepRadius(this.radius, notches, this.unit));
  }

  setRadius(radius: number): void {
    this.radius = radius;
    this.autoRadius = false;
    this.painter.refresh();
    this.changed();
  }

  private noRangeTold = 0;

  /** Says (at most every few seconds) that the range limit is on but the image's values cannot be read. */
  private noRange(): void {
    if (Date.now() - this.noRangeTold < 4000) return;
    this.noRangeTold = Date.now();
    const ref = this.current?.reference?.layer;
    this.ctx.ui.toast(
      ref === undefined
        ? "“Only within the range” is on, but no image is chosen: choose one under Image values, or untick it."
        : `“Only within the range” is on, but ${ref}'s values cannot be read here (is it shown and loaded?). Nothing was painted.`,
      "error",
    );
  }

  /** Changes the brush's unit, keeping its size (5 voxels of 0.1 mm become 0.5 mm, not 5 mm). */
  setUnit(unit: "mm" | "µm" | "voxels"): void {
    if (unit === this.unit) return;
    const affine = this.current?.placement()?.voxelToMm ?? this.current?.volume.voxelToRas;
    const voxel = affine ? Math.min(...voxelEdges(affine)) : undefined;
    const mm = this.unit === "mm" ? this.radius : this.unit === "µm" ? this.radius / 1000 : voxel !== undefined ? this.radius * voxel : undefined;
    this.unit = unit;
    if (mm !== undefined && mm > 0) {
      const next = unit === "mm" ? mm : unit === "µm" ? mm * 1000 : voxel !== undefined ? mm / voxel : this.radius;
      this.radius = Number(next.toPrecision(3));
    }
    this.painter.refresh();
    this.changed();
  }

  setCurrent(session: Session): void {
    if (session !== this.current) this.cancelPreview();
    this.current = session;
    this.value = this.rows()[0]?.value ?? 1;
    if (this.editing) this.ctx.workspace.selectLayer(session.layer);
    this.changed();
  }

  // ------------------------------------------------------------ segments

  /** The current volume's segments. */
  rows(): SegmentRow[] {
    const s = this.current;
    if (s === undefined) return [];
    const state = this.segmentsState(s);
    // Edited in place: the original's names for its segments met in the edits.
    const names = s.theirs.size ? new Map([...[...s.counts.keys()].filter((v) => s.theirs.has(v)).map((v) => [v, s.theirs.get(v)!] as const), ...s.labels]) : s.labels;
    const rows = segmentRows(s.counts, names, (v) => s.colour(v), (v) => isVisible(state, v));
    if (!rows.some((r) => r.value === this.value)) rows.push({ value: this.value, name: "", colour: s.colour(this.value), voxels: 0, visible: isVisible(state, this.value) });
    return rows.sort((a, b) => a.value - b.value);
  }

  private segmentsState(session: Session): SegmentsState {
    return (this.ctx.viewer.layerSpec(session.layer) as SegmentsState | undefined) ?? {};
  }

  /** Paints with a segment from now on. */
  activate(value: number): void {
    const s = this.current;
    if (s === undefined) return;
    this.value = Math.max(1, Math.min(LABEL_MAX[s.volume.type], Math.round(value)));
    s.applyColours([this.value]);
    this.changed();
  }

  /** A new segment (one more than the largest used) becomes the active one. */
  newSegment(): void {
    const s = this.current;
    if (s === undefined) return;
    s.counts = s.volume.counts();
    // Edited in place: above every label read from the original so far too.
    const seen = s.volume instanceof CowVolume ? [s.volume.largestSeen] : [];
    const v = nextSegment([...s.counts.keys(), ...s.labels.keys(), this.value, ...seen], LABEL_MAX[s.volume.type]);
    if (v === 0) {
      this.ctx.ui.toast(`Every value of a ${s.volume.type} label volume is used.`);
      return;
    }
    s.labels.set(v, { name: "", colour: s.colour(v) });
    s.changed([]);
    this.value = v;
    s.applyColours([v]);
    this.show(s, v, true, true);
    this.changed();
  }

  rename(value: number, name: string): void {
    const s = this.current;
    if (s === undefined) return;
    s.labels.set(value, { name: name.trim(), colour: s.colour(value) });
    s.changed([]);
    this.changed();
  }

  recolour(value: number, colour: string): void {
    const s = this.current;
    if (s === undefined) return;
    s.labels.set(value, { name: s.labels.get(value)?.name ?? "", colour });
    s.changed([]);
    s.applyColours([value]);
    this.changed();
  }

  /** Shows or hides a segment in its layer (Neuroglancer's visible segments). */
  show(session: Session, value: number, visible: boolean, quiet = false): void {
    this.showSegments(session, [value], visible, quiet);
  }

  /** Shows or hides several segments (a group) in its layer, as one change. */
  showSegments(session: Session, values: number[], visible: boolean, quiet = false): void {
    let state = this.segmentsState(session);
    const change = values.filter((v) => isVisible(state, v) !== visible);
    if (change.length === 0) return;
    const known = [...new Set([...session.counts.keys(), ...session.labels.keys(), this.value, ...values])];
    for (const v of change) state = withVisibility(state, known, v, visible);
    const next = state as Required<SegmentsState>;
    this.ctx.viewer.patchState(
      (ng) => {
        const layer = ((ng.layers as Record<string, unknown>[] | undefined) ?? []).find((l) => l.name === session.layer);
        if (layer === undefined) return;
        layer.segments = next.segments;
        if (next.ignoreNullVisibleSet) delete layer.ignoreNullVisibleSet;
        else layer.ignoreNullVisibleSet = false;
      },
      { quiet },
    );
    this.changed();
  }

  // ------------------------------------------------------------ groups

  /** The current volume's segment groups (from the plugin's state for this scene). */
  groups(session = this.current): VolumeGroups {
    if (session === undefined) return readGroups(undefined);
    return readGroups(this.ctx.state.get<SegmentationSaved>()?.groups?.[session.id]);
  }

  private setGroups(session: Session, next: VolumeGroups): void {
    const saved = this.ctx.state.get<SegmentationSaved>() ?? {};
    this.ctx.state.set<SegmentationSaved>({ ...saved, groups: { ...saved.groups, [session.id]: next } });
    this.changed();
  }

  /** A new, empty group; returns its id. */
  newGroup(name?: string): string | undefined {
    const s = this.current;
    if (s === undefined) return undefined;
    const { next, id } = addGroup(this.groups(s), name);
    this.setGroups(s, next);
    return id;
  }

  renameGroup(id: string, name: string): void {
    const s = this.current;
    if (s) this.setGroups(s, editGroup(this.groups(s), id, { name }));
  }

  foldGroup(id: string, collapsed: boolean): void {
    const s = this.current;
    if (s) this.setGroups(s, editGroup(this.groups(s), id, { collapsed }));
  }

  /** Gives a group, and every segment in it, a colour. */
  recolourGroup(id: string, colour: string): void {
    const s = this.current;
    if (s === undefined) return;
    const values = members(this.groups(s), id, this.rows().map((r) => r.value));
    for (const v of values) s.labels.set(v, { name: s.labels.get(v)?.name ?? "", colour });
    s.changed([]);
    s.applyColours(values);
    this.setGroups(s, editGroup(this.groups(s), id, { colour }));
  }

  /** Takes a group away; its segments stay, in no group. */
  deleteGroup(id: string): void {
    const s = this.current;
    if (s) this.setGroups(s, removeGroup(this.groups(s), id));
  }

  /** Puts segments in a group (undefined: in none). */
  assignGroup(values: number[], id: string | undefined): void {
    const s = this.current;
    if (s) this.setGroups(s, assign(this.groups(s), values, id));
  }

  /** Shows or hides every segment of a group. */
  showGroup(id: string, visible: boolean): void {
    const s = this.current;
    if (s) this.showSegments(s, members(this.groups(s), id, this.rows().map((r) => r.value)), visible);
  }

  /** Moves the views to a segment: its voxel nearest its centre (edited in place, of its voxels in the edited chunks). */
  async goTo(value: number): Promise<void> {
    const s = this.current;
    const placed = s?.placement();
    if (s === undefined || placed === undefined) return;
    const v = s.volume;
    const release = v instanceof CowVolume ? await v.prepareKeys(v.keysWith(value)) : undefined;
    const voxel = v.centre(value);
    release?.();
    if (voxel === undefined) {
      this.ctx.ui.toast(v instanceof CowVolume ? `Segment ${value} is not in the edited chunks.` : `Segment ${value} is not painted.`);
      return;
    }
    const position = (this.ctx.viewer.getState() as { position?: number[] }).position ?? [];
    this.ctx.viewer.setPosition(toGlobal(placed, voxel, position));
  }

  /** Erases a segment everywhere (undoable). */
  async deleteSegment(value: number): Promise<void> {
    const s = this.current;
    if (s === undefined) return;
    const n = s.counts.get(value) ?? 0;
    const inPlace = s.volume instanceof CowVolume;
    if (n > 0 && !(await this.ctx.ui.confirm(`Delete segment ${value}: erase its ${n.toLocaleString()} voxels${inPlace ? " in the edited chunks (the original's elsewhere stay)" : ""}? (Undo brings them back.)`))) return;
    this.enqueue(async () => {
      const stroke = new Stroke(s.volume);
      const release = await s.volume.prepareKeys(s.volume.keys());
      relabel(stroke, value, 0);
      release();
      this.forgetLabel(s, stroke, value);
      if (this.groups(s).of[String(value)] !== undefined) this.assignGroup([value], undefined);
      s.changed([]);
      this.commit(stroke, s, 0);
      if (this.value === value) this.value = this.rows().find((r) => r.value !== value)?.value ?? 1;
      this.changed();
    });
  }

  /** Drops a segment's name and colour, which undoing `stroke` puts back (its group is a workspace step of its own). */
  private forgetLabel(s: Session, stroke: Stroke, value: number): void {
    const kept = s.labels.get(value);
    s.labels.delete(value);
    if (kept === undefined) return;
    stroke.onUndo = () => {
      s.labels.set(value, kept);
      s.changed([]);
    };
    stroke.onRedo = () => {
      s.labels.delete(value);
      s.changed([]);
    };
  }

  /** Gives a segment's voxels to the active segment (undoable). */
  merge(from: number, into = this.value): void {
    const s = this.current;
    if (s === undefined || from === into) return;
    this.enqueue(async () => {
      const stroke = new Stroke(s.volume);
      const release = await s.volume.prepareKeys(s.volume.keys());
      const n = relabel(stroke, from, into);
      release();
      this.forgetLabel(s, stroke, from);
      if (this.groups(s).of[String(from)] !== undefined) this.assignGroup([from], undefined);
      s.changed([]);
      this.ctx.ui.toast(`Merged segment ${from} into ${into}: ${n.toLocaleString()} voxels${s.volume instanceof CowVolume ? " in the edited chunks" : ""}.`);
      this.commit(stroke, s, into);
      this.changed();
    });
  }

  // ------------------------------------------------------------ volumes

  /**
   * Layers showing a label volume that is not in this page (the page was
   * reloaded): each is pointed at the volume as kept in the browser, if it
   * was; otherwise the log says it is gone.
   */
  private async restoreLost(): Promise<void> {
    const open = new Set(this.sessions.map((s) => s.id));
    const lost: { layer: string; id: string }[] = [];
    for (const l of this.ctx.viewer.layers()) {
      for (const source of l.sources) {
        const m = /\/([^/]+)\.ngplabels\/?$/.exec(source);
        if (m && !open.has(m[1]) && !this.sought.has(m[1])) lost.push({ layer: l.name, id: m[1] });
      }
    }
    if (lost.length === 0) return;
    for (const { id } of lost) this.sought.add(id);
    const keptNow = await kept();
    for (const { layer, id } of lost) {
      const info = keptNow.find((k) => k.id === id);
      if (info === undefined) {
        this.ctx.log.error(`The label volume of “${layer}” was in a page since closed, and not kept in this browser: it is gone. Remove the layer.`);
        continue;
      }
      try {
        await this.reopen(info, layer);
        this.ctx.log.info(`Brought back “${layer}” as kept in this browser (${new Date(info.time).toLocaleString()}).`);
      } catch (e) {
        this.ctx.log.error(`Could not bring back “${layer}”: ${(e as Error).message}`);
      }
    }
    void this.refreshKept();
  }

  /** A kept volume opened again: into a layer that shows it (`replace`), or as a new one. */
  async reopen(info: KeptInfo, replace?: string): Promise<void> {
    if (info.original !== undefined) return this.reopenInPlace(info, replace);
    const volume = await restore(info);
    const session = await Session.open(this.ctx, this.voxels, volume, info.name, { id: info.id, replace });
    for (const [value, label] of info.labels) session.labels.set(value, label);
    if (info.reference && this.ctx.viewer.layers().some((l) => l.name === info.reference)) await this.chooseReference(session, info.reference);
    this.adopt(session, replace === undefined);
    session.applyColours([...session.counts.keys(), ...session.labels.keys()]);
  }

  /** A segmentation edited in place, kept in this browser, opened again over its original (an error if that cannot be read). */
  private async reopenInPlace(info: KeptInfo, replace?: string): Promise<void> {
    const volume = await this.overOriginal(info.original!, info.name, info.size);
    const session = await Session.open(this.ctx, this.voxels, volume, info.name, { id: info.id, replace });
    for (const [value, label] of info.labels) session.labels.set(value, label);
    await restoreInto(volume, info);
    await this.theirLabels(info.original!.layer, session);
    if (info.reference && this.ctx.viewer.layers().some((l) => l.name === info.reference)) await this.chooseReference(session, info.reference);
    this.adopt(session, replace === undefined);
    session.applyColours([...session.labels.keys()]);
    session.refresh();
  }

  /**
   * A volume edited in place over an original: an error saying so if the
   * original cannot be read, or (`size`) is no longer the size it was.
   */
  private async overOriginal(original: Original, name: string, size?: number[]): Promise<CowVolume> {
    let levels: ImageLevel[];
    try {
      levels = await this.voxels.levels(original.store);
    } catch (e) {
      throw new Error(`its original, ${original.layer} (${original.store}), cannot be read: ${(e as Error).message}. It may have moved or be gone`);
    }
    if (size !== undefined && levels[0].size.some((n, k) => n !== size[k])) throw new Error(`its original, ${original.layer} (${original.store}), is now ${levels[0].size.join(" × ")} voxels, not ${size.join(" × ")}`);
    return new CowVolume(levels, labelTypeOf(levels[0].type), original, (level, lo, extent, signal) => this.voxels.labels(original.store, level, lo, extent, undefined, signal), name);
  }

  /**
   * Edited in place: the original's segment names and colours for the new
   * layer (its lookup table, or its layer's colours and colour seed), so
   * its segments look as they did.
   */
  private async theirLabels(layer: string, session: Session): Promise<void> {
    const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const lut = this.ctx.viewer.layers().some((l) => l.name === layer) ? this.ctx.viewer.lookupTables.of(layer) : undefined;
    if (lut !== undefined) {
      try {
        const table = await this.ctx.viewer.lookupTables.load(lut);
        for (const e of table.entries) session.theirs.set(Number(e.value), { name: e.name, colour: hex(e.colour) });
        await this.ctx.viewer.lookupTables.apply(session.layer, lut);
        return;
      } catch {
        // Without its table, its layer's colours below.
      }
    }
    const spec = this.ctx.viewer.layerSpec(layer) as { segmentColors?: Record<string, string>; colorSeed?: number; segmentDefaultColor?: string } | undefined;
    if (spec === undefined) return;
    for (const [id, colour] of Object.entries(spec.segmentColors ?? {})) session.theirs.set(Number(id), { name: "", colour });
    this.ctx.viewer.patchState(
      (ng) => {
        const own = ((ng.layers as Record<string, unknown>[] | undefined) ?? []).find((l) => l.name === session.layer);
        if (own === undefined) return;
        if (spec.segmentColors) own.segmentColors = { ...spec.segmentColors, ...((own.segmentColors as Record<string, string> | undefined) ?? {}) };
        if (spec.colorSeed !== undefined) own.colorSeed = spec.colorSeed;
        if (spec.segmentDefaultColor !== undefined) own.segmentDefaultColor = spec.segmentDefaultColor;
      },
      { quiet: true },
    );
  }

  async refreshKept(): Promise<void> {
    const open = new Set(this.sessions.map((s) => s.id));
    this.keptHere = (await kept()).filter((k) => !open.has(k.id));
    this.changed();
  }

  async discardKept(id: string): Promise<void> {
    await discard(id);
    await this.refreshKept();
  }

  /** Makes a new segmentation layer: a label volume on a layer's grid, empty or a copy of its labels. */
  async create(spec: NewLayer): Promise<boolean> {
    const store = layerStore(this.ctx, spec.layer);
    if (store === undefined) return false;
    try {
      if (spec.inPlace) return await this.editInPlace(spec, store);
      const levels = await this.voxels.levels(store);
      const index = Math.min(spec.level, levels.length - 1);
      const level = levels[index];
      const volume = new LabelVolume(level.size, spec.copy ? labelTypeOf(level.type) : spec.type, level.voxelToRas, spec.name);
      if (spec.copy) await this.copyInto(volume, store, index, `Copying ${spec.layer}`);
      const session = await Session.open(this.ctx, this.voxels, volume, spec.name);
      if (spec.copy) {
        await this.copyLabels(spec.layer, session);
        this.ctx.viewer.setLayerVisible(spec.layer, false);
        await this.chooseReference(session, readableImages(this.ctx).find((l) => l !== session.layer));
        session.changed(volume.keys());
      } else if (this.ctx.viewer.layers().find((l) => l.name === spec.layer)?.type === "image") {
        session.setReference({ layer: spec.layer, store, level: index, levels });
      } else {
        await this.chooseReference(session, readableImages(this.ctx).find((l) => l !== session.layer));
      }
      this.adopt(session);
      this.ctx.log.info(
        spec.copy
          ? `New segmentation layer “${session.layer}”: a copy of ${spec.layer} (level ${index}, ${level.size.join(" × ")} voxels) to edit; ${spec.layer} is hidden and unchanged.`
          : `New segmentation layer “${session.layer}” on ${spec.layer}'s grid: ${level.size.join(" × ")} voxels.`,
      );
      return true;
    } catch (e) {
      this.ctx.ui.toast(`Could not make the segmentation layer: ${(e as Error).message}`, "error");
      return false;
    }
  }

  /**
   * Edits a segmentation layer in place: a volume over its finest level
   * whose chunks are read from it until edited (nothing is copied first).
   * The original is hidden and never written.
   */
  private async editInPlace(spec: NewLayer, store: string): Promise<boolean> {
    const original: Original = { store, layer: spec.layer, source: sourceUrl(this.ctx.viewer.layerSpec(spec.layer)) };
    const volume = await this.overOriginal(original, spec.name);
    const session = await Session.open(this.ctx, this.voxels, volume, spec.name);
    await this.theirLabels(spec.layer, session);
    this.ctx.viewer.setLayerVisible(spec.layer, false);
    await this.chooseReference(session, readableImages(this.ctx).find((l) => l !== session.layer));
    this.adopt(session);
    // Its description (with where the original is) kept at once; the active segment a new one, above the labels the original shows.
    await volume.survey().catch(() => 0);
    this.newSegment();
    const n = volume.size[0] * volume.size[1] * volume.size[2];
    this.ctx.log.info(
      `New segmentation layer “${session.layer}”: ${spec.layer} edited in place (${volume.size.join(" × ")} voxels, ${(n / 2 ** 30).toFixed(1)} G): its chunks are read from it as needed, and only those you change are kept, in this page and this browser. ${spec.layer} is hidden and unchanged.`,
    );
    return true;
  }

  /**
   * Reads a level of a layer's voxels into a volume, a block at a time (so
   * a large grid never sits in memory whole), as a job that can be
   * cancelled.
   */
  private async copyInto(volume: LabelVolume, store: string, level: number, title: string): Promise<void> {
    const size = volume.size;
    const n = size[0] * size[1] * size[2];
    if (n > MAX_COPY) throw new Error(`${size.join(" × ")} voxels is more than this can copy (${MAX_COPY / 2 ** 20} M): choose a coarser level`);
    const blocks: Vec3[] = [];
    for (let z = 0; z < size[2]; z += COPY_BLOCK[2]) for (let y = 0; y < size[1]; y += COPY_BLOCK[1]) for (let x = 0; x < size[0]; x += COPY_BLOCK[0]) blocks.push([x, y, z]);
    const max = LABEL_MAX[volume.type];
    await this.ctx.jobs.run(title, async (job) => {
      for (let i = 0; i < blocks.length; ++i) {
        if (job.cancelled) throw new Error("cancelled");
        job.progress(i / blocks.length, `Reading block ${i + 1} of ${blocks.length}`);
        const lo = blocks[i];
        const extent = lo.map((v, k) => Math.min(COPY_BLOCK[k], size[k] - v)) as Vec3;
        // Exactly: 32-bit labels as they are, 64-bit ones narrowed to 32 bits (an error past them).
        const data = await this.voxels.labels(store, level, lo, extent);
        const bad = badLabel(data, max);
        if (bad !== undefined) throw new Error(bad > max ? `label ${bad} is more than a ${volume.type} volume holds` : `${bad} is not a label (a whole number from 0)`);
        volume.addBlock(lo, extent, data);
      }
    });
  }

  /** A copied segmentation's names and colours: its lookup table's, or the colours its layer gives segments. */
  private async copyLabels(layer: string, session: Session): Promise<void> {
    const counts = (session.counts = session.volume.counts());
    const lut = this.ctx.viewer.lookupTables.of(layer);
    if (lut !== undefined) {
      try {
        const table = await this.ctx.viewer.lookupTables.load(lut);
        for (const e of table.entries) {
          const value = Number(e.value);
          if (!counts.has(value)) continue;
          session.labels.set(value, { name: e.name, colour: `#${e.colour.map((c) => c.toString(16).padStart(2, "0")).join("")}` });
        }
        return;
      } catch {
        // Without its table, its own colours below.
      }
    }
    const colours = (this.ctx.viewer.layerSpec(layer) as { segmentColors?: Record<string, string> } | undefined)?.segmentColors ?? {};
    for (const [id, colour] of Object.entries(colours)) if (counts.has(Number(id))) session.labels.set(Number(id), { name: "", colour });
  }

  private adopt(session: Session, edit = true): void {
    this.sessions.push(session);
    this.current = session;
    // What the last save said was of another volume.
    this.note = "";
    session.counts = session.volume.counts();
    this.value = [...session.counts.keys()].sort((a, b) => a - b)[0] ?? 1;
    session.applyColours([...session.counts.keys(), this.value]);
    // A brush that shows at the scale of the whole grid: a two-hundredth of its largest side.
    if (this.autoRadius && this.unit === "voxels") this.radius = Math.max(2, Math.round(Math.max(...session.volume.size) / 200));
    if (edit) {
      // A new layer opens with the brush, as WebKnossos's volume layers do.
      this.editing = true;
      this.tool = "brush";
      this.ctx.workspace.selectLayer(session.layer);
    }
    this.apply();
  }

  pickNifti(): void {
    const input = el("input", { type: "file", accept: ".nii,.gz" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.openNifti(file);
    });
    input.click();
  }

  /** Opens a NIfTI label image to edit: read (as the platform serves it) into a volume in the page. */
  async openNifti(file: File): Promise<void> {
    const found = (await this.ctx.workspace.local.open(file, { derived: true }))[0];
    const store = found && storeOf(found.source);
    if (store === undefined) {
      this.ctx.ui.toast(`${file.name} is not a NIfTI image.`, "error");
      return;
    }
    try {
      const [level] = await this.voxels.levels(store);
      const name = file.name.replace(/\.nii(\.gz)?$/i, "");
      const volume = new LabelVolume(level.size, labelTypeOf(level.type), level.voxelToRas, name);
      await this.copyInto(volume, store, 0, `Opening ${file.name}`);
      const session = await Session.open(this.ctx, this.voxels, volume, name);
      await this.chooseReference(session, readableImages(this.ctx).find((l) => l !== session.layer));
      this.adopt(session);
      session.changed(volume.keys());
      this.ctx.log.info(`Opened ${file.name} to edit: ${level.size.join(" × ")} voxels, ${volume.type}.`);
    } catch (e) {
      this.ctx.ui.toast(`Could not open ${file.name}: ${(e as Error).message}`, "error");
    } finally {
      this.ctx.workspace.local.close(found.source);
    }
  }

  /** Uses an image's values to limit the tools: its level with voxels nearest in size to the label volume's. */
  async chooseReference(session: Session, image: string | undefined): Promise<void> {
    const store = image && layerStore(this.ctx, image);
    if (!image || store === undefined) {
      session.setReference(undefined);
      return;
    }
    const levels = await this.voxels.levels(store);
    const own = voxelEdges(session.volume.voxelToRas).reduce((a, b) => a + b) / 3;
    let level = 0;
    levels.forEach((l, i) => {
      if (Math.abs(Math.log(l.voxelSize / own)) < Math.abs(Math.log(levels[level].voxelSize / own))) level = i;
    });
    session.setReference({ layer: image, store, level, levels });
    this.changed();
  }

  async close(session: Session): Promise<void> {
    if (session.unsaved > 0 && !(await this.ctx.ui.confirm(`Close “${session.layer}” without saving its last ${session.unsaved} change${session.unsaved === 1 ? "" : "s"}?`))) return;
    session.dispose(true);
    this.sessions.splice(this.sessions.indexOf(session), 1);
    if (this.ctx.viewer.layers().some((l) => l.name === session.layer)) this.ctx.workspace.removeLayer(session.layer);
    if (this.current === session) this.current = this.inScene()[0];
    if (this.current === undefined) this.setEditing(false);
    this.changed();
  }

  // ------------------------------------------------------------ drawing

  /** Where a view point is in the label volume, and the section's normal there (2-D views). */
  private locate(p: ViewPoint): { voxel: Vec3; normal?: Vec3 } | undefined {
    const placed = this.current?.placement();
    if (placed === undefined) {
      this.ctx.ui.toast("The segmentation layer has not loaded yet.");
      return undefined;
    }
    const voxel = toVoxel(placed, p.global);
    // The depth's gradient over voxel indices: through the voxels' map to the global dimensions.
    const m = placed.voxelToGlobal;
    const normal = [0, 1, 2].map((k) => placed.dims.reduce((s, d, r) => s + (p.depthPerUnit.get(d) ?? 0) * m[4 * r + k], 0)) as Vec3;
    if (Math.hypot(...normal) === 0) return { voxel };
    this.axis = dominant(normal);
    // The section shown, exactly: the stroke must land in it, not the next.
    voxel[this.axis] = voxelIndex(voxel[this.axis]);
    return { voxel, normal };
  }

  /** The brush's shape in voxels. */
  private shapeQ() {
    const radius = this.unit === "µm" ? this.radius / 1000 : this.radius;
    return ballShape(radius, this.unit === "voxels" ? "voxels" : "mm", this.current?.placement()?.voxelToMm ?? this.current?.volume.voxelToRas);
  }

  private ring(p: ViewPoint): number | undefined {
    if (!brushes(this.tool) || this.current === undefined) return undefined;
    const sp = spaceOf(this.ctx);
    // Pixels per millimetre in the view's plane.
    let perMm = 0;
    for (const [d, px] of p.pixelsPerUnit) if (px > 0 && sp.units[d] === "m") perMm = Math.max(perMm, px / mmOf(sp.scales[d], "m"));
    if (!(perMm > 0)) return undefined;
    const edges = voxelEdges(this.current.placement()?.voxelToMm ?? this.current.volume.voxelToRas);
    const mm = this.unit === "mm" ? this.radius : this.unit === "µm" ? this.radius / 1000 : this.radius * Math.min(...edges);
    return mm * perMm;
  }

  /**
   * Has the chunks a tool reaches (a box of voxels) ready: edited in place,
   * the original's are read first.  Resolves the function that lets them
   * go, or undefined (and says why) when the box holds more chunks than a
   * tool reads at once.
   */
  private async ready(session: Session, lo: Vec3, hi: Vec3, what: string): Promise<(() => void) | undefined> {
    const v = session.volume;
    if (!(v instanceof CowVolume)) return () => {};
    const n = v.chunksIn(lo, hi);
    const max = reachChunks(v);
    if (n > max) {
      this.ctx.ui.toast(`${what} reaches ${n.toLocaleString()} chunks of 64³ voxels; edited in place, a tool reads at most ${max} of the original's at once. Make it smaller.`);
      return undefined;
    }
    try {
      return await v.prepare(lo, hi);
    } catch (e) {
      this.ctx.ui.toast(`Could not read ${v.original.layer} there: ${(e as Error).message}`, "error");
      return undefined;
    }
  }

  private enqueue(work: () => Promise<void> | void): void {
    this.queue = this.queue.then(work).catch((e) => {
      this.ctx.log.error(`Drawing: ${(e as Error).message}`);
    });
  }

  /**
   * A stroke of the brush or eraser, its settings taken when it starts:
   * its dabs may wait for the image's values after the button is let go.
   */
  private begin(session: Session): Brushing {
    const erase = this.tool === "erase";
    if (this.limit && session.reference === undefined) this.noRange();
    return {
      session,
      stroke: new Stroke(session.volume),
      q: this.shapeQ(),
      paint: erase ? { value: 0, only: this.eraseOnly ? this.value : undefined } : { value: this.value, only: this.overwrite === "empty" ? 0 : undefined },
      range: this.limit && session.reference ? [this.low, this.high] : undefined,
      disc: this.shape === "disc",
    };
  }

  private async dab(b: Brushing, at: Vec3, normal: Vec3 | undefined): Promise<void> {
    const reach = ballReach(b.q);
    const paint: Paint = { ...b.paint };
    const lo = at.map((v, k) => Math.floor(v - reach[k]) - 1) as Vec3;
    const hi = at.map((v, k) => Math.ceil(v + reach[k]) + 2) as Vec3;
    if (b.range !== undefined) {
      const block = await b.session.imageBlock(lo, hi);
      // Asked to keep within a range whose values cannot be read: paint nothing rather than everything.
      if (block === undefined) return this.noRange();
      paint.where = inRange(block, b.range[0], b.range[1]);
    }
    const release = await this.ready(b.session, lo, hi, "The brush");
    if (release === undefined) return;
    try {
      paintBall(b.stroke, at, b.q, paint, b.disc ? normal : undefined);
    } finally {
      release();
    }
    if (b.stroke.flush().length) b.session.refresh(true);
  }

  private down(p: ViewPoint, e?: MouseEvent): void {
    const session = this.current;
    const where = session && this.locate(p);
    if (session === undefined || where === undefined) return;
    const { voxel, normal } = where;
    switch (this.tool) {
      case "brush":
      case "erase": {
        const brushing = (this.brushing = this.begin(session));
        this.last = voxel;
        this.lastNormal = normal;
        this.enqueue(() => this.dab(brushing, voxel, normal));
        break;
      }
      case "pick": {
        const at = voxel.map(voxelIndex) as Vec3;
        const pick = (v: number) => {
          if (v > 0) this.activate(v);
          else this.ctx.ui.toast("No segment there (0).");
        };
        if (!(session.volume instanceof CowVolume)) pick(session.volume.get(...at));
        else {
          // Edited in place: the chunk may have to be read first.
          this.enqueue(async () => {
            const release = await this.ready(session, at, at.map((v) => v + 1) as Vec3, "Pick");
            if (release === undefined) return;
            const v = session.volume.get(...at);
            release();
            pick(v);
          });
        }
        break;
      }
      case "fill": {
        const threeD = this.fill3d || normal === undefined;
        this.enqueue(() => this.fill(voxel, threeD ? undefined : normal));
        break;
      }
      case "quick":
        // Shift or Alt: a click on what is not wanted (for a method that refines).
        this.quickStart = { voxel, axis: normal ? dominant(normal) : undefined, negative: e?.shiftKey === true || e?.altKey === true };
        this.quickEnd = voxel;
        break;
      case "lasso": {
        if (normal === undefined) return;
        const axis = dominant(normal);
        const [u, w] = [0, 1, 2].filter((k) => k !== axis);
        this.lasso = { session, axis, index: voxelIndex(voxel[axis]), points: [[voxel[u], voxel[w]]] };
        break;
      }
    }
  }

  /** Fills the sections between those where the active segment is drawn, along the last view's axis. */
  interpolate(): void {
    const session = this.current;
    if (session === undefined) return;
    const value = this.value;
    const axis = this.axis;
    const only = this.overwrite === "empty" ? 0 : undefined;
    this.enqueue(async () => {
      const v = session.volume;
      // Edited in place: the sections drawn are those in the edited chunks.
      const own = v instanceof CowVolume ? await v.prepareKeys(v.keysWith(value)) : undefined;
      const box = v.paintedBox(value);
      own?.();
      if (box === undefined) {
        this.ctx.ui.toast(`Segment ${value} is not drawn yet.`);
        return;
      }
      const release = await this.ready(session, box.lo, box.hi, "Interpolating it");
      if (release === undefined) return;
      const stroke = new Stroke(session.volume);
      let sections: number;
      try {
        sections = interpolate(stroke, value, axis, box, only);
      } finally {
        release();
      }
      this.ctx.ui.toast(
        sections
          ? `Filled ${sections} section${sections === 1 ? "" : "s"} of segment ${value} between those drawn: ${stroke.changes.toLocaleString()} voxels${only === 0 ? " (empty ones only)" : ""}.`
          : `Segment ${value} has no gaps between drawn sections along ${"xyz"[axis]}: draw it in two sections a few apart.`,
      );
      this.commit(stroke, session, value);
    });
  }

  private drag(p: ViewPoint): void {
    if (this.tool === "lasso") {
      const lasso = this.lasso;
      const where = lasso && this.locate(p);
      if (lasso === undefined || where === undefined) return;
      const [u, w] = [0, 1, 2].filter((k) => k !== lasso.axis);
      const [lu, lw] = lasso.points[lasso.points.length - 1];
      // A point a quarter voxel or more from the last: enough for the outline, not one per pixel.
      if (Math.hypot(where.voxel[u] - lu, where.voxel[w] - lw) >= 0.25) lasso.points.push([where.voxel[u], where.voxel[w]]);
      return;
    }
    if (this.tool === "quick") {
      const where = this.locate(p);
      if (where) this.quickEnd = where.voxel;
      return;
    }
    const brushing = this.brushing;
    if (brushing === undefined || this.last === undefined) return;
    const where = this.locate(p);
    if (where === undefined) return;
    const from = this.last;
    this.last = where.voxel;
    const normal = where.normal ?? this.lastNormal;
    for (const at of dabsBetween(from, where.voxel, brushing.q)) this.enqueue(() => this.dab(brushing, at, normal));
  }

  private up(): void {
    if (this.lasso !== undefined) {
      const lasso = this.lasso;
      this.lasso = undefined;
      this.enqueue(() => this.fillLasso(lasso));
      return;
    }
    if (this.tool === "quick" && this.quickStart !== undefined) {
      const start = this.quickStart;
      const end = this.quickEnd ?? start.voxel;
      this.quickStart = undefined;
      this.enqueue(() => this.runQuick(start, end));
      return;
    }
    const brushing = this.brushing;
    this.brushing = undefined;
    this.last = undefined;
    if (brushing !== undefined) this.enqueue(() => this.commit(brushing.stroke, brushing.session, brushing.paint.value));
  }

  /** Ends a stroke: kept for undo, shown, counted. */
  private commit(stroke: Stroke, session = this.current, value = this.value): void {
    stroke.finish();
    if (session === undefined || stroke.changes === 0) return;
    if (value > 0) {
      // Before the stroke is timed: a change of the user's still settling is recorded first, as its own step.
      session.applyColours([value]);
      // A segment painted shows, even where others are hidden.
      this.show(session, value, true, true);
    }
    session.history.push(stroke);
    session.changed(stroke.keys());
    session.unsaved++;
    session.refresh();
    this.recount();
  }

  /**
   * Paints inside the lasso's outline, in its section: the active segment
   * over what Paint over allows (or 0, erasing, as Erase allows), within the
   * image's range when the brush is limited to it.
   */
  private async fillLasso(lasso: { session: Session; axis: number; index: number; points: [number, number][] }): Promise<void> {
    const { session, axis, index, points } = lasso;
    if (points.length < 3) {
      this.ctx.ui.toast("Draw round what to fill: hold the button down and come back near the start.");
      return;
    }
    const paint: Paint = this.lassoErase ? { value: 0, only: this.eraseOnly ? this.value : undefined } : { value: this.value, only: this.overwrite === "empty" ? 0 : undefined };
    // The outline's box in its section.
    const [u, w] = [0, 1, 2].filter((k) => k !== axis);
    const lo: Vec3 = [0, 0, 0];
    const hi: Vec3 = [0, 0, 0];
    lo[axis] = index;
    hi[axis] = index + 1;
    lo[u] = Math.floor(Math.min(...points.map((p) => p[0])));
    hi[u] = Math.ceil(Math.max(...points.map((p) => p[0]))) + 1;
    lo[w] = Math.floor(Math.min(...points.map((p) => p[1])));
    hi[w] = Math.ceil(Math.max(...points.map((p) => p[1]))) + 1;
    if (this.limit && session.reference) {
      const block = await session.imageBox(lo, hi);
      if (block === undefined) return this.noRange();
      paint.where = inRange(block, this.low, this.high);
    }
    const release = await this.ready(session, lo, hi, "The outline");
    if (release === undefined) return;
    const stroke = new Stroke(session.volume);
    let n: number;
    try {
      n = fillOutline(stroke, axis, index, points, paint);
    } finally {
      release();
    }
    if (n === 0) this.ctx.ui.toast(this.lassoErase ? "Nothing to erase inside the outline." : "Nothing painted: the outline holds no voxel it may paint (Paint over, the image's range).");
    this.commit(stroke, session, paint.value);
  }

  private async fill(seed: Vec3, normal: Vec3 | undefined): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    const s = seed.map(voxelIndex) as Vec3;
    const size = session.volume.size;
    const axis = normal ? dominant(normal) : undefined;
    let lo: Vec3;
    let hi: Vec3;
    if (axis !== undefined) {
      lo = [0, 0, 0];
      hi = [...size] as Vec3;
      lo[axis] = s[axis];
      hi[axis] = s[axis] + 1;
    } else {
      lo = s.map((v) => v - this.reach) as Vec3;
      hi = s.map((v) => v + this.reach + 1) as Vec3;
    }
    // Edited in place, a fill reads the original's chunks it may reach first: at most a tool's worth round the click.
    let capped = false;
    if (session.volume instanceof CowVolume) {
      const v = session.volume;
      const clamp = (b: Vec3) => b.map((x, k) => Math.max(0, Math.min(size[k], x))) as Vec3;
      ({ lo, hi, capped } = capBox(s, clamp(lo), clamp(hi), reachChunks(v), (a, b) => v.chunksIn(a, b)));
    }
    const release = await this.ready(session, lo, hi, "The fill");
    if (release === undefined) return;
    try {
      await this.fillIn(session, s, axis, lo, hi, capped);
    } finally {
      release();
    }
  }

  private async fillIn(session: Session, s: Vec3, axis: number | undefined, lo: Vec3, hi: Vec3, capped: boolean): Promise<void> {
    let inside = sameLabel(session.volume, s);
    if (this.fillBy === "image") {
      if (session.reference === undefined) {
        this.ctx.ui.toast("Choose an image for the intensity range first.");
        return;
      }
      const block = await session.imageBox(lo, hi);
      if (block === undefined) return;
      inside = inRange(block, this.low, this.high);
    }
    const stroke = new Stroke(session.volume);
    const result = floodFill(stroke, s, inside, { value: this.value, only: this.overwrite === "empty" ? 0 : undefined }, { axis, box: { lo, hi }, maxVoxels: 64 * 2 ** 20 });
    if (result.reached === 0) this.ctx.ui.toast(this.fillBy === "image" ? `The value clicked is outside ${fmt(this.low)} to ${fmt(this.high)}.` : "Nothing to fill there.");
    else if (result.limited) this.ctx.ui.toast(`The fill stopped at its limit of ${result.reached.toLocaleString()} voxels.`);
    else if (capped && result.edge) this.ctx.ui.toast(`The fill stopped at the edge of the ${[0, 1, 2].map((k) => hi[k] - lo[k]).join(" × ")} voxels round the click it may read at once (edited in place, it reads the original's chunks first). Fill again beyond it to go on.`);
    this.commit(stroke, session);
  }

  /** The method chosen (the first if it has gone). */
  quickMethod(): QuickSelectMethod {
    return this.quickSelect.methods().find((m) => m.id === this.method) ?? this.quickSelect.methods()[0];
  }

  /** What a method may know of the volume's image beyond the block it is handed. */
  private quickExtras(session: Session): Pick<QuickSelectRequest, "read" | "source" | "context" | "progress"> {
    const r = session.reference;
    const affine = session.referenceAffine();
    return {
      read: (lo, hi, signal) => session.imageBox(lo, hi, signal),
      source:
        r === undefined
          ? undefined
          : {
              key: `${r.store}|${r.level}|${affine ? Array.from(affine, (v) => +v.toFixed(6)).join(",") : ""}`,
              window: layerWindow(this.ctx.viewer.layerSpec(r.layer)),
              spacing: voxelEdges(session.volume.voxelToRas),
              size: [...session.volume.size] as Vec3,
            },
      context: this.quickContext,
      progress: (text, fraction) => {
        this.quickStatus = { text, fraction };
        this.changed();
      },
    };
  }

  private async runQuick(start: { voxel: Vec3; axis?: number; negative: boolean }, end: Vec3): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    const method = this.quickMethod();
    const a = start.voxel.map(voxelIndex) as Vec3;
    const b = end.map(voxelIndex) as Vec3;
    const moved = Math.max(...a.map((v, k) => Math.abs(v - b[k]))) >= 2;
    let prompt: Prompt;
    let lo: Vec3;
    let hi: Vec3;
    if (moved && start.axis !== undefined && method.prompts.includes("box")) {
      lo = a.map((v, k) => Math.min(v, b[k])) as Vec3;
      hi = a.map((v, k) => Math.max(v, b[k]) + 1) as Vec3;
      lo[start.axis] = a[start.axis];
      hi[start.axis] = a[start.axis] + 1;
      prompt = { kind: "box", lo, hi };
    } else if (method.prompts.includes("point")) {
      // The region a click may grow into: 64 voxels around, in the section in a 2-D view.
      lo = a.map((v) => v - 64) as Vec3;
      hi = a.map((v) => v + 65) as Vec3;
      if (start.axis !== undefined) {
        lo[start.axis] = a[start.axis];
        hi[start.axis] = a[start.axis] + 1;
      }
      prompt = { kind: "point", at: a };
    } else {
      this.ctx.ui.toast(`${method.title} takes a box: drag one in a 2-D view.`);
      return;
    }
    // A method that refines: a box starts the section's prompt again; a click adds to it (wanted, or not with Shift or Alt).
    let prompts: QuickSelectRequest["prompts"];
    if (method.refines && start.axis !== undefined) {
      const axis = start.axis;
      const index = a[axis];
      const q = this.quickPrompts;
      const same = q !== undefined && q.session === session && q.method === method.id && q.axis === axis && q.index === index;
      if (prompt.kind === "box") this.quickPrompts = { session, method: method.id, axis, index, box: { lo, hi }, points: [] };
      else if (same) q.points.push({ at: a, positive: !start.negative });
      else if (start.negative) {
        this.ctx.ui.toast("Shift+click or Alt+click marks what is not wanted: first click on what is, or draw a box round it.");
        return;
      } else this.quickPrompts = { session, method: method.id, axis, index, points: [{ at: a, positive: true }] };
      const p = this.quickPrompts!;
      prompts = { box: p.box, points: p.points.map((x) => ({ ...x })) };
      this.previewOverlay.draw();
    }
    const image: ImageBlock | undefined = await session.imageBox(lo, hi);
    if (image === undefined) {
      this.ctx.ui.toast("Quick select reads an image: choose one under “Image values”.");
      return;
    }
    // Enter or Escape while the mask is computed says now what to do with it.
    this.decided = undefined;
    this.ctx.context.set(SELECTING, true);
    const abort = (this.quickAbort = new AbortController());
    let mask: Mask;
    try {
      // Escape (or Stop) ends the wait at once, even while the model downloads: the strokes queued behind it go on.
      mask = await untilAborted(method.run({ prompt, image, axis: start.axis, tolerance: this.tolerance, prompts, ...this.quickExtras(session) }, abort.signal), abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) this.ctx.ui.toast(`${method.title}: ${e instanceof Error ? e.message : String(e)}`);
      this.quickPrompts = undefined;
      this.previewOverlay.draw();
      return;
    } finally {
      this.ctx.context.set(SELECTING, false);
      if (this.quickAbort === abort) this.quickAbort = undefined;
      this.quickStatus = undefined;
      this.changed();
    }
    const decided = this.decided;
    this.decided = undefined;
    if (decided === "cancel") return;
    // The scene or the label volume changed while the mask was worked out: it belongs to neither.
    if (this.current !== session) return;
    const voxels = maskCount(mask);
    if (voxels === 0) {
      this.ctx.ui.toast("Quick select found nothing there.");
      return;
    }
    if (this.quickMode === "paint" || decided === "accept") {
      this.quickPrompts = undefined;
      await this.paintMask(session, mask);
      this.previewOverlay.draw();
      return;
    }
    // Shown first: Enter (or Accept) paints it, Escape (or Cancel) drops it; a new prompt replaces it.
    this.pending = { session, mask, voxels, axis: start.axis };
    this.ctx.context.set(PREVIEWING, true);
    this.previewOverlay.draw();
    this.changed();
  }

  /** Whether the mask proposed lies in one section of a 2-D view, so it can be spread to the next. */
  canSpread(): boolean {
    const p = this.pending;
    return p !== undefined && p.axis !== undefined && p.mask.size[p.axis] === 1 && this.quickMethod().prompts.includes("box");
  }

  /**
   * Spreads the mask proposed, in one section, to `n` sections each way:
   * each section's prompt is the box round the mask in the section before
   * (a tenth larger each side), with the method chosen; it stops where the
   * mask comes back empty, or four times smaller or larger than the one
   * before.  The masks are proposed together, so Enter paints them as one
   * stroke (one undo).
   */
  spread(n = this.spreadCount): void {
    const p = this.pending;
    if (p === undefined || !this.canSpread()) {
      this.ctx.ui.toast("Spread takes a mask in one section: make one with quick select in a 2-D view first.");
      return;
    }
    this.enqueue(() => this.runSpread(p, n));
  }

  private async runSpread(p: NonNullable<Editor["pending"]>, n: number): Promise<void> {
    const { session } = p;
    const axis = p.axis!;
    const method = this.quickMethod();
    const [ua, wa] = sectionAxes(axis);
    const size = session.volume.size;
    const base = p.mask.lo[axis];
    const masks: Mask[] = [p.mask];
    const abort = (this.quickAbort = new AbortController());
    this.ctx.context.set(SELECTING, true);
    const extras = this.quickExtras(session);
    let done = 0;
    try {
      for (const dir of [-1, 1]) {
        let before = p.mask;
        let count = p.voxels;
        for (let k = 1; k <= n; ++k) {
          const index = base + dir * k;
          if (index < 0 || index >= size[axis]) break;
          const bounds = sectionBounds(before, axis);
          if (bounds === undefined) break;
          const lo = [0, 0, 0] as Vec3;
          const hi = [0, 0, 0] as Vec3;
          lo[axis] = index;
          hi[axis] = index + 1;
          for (const [i, ax] of [[0, ua], [1, wa]] as const) {
            const pad = Math.max(1, Math.round(0.1 * (bounds.hi[i] - bounds.lo[i])));
            lo[ax] = Math.max(0, bounds.lo[i] - pad);
            hi[ax] = Math.min(size[ax], bounds.hi[i] + pad);
          }
          ++done;
          const step = `Spreading: section ${index} (${done} of up to ${2 * n})`;
          this.quickStatus = { text: `${step}…`, fraction: done / (2 * n) };
          this.changed();
          const image = await session.imageBox(lo, hi, abort.signal);
          if (image === undefined || abort.signal.aborted || this.pending !== p) return;
          const progress = (text: string, fraction?: number) => {
            this.quickStatus = { text: `${step}: ${text}`, fraction: fraction ?? done / (2 * n) };
            this.changed();
          };
          const mask = await untilAborted(method.run({ prompt: { kind: "box", lo, hi }, image, axis, tolerance: this.tolerance, prompts: { box: { lo, hi }, points: [] }, ...extras, progress }, abort.signal), abort.signal);
          if (abort.signal.aborted || this.pending !== p) return;
          const voxels = maskCount(mask);
          if (voxels === 0 || voxels * 4 < count || voxels > 4 * count) break;
          masks.push(mask);
          before = mask;
          count = voxels;
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) this.ctx.ui.toast(`Spread: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      this.ctx.context.set(SELECTING, false);
      if (this.quickAbort === abort) this.quickAbort = undefined;
      this.quickStatus = undefined;
      this.changed();
    }
    if (this.pending !== p) return;
    const mask = stackMasks(masks)!;
    const voxels = maskCount(mask);
    this.pending = { session, mask, voxels };
    const first = mask.lo[axis];
    const last = first + mask.size[axis] - 1;
    this.ctx.ui.toast(
      masks.length > 1
        ? `Spread over ${masks.length} sections (${first} to ${last} along ${"xyz"[axis]}), ${voxels.toLocaleString()} voxels: Enter paints them as one stroke.`
        : "Spread found nothing in the next sections.",
    );
    this.previewOverlay.draw();
    this.changed();
  }

  /** Paints quick select's proposed mask with the active segment (as Paint over says). */
  acceptPreview(): void {
    const p = this.pending;
    if (p === undefined) {
      // Still computing: painted as soon as it comes.
      this.decided = "accept";
      return;
    }
    this.clearPreview();
    this.enqueue(() => this.paintMask(p.session, p.mask));
  }

  /** Drops quick select's proposed mask (and stops what it is computing). */
  cancelPreview(): void {
    this.quickAbort?.abort();
    if (this.pending !== undefined) this.clearPreview();
    else {
      this.decided = "cancel";
      if (this.quickPrompts !== undefined) {
        this.quickPrompts = undefined;
        this.previewOverlay.draw();
      }
    }
  }

  /** What Enter or Escape asked for while quick select was computing. */
  private decided: "accept" | "cancel" | undefined;

  private clearPreview(): void {
    this.pending = undefined;
    this.quickPrompts = undefined;
    this.ctx.context.set(PREVIEWING, false);
    this.previewOverlay.draw();
    this.changed();
  }

  /** Paints a mask with the active segment, as one stroke. */
  private async paintMask(session: Session, mask: Mask): Promise<void> {
    const release = await this.ready(session, mask.lo as Vec3, mask.lo.map((v, k) => v + mask.size[k]) as Vec3, "The mask");
    if (release === undefined) return;
    try {
      this.paintMaskNow(session, mask);
    } finally {
      release();
    }
  }

  private paintMaskNow(session: Session, mask: Mask): void {
    const stroke = new Stroke(session.volume);
    const only = this.overwrite === "empty" ? 0 : undefined;
    let i = 0;
    for (let z = 0; z < mask.size[2]; ++z) {
      for (let y = 0; y < mask.size[1]; ++y) {
        for (let x = 0; x < mask.size[0]; ++x, ++i) {
          if (!mask.data[i]) continue;
          const X = mask.lo[0] + x;
          const Y = mask.lo[1] + y;
          const Z = mask.lo[2] + z;
          if (!session.volume.inside(X, Y, Z)) continue;
          if (only !== undefined && session.volume.get(X, Y, Z) !== only) continue;
          stroke.set(X, Y, Z, this.value);
        }
      }
    }
    if (stroke.changes === 0) this.ctx.ui.toast("Nothing to paint: the mask is painted already (or only over empty voxels, as Paint over says).");
    this.commit(stroke, session);
  }

  /**
   * What undo (or redo) takes now: the current volume's last stroke or the
   * workspace's last change, whichever came last (for redo, the one undone
   * first), so the two undo as one history (`chooseUndo`).
   */
  undoTarget(redo: boolean): { kind: "stroke" } | { kind: "workspace"; label: string } | undefined {
    const h = this.current?.history;
    const steps = this.ctx.workspace.undoSteps();
    const workspace = redo ? steps.redo : steps.undo;
    const which = chooseUndo(redo ? h?.redoTime : h?.undoTime, workspace?.time, redo);
    return which === "workspace" ? { kind: "workspace", label: workspace!.label } : which && { kind: which };
  }

  undo(redo: boolean): void {
    const session = this.current;
    // After strokes still being drawn are kept.
    this.enqueue(async () => {
      const target = this.undoTarget(redo);
      if (target?.kind === "workspace" || session === undefined) {
        if (target === undefined || (await this.ctx.commands.invoke(redo ? "edit.redo" : "edit.undo")) === undefined) this.ctx.ui.toast(redo ? "Nothing to redo." : "Nothing to undo.");
        this.changed();
        return;
      }
      const keys = redo ? session.history.redo() : session.history.undo();
      if (keys.length === 0) {
        this.ctx.ui.toast(redo ? "Nothing to redo." : "Nothing to undo.");
        return;
      }
      session.changed(keys);
      session.unsaved += 1;
      session.refresh();
      this.recount();
    });
  }

  /** Counts the segments a little after strokes stop. */
  private recount(): void {
    this.changed();
    clearTimeout(this.countsTimer);
    this.countsTimer = setTimeout(() => {
      if (this.current) this.current.counts = this.current.volume.counts();
      this.changed();
    }, 300);
  }

  /** Sets the range to the value under the pointer, ± the tolerance of the image's range near it. */
  async rangeFromCursor(): Promise<void> {
    const session = this.current;
    const placed = session?.placement();
    const cursor = this.ctx.viewer.cursor();
    if (session === undefined || placed === undefined || session.reference === undefined) {
      this.ctx.ui.toast("Choose an image for its values first.");
      return;
    }
    const position = cursor.active ? cursor.position : ((this.ctx.viewer.getState() as { position?: number[] }).position ?? []);
    const v = toVoxel(placed, position).map(voxelIndex) as Vec3;
    const around = await session.imageBox(v.map((x) => x - 8) as Vec3, v.map((x) => x + 9) as Vec3);
    if (around === undefined) return;
    const centre = v.map((x, k) => x - around.lo[k]);
    const value = around.data[centre[0] + around.size[0] * (centre[1] + around.size[1] * centre[2])];
    if (!Number.isFinite(value)) {
      this.ctx.ui.toast("The pointer is outside the image.");
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of around.data) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    const t = Math.max(this.tolerance * (hi - lo), 1e-6);
    this.low = Number((value - t).toPrecision(4));
    this.high = Number((value + t).toPrecision(4));
    this.changed();
  }

  // --------------------------------------------------------------- save

  /** A save under way (one at a time: two would write the same files). */
  private saving = false;

  async save(): Promise<void> {
    const session = this.current;
    if (session === undefined) {
      this.ctx.ui.toast("No label volume to save.");
      return;
    }
    if (this.saving) {
      this.ctx.ui.toast("A save is under way: wait for it to finish.");
      return;
    }
    this.saving = true;
    try {
      await this.saveSession(session);
    } catch (e) {
      // A file picker that failed (not one closed), or a folder that could not be made.
      this.setNote(`Could not save: ${(e as Error).message}`);
    } finally {
      this.saving = false;
    }
  }

  /** Changes counted as saved: those made before the save began (strokes made during it are still unsaved). */
  private markSaved(session: Session, before: number): void {
    session.unsaved = Math.max(0, session.unsaved - before);
  }

  private async saveSession(session: Session): Promise<void> {
    const volume = session.volume;
    if (volume instanceof CowVolume) return this.saveEdited(session, volume);
    const box = this.saveCrop ? volume.paintedBox() : undefined;
    if (this.saveCrop && box === undefined) {
      this.ctx.ui.toast("Nothing is painted yet.");
      return;
    }
    const out = box ? cropped(volume, box) : volume;
    const zarr = this.saveFormat === "zarr";
    if (!zarr && niftiBytes(out) > MAX_NIFTI) {
      this.ctx.ui.toast("Too large for one NIfTI file: save only the painted box, or as OME-Zarr (which writes only what is painted).", "error");
      this.ctx.ui.showPanel(SEGMENTATION_PANEL);
      return;
    }
    const base = fileName(session.layer) + (box ? "_box" : "");
    const suffix = zarr ? ".ome.zarr" : ".nii.gz";
    const picker = window as unknown as FilePicker;
    let file: FileSystemFileHandle | undefined;
    let folder: FileSystemDirectoryHandle | undefined;
    // Where to, asked first: a picker needs the click that asked for it.
    try {
      if (zarr && picker.showDirectoryPicker) folder = await picker.showDirectoryPicker({ id: "ngplatform-save", mode: "readwrite" });
      else if (!zarr && picker.showSaveFilePicker) file = await picker.showSaveFilePicker({ id: "ngplatform-save", suggestedName: base + suffix, types: [{ description: "NIfTI", accept: { "application/octet-stream": [suffix] } }] });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
      throw e;
    }
    const description = `${session.layer}, labels drawn in ngplatform`;
    const before = session.unsaved;
    this.setNote("Writing…");
    try {
      let where: string;
      if (zarr) {
        const files = await omeZarr(out, description, (done, total) => this.setNote(`Writing: ${Math.round((100 * done) / total)}%`), this.savedLabels(session));
        where = await writeFolder(files, folder, base + suffix);
      } else {
        const bytes = await niftiGz(out, description);
        if (file) {
          const w = await file.createWritable();
          await w.write(bytes as unknown as BufferSource);
          await w.close();
          where = file.name;
        } else {
          download(new Blob([bytes as BlobPart]), base + suffix);
          where = base + suffix;
        }
      }
      this.markSaved(session, before);
      this.setNote(`Saved ${where}: ${out.size.join(" × ")}${box ? `, the painted box from voxel ${box.lo.join(", ")}` : ""}.`);
      this.ctx.log.info(`Saved ${session.layer} as ${where}.`);
    } catch (e) {
      this.setNote(`Could not save: ${(e as Error).message}`);
    }
  }

  /** The segments' names, colours and groups, as saved. */
  private savedLabels(session: Session): SavedLabel[] {
    const groups = this.groups(session);
    return [...new Set([...session.counts.keys(), ...session.labels.keys()])]
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
      .map((value) => ({ value, name: session.labels.get(value)?.name || session.theirs.get(value)?.name || undefined, colour: session.colour(value), group: groupOf(groups, value)?.name }));
  }

  /**
   * Saves a segmentation edited in place: its edits only (an OME-Zarr of
   * the edited chunks naming the original), or the whole volume (an
   * OME-Zarr written into a folder as a job: the original's chunks copied
   * a block at a time, the edited ones as edited).
   */
  private async saveEdited(session: Session, volume: CowVolume): Promise<void> {
    const whole = this.saveInPlace === "whole";
    const picker = window as unknown as FilePicker;
    if (whole && !picker.showDirectoryPicker) {
      this.ctx.ui.toast("Saving the whole volume writes a folder, which this browser cannot (Chrome and Edge can): save the edits only.", "error");
      return;
    }
    const name = `${fileName(session.layer)}${whole ? "" : "_edits"}.ome.zarr`;
    let folder: FileSystemDirectoryHandle | undefined;
    try {
      if (picker.showDirectoryPicker) folder = await picker.showDirectoryPicker({ id: "ngplatform-save", mode: "readwrite" });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
      throw e;
    }
    const original = volume.original;
    const description = whole ? `${session.layer}: ${original.layer} edited in ngplatform` : `${session.layer}: edits of ${original.layer} (${original.store}) made in ngplatform`;
    const labels = this.savedLabels(session);
    const before = session.unsaved;
    if (!whole) {
      this.setNote("Writing the edits…");
      try {
        const files = await editsZarr(volume, description, (done, total) => this.setNote(`Writing the edits: ${Math.round((100 * done) / total)}%`), labels);
        const where = await writeFolder(files, folder, name);
        this.markSaved(session, before);
        this.setNote(`Saved the edits as ${where}: ${volume.chunkCount} chunks of 64³; the rest is ${original.layer} (${original.store}), which they name. Open edits… opens them over it again.`);
        this.ctx.log.info(`Saved the edits of ${session.layer} as ${where}.`);
      } catch (e) {
        this.setNote(`Could not save: ${(e as Error).message}`);
      }
      return;
    }
    const root = await folder!.getDirectoryHandle(name, { create: true });
    const where = `${folder!.name}/${name}`;
    this.setNote(`Writing the whole volume into ${where}, a job (see Jobs); edits made meanwhile may or may not be in it.`);
    try {
      const n = await this.ctx.jobs.run(`Saving ${session.layer}`, (job) =>
        writeWhole(volume, (path, bytes) => writeFile(root, path, bytes), {
          description,
          labels,
          progress: (done, total) => job.progress(done / total, `Block ${done} of ${total}`),
          cancelled: () => job.cancelled,
        }),
      );
      this.markSaved(session, before);
      this.setNote(`Saved the whole volume as ${where}: ${n.toLocaleString()} chunks.`);
      this.ctx.log.info(`Saved ${session.layer} (the whole volume) as ${where}.`);
    } catch (e) {
      this.setNote(`Could not save the whole volume: ${(e as Error).message}`);
    }
  }

  /** Asks for a saved edits folder (Save → Edits only) and opens it over its original. */
  pickEdits(): void {
    const input = el("input", { type: "file" }) as HTMLInputElement;
    input.webkitdirectory = true;
    input.addEventListener("change", () => {
      if (input.files?.length) void this.openEdits([...input.files]);
    });
    input.click();
  }

  /**
   * Opens saved edits (the files of an edits-only OME-Zarr folder, with
   * their paths) over their original again, as a segmentation edited in
   * place; says so if the original cannot be read.
   */
  async openEdits(files: File[]): Promise<boolean> {
    // Paths within the folder: "x_edits.ome.zarr/0/c/1/2/3" → "0/c/1/2/3".
    const byPath = new Map<string, Blob>();
    for (const f of files) byPath.set((f.webkitRelativePath || f.name).split("/").slice(f.webkitRelativePath ? 1 : 0).join("/"), f);
    const folder = files[0]?.webkitRelativePath.split("/")[0] || "the folder";
    try {
      const saved = await readEdits(byPath);
      const name = folder.replace(/(_edits)?\.ome\.zarr$/i, "") || `${saved.note.original.layer} (edited)`;
      const volume = await this.overOriginal(saved.note.original, name, saved.note.size);
      if (volume.type !== saved.note.type) throw new Error(`its original now holds ${volume.type} labels, the edits ${saved.note.type}`);
      for (const c of saved.chunks) volume.putChunk(volume.key(...c.at), c.data);
      const session = await Session.open(this.ctx, this.voxels, volume, name);
      for (const l of saved.labels) if (l.name || l.colour) session.labels.set(l.value, { name: l.name ?? "", colour: l.colour ?? session.colour(l.value) });
      await this.theirLabels(saved.note.original.layer, session);
      await this.chooseReference(session, readableImages(this.ctx).find((l) => l !== session.layer));
      this.adopt(session);
      session.changed(volume.keys());
      session.applyColours([...session.labels.keys()]);
      session.refresh();
      this.ctx.log.info(`Opened ${folder}: ${saved.chunks.length} edited chunks over ${saved.note.original.layer} (${saved.note.original.store}).`);
      return true;
    } catch (e) {
      this.ctx.ui.toast(`Could not open ${folder}: ${(e as Error).message}`, "error");
      return false;
    }
  }

  private setNote(text: string): void {
    this.note = text;
    this.changed();
  }
}

interface Brushing {
  session: Session;
  stroke: Stroke;
  q: number[];
  paint: Paint;
  /** The image range it is limited to. */
  range: [number, number] | undefined;
  disc: boolean;
}

/** Writes a file by its path under a folder, making the folders on the way. */
async function writeFile(root: FileSystemDirectoryHandle, path: string, bytes: Uint8Array): Promise<void> {
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(bytes as unknown as BufferSource);
  await w.close();
}

/** Files by path written into `name` in a folder, or (no folder) downloaded as `name`.zip; resolves where. */
async function writeFolder(files: Map<string, Uint8Array>, folder: FileSystemDirectoryHandle | undefined, name: string): Promise<string> {
  if (folder) {
    const root = await folder.getDirectoryHandle(name, { create: true });
    for (const [path, bytes] of files) await writeFile(root, path, bytes);
    return `${folder.name}/${name}`;
  }
  download(zipFiles(new Map([...files].map(([p, b]) => [`${name}/${p}`, b]))), `${name}.zip`);
  return `${name}.zip`;
}

/** The voxel axis a normal is closest to. */
function dominant(n: Vec3): number {
  const a = n.map(Math.abs);
  return a.indexOf(Math.max(...a));
}

/** The first value of a block that is not a label a volume holding up to `max` takes; NaN (outside the image) is none. */
export function badLabel(data: ArrayLike<number>, max: number): number | undefined {
  for (let j = 0; j < data.length; ++j) {
    const v = data[j];
    if (v !== v) continue;
    if (v < 0 || v > max || v !== Math.floor(v)) return v;
  }
  return undefined;
}

/** The label type that holds a stored type's values: 8 and 16 bits as they are, anything else in 32. */
export function labelTypeOf(stored: string): LabelType {
  return /^u?int8$/.test(stored) ? "uint8" : /^u?int16$/.test(stored) ? "uint16" : "uint32";
}

export function fmtBytes(n: number): string {
  return n >= 2 ** 30 ? `${fmt(n / 2 ** 30, 3)} GB` : n >= 2 ** 20 ? `${fmt(n / 2 ** 20, 3)} MB` : `${Math.round(n / 1024)} KB`;
}

export type { ImageLevel, Reference };

/** `p`, or an AbortError as soon as `signal` aborts (the work behind `p` may finish later, unheeded). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
