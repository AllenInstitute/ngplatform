/**
 * The Segmentation section: label volumes drawn by hand, as WebKnossos's
 * volume annotation (see docs/plugins/segmentation-survey.md).
 *
 *  - New: an empty label volume on an image's grid (a level of it: the same
 *    voxels and placement), 8, 16 or 32 bits; or Open a NIfTI label image.
 *  - Tools, in the views (./painter.ts): a brush (a ball, or its disc in
 *    the section; radius in mm or voxels), an eraser, fills of the section
 *    and of a bounded box, a picker, and quick select (./quick_select.ts).
 *    Brush and fills can be limited to an intensity range of an image.
 *  - Undo and redo of strokes; Save as NIfTI or OME-Zarr (./save.ts).
 *
 * The volume lives in the page (./label_volume.ts) and shows as a
 * segmentation layer that reads it as an OME-Zarr store (./session.ts).
 */
import type { Disposer, PlatformContext } from "@ngplatform/sdk";
import { mmOf, toVoxel, voxelEdges, voxelVolume } from "../geometry.js";
import { PAINTING } from "../manifest.js";
import { space as spaceOf } from "../scene.js";
import { button, download, el, field, fileName, fmt, numberInput, physical, select } from "../ui.js";
import { type ImageLevel, layerStore, readableImages, type Voxels } from "../voxels.js";
import { storeOf } from "../../volume-view/sources.js";
import { Stroke } from "./history.js";
import { ballReach, ballShape, dabsBetween, floodFill, type ImageBlock, inRange, interpolate, type Paint, paintBall, sameLabel, type Vec3 } from "./kernels.js";
import { LABEL_MAX, type LabelType, LabelVolume } from "./label_volume.js";
import { Painter, type ViewPoint } from "./painter.js";
import { type Prompt, QuickSelectRegistry } from "./quick_select.js";
import { cropped, niftiBytes, niftiGz, omeZarr } from "./save.js";
import { type Reference, Session } from "./session.js";
import { zipFiles } from "../../registration/volume_io.js";

export type Tool = "brush" | "erase" | "fill2d" | "fill3d" | "pick" | "quick";

const TOOLS: [Tool, string, string][] = [
  ["brush", "Brush", "Paint the label (B)"],
  ["erase", "Erase", "Paint 0 (E)"],
  ["fill2d", "Fill 2-D", "Fill the region clicked, in its section (F)"],
  ["fill3d", "Fill 3-D", "Fill the region clicked, in a box around it (Shift+F)"],
  ["pick", "Pick", "Take the label clicked (I)"],
  ["quick", "Quick select", "Drag a box, or click (Q)"],
];

/** A NIfTI holds every voxel: beyond this, save the painted box only. */
const MAX_NIFTI = 2 * 2 ** 30;
/** Voxels read to open a label image (as 32-bit numbers). */
const MAX_OPEN = 512 * 2 ** 20;

type FilePicker = {
  showSaveFilePicker?(o?: unknown): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle>;
};

export class Segmentation {
  readonly sessions: Session[] = [];
  current: Session | undefined;
  readonly quickSelect = new QuickSelectRegistry();
  private readonly painter: Painter;
  private readonly offs: Disposer[] = [];

  // Tool settings (this visit).
  tool: Tool = "brush";
  value = 1;
  radius = 1;
  unit: "mm" | "voxels" = "mm";
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

  // The New form's choices.
  private newImage = "";
  private newLevel = 0;
  private newType: LabelType = "uint8";
  private newName = "Labels";
  private showForm = false;
  private saveFormat: "nii.gz" | "zarr" = "nii.gz";
  private saveCrop = false;
  private note = "";

