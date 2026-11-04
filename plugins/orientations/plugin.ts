/**
 * Orientation glyphs over an image: ODFs from spherical harmonics, tensors
 * as ellipsoids, peaks and vectors as lines, one per voxel of the level
 * that suits each view's zoom, drawn over the 2-D views (./overlay.ts) and
 * on their sections in the 3-D view (draw3d).  Neuroglancer shows the
 * image itself; the plugin reads its pyramid in a worker (./worker.ts),
 * only the voxels on each section and in view, and turns them into glyphs
 * there (./glyphs.ts).  Zooming in brings the next finer level's glyphs;
 * the coarser stay until they arrive.
 */
import type { Disposer, Frame3d, LayerInfo, PlatformContext, PluginModule, ViewPanelInfo } from "@ngplatform/sdk";
import { el } from "@ngplatform/sdk/dom";
import { mmText } from "@ngplatform/sdk/format";
import { omeZarrUrl } from "../volume-view/sources.js";
import { OrientationClient } from "./client.js";
import { type GlyphOptions, type GlyphSet, type Normalise, type OrientationKind, voxelFrame, withFlips } from "./glyphs.js";
import { ORIENTATIONS_PANEL } from "./manifest.js";
import { GlyphOverlay, type PanelDraw } from "./overlay.js";
import type { Opened, OrientationLevel } from "./reader.js";
import { GlyphRenderer } from "./render.js";
import { lmaxOf, SH_BASES, type ShBasis } from "./sh.js";
import { describeVoxel } from "./readout.js";
import { directionShader } from "./shader.js";
import { TENSOR_ORDERS, type TensorOrder } from "./tensor.js";
import { type Box, chooseLevel, layerMove, type SectionPlan, contains, invert4, planesAround, planSection, type Section, sectionOf, type Vec3, applyAffine } from "./view.js";

export interface Saved {
  on: boolean;
  /** The image layer read; the first that has orientations when unset or gone. */
  layer?: string;
  kind: "auto" | OrientationKind;
  basis: "auto" | ShBasis;
  tensorOrder: "auto" | TensorOrder;
  frame: "auto" | "voxel" | "world";
  flips: [boolean, boolean, boolean];
  normalise: Normalise;
  tensorGlyph: "ellipsoid" | "line";
  /** Spherical harmonics as ODF shapes, or as lines along their peaks. */
  shGlyph: "odf" | "peaks";
  /** A glyph's size: 1 fills its voxel. */
  size: number;
  /** Glyphs at least this many pixels apart: the level is the finest that keeps them so. */
  spacing: number;
  /** At most this many glyphs in a view (a coarser level, or none, beyond). */
  maxGlyphs: number;
  /** Glyphs less anisotropic than this (GFA, FA) are left out. */
  minAnisotropy: number;
  show2d: boolean;
  show3d: boolean;
}

const KINDS: OrientationKind[] = ["sh", "tensor", "vector", "peaks"];

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
  const flips = Array.isArray(s.flips) && s.flips.length === 3 ? (s.flips.map((f) => f === true) as [boolean, boolean, boolean]) : [false, false, false];
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  return {
    on: s.on === true,
    layer: typeof s.layer === "string" ? s.layer : undefined,
    kind: pick(s.kind, ["auto", ...KINDS], "auto"),
    basis: pick(s.basis, ["auto", ...SH_BASES.map(([b]) => b)], "auto"),
    tensorOrder: pick(s.tensorOrder, ["auto", ...TENSOR_ORDERS.map(([o]) => o)], "auto"),
    frame: pick(s.frame, ["auto", "voxel", "world"], "auto"),
    flips: flips as [boolean, boolean, boolean],
    normalise: pick(s.normalise, ["minmax", "max", "none"], "minmax"),
    tensorGlyph: pick(s.tensorGlyph, ["ellipsoid", "line"], "ellipsoid"),
    shGlyph: pick(s.shGlyph, ["odf", "peaks"], "odf"),
    size: num(s.size, 0.2, 3, 1),
    spacing: num(s.spacing, 4, 200, 24),
    maxGlyphs: num(s.maxGlyphs, 100, 50000, 8000),
    minAnisotropy: num(s.minAnisotropy, 0, 1, 0),
    show2d: s.show2d !== false,
    show3d: s.show3d !== false,
  };
}

/** What the data is, from the settings, the store's own attributes and the number of components. */
export function resolveKind(saved: Pick<Saved, "kind">, opened: Pick<Opened, "metadata">, components: number): OrientationKind {
  if (saved.kind !== "auto") return saved.kind;
  const said = opened.metadata?.type;
  if (said !== undefined && KINDS.includes(said)) return said;
  if (components === 3) return "vector";
  if (components === 6) return "tensor";
  if (lmaxOf(components) !== undefined) return "sh";
  return "peaks";
}

export function resolveBasis(saved: Pick<Saved, "basis">, opened: Pick<Opened, "metadata">): ShBasis {
  if (saved.basis !== "auto") return saved.basis;
  const m = opened.metadata;
  const said = String(m?.basis ?? "").toLowerCase();
  if (said.startsWith("tournier") || said === "mrtrix" || said === "mrtrix3") return m?.legacy === true ? "tournier07-legacy" : "tournier07";
  if (said.startsWith("descoteaux") || said === "dipy") return m?.legacy === false ? "descoteaux07" : "descoteaux07-legacy";
  return "descoteaux07-legacy";
}

/**
 * The tensors' component order: the setting, else the store's own
 * attributes, else DIPY's for a NIfTI whose intent says symmetric matrix
 * (NIfTI stores its lower triangle by rows), else FSL's.
 */
export function resolveTensorOrder(saved: Pick<Saved, "tensorOrder">, opened: Pick<Opened, "metadata" | "nifti">): TensorOrder {
  if (saved.tensorOrder !== "auto") return saved.tensorOrder;
  const said = String(opened.metadata?.order ?? "");
  if (said === "dipy" || said === "mrtrix" || said === "fsl") return said;
  if (opened.nifti?.intent === 1005) return "dipy";
  return "fsl";
}

