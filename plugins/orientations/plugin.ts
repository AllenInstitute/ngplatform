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
import { button, card, checkbox, el, emptyState, field, info, region, select, type Settable, slider, statusLine, toggle } from "@ngplatform/sdk/dom";
import { mmText } from "@ngplatform/sdk/format";
import { omeZarrUrl } from "../volume-view/sources.js";
import { OrientationClient } from "./client.js";
import { type GlyphOptions, type GlyphSet, type Normalise, type OrientationKind, voxelFrame, withFlips } from "./glyphs.js";
import { ORIENTATIONS_PANEL } from "./manifest.js";
import { CONTEXT_LOST, GlyphOverlay, type PanelDraw } from "./overlay.js";
import type { Opened, OrientationLevel } from "./reader.js";
import { GlyphRenderer } from "./render.js";
import { lmaxOf, SH_BASES, type ShBasis } from "./sh.js";
import { describeVoxel } from "./readout.js";
import { directionShader } from "./shader.js";
import { TENSOR_ORDERS, type TensorOrder } from "./tensor.js";
import { type Box, chooseLevel, layerMove, type SectionPlan, contains, invert4, planesAround, planSection, type Section, sectionOf, type Vec3, applyAffine } from "./view.js";
import { gcsReadable } from "@ngplatform/sdk/sources";

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
  /** Why nothing is shown, when nothing is (zoom in). */
  note?: string;
  /** The last read failed: why, and what it was for (not read again for that until Retry). */
  error?: { message: string; key: string };
}

/** The reading the plugin does, in a worker (./client.ts); a test gives its own. */
export type Client = Pick<OrientationClient, "open" | "glyphs" | "values" | "dispose">;

/** Opening an image is tried this many times, waiting twice as long each time from the first wait, before Retry is offered. */
export const OPEN_ATTEMPTS = 3;
export const OPEN_WAIT_MS = 2000;

type Want = SectionPlan;

/** The global coordinate space, as the state has it, cached from state changes. */
interface Space {
  names: string[];
  scales: number[];
  units: string[];
  position: number[];
  projectionScale: number | undefined;
}

export class Orientations {
  private saved: Saved;
  private client: Client | undefined;
  private store: string | undefined;
  private opened: Opened | undefined;
  private openError: string | undefined;
  /** An image that failed to open, not asked for again until then (for ever once the attempts are spent: Retry); and how often it failed. */
  private failed: { url: string; until: number; attempts: number } | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
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
  /** The panel's line for the voxel under the cursor: its text alone changes. */
  private cursorText: HTMLElement | undefined;
  private readonly toggle: { set(value: boolean): void; dispose(): void };
  private readonly offs: Disposer[] = [];
  /** Image layers looked at for a component axis, by URL: whether they have one. */
  private readonly probed = new Map<string, Promise<boolean>>();