  /** Work on the volume in order (a stroke's dabs may wait for image values). */
  private queue: Promise<void> = Promise.resolve();
  private brushing: Brushing | undefined;
  private last: Vec3 | undefined;
  private quickStart: { voxel: Vec3; axis?: number } | undefined;
  private quickEnd: Vec3 | undefined;
  private update: (() => void) | undefined;
  private countsTimer: ReturnType<typeof setTimeout> | undefined;
  private get counts(): Map<number, number> {
    return this.current?.counts ?? new Map();
  }

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
    });
    this.offs.push(ctx.services.provide("annotations.quickSelect", this.quickSelect), this.quickSelect.onChanged(() => this.update?.()));
    const c = ctx.commands;
    c.register("annotations.newLabelVolume", () => {
      this.showForm = true;
      ctx.ui.showPanel("annotations.labels");
      this.update?.();
    });
    c.register("annotations.openLabelVolume", () => this.pickNifti());
    c.register("annotations.saveLabelVolume", () => this.save());
    c.register("annotations.tool", ({ tool }: { tool: Tool }) => {
      if (!TOOLS.some(([t]) => t === tool)) return;
      this.tool = tool;
      this.setDrawing(true);
    });
    c.register("annotations.brushSize", ({ factor }: { factor: number }) => {
      this.radius = Math.max(0.01, Number((this.radius * (factor || 1)).toPrecision(3)));
      this.update?.();
    });
    c.register("annotations.undoStroke", () => this.undo(false));
    c.register("annotations.redoStroke", () => this.undo(true));
    c.register("annotations.interpolate", () => this.interpolate());
    c.register("annotations.stopDrawing", () => this.setDrawing(false));
    // A layer removed from the scene ends its session's drawing.
    this.offs.push(
      ctx.viewer.onLayersChanged(() => {
        if (this.current && !ctx.viewer.layers().some((l) => l.name === this.current!.layer) && this.painter.active) this.setDrawing(false);
      }),
    );
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    this.painter.dispose();
    for (const s of this.sessions) s.dispose();
    clearTimeout(this.countsTimer);
  }

  private setDrawing(on: boolean): void {
    if (on && this.current === undefined) {
      this.ctx.ui.toast("Make or open a label volume first (Annotations → Segmentation).");
      on = false;
    }
    this.painter.active = on;
    this.ctx.context.set(PAINTING, on);
    if (on && this.current) this.ctx.workspace.selectLayer(this.current.layer);
    this.update?.();
  }

  // ------------------------------------------------------------ volumes

  private async create(): Promise<void> {
    const image = this.newImage;
    const store = layerStore(this.ctx, image);
    if (store === undefined) return;
    try {
      const levels = await this.voxels.levels(store);
      const level = levels[Math.min(this.newLevel, levels.length - 1)];
      const volume = new LabelVolume(level.size, this.newType, level.voxelToRas, this.newName);
      const session = await Session.open(this.ctx, this.voxels, volume, this.newName);
      session.setReference({ layer: image, store, level: Math.min(this.newLevel, levels.length - 1), levels });
      this.adopt(session);
      this.ctx.log.info(`New label volume “${session.layer}” on ${image}'s grid: ${level.size.join(" × ")} voxels.`);
    } catch (e) {
      this.ctx.ui.toast(`Could not make the label volume: ${(e as Error).message}`, "error");
    }
  }

  private adopt(session: Session): void {
    this.sessions.push(session);
    this.current = session;
    this.showForm = false;
    this.value = 1;
    session.counts = session.volume.counts();
    session.applyColours([1]);
    this.setDrawing(true);
  }

  private pickNifti(): void {
    const input = el("input", { type: "file", accept: ".nii,.gz" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.openNifti(file);
    });
    input.click();
  }

  /** Opens a NIfTI label image to edit: read whole (as the platform serves it) into a volume in the page. */
  async openNifti(file: File): Promise<void> {
    const found = (await this.ctx.workspace.local.open(file, { derived: true }))[0];
    const store = found && storeOf(found.source);
    if (store === undefined) {
      this.ctx.ui.toast(`${file.name} is not a NIfTI image.`, "error");
      return;
    }
    try {
      await this.ctx.jobs.run(`Opening ${file.name}`, async (job) => {
        const [level] = await this.voxels.levels(store);
        const n = level.size[0] * level.size[1] * level.size[2];
        if (n > MAX_OPEN) throw new Error(`${level.size.join(" × ")} voxels is more than this can open (${MAX_OPEN / 2 ** 20} M)`);
        job.progress(undefined, "Reading");
        const data = await this.voxels.block(store, 0, [0, 0, 0], level.size);
        let max = 0;
        for (let i = 0; i < data.length; ++i) if (data[i] > max) max = data[i];
        const type: LabelType = max <= 255 ? "uint8" : max <= 65535 ? "uint16" : "uint32";
        const name = file.name.replace(/\.nii(\.gz)?$/i, "");
        const volume = new LabelVolume(level.size, type, level.voxelToRas, name);
        // Labels are whole numbers; anything else is rounded (and negatives are 0).
        volume.load(data.map((v) => (v > 0 ? Math.round(v) : 0)));
        const session = await Session.open(this.ctx, this.voxels, volume, name);
        await this.chooseReference(session, readableImages(this.ctx).find((l) => l !== session.layer));
        this.adopt(session);
        session.applyColours([...session.counts.keys()]);
        this.ctx.log.info(`Opened ${file.name} to edit: ${level.size.join(" × ")} voxels, ${type}.`);
      });
    } catch (e) {
      this.ctx.ui.toast(`Could not open ${file.name}: ${(e as Error).message}`, "error");
    } finally {
      this.ctx.workspace.local.close(found.source);
    }
  }

  /** Uses an image's values to limit the tools: its level with voxels nearest in size to the label volume's. */
  private async chooseReference(session: Session, image: string | undefined): Promise<void> {
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
  }

  private async close(session: Session): Promise<void> {
    if (session.unsaved > 0 && !(await this.ctx.ui.confirm(`Close “${session.layer}” without saving its last ${session.unsaved} stroke${session.unsaved === 1 ? "" : "s"}?`))) return;
    session.dispose();
    this.sessions.splice(this.sessions.indexOf(session), 1);
    if (this.ctx.viewer.layers().some((l) => l.name === session.layer)) this.ctx.workspace.removeLayer(session.layer);
    if (this.current === session) this.current = this.sessions[this.sessions.length - 1];
    if (this.current === undefined) this.setDrawing(false);
    this.update?.();
  }

  // ------------------------------------------------------------ drawing

  /** Where a view point is in the label volume, and the section's normal there (2-D views). */
  private locate(p: ViewPoint): { voxel: Vec3; normal?: Vec3 } | undefined {
    const placed = this.current?.placement();
    if (placed === undefined) {
      this.ctx.ui.toast("The label layer has not loaded yet.");
      return undefined;
    }
    const voxel = toVoxel(placed, p.global);
    if (p.depthPerUnit === undefined) return { voxel };
    // The depth's gradient over voxel indices: through the voxels' map to the global dimensions.
    const m = placed.voxelToGlobal;
    const normal = [0, 1, 2].map((k) => placed.dims.reduce((s, d, r) => s + (p.depthPerUnit!.get(d) ?? 0) * m[4 * r + k], 0)) as Vec3;
    if (Math.hypot(...normal) === 0) return { voxel };
    this.axis = dominant(normal);
    return { voxel, normal };
  }

  /** The brush's shape in voxels. */
  private shapeQ() {
    return ballShape(this.radius, this.unit, this.current?.placement()?.voxelToMm ?? this.current?.volume.voxelToRas);
  }

  private ring(p: ViewPoint): number | undefined {
    if ((this.tool !== "brush" && this.tool !== "erase") || this.current === undefined || p.pixelsPerUnit === undefined) return undefined;
    const sp = spaceOf(this.ctx);
    // Pixels per millimetre in the view's plane.
    let perMm = 0;
    for (const [d, px] of p.pixelsPerUnit) if (px > 0 && sp.units[d] === "m") perMm = Math.max(perMm, px / mmOf(sp.scales[d], "m"));
    if (!(perMm > 0)) return undefined;
    const edges = voxelEdges(this.current.placement()?.voxelToMm ?? this.current.volume.voxelToRas);
    const mm = this.unit === "mm" ? this.radius : this.radius * Math.min(...edges);
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
        const v = session.volume.get(...(voxel.map(Math.round) as Vec3));
        if (v > 0) this.value = v;
        this.ctx.ui.toast(v > 0 ? `Label ${v}` : "No label there (0).");
        this.update?.();
        break;
      }
      case "fill2d":
      case "fill3d":
        this.enqueue(() => this.fill(voxel, this.tool === "fill2d" ? normal : undefined, this.tool === "fill3d"));
        break;
      case "quick":
        this.quickStart = { voxel, axis: normal ? dominant(normal) : undefined };
        this.quickEnd = voxel;
        break;
    }
  }

  private lastNormal: Vec3 | undefined;
  /** The voxel axis across the 2-D view last drawn in: interpolation runs along it. */
  private axis = 2;

  /** Fills the sections between those where the active label is drawn, along the last view's axis. */
  private interpolate(): void {
    const session = this.current;
    if (session === undefined) return;
    const value = this.value;
    const axis = this.axis;
    this.enqueue(() => {
      const box = session.volume.paintedBox(value);
      if (box === undefined) {
        this.ctx.ui.toast(`Label ${value} is not drawn yet.`);
        return;
      }
      const stroke = new Stroke(session.volume);
      const sections = interpolate(stroke, value, axis, box);
      this.ctx.ui.toast(sections ? `Filled ${sections} section${sections === 1 ? "" : "s"} of label ${value} between those drawn.` : `Label ${value} has no gaps between drawn sections along ${"xyz"[axis]}: draw it in two sections a few apart.`);
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
    session.unsaved++;
    session.refresh();
    if (value > 0) session.applyColours([value]);
    this.recount();
  }

  private async fill(seed: Vec3, normal: Vec3 | undefined, threeD: boolean): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    if (!threeD && normal === undefined) {
      this.ctx.ui.toast("Fill 2-D works in a 2-D view (its section).");
      return;
    }
    const s = seed.map(Math.round) as Vec3;
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
    const a = start.voxel.map(Math.round) as Vec3;
    const b = end.map(Math.round) as Vec3;
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

  private undo(redo: boolean): void {
    const session = this.current;
    if (session === undefined) return;
    this.enqueue(() => {
      const keys = redo ? session.history.redo() : session.history.undo();
      if (keys.length === 0) return;
      session.unsaved += 1;
      session.refresh();
      this.recount();
    });
  }

  /** Counts the labels a little after strokes stop. */
  private recount(): void {
    clearTimeout(this.countsTimer);
    this.countsTimer = setTimeout(() => {
      if (this.current) this.current.counts = this.current.volume.counts();
      this.update?.();
    }, 300);
  }

  // --------------------------------------------------------------- save

  private async save(): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
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
        const files = await omeZarr(out, description, (done, total) => this.setNote(`Writing: ${Math.round((100 * done) / total)}%`));
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
    this.update?.();
  }

  // -------------------------------------------------------------- panel

  render(host: HTMLElement): Disposer {
    let levels: { store: string; levels: ImageLevel[] } | undefined;
    const draw = () => {
      const images = readableImages(this.ctx).filter((n) => !this.sessions.some((s) => s.layer === n));
      if (!images.includes(this.newImage)) {
        this.newImage = images[0] ?? "";
        this.newLevel = 0;
      }
      const store = this.newImage ? layerStore(this.ctx, this.newImage) : undefined;
      if (store !== undefined && levels?.store !== store) {
        levels = { store, levels: [] };
        void this.voxels.levels(store).then(
          (l) => {
            levels = { store, levels: l };
            draw();
          },
          () => {},
        );
      }
      const children: Node[] = [];
      if (this.sessions.length === 0 || this.showForm) children.push(this.newForm(images, levels?.store === store ? (levels?.levels ?? []) : []));
      if (this.current) children.push(this.sessionView(this.current));
      host.replaceChildren(...children);
    };
    this.update = draw;
    draw();
    const off = this.ctx.viewer.onLayersChanged(() => draw());
    return () => {
      off();
      this.update = undefined;
    };
  }

  private newForm(images: string[], levels: ImageLevel[]): HTMLElement {
    const levelLabel = (l: ImageLevel, i: number) => {
      const bytes = l.size[0] * l.size[1] * l.size[2] * (this.newType === "uint8" ? 1 : this.newType === "uint16" ? 2 : 4);
      return `${i}: ${l.size.join(" × ")}, ${physical(l.voxelSize)} (${fmtBytes(bytes)} if all painted)`;
    };
    const name = el("input", { class: "text-input", type: "text", value: this.newName, "aria-label": "Name" }) as HTMLInputElement;
    name.addEventListener("change", () => (this.newName = name.value.trim() || "Labels"));
    const create = button("Create", () => void this.create(), "An empty label volume on this image's grid", "btn primary small");
    create.disabled = !this.newImage || levels.length === 0;
    return el(
      "div",
      { class: "an-form" },
      images.length === 0
        ? el("p", { class: "empty" }, "Add an image (OME-Zarr, NIfTI or precomputed) to draw labels on its grid, or open a NIfTI label image.")
        : el(
            "div",
            { class: "an-grid2" },
            field("Image", select(images.map((n) => [n, n]), this.newImage, (v) => {
              this.newImage = v;
              this.newLevel = 0;
              this.update?.();
            }, "Image")),
            field("Name", name),
            field("Grid", select(levels.map((l, i) => [String(i), levelLabel(l, i)]), String(this.newLevel), (v) => (this.newLevel = Number(v)), "Level")),
            field("Labels", select([["uint8", "8-bit (to 255)"], ["uint16", "16-bit"], ["uint32", "32-bit"]], this.newType, (v) => {
              this.newType = v as LabelType;
              this.update?.();
            }, "Type")),
          ),
      el(
        "div",
        { class: "an-row" },
        images.length ? create : null,
        button("Open NIfTI…", () => this.pickNifti(), "Edit a label image from this computer (.nii, .nii.gz)"),
        this.sessions.length ? button("Cancel", () => {
          this.showForm = false;
          this.update?.();
        }) : null,
      ),
    );
  }

  private sessionView(session: Session): HTMLElement {
    const volume = session.volume;
    const placed = session.placement();
    const edges = voxelEdges(placed?.voxelToMm ?? volume.voxelToRas);
    const head = el(
      "div",
      { class: "an-row an-session" },
      this.sessions.length > 1
        ? select(this.sessions.map((s) => [s.fileName, s.layer]), session.fileName, (v) => {
            this.current = this.sessions.find((s) => s.fileName === v);
            this.update?.();
          }, "Label volume")
        : el("strong", {}, session.layer),
      el("span", { class: "an-faint" }, `${volume.size.join(" × ")} · ${edges.map((e) => physical(e)).join(" × ")} · ${volume.type}`),
      el("span", { class: "an-spacer" }),
      button("New…", () => {
        this.showForm = true;
        this.update?.();
      }),
      button("Close", () => void this.close(session), "Remove it from the scene"),
    );
    const drawing = this.painter.active;
    const toggle = button(drawing ? "Drawing: on" : "Draw in the views", () => this.setDrawing(!drawing), drawing ? "Stop drawing (Escape)" : "The left button draws in the views; hold Space to move them", drawing ? "btn primary small" : "btn outline small");
    const tools = el("div", { class: "segmented an-tools" });
    for (const [id, label, title] of TOOLS) {
      tools.append(
        el("button", {
          type: "button",
          title,
          "aria-pressed": String(this.tool === id),
          onclick: () => {
            this.tool = id;
            this.setDrawing(true);
          },
        }, label),
      );
    }
    // The label drawn.
    const max = LABEL_MAX[volume.type];
    const valueInput = numberInput(this.value, (v) => {
      this.value = Math.max(1, Math.min(max, Math.round(v)));
      session.applyColours([this.value]);
      this.update?.();
    }, { min: 1, max, step: 1, "aria-label": "Label" });
    const colour = el("input", { type: "color", value: session.colour(this.value), "aria-label": "Colour" }) as HTMLInputElement;
    colour.addEventListener("change", () => {
      session.labels.set(this.value, { name: session.labels.get(this.value)?.name ?? "", colour: colour.value });
      session.applyColours([this.value]);
      this.update?.();
    });
    const labelName = el("input", { class: "text-input", type: "text", value: session.labels.get(this.value)?.name ?? "", placeholder: "Name", "aria-label": "Label name" }) as HTMLInputElement;
    labelName.addEventListener("change", () => {
      session.labels.set(this.value, { name: labelName.value, colour: session.colour(this.value) });
      this.update?.();
    });
    const next = button("New label", () => {
      const used = new Set([...this.counts.keys(), ...session.labels.keys()]);
      let v = 1;
      while (used.has(v) && v < max) ++v;
      this.value = v;
      session.applyColours([v]);
      this.update?.();
    }, "The next label not used yet");

    const options = el("div", { class: "an-grid2" });
    if (this.tool === "brush" || this.tool === "erase") {
      options.append(
        field("Radius", el("div", { class: "an-inline" }, numberInput(this.radius, (v) => {
          this.radius = Math.max(0.01, v);
        }, { min: 0.01, step: "any", "aria-label": "Radius" }), select([["mm", "mm"], ["voxels", "voxels"]], this.unit, (v) => (this.unit = v as "mm" | "voxels"), "Unit"))),
        field("Shape", select([["disc", "Disc in the section"], ["ball", "Ball"]], this.shape, (v) => (this.shape = v as "ball" | "disc"), "Shape")),
        this.tool === "brush"
          ? field("Paint over", select([["all", "Any label"], ["empty", "Unlabelled only"]], this.overwrite, (v) => (this.overwrite = v as "all" | "empty"), "Paint over"))
          : field("Erase", select([["any", "Any label"], ["only", "This label only"]], this.eraseOnly ? "only" : "any", (v) => (this.eraseOnly = v === "only"), "Erase")),
      );
    } else if (this.tool === "fill2d" || this.tool === "fill3d") {
      options.append(
        field("Fill", select([["label", "The label clicked, where joined"], ["image", "The image range, where joined"]], this.fillBy, (v) => {
          this.fillBy = v as "image" | "label";
          this.update?.();
        }, "Fill by")),
        field("Paint over", select([["all", "Any label"], ["empty", "Unlabelled only"]], this.overwrite, (v) => (this.overwrite = v as "all" | "empty"), "Paint over")),
        this.tool === "fill3d" ? field("Reach (voxels)", numberInput(this.reach, (v) => (this.reach = Math.max(1, Math.min(256, Math.round(v)))), { min: 1, max: 256, step: 1 }), "The fill stays in a box this far around the click") : "",
      );
    } else if (this.tool === "quick") {
      const methods = this.quickSelect.methods();
      options.append(
        field("Method", select(methods.map((m) => [m.id, m.title]), this.method, (v) => (this.method = v), "Method"), methods.find((m) => m.id === this.method)?.description),
        field("Tolerance", numberInput(this.tolerance, (v) => (this.tolerance = Math.max(0, Math.min(1, v))), { min: 0, max: 1, step: 0.01 }), "For a click: how far from its value, as a fraction of the range"),
      );
    }

    // The image whose values limit the tools.
    const ref = session.reference;
    const images = readableImages(this.ctx).filter((n) => n !== session.layer);
    const limit = el("input", { type: "checkbox", "aria-label": "Limit to an intensity range" }) as HTMLInputElement;
    limit.checked = this.limit;
    limit.addEventListener("change", () => {
      this.limit = limit.checked;
      this.update?.();
    });
    const intensity = el(
      "div",
      { class: "an-limit" },
      el("div", { class: "an-grid2" },
        field("Image values from", select([["", "None"], ...images.map((n): [string, string] => [n, n])], ref?.layer ?? "", (v) => {
          void this.chooseReference(session, v || undefined).then(() => this.update?.());
        }, "Image"), ref ? `Level ${ref.level}: ${physical(ref.levels[ref.level].voxelSize)} voxels` : undefined),
        field("Range", el("div", { class: "an-inline" }, numberInput(this.low, (v) => (this.low = v), { step: "any", "aria-label": "Low" }), el("span", { class: "an-faint" }, "to"), numberInput(this.high, (v) => (this.high = v), { step: "any", "aria-label": "High" }))),
      ),
      el("label", { class: "field check" }, limit, el("span", {}, "Brush and eraser only within the range")),
      el("div", { class: "an-row" }, button("Range from the cursor", () => void this.rangeFromCursor(), "The value under the pointer, ± the tolerance of the range there")),
    );

    const interpolateButton = button("Interpolate", () => this.interpolate(), "Fill the sections between those where this label is drawn, across the view last drawn in (V)");
    const undo = button("Undo", () => this.undo(false), "Undo the last stroke (Ctrl+Z while drawing)");
    undo.disabled = !session.history.canUndo;
    const redo = button("Redo", () => this.undo(true), "Ctrl+Shift+Z while drawing");
    redo.disabled = !session.history.canRedo;

    // Labels used, with their sizes.
    const voxelMm3 = voxelVolume(placed?.voxelToMm ?? volume.voxelToRas);
    const rows = [...this.counts].sort((a, b) => a[0] - b[0]);
    const table = rows.length
      ? el(
          "table",
          { class: "an-table" },
          el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Label"), el("th", { class: "num" }, "Voxels"), el("th", { class: "num" }, "Volume"))),
          el(
            "tbody",
            {},
            ...rows.map(([v, n]) =>
              el(
                "tr",
                { class: `an-click${v === this.value ? " an-current" : ""}`, onclick: () => {
                  this.value = v;
                  this.update?.();
                } },
                el("td", {}, el("span", { class: "an-swatch", style: `background:${session.colour(v)}` })),
                el("td", {}, `${v}${session.labels.get(v)?.name ? ` ${session.labels.get(v)!.name}` : ""}`),
                el("td", { class: "num" }, n.toLocaleString()),
                el("td", { class: "num" }, physical(n * voxelMm3, 3)),
              ),
            ),
          ),
        )
      : el("p", { class: "an-hint" }, "Nothing painted yet.");

    const saveBox = el("input", { type: "checkbox", "aria-label": "Only the painted box" }) as HTMLInputElement;
    saveBox.checked = this.saveCrop;
    saveBox.addEventListener("change", () => (this.saveCrop = saveBox.checked));
    const big = niftiBytes(volume) > MAX_NIFTI;

    return el(
      "div",
      { class: "an-seg" },
      head,
      el("div", { class: "an-row" }, toggle, undo, redo, interpolateButton),
      tools,
      el("div", { class: "an-row an-label" }, el("span", { class: "an-swatch big", style: `background:${session.colour(this.value)}` }), valueInput, colour, labelName, next),
      options.childElementCount ? options : null,
      el("h4", { class: "an-sub" }, "Image values"),
      intensity,
      el("h4", { class: "an-sub" }, "Labels"),
      table,
      el("h4", { class: "an-sub" }, "Save"),
      el(
        "div",
        { class: "an-row" },
        select([["nii.gz", "NIfTI (.nii.gz)"], ["zarr", "OME-Zarr folder"]], this.saveFormat, (v) => (this.saveFormat = v as "nii.gz" | "zarr"), "Format"),
        el("label", { class: "field check" }, saveBox, el("span", {}, "Only the painted box")),
        button("Save", () => void this.save(), "Save to this computer", "btn primary small"),
      ),
      big ? el("p", { class: "an-hint" }, "This grid is too large for one NIfTI: save the painted box, or as OME-Zarr (only painted chunks are written).") : null,
      this.note ? el("p", { class: "an-hint" }, this.note) : null,
      el("p", { class: "an-hint" }, `In the page: ${volume.chunkCount} chunks, ${fmtBytes(volume.bytes)}. ${session.unsaved ? `${session.unsaved} change${session.unsaved === 1 ? "" : "s"} not saved.` : "Saved."}`),
    );
  }

  /** Sets the range to the value under the pointer, ± the tolerance of the image's range near it. */
  private async rangeFromCursor(): Promise<void> {
    const session = this.current;
    const placed = session?.placement();
    const cursor = this.ctx.viewer.cursor();
    if (session === undefined || placed === undefined || session.reference === undefined) {
      this.ctx.ui.toast("Choose an image for its values first.");
      return;
    }
    const position = cursor.active ? cursor.position : ((this.ctx.viewer.getState() as { position?: number[] }).position ?? []);
    const v = toVoxel(placed, position).map(Math.round) as Vec3;
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
    this.update?.();
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

function fmtBytes(n: number): string {
  return n >= 2 ** 30 ? `${fmt(n / 2 ** 30, 3)} GB` : n >= 2 ** 20 ? `${fmt(n / 2 ** 20, 3)} MB` : `${Math.round(n / 1024)} KB`;
}


export type { Reference };