export function resolveFrame(saved: Pick<Saved, "frame">, opened: Pick<Opened, "metadata">, basis: ShBasis, kind: OrientationKind): "voxel" | "world" {
  if (saved.frame !== "auto") return saved.frame;
  const said = opened.metadata?.frame;
  if (said === "voxel" || said === "world") return said;
  // MRtrix writes directions in world (scanner) space; DIPY and FSL along the voxel axes.
  return kind === "sh" && basis.startsWith("tournier") ? "world" : "voxel";
}

/** A glyph set drawn, and what it was read for. */
interface Shown {
  set: GlyphSet;
  level: number;
  box: Box;
  key: string;
}

/** One view's glyphs: what is shown, and what is being read for it. */
interface Slot {
  shown?: Shown;
  pending?: { key: string; box: Box; level: number; controller: AbortController };
  /** Why nothing is shown, when nothing is. */
  note?: string;
}

type Want = SectionPlan;

/** The global coordinate space, as the state has it, cached from state changes. */
interface Space {
  names: string[];
  scales: number[];
  units: string[];
  position: number[];
  projectionScale: number | undefined;
}

class Orientations {
  private saved: Saved;
  private client: OrientationClient | undefined;
  private store: string | undefined;
  private opened: Opened | undefined;
  private openError: string | undefined;
  /** An image that failed to open, not asked for again until then. */
  private failed: { url: string; until: number } | undefined;
  private disposed = false;
  private overlay: { element: HTMLElement; dispose(): void } | undefined;
  private glyphOverlay: GlyphOverlay | undefined;
  private handle: { redraw(): void; dispose(): void } | undefined;
  private handleLayer: string | undefined;
  private renderer3d: GlyphRenderer | undefined;
  private readonly slots = new Map<HTMLElement | "3d", Slot>();
  private space: Space | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queued = false;
  private panelUpdate: (() => void) | undefined;
  private readonly toggle: { set(value: boolean): void; dispose(): void };
  private readonly offs: Disposer[] = [];
  /** Image layers looked at for a component axis, by URL: whether they have one. */
  private readonly probed = new Map<string, Promise<boolean>>();

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    this.toggle = ctx.ui.viewToggle({
      label: "Glyphs",
      title: "Orientation glyphs (ODFs, tensors, peaks) over the image; the Orientations tab has their settings",
      value: this.saved.on,
      onChange: (on) => this.set({ on }),
    });
    this.offs.push(
      ctx.state.onChanged(() => {
        const next = readSaved(ctx.state.get());
        if (JSON.stringify(next) === JSON.stringify(this.saved)) return;
        this.saved = next;
        this.toggle.set(next.on);
        this.settingsChanged();
      }),
      ctx.viewer.onLayersChanged(() => this.update()),
      ctx.viewer.onStateChanged(() => {
        this.readSpace();
        this.schedule();
      }),
      ctx.viewer.onRendered(() => this.schedule()),
      ctx.viewer.onCursorChanged(() => {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => this.readCursor(), 120);
      }),
      () => clearTimeout(this.cursorTimer),
      ctx.ui.screenshotOverlay((context, canvas) => this.paintScreenshot(context, canvas)),
      () => clearTimeout(this.timer),
    );
    this.readSpace();
    this.update();
  }

  private set(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
    if (patch.on !== undefined) this.toggle.set(patch.on);
    this.settingsChanged();
  }

  /** Settings that change the glyphs: read again (and the store's coarser levels made anew, when they should be). */
  private settingsChanged(tell = true): void {
    for (const slot of this.slots.values()) {
      slot.pending?.controller.abort();
      slot.pending = undefined;
      if (slot.shown) slot.shown.key = "";
    }
    this.update();
    if (tell) void this.retellStore().catch((e: Error) => {
      if (this.disposed) return;
      this.openError = `Could not remake the image's coarser levels: ${e.message}`;
      this.panelUpdate?.();
    });
  }

  private readSpace(): void {
    const state = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[]; projectionScale?: number };
    const dims = state.dimensions ?? {};
    const names = Object.keys(dims);
    this.space = {
      names,
      scales: names.map((n) => dims[n][0]),
      units: names.map((n) => dims[n][1]),
      position: state.position ?? names.map(() => 0),
      projectionScale: state.projectionScale,
    };
    const t = this.handleLayer === undefined ? undefined : this.ctx.viewer.layerTransform(this.handleLayer);
    const move = t === undefined ? undefined : layerMove(t);
    if (JSON.stringify(move) !== JSON.stringify(this.move)) {
      this.move = move;
      // Moved: what each view shows of the store has changed.
      for (const slot of this.slots.values()) if (slot.shown) slot.shown.key = "";
    }
  }

  /** A global position for a RAS point (mm), the other dimensions where the view is. */
  private globalOf(ras: ArrayLike<number>): number[] | undefined {
    const space = this.space;
    if (space === undefined) return undefined;
    if (this.move !== undefined) ras = applyAffine(this.move, ras);
    const out = [...space.position];
    let found = 0;
    space.names.forEach((name, i) => {
      const axis = ["x", "y", "z"].indexOf(name);
      if (axis === -1) return;
      found++;
      out[i] = space.units[i] === "m" ? (ras[axis] * 1e-3) / space.scales[i] : ras[axis] / space.scales[i];
    });
    return found === 3 ? out : undefined;
  }

  /** The view's position in RAS mm. */
  private originRas(): Vec3 | undefined {
    const space = this.space;
    if (space === undefined) return undefined;
    const out: number[] = [NaN, NaN, NaN];
    space.names.forEach((name, i) => {
      const axis = ["x", "y", "z"].indexOf(name);
      if (axis === -1) return;
      out[axis] = space.units[i] === "m" ? space.position[i] * space.scales[i] * 1e3 : space.position[i] * space.scales[i];
    });
    if (!out.every(Number.isFinite)) return undefined;
    return this.move === undefined ? (out as Vec3) : applyAffine(invert4(this.move), out);
  }

  /**
   * The layer's move from where its store places it (Registration), RAS mm
   * to RAS mm; glyphs are placed from the store and drawn moved by it.
   */
  private move: number[] | undefined;

  /** Image layers it can read: OME-Zarr (a NIfTI read in place is one). */
  candidates(): LayerInfo[] {
    return this.ctx.viewer.layers().filter((l) => l.type === "image" && omeZarrUrl(l.sources[0]) !== undefined);
  }

  /** Whether an image has an axis of components (looking at its metadata only). */
  private probe(url: string): Promise<boolean> {
    let p = this.probed.get(url);
    if (p === undefined) {
      p = (async () => {
        // Zarr v3's group metadata, else v2's attributes (OME-Zarr 0.4).
        let response = await fetch(`${url}zarr.json`);
        if (!response.ok) response = await fetch(`${url}.zattrs`);
        if (!response.ok) return false;
        const { spatialGroup } = await import("./ome4.js");
        spatialGroup(await response.json());
        return true;
      })().catch(() => false);
      this.probed.set(url, p);
    }
    return p;
  }

  private chosen: string | undefined;

  /** The layer drawn: the one chosen, else the first whose image has components. */
  private target(): LayerInfo | undefined {
    const candidates = this.candidates();
    const named = candidates.find((l) => l.name === this.saved.layer);
    if (named !== undefined) return named;
    const auto = candidates.find((l) => l.name === this.chosen);
    if (auto !== undefined) return auto;
    // Look at each, and take the first with components (asynchronously).
    void (async () => {
      for (const l of candidates) {
        if (await this.probe(omeZarrUrl(l.sources[0])!)) {
          if (this.chosen !== l.name) {
            this.chosen = l.name;
            this.update();
          }
          return;
        }
      }
    })();
    return undefined;
  }

  private updating = false;

  private update(): void {
    // Attaching to a layer changes the layers, which calls this again.
    if (this.updating) return;
    this.updating = true;
    try {
      this.updateNow();
    } finally {
      this.updating = false;
    }
  }

  private updateNow(): void {
    const target = this.saved.on ? this.target() : undefined;
    if (!this.saved.on || target === undefined) {
      this.handle?.dispose();
      this.handle = undefined;
      this.handleLayer = undefined;
      this.clearSlots();
      this.glyphOverlay?.draw([], 1);
      this.drawn = "";
      this.panelUpdate?.();
      return;
    }
    if (this.overlay === undefined) {
      this.overlay = this.ctx.ui.overlay();
      this.glyphOverlay = new GlyphOverlay(this.overlay.element);
    }
    const url = omeZarrUrl(target.sources[0])!;
    if (url !== this.store && !(url === this.failed?.url && Date.now() < this.failed.until)) {
      this.store = url;
      this.failed = undefined;
      this.opened = undefined;
      this.openError = undefined;
      this.clearSlots();
      void this.open(url);
    }
    if (this.handleLayer !== target.name) {
      this.handle?.dispose();
      this.handleLayer = target.name;
      this.handle = this.ctx.viewer.draw3d(target.name, {
        draw: (frame) => this.draw3d(frame),
        dispose: () => {
          this.renderer3d?.dispose();
          this.renderer3d = undefined;
        },
      });
    }
    this.schedule();
    this.panelUpdate?.();
  }

  private clearSlots(): void {
    for (const slot of this.slots.values()) slot.pending?.controller.abort();
    this.slots.clear();
  }

  private async open(url: string): Promise<void> {
    this.client ??= new OrientationClient();
    try {
      let opened = await this.client.open(url);
      if (this.store !== url) return;
      if (opened.levels.length === 0) throw new Error("it has no levels");
      if (await this.tellStore(url, opened)) {
        // Its coarser levels are made anew: Neuroglancer's too.
        opened = await this.client.open(url);
        this.ctx.viewer.reloadData(url);
        if (this.store !== url) return;
      }
      this.opened = opened;
      this.schedule();
    } catch (e) {
      if (this.store === url && !this.disposed) {
        this.openError = `Could not read the image: ${(e as Error).message}. Trying again in a few seconds.`;
        // Not kept as open (a network blip need not stick): opened afresh by a later update, at most every few seconds.
        this.store = undefined;
        this.probed.delete(url);
        this.failed = { url, until: Date.now() + 5000 };
        setTimeout(() => {
          if (!this.disposed) this.update();
        }, 5100);
      }
    }
    this.panelUpdate?.();
  }

  /**
   * The tensor order a NIfTI read in place has its coarser levels averaged
   * in (null: plain means), as the store last said; by store URL.
   */
  private coarsened: { url: string; tensor: string | null } | undefined;

  /**
   * For a NIfTI read in place (whose coarser levels the app makes): tells
   * its store to make them log-Euclidean means when the image is drawn as
   * tensors, and plain means when not.  True when that changed them.
   */
  private async tellStore(url: string, opened: Opened): Promise<boolean> {
    if (opened.nifti === undefined || opened.levels.length < 2 || opened.levels[0].components !== 6) return false;
    const options = this.optionsFor(opened, 2);
    const wanted = options.kind === "tensor" ? options.tensorOrder : null;
    const current = this.coarsened?.url === url ? this.coarsened.tensor : (opened.nifti.tensorOrder ?? null);
    if (wanted === current) {
      this.coarsened = { url, tensor: current };
      return false;
    }
    try {
      const answer = (await this.ctx.workspace.local.send(url, { tensor: wanted })) as { tensor: string | null; changed: boolean };
      this.coarsened = { url, tensor: answer.tensor };
      return answer.changed;
    } catch {
      // Not a file on this computer (or a store that takes no messages): its levels are as they are.
      this.coarsened = { url, tensor: current };
      return false;
    }
  }

  /** After a change of settings: the store's coarser levels made anew when they should be, and read again. */
  private async retellStore(): Promise<void> {
    const url = this.store;
    const opened = this.opened;
    if (url === undefined || opened === undefined || this.client === undefined) return;
    if (!(await this.tellStore(url, opened)) || this.store !== url) return;
    // The worker's chunks are of the old levels: opened again, they are forgotten.
    await this.client.open(url);
    if (this.store !== url) return;
    this.ctx.viewer.reloadData(url);
    this.settingsChanged(false);
  }

  /** The glyph settings for the open image. */
  private options(subdivisions: number): GlyphOptions | undefined {
    return this.opened === undefined ? undefined : this.optionsFor(this.opened, subdivisions);
  }

  private optionsFor(opened: Opened, subdivisions: number): GlyphOptions {
    const level0 = opened.levels[0];
    const kind = resolveKind(this.saved, opened, level0.components);
    const basis = resolveBasis(this.saved, opened);
    const frame = resolveFrame(this.saved, opened, basis, kind);
    const tensorOrder = resolveTensorOrder(this.saved, opened);
    const toData = withFlips(frame === "voxel" ? voxelFrame(level0.voxelToRas) : [1, 0, 0, 0, 1, 0, 0, 0, 1], this.saved.flips);
    return { kind, basis, tensorOrder, toData, normalise: this.saved.normalise, tensorGlyph: this.saved.tensorGlyph, shGlyph: this.saved.shGlyph, subdivisions, minAnisotropy: this.saved.minAnisotropy };
  }

  // ------------------------------------------------------------- frames

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      // A frame queued before the plugin was switched off draws nothing.
      if (!this.disposed) this.frame();
    });
  }

  /** The 2-D views, with their sections now. */
  private sections(): { panel: ViewPanelInfo; section: Section }[] {
    const origin = this.originRas();
    if (origin === undefined) return [];
    const out: { panel: ViewPanelInfo; section: Section }[] = [];
    for (const panel of this.ctx.viewer.panels()) {
      if (panel.kind !== "2d") continue;
      const rect = panel.element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const section = sectionOf(
        (ras) => {
          const g = this.globalOf(ras);
          return g === undefined ? undefined : panel.project(g);
        },
        origin,
        rect.width,
        rect.height,
      );
      if (section !== undefined) out.push({ panel, section });
    }
    return out;
  }

  /** What a 2-D view wants read. */
  private want2d(section: Section): Want | { note: string } {
    return planSection(this.opened!.levels, section, this.saved);
  }

  /** What the 3-D view wants read when there are no 2-D views: three planes through the position. */
  private want3d(): Want | { note: string } {
    const levels = this.opened!.levels;
    const origin = this.originRas();
    const space = this.space;
    const panel = this.ctx.viewer.panels().find((p) => p.kind === "3d");
    if (origin === undefined || space === undefined || panel === undefined) return { note: "" };
    const metres = space.scales.filter((_, i) => space.units[i] === "m");
    const height = (space.projectionScale ?? 256) * Math.min(...metres) * 1000;
    const pxPerMm = panel.element.clientHeight / Math.max(1e-9, height);
    const half = Math.max(2, Math.floor(Math.sqrt(this.saved.maxGlyphs / 3) / 2));
    let level = chooseLevel(
      levels.map((l) => l.voxelSize),
      pxPerMm,
      this.saved.spacing,
    );
    // No finer than three planes of the cap can reach across most of the view.
    while (level < levels.length - 1 && 2 * half * levels[level].voxelSize * pxPerMm < 0.6 * panel.element.clientHeight) ++level;
    const info = levels[level];
    const voxel = applyAffine(invert4(info.voxelToRas), origin);
    const planes = planesAround(voxel, info.size, half);
    if (planes === undefined) return { note: "" };
    const key = `3d|${level}|${planes.slabs.map((s) => s.d).join(",")}|${planes.box.lo.join(",")}`;
    return { level, box: planes.box, visible: planes.box, slabs: planes.slabs, key, subdivisions: 2 };
  }

  private frame(force = false): void {
    const opened = this.opened;
    this.stats.frames++;
    if (!this.saved.on || opened === undefined || this.glyphOverlay === undefined) {
      if (this.drawn !== "") this.glyphOverlay?.draw([], 1);
      this.drawn = "";
      return;
    }
    this.channelise();
    const layerShown = this.ctx.viewer.layers().find((l) => l.name === this.handleLayer)?.visible !== false;
    const sections = this.sections();
    const seen = new Set<HTMLElement | "3d">();
    const draws: PanelDraw[] = [];
    const base = this.overlay!.element.getBoundingClientRect();
    for (const { panel, section } of sections) {
      seen.add(panel.element);
      let slot = this.slots.get(panel.element);
      if (slot === undefined) this.slots.set(panel.element, (slot = {}));
      const want = this.want2d(section);
      this.follow(slot, want);
      if (this.saved.show2d && layerShown && slot.shown !== undefined) {
        const rect = panel.element.getBoundingClientRect();
        const voxel = opened.levels[slot.shown.level].voxelSize;
        draws.push({
          left: rect.left - base.left,
          top: rect.top - base.top,
          width: rect.width,
          height: rect.height,
          section,
          sets: [{ set: slot.shown.set, scale: (voxel * this.saved.size) / 2, depthRange: 4 * voxel * Math.max(1, this.saved.size) }],
        });
      }
    }
    if (sections.length === 0 && this.saved.show3d) {
      seen.add("3d");
      let slot = this.slots.get("3d");
      if (slot === undefined) this.slots.set("3d", (slot = {}));
      this.follow(slot, this.want3d());
    }
    for (const [key, slot] of this.slots) {
      if (seen.has(key)) continue;
      slot.pending?.controller.abort();
      this.slots.delete(key);
    }
    // Only when something moved or arrived: Neuroglancer draws many frames
    // while chunks load, and glyphs are many triangles.
    const signature = draws
      .map((d) => [d.left, d.top, d.width, d.height, ...d.section.toScreen.map((v) => v.toPrecision(7)), ...d.sets.map((s) => `${this.idOf(s.set)}:${s.scale}`)].join(","))
      .join("|");
    if (!force && signature === this.drawn) return;
    this.drawn = signature;
    const started = performance.now();
    this.glyphOverlay.draw(draws, 2);
    this.stats.draws++;
    this.stats.drawMs += performance.now() - started;
  }

  private drawn = "";
  private ids = new WeakMap<GlyphSet, number>();
  private nextId = 1;
  readonly stats = { frames: 0, draws: 0, drawMs: 0, reads: 0, readMs: 0 };

  private idOf(set: GlyphSet): number {
    let id = this.ids.get(set);
    if (id === undefined) this.ids.set(set, (id = this.nextId++));
    return id;
  }

  /** Reads what a view wants when what it shows (or is reading) does not cover it. */
  private follow(slot: Slot, want: Want | { note: string }): void {
    if ("note" in want) {
      slot.pending?.controller.abort();
      slot.pending = undefined;
      if (want.note !== slot.note) {
        slot.note = want.note;
        this.panelUpdate?.();
      }
      // Too many to draw: nothing rather than the wrong level.
      if (want.note) slot.shown = undefined;
      return;
    }
    slot.note = undefined;
    const covered = (s: { key: string; box: Box } | undefined) => s !== undefined && s.key === want.key && contains(s.box, want.visible);
    if (covered(slot.shown) || covered(slot.pending)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.schedule(), 120);
    if (slot.pending !== undefined && slot.pending.key === want.key) return;
    // Wait for the view to settle a moment before reading.
    if (this.settling(slot, want)) return;
    this.read(slot, want);
  }

  private wanted = new WeakMap<Slot, { key: string; since: number }>();

  /** True until a view has wanted the same thing for a short while. */
  private settling(slot: Slot, want: Want): boolean {
    const now = performance.now();
    const last = this.wanted.get(slot);
    const key = `${want.key}|${want.visible.lo.join(",")}|${want.visible.hi.join(",")}`;
    if (last === undefined || last.key !== key) {
      this.wanted.set(slot, { key, since: now });
      return true;
    }
    return now - last.since < 100;
  }

  private read(slot: Slot, want: Want): void {
    const client = this.client;
    const options = this.options(want.subdivisions);
    if (client === undefined || options === undefined) return;
    slot.pending?.controller.abort();
    const controller = new AbortController();
    slot.pending = { key: want.key, box: want.box, level: want.level, controller };
    this.panelUpdate?.();
    const started = performance.now();
    client.glyphs(want.level, { lo: want.box.lo, hi: want.box.hi, slabs: want.slabs }, options, controller.signal).then(
      ({ set }) => {
        if (slot.pending?.controller !== controller) return;
        slot.pending = undefined;
        slot.shown = { set, level: want.level, box: want.box, key: want.key };
        this.stats.reads++;
        this.stats.readMs += performance.now() - started;
        this.schedule();
        this.handle?.redraw();
        this.panelUpdate?.();
      },
      (e: Error) => {
        if (controller.signal.aborted || slot.pending?.controller !== controller) return;
        slot.pending = undefined;
        slot.note = `Could not read glyphs: ${e.message}`;
        this.panelUpdate?.();
      },
    );
  }

  // ------------------------------------------------------------- under the cursor

  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorRead: AbortController | undefined;
  /** What the voxel under the cursor holds, in words. */
  private cursorLine: string | undefined;

  /** Reads the finest level's voxel under the cursor, for the panel. */
  private readCursor(): void {
    const opened = this.opened;
    const client = this.client;
    const cursor = this.ctx.viewer.cursor();
    const space = this.space;
    if (!this.saved.on || opened === undefined || client === undefined || space === undefined || !cursor.active) return;
    const ras: number[] = [NaN, NaN, NaN];
    cursor.names.forEach((name, i) => {
      const axis = ["x", "y", "z"].indexOf(name);
      const k = space.names.indexOf(name);
      if (axis === -1 || k === -1) return;
      ras[axis] = space.units[k] === "m" ? cursor.position[i] * space.scales[k] * 1e3 : cursor.position[i] * space.scales[k];
    });
    if (!ras.every(Number.isFinite)) return;
    const at = this.move === undefined ? ras : applyAffine(invert4(this.move), ras);
    const level = opened.levels[0];
    const voxel = applyAffine(invert4(level.voxelToRas), at).map(Math.round) as Vec3;
    const inside = voxel.every((v, k) => v >= 0 && v < level.size[k]);
    this.cursorRead?.abort();
    if (!inside) {
      this.setCursorLine(undefined);
      return;
    }
    const controller = (this.cursorRead = new AbortController());
    const options = this.options(2)!;
    client.values(0, { lo: voxel, hi: voxel.map((v) => v + 1) as Vec3 }, controller.signal).then(
      (voxels) => {
        if (controller.signal.aborted || voxels.count === 0) return;
        this.setCursorLine(`Voxel ${voxel.join(", ")} (${mmText(level.voxelSize)}): ${describeVoxel(voxels.values, level.components, options)}`);
      },
      () => {},
    );
  }

  private setCursorLine(line: string | undefined): void {
    if (line === this.cursorLine) return;
    this.cursorLine = line;
    this.panelUpdate?.();
  }

  // ------------------------------------------------------------- 3-D view

  private draw3d(frame: Frame3d): void {
    if (!this.saved.on || !this.saved.show3d || this.opened === undefined) return;
    const toDisplay = displayOfRasMatrix(frame.dimensions);
    if (toDisplay === undefined) return;
    const { gl } = frame;
    if (this.renderer3d?.gl !== gl) {
      this.renderer3d?.dispose();
      this.renderer3d = new GlyphRenderer(gl, frame.outputs);
    }
    // RAS mm to clip: the frame's view-projection after RAS to display (after the layer's move).
    const vp = frame.viewProjection;
    const placed = new Float32Array(16);
    const move = this.move;
    for (let c = 0; c < 4; ++c) {
      for (let r = 0; r < 4; ++r) {
        let s = 0;
        for (let k = 0; k < 4; ++k) s += toDisplay[4 * k + r] * (move === undefined ? (k === c ? 1 : 0) : move[4 * k + c]);
        placed[4 * c + r] = s;
      }
    }
    const matrix = new Float32Array(16);
    for (let c = 0; c < 4; ++c) {
      for (let r = 0; r < 4; ++r) {
        let s = 0;
        for (let k = 0; k < 4; ++k) s += vp[4 * k + r] * placed[4 * c + k];
        matrix[4 * c + r] = s;
      }
    }
    // The view's direction, from the near plane's centre to the far one's, in RAS.
    const inv = frame.invViewProjection;
    const at = (z: number) => {
      const w = inv[11] * z + inv[15];
      return [0, 1, 2].map((r) => (inv[8 + r] * z + inv[12 + r]) / w);
    };
    const near = at(-1);
    const far = at(1);
    // Display axis k is RAS axis a with display = factor × ras: undo it.
    let viewRas = [0, 0, 0];
    for (let k = 0; k < 3; ++k) for (let a = 0; a < 3; ++a) if (toDisplay[4 * a + k] !== 0) viewRas[a] = (far[k] - near[k]) / toDisplay[4 * a + k];
    // Back into the store's frame, before the layer's move.
    if (move !== undefined) {
      const back = invert4(move);
      viewRas = [0, 1, 2].map((r) => back[4 * r] * viewRas[0] + back[4 * r + 1] * viewRas[1] + back[4 * r + 2] * viewRas[2]);
    }
    const n = Math.hypot(viewRas[0], viewRas[1], viewRas[2]) || 1;
    const viewDir = viewRas.map((v) => v / n) as Vec3;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    const used: GlyphSet[] = [];
    for (const slot of this.slots.values()) {
      const shown = slot.shown;
      if (shown === undefined) continue;
      const voxel = this.opened.levels[shown.level].voxelSize;
      const scale = (voxel * this.saved.size) / 2;
      used.push(shown.set);
      this.renderer3d.draw(shown.set, { matrix, viewDir, scale, viewport: [frame.width, frame.height], lineWidth: 2, lift: scale * 1.05 });
    }
    this.renderer3d.keepOnly(used);
  }

  // ------------------------------------------------------------- screenshots

  private paintScreenshot(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    if (!this.saved.on || !this.saved.show2d || this.glyphOverlay === undefined || this.overlay === undefined) return;
    // Drawn again now, so the canvas holds this frame when it is copied.
    this.frame(true);
    const glyphs = this.glyphOverlay.canvas;
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, canvasRect.width);
    const base = this.overlay.element.getBoundingClientRect();
    context.drawImage(glyphs, (base.left - canvasRect.left) * scale, (base.top - canvasRect.top) * scale, base.width * scale, base.height * scale);
  }

  // ------------------------------------------------------------- direction colour

  /** Sets the image layer's shader to direction colour (see ./shader.ts). */
  applyDirectionColour(): void {
    const opened = this.opened;
    const target = this.target();
    if (opened === undefined || target === undefined) {
      this.ctx.ui.toast("Open an image with orientations first.");
      return;
    }
    const options = this.options(2)!;
    const shader = directionShader(options, opened.levels[0].components);
    if (shader === undefined) {
      this.ctx.ui.toast("Direction colour needs vectors, tensors or spherical harmonics.");
      return;
    }
    const level0 = opened.levels[0];
    if (level0.componentChunk < level0.components) {
      // Neuroglancer's shaders see a channel dimension only whole in one chunk.
      this.ctx.ui.toast(`Can't colour by direction: this image splits each voxel's ${level0.components} components over chunks of ${level0.componentChunk}. Write it as OME-Zarr with whole channel chunks (see the README).`, "error");
      return;
    }
    const edit = this.channelEdit(target.name, "^");
    if (edit === "loading") {
      this.ctx.ui.toast("The image's layer has not loaded yet; try again in a moment.");
      return;
    }
    this.ctx.viewer.patchState((ng) => {
      const layer = ((ng.layers ?? []) as Record<string, unknown>[]).find((l) => l.name === target.name);
      if (layer === undefined) return;
      layer.shader = shader;
      edit?.(layer);
    });
  }

  /**
   * An edit renaming a layer's component axis: to a channel dimension
   * (`c^`), so a shader sees every component at once, or to a local one
   * (`t'`), out of the global dimensions; the layer's output dimensions as
   * they are, that one renamed.  Undefined when it is so already (a channel
   * dimension stays one); "loading" until the layer's source has loaded.
   */
  private channelEdit(layerName: string, suffix: "^" | "'"): ((layer: Record<string, unknown>) => void) | undefined | "loading" {
    const transform = this.ctx.viewer.layerTransform(layerName);
    const axis = this.opened?.componentAxis;
    const names = transform?.output.names ?? [];
    const current = names.find((n) => n === `${axis}'` || n === axis || n === `${axis}^`);
    if (transform === undefined || axis === undefined || current === undefined) return "loading";
    if (current === `${axis}${suffix}` || current === `${axis}^`) return undefined;
    return (layer) => {
      const source: Record<string, unknown> = typeof layer.source === "string" ? { url: layer.source } : { ...(layer.source as Record<string, unknown>) };
      const outputDimensions: Record<string, [number, string]> = {};
      names.forEach((n, i) => (outputDimensions[n === current ? `${axis}${suffix}` : n] = [transform.output.scales[i], transform.output.units[i]]));
      source.transform = { ...((source.transform as Record<string, unknown>) ?? {}), outputDimensions };
      layer.source = source;
      // The local position along it no longer applies.
      delete layer.localDimensions;
      delete layer.localPosition;
    };
  }

  /** The store whose component axis was taken out of the global dimensions. */
  private channelised: string | undefined;

  /**
   * A component axis among the global dimensions (a 4-D NIfTI's t) makes
   * every view step through components and upsets the 2-D views' zoom; it
   * becomes a local dimension of the layer instead (`t'`), once per image,
   * on the user's behalf (the layer still shows the first component).
   */
  private channelise(): void {
    const opened = this.opened;
    const layer = this.handleLayer;
    if (opened === undefined || layer === undefined || this.channelised === this.store) return;
    if (!(this.space?.names ?? []).includes(opened.componentAxis)) {
      this.channelised = this.store;
      return;
    }
    const edit = this.channelEdit(layer, "'");
    if (edit === "loading") return;
    this.channelised = this.store;
    if (edit === undefined) return;
    this.ctx.viewer.patchState(
      (ng) => {
        const spec = ((ng.layers ?? []) as Record<string, unknown>[]).find((l) => l.name === layer);
        if (spec !== undefined) edit(spec);
      },
      { quiet: true },
    );
  }

  // ------------------------------------------------------------- panel

  /** What the image is and what each view shows, in lines for the panel. */
  describe(): string[] {
    const lines: string[] = [];
    const opened = this.opened;
    if (opened === undefined) return lines;
    const level0 = opened.levels[0];
    const options = this.options(2)!;
    const what =
      options.kind === "sh"
        ? `spherical harmonics, order ${lmaxOf(level0.components)} (${level0.components} coefficients), ${SH_BASES.find(([b]) => b === options.basis)?.[1]}`
        : options.kind === "tensor"
          ? `tensors, ${TENSOR_ORDERS.find(([o]) => o === options.tensorOrder)?.[1]}`
          : options.kind === "vector"
            ? "vectors"
            : `peaks (${Math.floor(level0.components / 3)} per voxel)`;
    lines.push(`${opened.name}: ${what}; ${opened.levels.length} level${opened.levels.length === 1 ? "" : "s"}, ${opened.levels.map((l) => mmText(l.voxelSize)).join(", ")}.`);
    const coarsened = this.coarsened;
    if (opened.nifti !== undefined && opened.levels.length > 1 && coarsened !== undefined && coarsened.url === this.store) {
      lines.push(coarsened.tensor !== null ? "Coarser levels: log-Euclidean means of the tensors (made by the app)." : "Coarser levels: means of each component (made by the app).");
    }
    let index = 0;
    for (const [key, slot] of this.slots) {
      index++;
      const name = key === "3d" ? "3-D view" : `View ${index}`;
      const shown = slot.shown;
      const parts: string[] = [];
      if (shown) parts.push(`${shown.set.count} glyphs at ${mmText(opened.levels[shown.level].voxelSize)}`);
      if (slot.pending) parts.push(`reading ${mmText(opened.levels[slot.pending.level].voxelSize)}…`);
      if (slot.note) parts.push(slot.note);
      if (parts.length > 0) lines.push(`${name}: ${parts.join("; ")}`);
    }
    return lines;
  }

  render(host: HTMLElement): Disposer {
    const draw = () => {
      const { saved } = this;
      const candidates = this.candidates();
      const target = saved.on ? this.target() : (candidates.find((l) => l.name === saved.layer) ?? candidates.find((l) => l.name === this.chosen) ?? candidates[0]);
      const select = (label: string, value: string, options: [string, string][], onChange: (v: string) => void, disabled = false) => {
        const s = el("select", { class: "text-input", "aria-label": label }) as HTMLSelectElement;
        for (const [v, text] of options) s.append(el("option", { value: v }, text));
        s.value = value;
        s.disabled = disabled;
        s.addEventListener("change", () => onChange(s.value));
        return el("label", { class: "field" }, el("span", {}, label), s);
      };
      const check = (label: string, value: boolean, onChange: (v: boolean) => void, title?: string) => {
        const c = el("input", { type: "checkbox" }) as HTMLInputElement;
        c.checked = value;
        c.addEventListener("change", () => onChange(c.checked));
        return el("label", { class: "field check", title }, c, el("span", {}, label));
      };
      const range = (label: string, value: number, min: number, max: number, step: number, show: (v: number) => string, onChange: (v: number) => void) => {
        const r = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label }) as HTMLInputElement;
        const out = el("span", { class: "type" }, show(value));
        r.addEventListener("input", () => (out.textContent = show(Number(r.value))));
        r.addEventListener("change", () => onChange(Number(r.value)));
        return el("label", { class: "field" }, el("span", {}, label), el("div", { class: "or-row" }, r, out));
      };
      const on = el("input", { type: "checkbox", "aria-label": "Orientation glyphs" }) as HTMLInputElement;
      on.checked = saved.on;
      on.addEventListener("change", () => this.set({ on: on.checked }));
      const components = this.opened?.levels[0].components;
      const kind = this.opened ? resolveKind(saved, this.opened, components!) : undefined;
      const flips = el(
        "div",
        { class: "or-flips" },
        ...[0, 1, 2].map((k) =>
          check(`Flip ${"xyz"[k]}`, saved.flips[k], (v) => {
            const f = [...saved.flips] as [boolean, boolean, boolean];
            f[k] = v;
            this.set({ flips: f });
          }),
        ),
      );
      const noTarget = saved.on && candidates.length > 0 && this.target() === undefined ? "None of these images has a component axis (c) to draw as glyphs." : undefined;
      const status = [this.openError, noTarget, this.glyphOverlay?.problem, ...this.describe(), this.cursorLine].filter((s): s is string => !!s);
      if (candidates.length === 0) {
        host.replaceChildren(
          el(
            "div",
            { class: "or-panel" },
            el("label", { class: "or-row" }, el("span", { class: "or-label" }, "Orientation glyphs"), on),
            el("p", { class: "note" }, "Add an image of orientations (ODFs, tensors or peaks): an OME-Zarr or 4-D NIfTI with a component axis."),
          ),
        );
        return;
      }
      host.replaceChildren(
        el(
          "div",
          { class: "or-panel" },
          el("label", { class: "or-row", title: "ODFs, tensors and peaks over an image with a component axis. Also Glyphs beside Sections in the 3-D view." }, el("span", { class: "or-label" }, "Orientation glyphs"), on),
          select(
            "Image",
            target?.name ?? "",
            candidates.map((c) => [c.name, c.name]),
            (v) => this.set({ layer: v }),
            candidates.length < 2,
          ),
          select(
            "Data",
            saved.kind,
            [
              ["auto", `Automatic${kind && saved.kind === "auto" ? ` (${kind === "sh" ? "spherical harmonics" : kind})` : ""}`],
              ["sh", "Spherical harmonics (ODF)"],
              ["tensor", "Diffusion tensor (6)"],
              ["vector", "Vector (3)"],
              ["peaks", "Peaks (3 per peak)"],
            ],
            (v) => this.set({ kind: v as Saved["kind"] }),
          ),
          kind === "sh" || saved.kind === "auto"
            ? select("SH basis", saved.basis, [["auto", "Automatic (the store's, else DIPY's)"], ...SH_BASES], (v) => this.set({ basis: v as Saved["basis"] }))
            : null,
          kind === "sh"
            ? select(
                "SH glyph",
                saved.shGlyph,
                [
                  ["odf", "ODF shape"],
                  ["peaks", "Peaks (up to 3)"],
                ],
                (v) => this.set({ shGlyph: v as Saved["shGlyph"] }),
              )
            : null,
          kind === "tensor" ? select("Tensor order", saved.tensorOrder, [["auto", "Automatic (the store's, else FSL's)"], ...TENSOR_ORDERS], (v) => this.set({ tensorOrder: v as Saved["tensorOrder"] })) : null,
          kind === "tensor"
            ? select(
                "Tensor glyph",
                saved.tensorGlyph,
                [
                  ["ellipsoid", "Ellipsoid"],
                  ["line", "Principal direction"],
                ],
                (v) => this.set({ tensorGlyph: v as Saved["tensorGlyph"] }),
              )
            : null,
          select(
            "Frame",
            saved.frame,
            [
              ["auto", "Automatic"],
              ["voxel", "Voxel axes (DIPY, FSL)"],
              ["world", "World x, y, z (MRtrix)"],
            ],
            (v) => this.set({ frame: v as Saved["frame"] }),
          ),
          flips,
          select(
            "Normalise",
            saved.normalise,
            [
              ["minmax", "Min–max per voxel (FURY)"],
              ["max", "Maximum per voxel"],
              ["none", "Across the view (sizes compare)"],
            ],
            (v) => this.set({ normalise: v as Normalise }),
          ),
          range("Size", saved.size, 0.2, 3, 0.05, (v) => `${v.toFixed(2)} voxel`, (v) => this.set({ size: v })),
          range("Spacing", saved.spacing, 4, 80, 1, (v) => `${v} px`, (v) => this.set({ spacing: v })),
          kind === "sh" || kind === "tensor"
            ? range("Hide below anisotropy", saved.minAnisotropy, 0, 0.9, 0.01, (v) => (v > 0 ? `${kind === "sh" ? "GFA" : "FA"} ${v.toFixed(2)}` : "off"), (v) => this.set({ minAnisotropy: v }))
            : null,
          range("Most glyphs per view", saved.maxGlyphs, 500, 30000, 500, (v) => String(v), (v) => this.set({ maxGlyphs: v })),
          el("div", { class: "or-flips" }, check("2-D views", saved.show2d, (v) => this.set({ show2d: v })), check("3-D view", saved.show3d, (v) => this.set({ show3d: v }))),
          el(
            "button",
            {
              class: "btn outline small",
              type: "button",
              title: "Set the image layer's shader to show the principal direction as colour, weighted by anisotropy",
              onclick: () => this.applyDirectionColour(),
            },
            "Colour image by direction",
          ),
          status.length ? el("div", { class: "note or-status" }, ...status.map((s) => el("div", {}, s))) : null,
        ),
      );
    };
    this.panelUpdate = draw;
    draw();
    return () => {
      if (this.panelUpdate === draw) this.panelUpdate = undefined;
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cursorRead?.abort();
    this.offs.forEach((off) => off());
    this.clearSlots();
    this.handle?.dispose();
    this.toggle.dispose();
    this.glyphOverlay?.dispose();
    this.overlay?.dispose();
    this.client?.dispose();
  }
}

