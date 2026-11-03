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
 *    (./quick_select.ts).  Brush and fills can be limited to an intensity
 *    range of an image.
 *  - Segments (./segments.ts): the active one, new ones, names, colours,
 *    shown or hidden, gone to, merged and deleted.
 *  - Undo and redo of strokes; Save as NIfTI or OME-Zarr (./save.ts).
 *
 * The volume lives in the page (./label_volume.ts) and shows as a
 * segmentation layer that reads it as an OME-Zarr store (./session.ts).
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { mmOf, toGlobal, toVoxel, voxelEdges } from "../annotations/geometry.js";
import { space as spaceOf } from "../annotations/scene.js";
import { download, el, fileName, fmt } from "../annotations/ui.js";
import { type ImageLevel, layerStore, readableImages, type Voxels } from "../annotations/voxels.js";
import { zipFiles } from "../registration/volume_io.js";
import { storeOf } from "../volume-view/sources.js";
import { Stroke } from "./history.js";
import { ballReach, ballShape, dabsBetween, floodFill, type ImageBlock, inRange, interpolate, type Paint, paintBall, relabel, sameLabel, type Vec3, voxelIndex } from "./kernels.js";
import { discard, type KeptInfo, kept, restore } from "./keep.js";
import { LABEL_MAX, type LabelType, LabelVolume } from "./label_volume.js";
import { BRUSHING, DRAWING, EDITING, SEGMENTATION_PANEL } from "./manifest.js";
import { Painter, type ViewPoint } from "./painter.js";
import { type Prompt, QuickSelectRegistry } from "./quick_select.js";
import { cropped, niftiBytes, niftiGz, omeZarr } from "./save.js";
import { isVisible, nextSegment, type SegmentRow, segmentRows, type SegmentsState, withVisibility } from "./segments.js";
import { type Reference, Session } from "./session.js";
import { brushes, cycle, draws, stepRadius, type Tool, TOOLS } from "./tools.js";

