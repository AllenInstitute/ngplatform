/**
 * A label volume being drawn: the volume in the page, the segmentation
 * layer that shows it (served from the page as an OME-Zarr store), its
 * strokes' history, its labels' names and colours, and the image whose
 * values limit the tools (by default the one whose grid it was made on).
 *
 * After a stroke the layer's data is read again: Neuroglancer drops the
 * chunks it holds from the store and asks for those on screen, which the
 * page answers from memory at once.  Strokes are told a few times a second
 * while they last, and once when they end.  (A segmentation edited in
 * place, ./cow_volume.ts, answers its unedited chunks from its original,
 * which it may have to read first.)
 */
import type { PlatformContext } from "@ngplatform/sdk";
import { between, type Placement, placement } from "../annotations/geometry.js";
import { space } from "../annotations/scene.js";
import type { ImageLevel, Voxels } from "../annotations/voxels.js";
import { History } from "./history.js";
import type { ImageBlock, Vec3 } from "./kernels.js";
import { CHUNK, LabelVolume } from "./label_volume.js";
import { CowVolume } from "./cow_volume.js";
import { discard, keep, persist, readKept } from "./keep.js";
import { hashColour } from "./segments.js";
import { LABEL_STORE_EXTENSION, serveInPage } from "./store_format.js";

/** Distinct colours for labels 1, 2, 3, … (then round again). */
export const PALETTE = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000", "#aaffc3"];

export const colourOf = (value: number) => PALETTE[(value - 1) % PALETTE.length];

/** A volume opened with more segments than this keeps Neuroglancer's colours (see `Session.palette`). */
export const PALETTE_SEGMENTS = 1000;

export interface Reference {
  layer: string;
  store: string;
  level: number;
  levels: ImageLevel[];
}

let sessions = 0;

/** Whether this browser's refusal to keep the copies for good has been said (once a visit). */
let refusalTold = false;

export class Session {
  readonly history = new History();
  /** Names and colours of labels, by value. */
  readonly labels = new Map<number, { name: string; colour: string }>();
  /** Edited in place: the original's segments' names and colours (its lookup table's, or its layer's colours). */
  readonly theirs = new Map<number, { name: string; colour: string }>();
  layer = "";
  source = "";
  /** The store's http(s) URL, which Neuroglancer's chunk sources name. */
  url = "";
  reference: Reference | undefined;
  /** Voxels of each label (counted a little after strokes stop). */
  counts = new Map<number, number>();
  /** Strokes since the last save. */
  unsaved = 0;
  /** Activity has been told that undo let go of the oldest strokes. */
  undoLimitTold = false;
  /** What `Editor.applyHidden` last showed the layer (undefined: the layer shows its own list). */
  hiddenApplied: string | undefined;
  /**
   * Its segments are coloured from the palette, each colour written in the
   * layer's state; a volume opened with more than PALETTE_SEGMENTS segments
   * (a copied segmentation) keeps Neuroglancer's own colours instead, which
   * need no state.  Undefined until the editor decides, when it opens.
   */
  palette: boolean | undefined;
  /** The scene its layer was shown in when it was opened: a layer gone from that scene, while it is shown, was removed. */
  scene: string | undefined;
  private readonly unserve: () => void;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRefresh = 0;
  private readonly blocks = new Map<string, Promise<Float32Array>>();
  /** Chunks changed since last kept in the browser. */
  private readonly dirty = new Set<number>();
  private keepTimer: ReturnType<typeof setTimeout> | undefined;
  private keeping: Promise<unknown> = Promise.resolve();
  /** When the oldest change not yet kept was made: drawing without a pause is kept every few seconds all the same. */
  private dirtySince: number | undefined;
  /**
   * Leaving the page, or hiding it (another tab, the window minimised, a
   * phone's app switched), keeps what is not kept yet: hidden comes first,
   * while there is still time for the browser's storage to be written.
   */
  private readonly onPageHide = () => this.keepNow();
  private readonly onHidden = () => {
    if (document.visibilityState === "hidden") this.keepNow();
  };
  private blockGeneration = 0;

  private constructor(
    private readonly ctx: PlatformContext,
    private readonly voxels: Voxels,
    readonly volume: LabelVolume,
    readonly fileName: string,
  ) {
    this.unserve = serveInPage(fileName, volume);
    // Edited in place: edits let go from memory are read back from the browser's copy.
    if (volume instanceof CowVolume) volume.spill = { read: (key) => readKept(this.id, key, volume.type) };
  }