  constructor(
    private readonly ctx: PlatformContext,
    private readonly makeClient: () => Client = () => new OrientationClient(),
  ) {
    this.saved = readSaved(ctx.state.get());
    this.toggle = ctx.ui.viewToggle({
      label: "Glyphs",
      title: "Orientation glyphs (ODFs, tensors, peaks) over the image; the Orientations panel has their settings",
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
      () => clearTimeout(this.retryTimer),
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
        let response = await fetch(gcsReadable(`${url}zarr.json`));
        if (!response.ok) response = await fetch(gcsReadable(`${url}.zattrs`));
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
      this.newGlyphOverlay();
    }
    const url = omeZarrUrl(target.sources[0])!;
    if (url !== this.store && !(url === this.failed?.url && Date.now() < this.failed.until)) {
      this.store = url;
      if (this.failed?.url !== url) {
        this.failed = undefined;
        this.openError = undefined;
      }
      this.opened = undefined;
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

  /** The 2-D views' glyph canvas (anew: a new canvas asks for a new context); drawn again when its context is lost or given back. */
  private newGlyphOverlay(): void {
    if (this.overlay === undefined) return;
    this.glyphOverlay?.dispose();
    this.glyphOverlay = new GlyphOverlay(this.overlay.element, () => {
      this.drawn = "";
      this.schedule();
      this.panelUpdate?.();
    });
    this.drawn = "";
    this.schedule();
    this.panelUpdate?.();
  }

  private clearSlots(): void {
    for (const slot of this.slots.values()) slot.pending?.controller.abort();
    this.slots.clear();
  }

  private async open(url: string): Promise<void> {
    this.client ??= this.makeClient();
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
      this.failed = undefined;
      this.openError = undefined;
      this.schedule();
    } catch (e) {
      if (this.store === url && !this.disposed) {
        // Not kept as open (a network blip need not stick): opened afresh a few
        // times, waiting longer each time, then left until Retry.
        const attempts = (this.failed?.url === url ? this.failed.attempts : 0) + 1;
        const wait = attempts < OPEN_ATTEMPTS ? OPEN_WAIT_MS * 2 ** (attempts - 1) : Infinity;
        this.openError = `Could not read the image: ${(e as Error).message}`;
        this.store = undefined;
        this.probed.delete(url);
        this.failed = { url, until: Date.now() + wait, attempts };
        clearTimeout(this.retryTimer);
        if (Number.isFinite(wait))
          this.retryTimer = setTimeout(() => {
            if (this.disposed || this.failed?.url !== url) return;
            this.failed.until = 0;
            this.update();
          }, wait);
      }
    }
    this.panelUpdate?.();
  }

  /** Opens the image again now, its attempts counted afresh. */
  retryOpen(): void {
    clearTimeout(this.retryTimer);
    this.failed = undefined;
    this.openError = undefined;
    this.store = undefined;
    this.update();
  }

  /** Whether the image is being read again after failing, or has been given up on until Retry. */
  private openState(): "reading" | "retrying" | "failed" | undefined {
    if (this.failed !== undefined) return Number.isFinite(this.failed.until) ? "retrying" : "failed";
    if (this.saved.on && this.store !== undefined && this.opened === undefined) return "reading";
    return undefined;
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
      if ((want.note || undefined) !== slot.note) {
        slot.note = want.note || undefined;
        this.panelUpdate?.();
      }
      // Too many to draw: nothing rather than the wrong level.
      if (want.note) slot.shown = undefined;
      return;
    }
    if (slot.note !== undefined) {
      slot.note = undefined;
      this.panelUpdate?.();
    }
    const covered = (s: { key: string; box: Box } | undefined) => s !== undefined && s.key === want.key && contains(s.box, want.visible);
    if (covered(slot.shown) || covered(slot.pending)) return;
    // What failed is not read again until Retry (or the view wants something else).
    if (slot.error?.key === want.key) return;
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
        if (slot.error !== undefined) {
          slot.error = undefined;
          this.panelUpdate?.();
        }
      },
      (e: Error) => {
        if (controller.signal.aborted || slot.pending?.controller !== controller) return;
        slot.pending = undefined;
        slot.error = { message: e.message, key: want.key };
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

  /** Only the voxel line's text changes: the panel is not brought up to date for it. */
  private setCursorLine(line: string | undefined): void {
    if (line === this.cursorLine) return;
    this.cursorLine = line;
    if (this.cursorText !== undefined) this.cursorText.textContent = line ?? NO_VOXEL;
  }

  /** Reads again what failed for each view. */
  retryGlyphs(): void {
    for (const slot of this.slots.values()) slot.error = undefined;
    this.drawn = "";
    this.schedule();
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

  /** What the open image holds and how its levels were made, in words: the panel's quiet line under the image. */
  summary(): string | undefined {
    const opened = this.opened;
    if (opened === undefined) return undefined;
    const level0 = opened.levels[0];
    const options = this.options(2)!;
    const what =
      options.kind === "sh"
        ? `Spherical harmonics, order ${lmaxOf(level0.components)}, ${options.basis.replace("-", " ")}`
        : options.kind === "tensor"
          ? `Tensors in ${{ fsl: "FSL", dipy: "DIPY", mrtrix: "MRtrix" }[options.tensorOrder]} order`
          : options.kind === "vector"
            ? "Vectors"
            : `Peaks, ${Math.floor(level0.components / 3)} per voxel`;
    const levels = `${opened.levels.length} level${opened.levels.length === 1 ? "" : "s"}, ${opened.levels.map((l) => mmText(l.voxelSize)).join(", ")}`;
    const coarsened = this.coarsened;
    const made =
      opened.nifti !== undefined && opened.levels.length > 1 && coarsened !== undefined && coarsened.url === this.store
        ? coarsened.tensor !== null
          ? "; coarser levels: log-Euclidean means"
          : "; coarser levels: means"
        : "";
    return `${what} · ${levels}${made}`;
  }

  /** What the image is and what each view shows, in lines: for the `orientations.status` service, not the panel. */
  describe(): string[] {
    const lines: string[] = [];
    const opened = this.opened;
    if (opened === undefined) return lines;
    lines.push(`${opened.name}: ${this.summary()}.`);
    let index = 0;
    for (const [key, slot] of this.slots) {
      index++;
      const name = key === "3d" ? "3-D view" : `View ${index}`;
      const shown = slot.shown;
      const parts: string[] = [];
      if (shown) parts.push(`${shown.set.count} glyphs at ${mmText(opened.levels[shown.level].voxelSize)}`);
      if (slot.pending) parts.push(`reading ${mmText(opened.levels[slot.pending.level].voxelSize)}…`);
      if (slot.note) parts.push(slot.note);
      if (slot.error) parts.push(`could not read glyphs: ${slot.error.message}`);
      if (parts.length > 0) lines.push(`${name}: ${parts.join("; ")}`);
    }
    return lines;
  }

  /**
   * Draws the panel once into `host` and keeps it up to date in place
   * (plugins/README.md, "Building a panel"): the controls are set from the
   * state with `set()`, the fields for one kind of data hidden or shown,
   * and the voxel under the cursor changes one line's text only; so a
   * cursor move or a glyph read never closes a select or ends a drag.
   */
  render(host: HTMLElement): Disposer {
    const ctx = this.ctx;
    const empty = emptyState("No image in this scene.", { label: "Open data…", run: () => void ctx.commands.invoke("dataset.add") });
    const status = statusLine();
    const s = this.saved;

    const on = toggle("Orientation glyphs", s.on, (v) => this.set({ on: v }), {
      info: "ODFs, tensors and peaks over an image with an axis of components (c). Also Glyphs beside Sections in the 3-D view.",
    });

    // ---- Image: which image, what its voxels hold and how to read them.
    const image = select([], "", (v) => this.set({ layer: v }), "Image");
    const noComponents = el("p", { class: "hint" }, "None of these images has an axis of components (c).");
    const kind = select(
      [
        ["auto", "Automatic"],
        ["sh", "Spherical harmonics (ODFs)"],
        ["tensor", "Diffusion tensors"],
        ["vector", "Vectors"],
        ["peaks", "Peaks"],
      ],
      s.kind,
      (v) => this.set({ kind: v as Saved["kind"] }),
      "Voxels hold",
    );
    const basis = select([["auto", "Automatic"], ...SH_BASES], s.basis, (v) => this.set({ basis: v as Saved["basis"] }), "SH basis");
    const basisField = field("SH basis", basis, { info: "Automatic: the store's own word, else DIPY's legacy descoteaux07. MRtrix3 writes tournier07. A wrong basis scrambles the glyphs." });
    const order = select([["auto", "Automatic"], ...TENSOR_ORDERS], s.tensorOrder, (v) => this.set({ tensorOrder: v as Saved["tensorOrder"] }), "Tensor order");
    const orderField = field("Tensor order", order, { info: "Automatic: the store's own word, DIPY's for a NIfTI whose header says symmetric matrix, else FSL's." });
    const frame = select(
      [
        ["auto", "Automatic"],
        ["voxel", "Voxel axes (DIPY, FSL)"],
        ["world", "World x, y, z (MRtrix)"],
      ],
      s.frame,
      (v) => this.set({ frame: v as Saved["frame"] }),
      "Frame",
    );
    const flips = [0, 1, 2].map((k) =>
      checkbox(`Flip ${"xyz"[k]}`, s.flips[k], (v) => {
        const f = [...this.saved.flips] as [boolean, boolean, boolean];
        f[k] = v;
        this.set({ flips: f });
      }),
    );
    const about = el("p", { class: "hint" });

    // ---- Glyphs: their shape and size, and which are drawn.
    const shGlyph = select(
      [
        ["odf", "ODF shape"],
        ["peaks", "Peaks (up to 3)"],
      ],
      s.shGlyph,
      (v) => this.set({ shGlyph: v as Saved["shGlyph"] }),
      "ODF glyph",
    );
    const shGlyphField = field("ODF glyph", shGlyph);
    const tensorGlyph = select(
      [
        ["ellipsoid", "Ellipsoid"],
        ["line", "Principal direction"],
      ],
      s.tensorGlyph,
      (v) => this.set({ tensorGlyph: v as Saved["tensorGlyph"] }),
      "Tensor glyph",
    );
    const tensorGlyphField = field("Tensor glyph", tensorGlyph);
    const normalise = select(
      [
        ["minmax", "Each voxel's range"],
        ["max", "Each voxel's maximum"],
        ["none", "The view's largest"],
      ],
      s.normalise,
      (v) => this.set({ normalise: v as Normalise }),
      "Scale glyphs to",
    );
    const size = slider(s.size, { min: 0.2, max: 3, step: 0.05, unit: "voxel", label: "Size", onchange: (v) => this.set({ size: v }) });
    const spacing = slider(s.spacing, { min: 4, max: 80, step: 1, unit: "px", label: "Spacing", onchange: (v) => this.set({ spacing: v }) });
    const anisotropy = slider(s.minAnisotropy, { min: 0, max: 0.9, step: 0.01, label: "Hide below anisotropy", onchange: (v) => this.set({ minAnisotropy: v }) });
    const anisotropyField = field("Hide below anisotropy", anisotropy, { info: "Leaves out glyphs whose GFA (spherical harmonics) or FA (tensors) is lower: outside the white matter, say. 0 hides none." });
    const limit = slider(s.maxGlyphs, { min: 500, max: 30000, step: 500, label: "Glyph limit per view", onchange: (v) => this.set({ maxGlyphs: v }) });

    // ---- Views: where glyphs are drawn, and the image's colours.
    const show2d = checkbox("2-D views", s.show2d, (v) => this.set({ show2d: v }));
    const show3d = checkbox("3-D view", s.show3d, (v) => this.set({ show3d: v }), { info: "On the 2-D views' sections; with only a 3-D view, on three planes through the position." });
    const notes = region((lines: string[]) => lines.map((l) => el("p", { class: "hint" }, l)), { class: "stack" });
    const colour = button("Colour image by direction", () => this.applyDirectionColour());

    // ---- Voxel: what the voxel under the cursor holds (its text set alone, by setCursorLine).
    const cursorText = el("p", { class: "readout" }, this.cursorLine ?? NO_VOXEL);
    this.cursorText = cursorText;

    const main = el(
      "div",
      { class: "stack" },
      on,
      card(
        "orientations.image",
        "Image",
        { open: true },
        field("Image", image),
        noComponents,
        field("Voxels hold", kind, { info: "Automatic reads the store's orientations attributes, else goes by the number of components: 3 a vector, 6 a tensor, 15, 28, 45… spherical harmonics, other multiples of 3 peaks. Six can also be order-2 harmonics: choose them here." }),
        basisField,
        orderField,
        field("Frame", frame, { info: "Directions along the voxel axes (DIPY, FSL) or along the world's x, y, z (MRtrix). Automatic: the store's word, else world for tournier07 and voxel otherwise." }),
        el("div", { class: "row" }, ...flips, info("Flip an axis when glyphs point the wrong way (a common bvec problem), as in mrview or DSI Studio.", "About Flip")),
        about,
      ),
      card(
        "orientations.glyphs",
        "Glyphs",
        {},
        shGlyphField,
        tensorGlyphField,
        field("Scale glyphs to", normalise, { info: "Each voxel's range (min to max, as FURY), each voxel's maximum, or the largest in the view, so that sizes compare." }),
        field("Size", size, { info: "1 fills a voxel." }),
        field("Spacing", spacing, { info: "Glyphs at least this many pixels apart: each view shows the finest level that keeps them so." }),
        anisotropyField,
        field("Glyph limit per view", limit, { info: "At most this many glyphs in a view: beyond it a coarser level, and beyond the coarsest none until you zoom in." }),
      ),
      card(
        "orientations.views",
        "Views",
        {},
        el("div", { class: "row" }, show2d, show3d),
        notes,
        el(
          "div",
          { class: "row" },
          colour,
          info("Sets the image layer's colours to the principal direction (red left-right, green front-back, blue up-down), weighted by the anisotropy, as Freeview's -dti display. Its Display tab has a brightness slider.", "About Colour image by direction"),
        ),
      ),
      card("orientations.voxel", "Voxel", { info: "What the voxel under the mouse holds: a tensor's FA, MD, eigenvalues and principal direction; an ODF's GFA and peaks; a vector's direction and length." }, cursorText),
    );
    host.append(el("div", { class: "stack" }, empty, main, status));

    /** Brings the panel up to date with the state, the layers and what was read. */
    const sync = () => {
      const saved = this.saved;
      const candidates = this.candidates();
      empty.hidden = candidates.length > 0;
      main.hidden = candidates.length === 0;
      on.set(saved.on);
      // The image drawn; else (off, or none with components found) the one that would be.
      const target = saved.on ? this.target() : undefined;
      const shown = target ?? candidates.find((l) => l.name === saved.layer) ?? candidates.find((l) => l.name === this.chosen) ?? candidates[0];
      setOptions(
        image,
        candidates.map((c): [string, string] => [c.name, c.name]),
        shown?.name ?? "",
      );
      image.disabled = candidates.length < 2;
      noComponents.hidden = !(saved.on && candidates.length > 0 && target === undefined);
      const resolved = this.opened ? resolveKind(saved, this.opened, this.opened.levels[0].components) : undefined;
      kind.set(saved.kind);
      basis.set(saved.basis);
      basisField.hidden = resolved !== "sh";
      order.set(saved.tensorOrder);
      orderField.hidden = resolved !== "tensor";
      frame.set(saved.frame);
      flips.forEach((f, k) => f.set(saved.flips[k]));
      const summary = this.summary();
      about.textContent = summary ?? "";
      about.hidden = summary === undefined;

      shGlyph.set(saved.shGlyph);
      shGlyphField.hidden = resolved !== "sh";
      tensorGlyph.set(saved.tensorGlyph);
      tensorGlyphField.hidden = resolved !== "tensor";
      normalise.set(saved.normalise);
      size.set(saved.size);
      spacing.set(saved.spacing);
      anisotropy.set(saved.minAnisotropy);
      anisotropyField.hidden = resolved !== "sh" && resolved !== "tensor";
      limit.set(saved.maxGlyphs);

      show2d.set(saved.show2d);
      show3d.set(saved.show3d);
      notes.update([...new Set([...this.slots.values()].flatMap((slot) => (slot.note ? [slot.note] : [])))]);
      colour.disabled = this.opened === undefined;

      // Errors first, then what is being read.
      const slotError = [...this.slots.values()].find((slot) => slot.error !== undefined)?.error;
      const problem = this.glyphOverlay?.problem;
      const open = this.openState();
      if (problem !== undefined) status.error(problem, problem === CONTEXT_LOST ? { label: "Retry", run: () => this.newGlyphOverlay() } : undefined);
      else if (open === "failed") status.error(this.openError ?? "Could not read the image.", { label: "Retry", run: () => this.retryOpen() });
      else if (open === "retrying") status.progress(`${this.openError ?? "Could not read the image"}. Trying again…`);
      else if (this.openError !== undefined && saved.on) status.error(this.openError);
      else if (slotError !== undefined) status.error(`Could not read glyphs: ${slotError.message}`, { label: "Retry", run: () => this.retryGlyphs() });
      else if (open === "reading") status.progress("Reading the image…");
      else status.clear();
    };
    this.panelUpdate = sync;
    sync();
    return () => {
      if (this.panelUpdate === sync) this.panelUpdate = undefined;
      if (this.cursorText === cursorText) this.cursorText = undefined;
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cursorRead?.abort();
    clearTimeout(this.retryTimer);
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

/** The Voxel card's line with nothing under the mouse. */
const NO_VOXEL = "No voxel under the mouse.";

/** A select's options set anew only when they change (so an open select stays open); its value shown. */
function setOptions(s: Settable<HTMLSelectElement, string>, options: [string, string][], value: string): void {
  const key = JSON.stringify(options);
  if (s.getAttribute("data-options") !== key) {
    s.setAttribute("data-options", key);
    s.replaceChildren(...options.map(([v, text]) => el("option", { value: v }, text)));
    s.value = value;
  }
  s.set(value);
}

let instance: Orientations | undefined;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    instance = new Orientations(ctx);
    const own = instance;
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