/** A NIfTI holds every voxel: beyond this, save the painted box only. */
export const MAX_NIFTI = 2 * 2 ** 30;
/** Voxels read to open a label image or copy a segmentation. */
export const MAX_COPY = 512 * 2 ** 20;
/** Labels are read as 32-bit floats, exact to here. */
const EXACT = 2 ** 24;
/** The block a copy is read in, in voxels. */
const COPY_BLOCK: Vec3 = [256, 256, 64];

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
  private readonly painter: Painter;
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
  limit = false;
  low = 0;
  high = 255;
  fillBy: "image" | "label" = "label";
  reach = 32;
  method = "threshold";
  tolerance = 0.1;
  saveFormat: "nii.gz" | "zarr" = "nii.gz";
  saveCrop = false;
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
  private quickStart: { voxel: Vec3; axis?: number } | undefined;
  private quickEnd: Vec3 | undefined;
  private countsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Volumes already looked for after a reload. */
  private readonly sought = new Set<string>();

  constructor(
    private readonly ctx: PlatformContext,
    private readonly voxels: Voxels,
  ) {
    this.painter = new Painter(ctx, {
      down: (p) => this.down(p),
      drag: (p) => this.drag(p),
      up: () => this.up(),
      ring: (p) => this.ring(p),
      boxDrag: () => this.tool === "quick",
      wheel: (notches) => {
        if (!brushes(this.tool)) return false;
        this.brushSize(notches);
        return true;
      },
    });
    this.offs.push(ctx.services.provide("segmentation.quickSelect", this.quickSelect), ctx.services.provide("segmentation.labelVolumes", this as LabelVolumes), this.quickSelect.onChanged(() => this.changed()));
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
    // Each scene shows its own label volumes, as if it were a viewer of its
    // own: a layer removed (or another scene shown) ends editing the volume
    // it showed, and the scene's first volume becomes the current one.  A
    // label layer whose volume went with a reload comes back from the browser.
    this.offs.push(
      ctx.viewer.onLayersChanged(() => {
        const here = this.inScene();
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
    this.tool = tool;
    if (draws(tool)) this.editing = true;
    this.apply();
  }

  /** Shows or hides the tool bar; hidden, the views are Neuroglancer's again. */
  setEditing(on: boolean): void {
    if (on && this.current === undefined) on = false;
    this.editing = on;
    if (!on) this.tool = "move";
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

  setCurrent(session: Session): void {
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
    const rows = segmentRows(s.counts, s.labels, (v) => s.colour(v), (v) => isVisible(state, v));
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
    const v = nextSegment([...s.counts.keys(), ...s.labels.keys(), this.value], LABEL_MAX[s.volume.type]);
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
    const state = this.segmentsState(session);
    if (isVisible(state, value) === visible) return;
    const known = [...new Set([...session.counts.keys(), ...session.labels.keys(), this.value])];
    const next = withVisibility(state, known, value, visible);
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

  /** Moves the views to a segment: its voxel nearest its centre. */
  goTo(value: number): void {
    const s = this.current;
    const placed = s?.placement();
    if (s === undefined || placed === undefined) return;
    const voxel = s.volume.centre(value);
    if (voxel === undefined) {
      this.ctx.ui.toast(`Segment ${value} is not painted.`);
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
    if (n > 0 && !(await this.ctx.ui.confirm(`Delete segment ${value}: erase its ${n.toLocaleString()} voxels? (Undo brings them back.)`))) return;
    this.enqueue(() => {
      const stroke = new Stroke(s.volume);
      relabel(stroke, value, 0);
      s.labels.delete(value);
      s.changed([]);
      this.commit(stroke, s, 0);
      if (this.value === value) this.value = this.rows().find((r) => r.value !== value)?.value ?? 1;
      this.changed();
    });
  }

  /** Gives a segment's voxels to the active segment (undoable). */
  merge(from: number, into = this.value): void {
    const s = this.current;
    if (s === undefined || from === into) return;
    this.enqueue(() => {
      const stroke = new Stroke(s.volume);
      const n = relabel(stroke, from, into);
      s.labels.delete(from);
      s.changed([]);
      this.ctx.ui.toast(`Merged segment ${from} into ${into}: ${n.toLocaleString()} voxels.`);
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
    const volume = await restore(info);
    const session = await Session.open(this.ctx, this.voxels, volume, info.name, { id: info.id, replace });
    for (const [value, label] of info.labels) session.labels.set(value, label);
    if (info.reference && this.ctx.viewer.layers().some((l) => l.name === info.reference)) await this.chooseReference(session, info.reference);
    this.adopt(session, replace === undefined);
    session.applyColours([...session.counts.keys(), ...session.labels.keys()]);
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
        const data = await this.voxels.block(store, level, lo, extent);
        for (let j = 0; j < data.length; ++j) {
          const v = data[j];
          if (v > max) throw new Error(`label ${v} is more than a ${volume.type} volume holds`);
          if (v > EXACT) throw new Error(`labels above ${EXACT.toLocaleString()} are not read exactly`);
        }
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
    if (b.range !== undefined) {
      const lo = at.map((v, k) => Math.floor(v - reach[k]) - 1) as Vec3;
      const hi = at.map((v, k) => Math.ceil(v + reach[k]) + 2) as Vec3;
      const block = await b.session.imageBlock(lo, hi);
      if (block) paint.where = inRange(block, b.range[0], b.range[1]);
    }
    paintBall(b.stroke, at, b.q, paint, b.disc ? normal : undefined);
    if (b.stroke.flush().length) b.session.refresh(true);
  }

  private down(p: ViewPoint): void {
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
        const v = session.volume.get(...(voxel.map(voxelIndex) as Vec3));
        if (v > 0) this.activate(v);
        else this.ctx.ui.toast("No segment there (0).");
        break;
      }
      case "fill": {
        const threeD = this.fill3d || normal === undefined;
        this.enqueue(() => this.fill(voxel, threeD ? undefined : normal));
        break;
      }
      case "quick":
        this.quickStart = { voxel, axis: normal ? dominant(normal) : undefined };
        this.quickEnd = voxel;
        break;
    }
  }

  /** Fills the sections between those where the active segment is drawn, along the last view's axis. */
  interpolate(): void {
    const session = this.current;
    if (session === undefined) return;
    const value = this.value;
    const axis = this.axis;
    const only = this.overwrite === "empty" ? 0 : undefined;
    this.enqueue(() => {
      const box = session.volume.paintedBox(value);
      if (box === undefined) {
        this.ctx.ui.toast(`Segment ${value} is not drawn yet.`);
        return;
      }
      const stroke = new Stroke(session.volume);
      const sections = interpolate(stroke, value, axis, box, only);
      this.ctx.ui.toast(
        sections
          ? `Filled ${sections} section${sections === 1 ? "" : "s"} of segment ${value} between those drawn: ${stroke.changes.toLocaleString()} voxels${only === 0 ? " (empty ones only)" : ""}.`
          : `Segment ${value} has no gaps between drawn sections along ${"xyz"[axis]}: draw it in two sections a few apart.`,
      );
      this.commit(stroke, session, value);
    });
  }

  private drag(p: ViewPoint): void {
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
    session.history.push(stroke);
    session.changed(stroke.keys());
    session.unsaved++;
    session.refresh();
    if (value > 0) {
      session.applyColours([value]);
      // A segment painted shows, even where others are hidden.
      this.show(session, value, true, true);
    }
    this.recount();
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
    this.commit(stroke);
  }

  private async runQuick(start: { voxel: Vec3; axis?: number }, end: Vec3): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    const method = this.quickSelect.methods().find((m) => m.id === this.method) ?? this.quickSelect.methods()[0];
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
    const image: ImageBlock | undefined = await session.imageBox(lo, hi);
    if (image === undefined) {
      this.ctx.ui.toast("Quick select reads an image: choose one under “Image values”.");
      return;
    }
    const mask = await method.run({ prompt, image, axis: start.axis, tolerance: this.tolerance }, new AbortController().signal);
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
    if (stroke.changes === 0) this.ctx.ui.toast("Quick select found nothing there.");
    this.commit(stroke);
  }

  undo(redo: boolean): void {
    const session = this.current;
    if (session === undefined) return;
    this.enqueue(() => {
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

  async save(): Promise<void> {
    const session = this.current;
    if (session === undefined) {
      this.ctx.ui.toast("No label volume to save.");
      return;
    }
    const volume = session.volume;
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
    this.setNote("Writing…");
    try {
      let where: string;
      if (zarr) {
        const labels = [...session.counts.keys()].sort((a, b) => a - b).map((value) => ({ value, name: session.labels.get(value)?.name || undefined, colour: session.colour(value) }));
        const files = await omeZarr(out, description, (done, total) => this.setNote(`Writing: ${Math.round((100 * done) / total)}%`), labels);
        if (folder) {
          const root = await folder.getDirectoryHandle(base + suffix, { create: true });
          for (const [path, bytes] of files) {
            const parts = path.split("/");
            let dir = root;
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
            const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
            await w.write(bytes as unknown as BufferSource);
            await w.close();
          }
          where = `${folder.name}/${base}${suffix}`;
        } else {
          download(zipFiles(new Map([...files].map(([p, b]) => [`${base}${suffix}/${p}`, b]))), `${base}${suffix}.zip`);
          where = `${base}${suffix}.zip`;
        }
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
      session.unsaved = 0;
      this.setNote(`Saved ${where}: ${out.size.join(" × ")}${box ? `, the painted box from voxel ${box.lo.join(", ")}` : ""}.`);
      this.ctx.log.info(`Saved ${session.layer} as ${where}.`);
    } catch (e) {
      this.setNote(`Could not save: ${(e as Error).message}`);
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

/** The voxel axis a normal is closest to. */
function dominant(n: Vec3): number {
  const a = n.map(Math.abs);
  return a.indexOf(Math.max(...a));
}

/** The label type that holds a stored type's values: 8 and 16 bits as they are, anything else in 32. */
export function labelTypeOf(stored: string): LabelType {
  return /^u?int8$/.test(stored) ? "uint8" : /^u?int16$/.test(stored) ? "uint16" : "uint32";
}

export function fmtBytes(n: number): string {
  return n >= 2 ** 30 ? `${fmt(n / 2 ** 30, 3)} GB` : n >= 2 ** 20 ? `${fmt(n / 2 ** 20, 3)} MB` : `${Math.round(n / 1024)} KB`;
}

export type { ImageLevel, Reference };