  /** Makes the session and shows its layer (named `name`) in the scene. */
  static async open(ctx: PlatformContext, voxels: Voxels, volume: LabelVolume, name: string, options: { id?: string; replace?: string } = {}): Promise<Session> {
    const fileName = `${options.id ?? `labels-${Date.now().toString(36)}-${++sessions}`}${LABEL_STORE_EXTENSION}`;
    const session = new Session(ctx, voxels, volume, fileName);
    try {
      // A file made in the page: its layer is a dataset by its name, not by
      // this visit's URL, so pointing it at a new one after a reload keeps it.
      const [found] = await ctx.workspace.local.open(new File([], fileName), { derived: true });
      if (found === undefined) throw new Error("local data did not take the label volume");
      session.source = found.source;
      session.url = found.source.replace(/^zarr3:\/\//, "");
      // The volume alone: its bounds' outline (a yellow box round the whole grid) is no help when drawing.
      const source = { url: found.source, subsources: { default: true, bounds: false }, enableDefaultSubsources: false };
      if (options.replace !== undefined) {
        const replace = options.replace;
        ctx.viewer.patchState(
          (ng) => {
            const layer = ((ng.layers as Record<string, unknown>[] | undefined) ?? []).find((l) => l.name === replace);
            if (layer) layer.source = source;
          },
          { quiet: true },
        );
        session.layer = replace;
        return session;
      }
      const before = new Set(ctx.viewer.layers().map((l) => l.name));
      // Its dataset is known by its name: a name no dataset or layer has yet.
      const taken = new Set([...ctx.workspace.datasets().map((d) => d.name), ...before]);
      let unique = name;
      for (let i = 2; taken.has(unique); ++i) unique = `${name} ${i}`;
      ctx.workspace.addDataset({ source, name: unique, kind: "segmentation" });
      session.layer = ctx.viewer.layers().find((l) => !before.has(l.name) && l.sources.some((s) => s.includes(fileName)))?.name ?? unique;
    } catch (e) {
      session.unserve();
      throw e;
    }
    return session;
  }

  get name(): string {
    return this.layer;
  }

  /** Its store's name without the extension: the folder it is kept in. */
  get id(): string {
    return this.fileName.slice(0, -LABEL_STORE_EXTENSION.length);
  }

  /**
   * Keeps changed chunks in the browser a moment after strokes stop (and,
   * with none, its labels' names and colours).
   */
  changed(keys: Iterable<number>): void {
    for (const k of keys) this.dirty.add(k);
    clearTimeout(this.keepTimer);
    if (this.dirtySince === undefined) {
      this.dirtySince = Date.now();
      window.addEventListener("pagehide", this.onPageHide);
      document.addEventListener("visibilitychange", this.onHidden);
    }
    // 1.5 s after the last change, or at once when changes have waited 5 s.
    this.keepTimer = setTimeout(() => this.keepNow(), Date.now() - this.dirtySince > 5000 ? 0 : 1500);
  }

  /** Writes the changed chunks (and the labels) to the browser's storage now. */
  keepNow(): void {
    clearTimeout(this.keepTimer);
    this.keepTimer = undefined;
    this.dirtySince = undefined;
    this.unlisten();
    const keys = [...this.dirty];
    this.dirty.clear();
    const versions = keys.map((k) => this.volume.versionOf(k));
    const original = this.volume instanceof CowVolume ? this.volume.original : undefined;
    this.keeping = this.keeping.then(async () => {
      if (await keep(this.volume, { id: this.id, name: this.layer, labels: [...this.labels], reference: this.reference?.layer, original, palette: this.palette }, keys, versions)) {
        this.volume.keptAt(keys, versions);
        this.keepFailed = false;
        // The first copy kept: ask that the browser not clear it when short of space.
        if ((await persist()) === false && !refusalTold) {
          refusalTold = true;
          const text = "This browser may clear the label volumes it keeps when it is short of space: save them to keep them.";
          this.ctx.ui.toast(text);
          this.ctx.log.info(text);
        }
        return;
      }
      // Not kept (storage full, say): kept again with the next change, so a reload does not bring back less.
      for (const k of keys) this.dirty.add(k);
      if (!this.keepFailed) this.ctx.log.error(`${this.layer}: its changes could not be kept in this browser's storage (full?); save the segmentation to keep them.`);
      this.keepFailed = true;
    });
  }

  /**
   * Keeps everything not kept yet, and waits for it: true when the browser
   * holds the whole volume as it is now (so it can be closed, and opened
   * again from there).
   */
  async keepAll(): Promise<boolean> {
    this.keepNow();
    await this.keeping;
    return !this.keepFailed && this.dirty.size === 0;
  }

  /** The last keep failed (said once until one succeeds). */
  private keepFailed = false;

  private unlisten(): void {
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onHidden);
  }