/**
 * RAS mm to the 3-D view's display coordinates, column-major (display axis
 * k is the global dimension named x, y or z, in its own units).
 */
function displayOfRasMatrix(dimensions: Frame3d["dimensions"]): Float32Array | undefined {
  const m = new Float32Array(16);
  m[15] = 1;
  for (let i = 0; i < 3; ++i) {
    const axis = ["x", "y", "z"].indexOf(dimensions.names[i]);
    if (axis === -1) return undefined;
    const factor = dimensions.units[i] === "m" ? 1e-3 / dimensions.scales[i] : 1 / dimensions.scales[i];
    m[4 * axis + i] = factor;
  }
  return m;
}

const STYLE = `
.or-panel { display: grid; gap: 10px; }
.or-row { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.or-row input[type="range"] { flex: 1; }
.or-label { font-weight: 600; }
.or-flips { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.or-status { display: grid; gap: 2px; }
`;

let instance: Orientations | undefined;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    instance = new Orientations(ctx);
    const own = instance;
    ctx.subscriptions.push(() => style.remove());
    ctx.subscriptions.push(() => {
      own.dispose();
      if (instance === own) instance = undefined;
    });
    ctx.ui.panel(ORIENTATIONS_PANEL, (host) => own.render(host));
    // What is shown, for other plugins and for checking the plugin in a browser.
    ctx.services.provide("orientations.status", { lines: () => own.describe(), stats: own.stats });
    ctx.commands.register("orientations.toggle", () => {
      const saved = readSaved(ctx.state.get());
      ctx.state.set({ ...saved, on: !saved.on });
    });
  },
};

export type { OrientationLevel };