  /** Where the label volume's voxels are in the global space (once its layer has loaded). */
  placement(): Placement | undefined {
    return placement(this.ctx.viewer.layerTransform(this.layer), this.volume.voxelToRas, space(this.ctx));
  }

  /** The reference level's voxels from the label volume's, when both are placed. */
  referenceAffine(): Float64Array | undefined {
    const r = this.reference;
    const own = this.placement();
    if (r === undefined || own === undefined) return undefined;
    const theirs = placement(this.ctx.viewer.layerTransform(r.layer), r.levels[r.level].voxelToRas, space(this.ctx));
    return theirs && between(own, theirs);
  }

  /** Sets the reference image; its level is the one nearest the label volume's voxel size. */
  setReference(reference: Reference | undefined): void {
    this.reference = reference;
    this.blocks.clear();
    ++this.blockGeneration;
  }

  // ---------------------------------------------------- the image's values

  /**
   * The reference image's values over a box of label voxels, read in blocks
   * of a chunk (kept, a few hundred at most); undefined without a reference.
   */
  async imageBlock(lo: Vec3, hi: Vec3, signal?: AbortSignal): Promise<ImageBlock | undefined> {
    const r = this.reference;
    const affine = this.referenceAffine();
    if (r === undefined || affine === undefined) return undefined;
    const clampedLo = lo.map((v) => Math.max(0, v)) as Vec3;
    const clampedHi = hi.map((v, k) => Math.min(this.volume.size[k], v)) as Vec3;
    const size = clampedHi.map((v, k) => Math.max(0, v - clampedLo[k])) as Vec3;
    const out = new Float32Array(size[0] * size[1] * size[2]).fill(NaN);
    const first = clampedLo.map((v) => Math.floor(v / CHUNK));
    const last = clampedHi.map((v) => Math.ceil(v / CHUNK) - 1);
    const jobs: Promise<void>[] = [];
    for (let cz = first[2]; cz <= last[2]; ++cz) {
      for (let cy = first[1]; cy <= last[1]; ++cy) {
        for (let cx = first[0]; cx <= last[0]; ++cx) {
          jobs.push(
            this.chunkBlock(cx, cy, cz, affine, signal).then((data) => {
              const origin = [cx * CHUNK, cy * CHUNK, cz * CHUNK];
              const from = [0, 1, 2].map((k) => Math.max(origin[k], clampedLo[k]));
              const to = [0, 1, 2].map((k) => Math.min(origin[k] + CHUNK, clampedHi[k]));
              for (let z = from[2]; z < to[2]; ++z) {
                for (let y = from[1]; y < to[1]; ++y) {
                  const src = from[0] - origin[0] + CHUNK * (y - origin[1] + CHUNK * (z - origin[2]));
                  const dst = from[0] - clampedLo[0] + size[0] * (y - clampedLo[1] + size[1] * (z - clampedLo[2]));
                  out.set(data.subarray(src, src + to[0] - from[0]), dst);
                }
              }
            }),
          );
        }
      }
    }
    await Promise.all(jobs);
    return { lo: clampedLo, size, data: out };
  }

  /** One chunk's worth of the image's values (a 64³ block on the label grid). */
  private chunkBlock(cx: number, cy: number, cz: number, affine: Float64Array, signal?: AbortSignal): Promise<Float32Array> {
    const r = this.reference!;
    const key = `${cx}/${cy}/${cz}`;
    let p = this.blocks.get(key);
    if (p === undefined) {
      p = this.voxels.block(r.store, r.level, [cx * CHUNK, cy * CHUNK, cz * CHUNK], [CHUNK, CHUNK, CHUNK], affine, signal);
      this.blocks.set(key, p);
      const generation = this.blockGeneration;
      p.catch(() => {
        if (generation === this.blockGeneration) this.blocks.delete(key);
      });
      // About 256 MB of blocks at most: the oldest go.
      while (this.blocks.size > 256) this.blocks.delete(this.blocks.keys().next().value!);
    }
    return p;
  }

  /** The image's values in one section (or any box), read as one block rather than chunk by chunk: for a fill. */
  async imageBox(lo: Vec3, hi: Vec3, signal?: AbortSignal): Promise<ImageBlock | undefined> {
    const r = this.reference;
    const affine = this.referenceAffine();
    if (r === undefined || affine === undefined) return undefined;
    const a = lo.map((v) => Math.max(0, v)) as Vec3;
    const b = hi.map((v, k) => Math.min(this.volume.size[k], v)) as Vec3;
    const size = b.map((v, k) => Math.max(0, v - a[k])) as Vec3;
    const data = await this.voxels.block(r.store, r.level, a, size, affine, signal);
    return { lo: a, size, data };
  }

  // ---------------------------------------------------- showing changes

  /** Has the layer read its data again: now, or (while drawing) at most a few times a second. */
  refresh(soon = false): void {
    const wait = soon ? Math.max(0, 120 - (performance.now() - this.lastRefresh)) : 0;
    if (this.refreshTimer !== undefined) {
      if (soon) return;
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.lastRefresh = performance.now();
      this.ctx.viewer.reloadData(this.url);
    }, wait);
  }

  /** The label's colour, picked from the palette the first time (edited in place, the original's if it has one). */
  colour(value: number): string {
    return this.colours()(value);
  }

  /**
   * Each label's colour, as `colour`, with the layer's state read once: a
   * list of 100k segments otherwise reads it 100k times (a third of a
   * second).
   */
  colours(): (value: number) => string {
    type Spec = { colorSeed?: number; segmentDefaultColor?: string } | undefined;
    let spec: Spec | null = null;
    return (value) => {
      const own = this.labels.get(value)?.colour ?? this.theirs.get(value)?.colour;
      if (own !== undefined) return own;
      if (!(this.volume instanceof CowVolume) && this.palette !== false) return colourOf(value);
      // Edited in place, or opened with many segments, they keep Neuroglancer's colours: the layer's default, or its hash.
      if (spec === null) {
        spec = this.ctx.viewer.layerSpec(this.layer) as Spec;
        const seed = spec?.colorSeed ?? 0;
        if (this.hashed.seed !== seed) this.hashed = { seed, colours: new Map() };
      }
      if (spec?.segmentDefaultColor !== undefined) return spec.segmentDefaultColor;
      let c = this.hashed.colours.get(value);
      if (c === undefined) this.hashed.colours.set(value, (c = hashColour(value, this.hashed.seed)));
      return c;
    };
  }

  /** Neuroglancer's hash colours worked out so far, for the layer's colour seed (the list asks for every one each time it is drawn). */
  private hashed: { seed: number; colours: Map<number, string> } = { seed: 0, colours: new Map() };

  /**
   * Gives the layer the labels' colours (Neuroglancer otherwise picks its
   * own).  Edited in place, a segment of the original's that has no colour
   * of its own keeps the one Neuroglancer gives it, as in the original.
   */
  applyColours(values: number[]): void {
    const wanted: Record<string, string> = {};
    // Colours Neuroglancer gives by itself (its hash) are not written: with many segments they would fill the state.
    const own = !(this.volume instanceof CowVolume) && this.palette !== false;
    for (const v of values) if (v > 0 && (own || this.labels.has(v) || this.theirs.has(v))) wanted[String(v)] = this.colour(v);
    if (Object.keys(wanted).length === 0) return;
    this.ctx.viewer.patchState(
      (ng) => {
        const layer = ((ng.layers as Record<string, unknown>[] | undefined) ?? []).find((l) => l.name === this.layer);
        if (layer === undefined) return;
        const current = (layer.segmentColors as Record<string, string> | undefined) ?? {};
        if (Object.entries(wanted).every(([k, c]) => current[k] === c)) return;
        layer.segmentColors = { ...current, ...wanted };
      },
      { quiet: true },
    );
  }

  /** Ends the session; `forget` also drops what the browser keeps of it (it was closed, not the page). */
  dispose(forget = false): void {
    clearTimeout(this.refreshTimer);
    // Changes not kept yet are kept, unless the session is being forgotten.
    if (!forget && this.keepTimer !== undefined) this.keepNow();
    clearTimeout(this.keepTimer);
    this.unlisten();
    this.unserve();
    this.ctx.workspace.local.close(this.source);
    if (forget) void this.keeping.then(() => discard(this.id));
  }
}
