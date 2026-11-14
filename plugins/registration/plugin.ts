/**
 * Registration: moving a layer by hand as Freeview's Transform Volume tool
 * does (./manual.ts); landmark pairs (a fixed point in the global space, a
 * moving point in the moving layer's own) fitted to a transform (./fit.ts),
 * applied as the moving layer's source transform; transform files
 * (./formats.ts); and the moved image saved as NIfTI or OME-Zarr
 * (./volume_io.ts, in ./save_worker.ts).
 *
 * Everything is in millimetres: the layer's transform (Neuroglancer keeps
 * it in multiples of each side's scales) is turned into a physical one
 * (moving mm to global mm) and back.  Landmarks show in two annotation
 * layers, the moving ones where the moving layer now puts them, with a line
 * to their fixed partner.
 */
import type { Json, LayerTransform, PlatformContext, PluginModule } from "@ngplatform/sdk";
import {
  type Action,
  button,
  card,
  checkbox,
  downloadBlob,
  el,
  emptyState,
  field,
  iconButton,
  info,
  type OnOff,
  region,
  roving,
  safeFileName,
  select,
  type Settable,
  type Slider,
  slider,
  type StatusLine,
  statusLine,
  toggle,
} from "@ngplatform/sdk/dom";
import { layerSourceUrl } from "@ngplatform/sdk/sources";
import { WorkerRpc } from "@ngplatform/sdk/worker_rpc";
import { storeOf } from "../volume-view/sources.js";
import { apply4, describe, fit, type Fit, identity4, invert4, type Mat4, MINIMUM, type Model, multiply4, type Vec3 } from "./fit.js";
import { needsGeometry, readTransformFile, type VolumeGeometry, writeItk, writeLta, writePlain } from "./formats.js";
import { axisOrder, identityManual, isIdentityManual, type Manual, manualMatrix, permute, readManual, translationStep, turned, unpermute } from "./manual.js";
import { REGISTRATION_PANEL } from "./manifest.js";
import type { SaveRequest } from "./save_worker.js";
import { DIRECTIONS, type Direction, straighten } from "./straighten.js";
import { ENLARGE, type Method, zipFiles } from "./volume_io.js";
import { withSharedChunks } from "../volume-view/chunk_host.js";

interface Pair {
  id: string;
  /** Global space, mm, in the moving layer's output dimensions' order. */
  fixed?: Vec3;
  /** The moving layer's own space, mm. */
  moving?: Vec3;
  on: boolean;
}

export interface Saved {
  layer?: string;
  model: Model;
  live: boolean;
  pairs: Pair[];
  /** The layer's transform (Neuroglancer's form) before registering, for Restore. */
  base?: number[];
  /** Moved by hand (Freeview's Transform Volume), from `start`. */
  manual: Manual;
  /** The transform (Neuroglancer's form) the hand-made one is applied to. */
  start?: number[];
  /** Freeview's "Apply to all visible volumes": the other visible 3-D layers follow the moving one. */
  all?: boolean;
  /** Straightening landmarks #1 to #4 (mm along the layer's output dimensions), and where the two lines go. */
  marks?: (number[] | null)[];
  lines?: [Direction, Direction];
}

export function readSaved(raw: unknown): Saved {
  const s = (raw ?? {}) as Partial<Saved>;
  return {
    layer: typeof s.layer === "string" ? s.layer : undefined,
    model: (["translation", "rigid", "similarity", "affine"] as Model[]).includes(s.model as Model) ? (s.model as Model) : "rigid",
    live: s.live !== false,
    pairs: Array.isArray(s.pairs) ? s.pairs : [],
    base: Array.isArray(s.base) ? s.base : undefined,
    manual: readManual(s.manual),
    start: Array.isArray(s.start) ? s.start : undefined,
    all: s.all === true,
    marks: Array.isArray(s.marks) ? s.marks : undefined,
    lines: Array.isArray(s.lines) && s.lines.length === 2 && s.lines.every((d) => DIRECTIONS.includes(d)) ? s.lines : undefined,
  };
}

/**
 * The moving layer until one is chosen: with two images or more, the one
 * added last (a scan opened onto a template opened first).
 */
export function defaultMoving(candidates: string[], images: string[]): string | undefined {
  const movable = images.filter((n) => candidates.includes(n));
  return movable.length >= 2 ? movable[movable.length - 1] : undefined;
}

const FIXED_LAYER = "landmarks (fixed)";
const MOVING_LAYER = "landmarks (moving)";

const mm = (scale: number, unit: string) => (unit === "m" ? scale * 1000 : scale);

/**
 * A transform's matrix as moving mm to global mm (row-major 4 × 4);
 * undefined unless it is 3-D.  Neuroglancer keeps the linear part as a
 * ratio of physical lengths and the translation in multiples of the output
 * scales (its coordinate_transform.ts rescales only the translation when an
 * output scale changes).
 */
export function physical(t: LayerTransform, matrix: ArrayLike<number> = t.matrix): Mat4 | undefined {
  if (t.rank !== 3) return undefined;
  const sout = [0, 1, 2].map((r) => mm(t.output.scales[r], t.output.units[r]));
  const p = identity4();
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) p[4 * r + c] = matrix[4 * c + r];
    p[4 * r + 3] = sout[r] * matrix[12 + r];
  }
  return p;
}

/** A physical matrix back in Neuroglancer's form (column-major). */
export function neuroglancer(t: LayerTransform, p: Mat4): Float64Array {
  const sout = [0, 1, 2].map((r) => mm(t.output.scales[r], t.output.units[r]));
  const m = new Float64Array(16);
  m[15] = 1;
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) m[4 * c + r] = p[4 * r + c];
    m[12 + r] = p[4 * r + 3] / sout[r];
  }
  return m;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

/**
 * Why the layers that cannot be moved are not offered: those that are not
 * 3-D (a 2-D section, channels, time), as "“movie” is 4-D".  Annotation
 * layers and layers not yet loaded are left out.
 */
export function notOffered(layers: { name: string; type: string; rank?: number }[]): string {
  const skipped = layers.filter((l) => (l.type === "image" || l.type === "segmentation") && l.rank !== undefined && l.rank !== 3);
  return skipped.map((l) => `“${l.name}” is ${l.rank}-D`).join(", ");
}

type Tab = "rotate" | "translate" | "scale" | "flip";
type ImageFormat = SaveRequest["format"];

/** The panel's places for progress and errors. */
type Part = "straighten" | "warp" | "file" | "image";

/** At most this much memory a save in memory uses (it takes the image's finest level that fits). */
const MAX_BYTES = 512 * 2 ** 20;

/** What Registration asks of its worker (a fake one in the tests). */
export interface SaveWorker {
  request<T>(message: object, progress?: (what: string, done: number, total: number) => void, signal?: AbortSignal): Promise<T>;
  dispose(): void;
}

/** Registration's worker: geometry and saving, as promises with progress and cancel. */
class SaveClient implements SaveWorker {
  private readonly rpc = new WorkerRpc(() => withSharedChunks(new Worker(new URL("./save_worker.ts", import.meta.url), { type: "module", name: "registration" })), {
    stopped: (why) => `the saving worker stopped: ${why}`,
    restart: true,
  });

  request<T>(message: object, progress?: (what: string, done: number, total: number) => void, signal?: AbortSignal): Promise<T> {
    return this.rpc.request<T>(message, { signal, progress: progress && ((msg) => progress(msg.what, msg.done, msg.total)) });
  }

  dispose(): void {
    this.rpc.dispose();
  }
}

/** A file name from a layer's name. */
const fileName = (name: string) => safeFileName(name, "image");

type FilePicker = {
  showSaveFilePicker?(o?: unknown): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle>;
};

export class Registration {
  private saved: Saved;
  private result: Fit | { error: string } | undefined;
  private panelUpdate: (() => void) | undefined;
  private tab: Tab = "rotate";
  /** The image save's choices (the formats are kept in this browser; the rest this session only). */
  private imageFormat: ImageFormat = "nii.gz";
  private headerOnly = false;
  private method: Method = "linear";
  private grid = "";
  private transformFormat: "lta" | "itk" | "plain" = "lta";
  private saving: AbortController | undefined;
  /** The shown panel's status lines (progress and errors), by part. */
  private lines: Record<Part, StatusLine> | undefined;
  private client: SaveWorker | undefined;
  /** The landmarks' points (global, as written into their annotation layers) by annotation id, to tell a dragged one. */
  private written = new Map<string, number[]>();

  constructor(
    private readonly ctx: PlatformContext,
    private readonly makeWorker: () => SaveWorker = () => new SaveClient(),
  ) {
    this.saved = readSaved(ctx.state.get());
    // The file formats chosen last, in this browser.
    const formats = ctx.settings.get<{ transform?: string; image?: string }>("formats") ?? {};
    if (formats.transform === "lta" || formats.transform === "itk" || formats.transform === "plain") this.transformFormat = formats.transform;
    if (["nii.gz", "nii", "mgz", "mgh", "zarr"].includes(formats.image ?? "")) this.imageFormat = formats.image as ImageFormat;
    // The state's notice comes for any plugin's change: only a change of this plugin's state is read again
    // (else a drag's move, kept in memory until it ends, would be read over and applied twice).
    let seen = JSON.stringify(ctx.state.get() ?? null);
    let readBack: ReturnType<typeof setTimeout> | undefined;
    ctx.subscriptions.push(
      ctx.state.onChanged(() => {
        const now = JSON.stringify(ctx.state.get() ?? null);
        if (now === seen) return;
        seen = now;
        this.saved = readSaved(ctx.state.get());
        this.refit(false);
        this.panelUpdate?.();
      }),
      ctx.viewer.onLayersChanged(() => this.panelUpdate?.()),
      // A landmark dragged in its annotation layer is read back into its pair, once the drag rests.
      ctx.viewer.onStateChanged(() => {
        clearTimeout(readBack);
        readBack = setTimeout(() => this.readBack(), 250);
      }),
      () => {
        clearTimeout(readBack);
        this.saving?.abort();
        this.client?.dispose();
      },
    );
    this.refit(false);
  }

  /** Reports progress in a part of the panel (when shown). */
  private progress(part: Part, text: string): void {
    this.lines?.[part].progress(text);
  }

  /** Reports a failure in a part of the panel; as a toast when the panel is not shown. */
  private problem(part: Part, text: string, action?: Action): void {
    if (this.lines) this.lines[part].error(text, action);
    else this.ctx.ui.toast(text, "error");
  }

  private settle(part: Part): void {
    this.lines?.[part].clear();
  }

  private save(patch: Partial<Saved>): void {
    // The first change made with the default moving layer keeps it chosen, so a layer added later does not take its place.
    if (this.saved.layer === undefined && !("layer" in patch)) patch = { ...patch, layer: this.layer() };
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
  }

  private keepFormats(): void {
    this.ctx.settings.set("formats", { transform: this.transformFormat, image: this.imageFormat });
  }

  /** Layers that can be moved: 3-D ones, not the landmarks themselves. */
  candidates(): string[] {
    return this.ctx.viewer
      .layers()
      .map((l) => l.name)
      .filter((name) => name !== FIXED_LAYER && name !== MOVING_LAYER && this.ctx.viewer.layerTransform(name)?.rank === 3);
  }

  private layer(): string | undefined {
    const candidates = this.candidates();
    if (this.saved.layer === undefined) {
      const images = this.ctx.viewer.layers().filter((l) => l.type === "image").map((l) => l.name);
      return defaultMoving(candidates, images);
    }
    return candidates.find((n) => n === this.saved.layer) ?? undefined;
  }

  /** The mouse's (or else the views' centre's) position, in mm along the moving layer's output dimensions. */
  private here(t: LayerTransform, mouse = true): Vec3 | undefined {
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[] };
    const cursor = this.ctx.viewer.cursor();
    const position = mouse && cursor.active ? cursor.position : ng.position;
    const dims = Object.entries(ng.dimensions ?? {});
    if (position === undefined) return undefined;
    const out = t.output.names.map((name) => {
      const i = dims.findIndex(([n]) => n === name);
      return i === -1 ? NaN : position[i] * mm(dims[i][1][0], dims[i][1][1]);
    });
    return out.some((v) => !Number.isFinite(v)) ? undefined : (out as Vec3);
  }

  /** Global position of a point in mm along the output dimensions. */
  private toGlobal(t: LayerTransform, p: Vec3): number[] | undefined {
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; position?: number[] };
    const dims = Object.entries(ng.dimensions ?? {});
    const out = dims.map((_, i) => ng.position?.[i] ?? 0);
    for (let r = 0; r < 3; ++r) {
      const i = dims.findIndex(([n]) => n === t.output.names[r]);
      if (i === -1) return undefined;
      out[i] = p[r] / mm(dims[i][1][0], dims[i][1][1]);
    }
    return out;
  }

  mark(role: "fixed" | "moving"): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    if (!name || !t) {
      this.ctx.ui.toast("Choose the moving layer in the Registration panel first.", "error");
      this.ctx.ui.showPanel(REGISTRATION_PANEL);
      return;
    }
    const p = physical(t);
    const at = this.here(t);
    if (p === undefined || at === undefined) {
      this.ctx.ui.toast("This layer's space is not one Registration can work in (it needs x, y and z).", "error");
      return;
    }
    // A moving point is kept in the moving layer's own space.
    const point = role === "fixed" ? at : apply4(invert4(p), at);
    // A new pair object: the one in the state may be an undo step's too.
    const pairs = [...this.saved.pairs];
    const open = pairs.findIndex((q) => q[role] === undefined);
    if (open !== -1) pairs[open] = { ...pairs[open], [role]: point };
    else pairs.push({ id: crypto.randomUUID().slice(0, 8), [role]: point, on: true });
    this.save({ pairs, base: this.saved.base ?? Array.from(t.matrix) });
    this.refit(true);
  }

  /**
   * The other visible 3-D layers, which follow the moving one with "Apply
   * to all visible volumes" (images and segmentations, not the landmarks).
   */
  private followers(): string[] {
    const moving = this.layer();
    const shown = new Set(this.ctx.viewer.layers().filter((l) => l.visible && (l.type === "image" || l.type === "segmentation")).map((l) => l.name));
    // Volumes only: geometry (tractograms, their track groups, meshes) stays where it is.
    const geometry = (name: string) => JSON.stringify(this.ctx.viewer.layerSpec(name)?.source ?? "").includes("zarr-vectors");
    return this.candidates().filter((name) => name !== moving && shown.has(name) && !geometry(name));
  }

  /**
   * Freeview's "Apply to all visible volumes": each other visible layer is
   * moved as the moving layer is, relative to where its own file puts it
   * (or put back there, when the box is cleared).
   */
  private syncFollowers(all = this.saved.all === true): void {
    const r = this.relative();
    for (const name of this.followers()) {
      const t = this.ctx.viewer.layerTransform(name);
      const d = t && physical(t, t.defaultMatrix);
      if (!t || !d || t.rank !== 3) continue;
      const move = all && r !== undefined ? permute(r.move, axisOrder(t.output.names)) : identity4();
      this.ctx.viewer.setLayerTransform(name, neuroglancer(t, multiply4(move, d)));
    }
  }

  /** A placement made another way (a fit, a file) replaces the hand-made one, which starts again from it. */
  private placed(name: string, matrix: Float64Array): void {
    this.ctx.viewer.setLayerTransform(name, matrix);
    if (this.saved.all) this.syncFollowers();
    if (this.saved.start !== undefined || !isIdentityManual(this.saved.manual)) this.save({ manual: identityManual(this.saved.manual.around), start: undefined });
  }

  /** Fits the pairs; with Live (or `apply`), moves the layer. */
  private refit(apply: boolean): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const pairs = this.saved.pairs.filter((q) => q.on && q.fixed && q.moving);
    if (!name || !t) {
      this.result = undefined;
    } else if (pairs.length < MINIMUM[this.saved.model]) {
      this.result = { error: `${this.saved.model} needs ${MINIMUM[this.saved.model]} complete pair${MINIMUM[this.saved.model] === 1 ? "" : "s"}; there ${pairs.length === 1 ? "is" : "are"} ${pairs.length}.` };
    } else {
      try {
        this.result = fit(this.saved.model, pairs.map((q) => q.moving!), pairs.map((q) => q.fixed!));
        if (apply && this.saved.live) this.placed(name, neuroglancer(t, this.result.matrix));
      } catch (e) {
        this.result = { error: (e as Error).message };
      }
    }
    this.showLandmarks();
    this.panelUpdate?.();
  }

  apply(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    if (!name || !t || this.result === undefined || "error" in this.result) return;
    if (this.saved.base === undefined) this.save({ base: Array.from(t.matrix) });
    this.placed(name, neuroglancer(t, this.result.matrix));
    this.showLandmarks();
  }

  /** Freeview's Restore to Original: the transform the layer had before registering. */
  restore(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    if (name && t) this.ctx.viewer.setLayerTransform(name, Float64Array.from(this.saved.base ?? this.saved.start ?? t.matrix));
    this.save({ base: undefined, start: undefined, manual: identityManual(this.saved.manual.around) });
    if (this.saved.all) this.syncFollowers();
    this.showLandmarks();
  }

  // ------------------------------------------------ moving by hand

  /** The layer's bounds' centre (mm along its output dimensions) where `matrix` puts it; else the views' centre. */
  private volumeCentre(t: LayerTransform, matrix: ArrayLike<number>): Vec3 | undefined {
    const b = t.input.bounds;
    const p = physical(t, matrix);
    if (b === undefined || p === undefined) return this.here(t, false);
    const inner = [0, 1, 2].map((k) => ((b.lower[k] + b.upper[k]) / 2) * mm(t.input.scales[k], t.input.units[k]));
    return apply4(p, inner);
  }

  /** The layer's size (mm) along each output dimension where `matrix` puts it; undefined without bounds. */
  private extent(t: LayerTransform, matrix: ArrayLike<number>): Vec3 | undefined {
    const b = t.input.bounds;
    const p = physical(t, matrix);
    if (b === undefined || p === undefined) return undefined;
    const edge = [0, 1, 2].map((k) => (b.upper[k] - b.lower[k]) * mm(t.input.scales[k], t.input.units[k]));
    return [0, 1, 2].map((r) => edge.reduce((s, e, k) => s + Math.abs(p[4 * r + k]) * e, 0)) as Vec3;
  }

  /**
   * Moves the layer by `manual` from its starting transform.  `persist`
   * false (a slider being dragged) moves it only; true saves it too.
   */
  private applyManual(manual: Manual, persist: boolean): Manual | undefined {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    if (!name || !t || t.rank !== 3) return undefined;
    const start = this.saved.start ?? Array.from(t.matrix);
    const p = physical(t, start)!;
    const order = axisOrder(t.output.names);
    const toXyz = (v: Vec3): Vec3 => [v[order[0]], v[order[1]], v[order[2]]];
    const centre = toXyz(this.volumeCentre(t, start) ?? [0, 0, 0]);
    let m = manual;
    if (!turned(m)) m = { ...m, pivot: undefined };
    else if (m.pivot === undefined) m = { ...m, pivot: m.around === "cursor" ? toXyz(this.here(t, false) ?? centre) : centre };
    this.ctx.viewer.setLayerTransform(name, neuroglancer(t, multiply4(permute(manualMatrix(m, centre), order), p)));
    // Kept now, so every step of a drag starts from the same transform.
    this.saved = { ...this.saved, manual: m, start, base: this.saved.base ?? start };
    if (this.saved.all) this.syncFollowers();
    if (persist) {
      this.save({});
      this.showLandmarks();
    }
    return m;
  }

  /** Marks straightening landmark `i` (0 to 3) at the views' centre. */
  private markHere(i: number): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const here = t && this.here(t, false);
    if (!here) return;
    const marks = [...(this.saved.marks ?? [null, null, null, null])];
    marks[i] = [...here];
    this.save({ marks });
    this.panelUpdate?.();
  }

  /**
   * Freeview's landmark straightening: the line #1 → #2 turned onto one
   * axis, #3 → #4 as nearly as it can onto another, about the volume's
   * centre (./straighten.ts).
   */
  private straightenNow(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const marks = this.saved.marks;
    if (!name || !t || t.rank !== 3 || !marks || marks.length < 4 || marks.some((m) => !m)) return;
    const order = axisOrder(t.output.names);
    const toXyz = (v: ArrayLike<number>): Vec3 => [v[order[0]], v[order[1]], v[order[2]]];
    const [first, second] = this.saved.lines ?? ["P→A", "I→S"];
    try {
      const centre = toXyz(this.volumeCentre(t, t.matrix) ?? [0, 0, 0]);
      const r = straighten(marks.map((m) => toXyz(m!)) as [Vec3, Vec3, Vec3, Vec3], first, second, centre);
      if (this.saved.base === undefined) this.save({ base: Array.from(t.matrix) });
      this.placed(name, neuroglancer(t, multiply4(permute(r, order), physical(t)!)));
      // The marks were on the image as it was; they no longer are.
      this.save({ marks: undefined });
      this.settle("straighten");
    } catch (e) {
      this.problem("straighten", `Could not straighten: ${(e as Error).message}.`);
    }
    this.panelUpdate?.();
  }

  /**
   * A new layer of the moving image warped by the pairs (a thin-plate
   * spline through them: each fixed point lands on its moving partner,
   * smoothly between), computed as it is viewed by chunkmirage's engine;
   * the moving layer is left as it is.
   */
  private async warp(): Promise<void> {
    const name = this.layer();
    const t = name ? this.ctx.viewer.layerTransform(name) : undefined;
    const source = name ? layerSourceUrl(this.ctx.viewer.layerSpec(name)) : undefined;
    const pairs = this.saved.pairs.filter((q) => q.on && q.fixed && q.moving);
    if (!name || !t) return;
    if (source === undefined) return this.problem("warp", `${name} has no source address that can be read again, so it cannot be warped.`);
    if (pairs.length < 4) return this.problem("warp", `A warp needs four complete pairs or more, not all in one plane; there ${pairs.length === 1 ? "is" : "are"} ${pairs.length}.`);
    // Pairs in x, y, z order: fixed in the layer's output dimensions', moving in its own.
    const order = (names: string[]) => ["x", "y", "z"].map((a) => names.indexOf(a));
    const pick = (v: Vec3, o: number[]) => (o.every((i) => i >= 0) ? o.map((i) => v[i]) : [...v]);
    const fo = order(t.output.names);
    const mo = order(t.input.names);
    this.progress("warp", "Adding the warped layer…");
    try {
      const url = await this.ctx.workspace.computed.url({
        source,
        chunk: [64, 64, 64],
        warp: { kind: "tps", fixed: pairs.map((q) => pick(q.fixed!, fo)), moving: pairs.map((q) => pick(q.moving!, mo)) },
      });
      const warped = `${name} (warped, ${pairs.length} pairs)`;
      this.ctx.workspace.addDataset({ source: url, name: warped, kind: "image" });
      const shader = (this.ctx.viewer.layerSpec(name) as { shader?: unknown } | undefined)?.shader;
      if (typeof shader === "string") {
        this.ctx.viewer.patchState(
          (ng) => {
            const l = ((ng.layers as Json[] | undefined) ?? []).find((x) => x.name === warped);
            if (l !== undefined) l.shader = shader;
          },
          { quiet: true },
        );
      }
      this.settle("warp");
    } catch (e) {
      this.problem("warp", `Could not warp: ${(e as Error).message}`);
    }
  }

  /** Freeview's Move Center to Current Cursor Location: the translation that puts the volume's centre at the views' centre. */
  private centreToCursor(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    if (!name || !t) return;
    const start = this.saved.start ?? Array.from(t.matrix);
    const order = axisOrder(t.output.names);
    const toXyz = (v: Vec3): Vec3 => [v[order[0]], v[order[1]], v[order[2]]];
    const centre = toXyz(this.volumeCentre(t, start) ?? [0, 0, 0]);
    const cursor = this.here(t, false);
    if (cursor === undefined) return;
    const m = this.saved.manual;
    const unmoved = apply4(manualMatrix({ ...m, translate: [0, 0, 0], pivot: m.pivot ?? (turned(m) ? centre : undefined) }, centre), centre);
    const target = toXyz(cursor);
    this.applyManual({ ...m, translate: [0, 1, 2].map((k) => target[k] - unmoved[k]) as Vec3 }, true);
  }

  // ------------------------------------------------ files

  /** The moving layer's placement relative to its own (as its file gives it), RAS mm along x, y, z. */
  private relative(): { name: string; t: LayerTransform; move: Mat4 } | undefined {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const p = t && physical(t);
    const d = t && physical(t, t.defaultMatrix);
    if (!name || !t || !p || !d) return undefined;
    return { name, t, move: unpermute(multiply4(p, invert4(d)), axisOrder(t.output.names)) };
  }

  private worker(): SaveWorker {
    return (this.client ??= this.makeWorker());
  }

  /** The store an image layer reads (OME-Zarr, NIfTI as virtual Zarr, precomputed), for the worker. */
  private storeOf(layer: string): string | undefined {
    return storeOf(layerSourceUrl(this.ctx.viewer.layerSpec(layer)));
  }

  /** Images in the scene whose grid an image can be resampled onto, and whose geometry an LTA can record. */
  private grids(except: string | undefined): string[] {
    return this.ctx.viewer
      .layers()
      .filter((l) => l.name !== except && l.type === "image" && this.storeOf(l.name) !== undefined)
      .map((l) => l.name);
  }

  private async geometry(layer: string | undefined): Promise<VolumeGeometry | undefined> {
    const store = layer && this.storeOf(layer);
    if (!store) return undefined;
    try {
      const g = await this.worker().request<{ size: [number, number, number]; voxelToRas: number[] }>({ type: "geometry", store });
      return { size: g.size, voxelToRas: Float64Array.from(g.voxelToRas), filename: layer };
    } catch {
      return undefined;
    }
  }

  /** Freeview's Save Reg: the moving layer's placement (relative to its file's) as a transform file. */
  private async exportFile(format: "plain" | "itk" | "lta"): Promise<void> {
    const r = this.relative();
    if (!r) return;
    let text: string;
    if (format === "lta") {
      // With the volumes' geometry (moving; fixed: the grid chosen, else the moving one's), as FreeSurfer's tools want.
      const src = await this.geometry(r.name);
      const dst = this.grid && this.grid !== ENLARGE ? await this.geometry(this.grid) : src;
      if (!src || !dst) {
        const which = !src ? r.name : this.grid;
        const go = await this.ctx.ui.confirm(
          `The voxel grid of “${which}” could not be read, so the LTA would be saved without the volumes' geometry: FreeSurfer's tools then need --mov and --targ to use it. Save it anyway?`,
        );
        if (!go) return;
      }
      text = writeLta(r.move, { src, dst });
    } else {
      text = format === "itk" ? writeItk(r.move) : writePlain(r.move);
    }
    downloadBlob(new Blob([text], { type: "text/plain" }), `${fileName(r.name)}_reg.${format === "lta" ? "lta" : "txt"}`);
  }

  private async importFile(file: File): Promise<void> {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const d = t && physical(t, t.defaultMatrix);
    if (!name || !t || !d) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let geometry: { moving?: VolumeGeometry; fixed?: VolumeGeometry } | undefined;
      if (needsGeometry(file.name, bytes)) {
        // register.dat and FSL .mat are relative to both voxel grids: this layer's, and the fixed image chosen under "Onto the grid of".
        if (!this.grid || this.grid === ENLARGE) throw new Error("it is relative to both images; choose the fixed image under “Onto the grid of” first");
        geometry = { moving: await this.geometry(name), fixed: await this.geometry(this.grid) };
        if (!geometry.moving || !geometry.fixed) throw new Error("the images' voxel grids could not be read");
      }
      const r = permute(readTransformFile(file.name, bytes, geometry), axisOrder(t.output.names));
      if (this.saved.base === undefined) this.save({ base: Array.from(t.matrix) });
      this.placed(name, neuroglancer(t, multiply4(r, d)));
      this.ctx.log.info(`Placed ${name} with ${file.name}.`);
      this.showLandmarks();
      this.settle("file");
    } catch (e) {
      this.problem("file", `Could not read ${file.name}: ${(e as Error).message}`);
    }
  }

  /**
   * Freeview's Save Volume As: the moving image, moved, as NIfTI or
   * OME-Zarr on this computer; resampled (onto its own grid or the chosen
   * image's), or its voxels kept with the new placement in the header.
   */
  private async saveImage(): Promise<void> {
    const r = this.relative();
    if (!r) return;
    const store = this.storeOf(r.name);
    if (store === undefined) return this.problem("image", "This layer's data cannot be read for saving: OME-Zarr, NIfTI and precomputed images can be.");
    const format = this.imageFormat;
    const base = `${fileName(r.name)}_registered`;
    const suffix = format === "zarr" ? ".ome.zarr" : `.${format}`;
    const retry = { label: "Retry", run: () => void this.saveImage() };
    // Where to, asked first (a picker needs the click that asked for it).
    const picker = window as unknown as FilePicker;
    let file: FileSystemFileHandle | undefined;
    let folder: FileSystemDirectoryHandle | undefined;
    try {
      if (format === "zarr" && picker.showDirectoryPicker) folder = await picker.showDirectoryPicker({ id: "ngplatform-save", mode: "readwrite" });
      else if (format !== "zarr" && picker.showSaveFilePicker)
        file = await picker.showSaveFilePicker({ id: "ngplatform-save", suggestedName: base + suffix, types: [{ description: /^mg/.test(format) ? "FreeSurfer volume" : "NIfTI", accept: { "application/octet-stream": [suffix] } }] });
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") this.problem("image", `Could not choose where to save: ${(e as Error).message}`);
      return;
    }
    // A store of that name already there (an earlier save) is not removed if this one stops.
    const fresh = folder !== undefined && !(await folder.getDirectoryHandle(base + suffix).then(() => true, () => false));
    this.saving?.abort();
    const controller = (this.saving = new AbortController());
    this.panelUpdate?.();
    const label = this.ctx.viewer.layers().find((l) => l.name === r.name)?.type === "segmentation";
    const request: SaveRequest = {
      store,
      grid: this.headerOnly || !this.grid ? undefined : this.grid === ENLARGE ? ENLARGE : this.storeOf(this.grid),
      move: Array.from(r.move),
      header: this.headerOnly,
      method: this.method,
      format,
      name: r.name,
      label,
      maxBytes: MAX_BYTES,
      // A folder to write into: the full resolution is then saved in blocks if it is larger than fits.
      ...(folder ? { folder, folderName: base + suffix } : {}),
      // A file to write into: likewise, in slabs.
      ...(file ? { file } : {}),
    };
    try {
      this.progress("image", "Reading…");
      const saved = await this.worker().request<{ files: [string, Uint8Array][]; level: number; voxelSize: number; size: number[]; written?: boolean }>(
        { type: "save", ...request },
        (what, done, total) => this.progress("image", total > 1 ? `${what}: ${Math.round((100 * done) / total)}%` : `${what}…`),
        controller.signal,
      );
      let where: string;
      if (saved.written) {
        where = folder ? `${folder.name}/${base}${suffix}` : file!.name;
      } else if (format === "zarr") {
        const files = new Map(saved.files);
        if (folder) {
          const root = await folder.getDirectoryHandle(base + suffix, { create: true });
          let n = 0;
          for (const [path, bytes] of files) {
            controller.signal.throwIfAborted();
            const parts = path.split("/");
            let dir = root;
            for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
            const writable = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
            await writable.write(bytes as unknown as BufferSource);
            await writable.close();
            if (++n % 50 === 0) this.progress("image", `Writing: ${n.toLocaleString()} of ${files.size.toLocaleString()} files`);
          }
          where = `${folder.name}/${base}${suffix}`;
        } else {
          // No folder can be written here: the store as a zip.
          const zipped = new Map([...files].map(([path, bytes]) => [`${base}${suffix}/${path}`, bytes]));
          downloadBlob(zipFiles(zipped), `${base}${suffix}.zip`);
          where = `${base}${suffix}.zip`;
        }
      } else {
        const bytes = saved.files[0][1];
        if (file) {
          const writable = await file.createWritable();
          await writable.write(bytes as unknown as BufferSource);
          await writable.close();
          where = file.name;
        } else {
          downloadBlob(new Blob([bytes as BlobPart]), base + suffix);
          where = base + suffix;
        }
      }
      this.settle("image");
      // Said once, as a toast: the status line reports progress and errors only.
      const resolution = saved.voxelSize >= 0.1 ? `${+saved.voxelSize.toFixed(2)} mm` : `${+(saved.voxelSize * 1000).toFixed(2)} µm`;
      const level = saved.level > 0 ? `, level ${saved.level} (${resolution}): the finest that fits in memory` : "";
      this.ctx.ui.toast(`Saved ${where}: ${saved.size.join(" × ")}${level}.`);
      this.ctx.log.info(`Saved ${r.name} as ${where}.`);
    } catch (e) {
      // A cancelled or failed OME-Zarr leaves no partial store behind (a file being written is discarded by its writer).
      if (folder && fresh) await folder.removeEntry(base + suffix, { recursive: true }).catch(() => {});
      if ((e as DOMException).name === "AbortError") this.settle("image");
      else this.problem("image", `Could not save: ${(e as Error).message}`, retry);
    } finally {
      if (this.saving === controller) this.saving = undefined;
      this.panelUpdate?.();
    }
  }

  /** The landmarks in two annotation layers: fixed ones, and moving ones where the layer now puts them, with lines. */
  private showLandmarks(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const p = t ? physical(t) : undefined;
    const fixed: Json[] = [];
    const moving: Json[] = [];
    if (t && p) {
      this.saved.pairs.forEach((q, i) => {
        const f = q.fixed && this.toGlobal(t, q.fixed);
        const m = q.moving && this.toGlobal(t, apply4(p, q.moving));
        if (f) fixed.push({ type: "point", id: `f${q.id}`, point: f, description: `${i + 1}` });
        if (m) moving.push({ type: "point", id: `m${q.id}`, point: m, description: `${i + 1}` });
        if (f && m && q.on) moving.push({ type: "line", id: `l${q.id}`, pointA: m, pointB: f });
      });
    }
    this.written = new Map([...fixed, ...moving].filter((a) => a.type === "point").map((a) => [a.id as string, a.point as number[]]));
    const state = this.ctx.viewer.getState() as { layers?: Json[] };
    const current = (n: string) => JSON.stringify((state.layers ?? []).find((l) => l.name === n)?.annotations ?? null);
    const wanted = fixed.length + moving.length > 0;
    if (current(FIXED_LAYER) === JSON.stringify(wanted ? fixed : null) && current(MOVING_LAYER) === JSON.stringify(wanted ? moving : null)) return;
    this.ctx.viewer.patchState((ng) => {
      const layers = ((ng.layers as Json[] | undefined) ?? []).filter((l) => l.name !== FIXED_LAYER && l.name !== MOVING_LAYER);
      if (wanted) {
        layers.push({ type: "annotation", source: "local://annotations", name: FIXED_LAYER, annotationColor: "#ffcc00", annotations: fixed });
        layers.push({ type: "annotation", source: "local://annotations", name: MOVING_LAYER, annotationColor: "#3fd3ff", annotations: moving });
      }
      ng.layers = layers;
    });
  }

  /**
   * Landmarks dragged in their annotation layers, read back into their
   * pairs (and the pairs fitted again).  A point counts as dragged when it
   * is not where it was written and not where its pair puts it (so an undo,
   * which puts back both, or Neuroglancer keeping the points as 32-bit
   * floats, changes nothing).
   */
  readBack(): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const p = t ? physical(t) : undefined;
    if (!t || !p) return;
    const ng = this.ctx.viewer.getState() as { dimensions?: Record<string, [number, string]>; layers?: Json[] };
    const dims = Object.entries(ng.dimensions ?? {});
    const axes = t.output.names.map((n) => dims.findIndex(([d]) => d === n));
    if (axes.some((i) => i === -1)) return;
    const voxel = axes.map((i) => mm(dims[i][1][0], dims[i][1][1]));
    const points = (layer: string) => {
      const found = new Map<string, number[]>();
      for (const a of ((ng.layers ?? []).find((l) => l.name === layer)?.annotations as Json[] | undefined) ?? []) {
        if (a.type === "point" && typeof a.id === "string" && Array.isArray(a.point)) found.set(a.id, a.point as number[]);
      }
      return found;
    };
    // Apart by more than a thousandth of a voxel of the global space.
    const apart = (a: ArrayLike<number>, b: ArrayLike<number>) => [0, 1, 2].some((r) => Math.abs(a[r] - b[r]) > 1e-3 * voxel[r]);
    const moved = (id: string, at: number[] | undefined) => at !== undefined && JSON.stringify(at) !== JSON.stringify(this.written.get(id));
    const fixed = points(FIXED_LAYER);
    const moving = points(MOVING_LAYER);
    const inverse = invert4(p);
    let changed = false;
    const pairs = this.saved.pairs.map((q) => {
      let next = q;
      const f = fixed.get(`f${q.id}`);
      if (q.fixed && moved(`f${q.id}`, f)) {
        const at = axes.map((i, r) => f![i] * voxel[r]) as Vec3;
        if (apart(at, q.fixed)) next = { ...next, fixed: at };
      }
      const m = moving.get(`m${q.id}`);
      if (q.moving && moved(`m${q.id}`, m)) {
        const at = apply4(inverse, axes.map((i, r) => m![i] * voxel[r]) as Vec3);
        if (apart(apply4(p, at), apply4(p, q.moving))) next = { ...next, moving: at };
      }
      changed ||= next !== q;
      return next;
    });
    for (const [id, at] of [...fixed, ...moving]) this.written.set(id, at);
    if (!changed) return;
    this.save({ pairs });
    this.refit(true);
  }

  /** Moves the views to a pair: its fixed point, else where the moving layer puts its moving one. */
  private goTo(q: Pair): void {
    const name = this.layer();
    const t = name && this.ctx.viewer.layerTransform(name);
    const p = t ? physical(t) : undefined;
    if (!t || !p) return;
    const at = q.fixed ?? (q.moving && apply4(p, q.moving));
    const position = at && this.toGlobal(t, at);
    if (position) this.ctx.viewer.setPosition(position);
  }

  // ------------------------------------------------ panel

  /**
   * Draws the panel once into `host` and keeps it up to date in place
   * (plugins/README.md, "Building a panel"): controls are set from the state
   * with `set()`, and what changes shape (the pairs, the axes of a newly
   * chosen layer) is a `region()`, so a change of state never takes a value
   * from under the person typing it, closes a select or ends a drag.
   */
  render(host: HTMLElement): () => void {
    const ctx = this.ctx;
    const lines: Record<Part, StatusLine> = { straighten: statusLine(), warp: statusLine(), file: statusLine(), image: statusLine() };
    this.lines = lines;
    const all = () => this.candidates();

    // Nothing to move: only this, and its action.
    const empty = region((text: string) => emptyState(text, { label: "Open data…", run: () => void ctx.commands.invoke("dataset.add") }));

    // ---- the moving layer
    const layer = select([], "", (v) => {
      for (const s of Object.values(lines)) s.clear();
      this.save({ layer: v || undefined, base: undefined, pairs: [], marks: undefined, start: undefined, manual: identityManual(this.saved.manual.around) });
    }, "Moving layer");
    const skipped = region((text: string) => (text ? el("p", { class: "hint" }, `Only 3-D layers can be moved: ${text}.`) : null));

    // ---- Transform: Freeview's Transform Volume, a tab for each of rotate, translate, scale and flip.
    const tabButtons = (
      [
        ["rotate", "Rotate"],
        ["translate", "Translate"],
        ["scale", "Scale"],
        ["flip", "Flip"],
      ] as [Tab, string][]
    ).map(([id, title]) => el("button", { type: "button", role: "tab", "data-tab": id, onclick: () => ((this.tab = id), showTab()) }, title));
    // The arrow keys move between the tabs, one tab stop for the row.
    const tabList = el("div", { class: "segmented", role: "tablist", "aria-label": "Transform" }, ...tabButtons);
    roving(tabList, { items: () => tabButtons, orientation: "horizontal", tabStop: true, onMove: (t) => t.click() });
    let axes: { slider: Slider; get: (m: Manual) => number }[] = [];
    let flips: OnOff[] = [];
    let around: Settable<HTMLSelectElement, string> | undefined;
    let centre: HTMLButtonElement | undefined;
    let bodies: Partial<Record<Tab, HTMLElement>> = {};
    const showTab = () => {
      for (const b of tabButtons) {
        const shown = b.getAttribute("data-tab") === this.tab;
        b.setAttribute("aria-selected", String(shown));
        b.setAttribute("tabindex", shown ? "0" : "-1");
      }
      for (const [id, body] of Object.entries(bodies)) body.hidden = id !== this.tab;
    };
    /** The tabs' controls, for the moving layer: drawn again only when the layer (its axes, its size) changes. */
    const transform = region((key: { enabled: boolean; labels: string[]; ranges: { max: number; step: number }[] }) => {
      const disabled = !key.enabled;
      /** One axis: the slider moves the layer as it is dragged; a typed value may go beyond its ends. */
      const axis = (k: number, tab: string, o: { min: number; max: number; step: number; unit: string; get: (m: Manual) => number; set: (m: Manual, v: number) => Manual | undefined }) => {
        const s = slider(o.get(this.saved.manual), {
          min: o.min,
          max: o.max,
          step: o.step,
          unit: o.unit,
          label: `${tab} ${key.labels[k]}`,
          unbounded: true,
          disabled,
          oninput: (v) => {
            const m = o.set(this.saved.manual, v);
            if (m) this.applyManual(m, false);
          },
          onchange: (v) => {
            const m = o.set(this.saved.manual, v);
            if (m) this.applyManual(m, true);
            else s.set(o.get(this.saved.manual));
          },
        });
        axes.push({ slider: s, get: o.get });
        return el("label", { class: "rg-axis" }, el("span", {}, key.labels[k]), s);
      };
      const set = (part: "rotate" | "translate" | "scale", k: number) => (m: Manual, v: number) => ({ ...m, [part]: m[part].map((x, i) => (i === k ? v : x)) as Vec3 });
      axes = [];
      around = select(
        [
          ["centre", "The volume's centre"],
          ["cursor", "The cursor (the views' centre)"],
        ],
        this.saved.manual.around,
        (v) => this.save({ manual: { ...this.saved.manual, around: v === "cursor" ? "cursor" : "centre" } }),
        "Rotate around",
      );
      centre = button("Move centre to cursor", () => this.centreToCursor());
      flips = [0, 1, 2].map((k) =>
        checkbox(`Flip ${key.labels[k]}`, this.saved.manual.flip[k], (on) => this.applyManual({ ...this.saved.manual, flip: this.saved.manual.flip.map((f, i) => (i === k ? on : f)) as Manual["flip"] }, true), { disabled }),
      );
      bodies = {
        rotate: el(
          "div",
          { class: "stack", role: "tabpanel" },
          ...[0, 1, 2].map((k) => axis(k, "Rotate", { min: -180, max: 180, step: 0.5, unit: "°", get: (m) => m.rotate[k], set: set("rotate", k) })),
          field("Rotate around", around, { info: "Chosen before turning: once the volume is turned, it turns about the same point until the angles are back at 0, as in Freeview." }),
        ),
        translate: el(
          "div",
          { class: "stack", role: "tabpanel" },
          ...[0, 1, 2].map((k) => axis(k, "Translate", { min: -key.ranges[k].max, max: key.ranges[k].max, step: key.ranges[k].step, unit: "mm", get: (m) => m.translate[k], set: set("translate", k) })),
          el("div", { class: "row" }, centre),
        ),
        // Scale: 0.5 to 2 on the slider (Freeview's range), any value above 0 typed.
        scale: el(
          "div",
          { class: "stack", role: "tabpanel" },
          ...[0, 1, 2].map((k) => axis(k, "Scale", { min: 0.5, max: 2, step: 0.001, unit: "×", get: (m) => m.scale[k], set: (m, v) => (v > 0 ? set("scale", k)(m, v) : undefined) })),
        ),
        flip: el("div", { class: "stack", role: "tabpanel" }, ...flips),
      };
      showTab();
      return Object.values(bodies);
    });
    const restore = button("Restore to original", () => this.restore());
    const following = checkbox(
      "Apply to all visible volumes",
      this.saved.all === true,
      (on) => {
        this.save({ all: on });
        this.syncFollowers(on);
      },
      { info: "Every other visible image and segmentation moves as this layer does, as Freeview's Apply to all visible volumes; cleared, they go back where their files put them." },
    );

    // ---- Straighten with four landmarks.
    const marks = [0, 1, 2, 3].map((i) => el("button", { class: "btn outline small", type: "button", "aria-label": `Mark #${i + 1} at the views' centre`, onclick: () => this.markHere(i) }));
    const directions = ([0, 1] as const).map((k) =>
      select(
        DIRECTIONS.map((d): [string, string] => [d, d]),
        (this.saved.lines ?? ["P→A", "I→S"])[k],
        (v) => {
          const lines = [...(this.saved.lines ?? ["P→A", "I→S"])] as [Direction, Direction];
          lines[k] = v as Direction;
          this.save({ lines });
        },
        k === 0 ? "#1 → #2 points" : "#3 → #4 points",
      ),
    );
    const straighten = button("Straighten", () => this.straightenNow(), undefined, "btn small");

    // ---- Landmark pairs.
    const pairsBadge = el("span");
    const fixedHere = button("Fixed here", () => this.mark("fixed"));
    const movingHere = button("Moving here", () => this.mark("moving"));
    const pairs = region((key: { pairs: Pair[]; errors: (number | undefined)[]; names: string[] }) => {
      if (key.pairs.length === 0) return null;
      // In x, y, z order (or the layer's own names'), whatever order the layer keeps its dimensions in.
      const order = [0, 1, 2].sort((a, b) => (key.names[a] ?? "").localeCompare(key.names[b] ?? ""));
      const v = (p?: Vec3) => (p ? order.map((k) => p[k].toFixed(1)).join(", ") : "—");
      const axes = order.map((k) => key.names[k]).join(", ");
      const rows = key.pairs.map((q, i) =>
        el(
          "tr",
          {},
          el("td", {}, String(i + 1)),
          el(
            "td",
            {},
            checkbox(`Use pair ${i + 1}`, q.on, (on) => {
              this.save({ pairs: this.saved.pairs.map((x) => (x.id === q.id ? { ...x, on } : x)) });
              this.refit(true);
            }, { hideLabel: true }),
          ),
          el("td", { class: "readout" }, v(q.fixed)),
          el("td", { class: "readout" }, v(q.moving)),
          el("td", { class: "readout" }, key.errors[i] === undefined ? "" : fmt(key.errors[i]!)),
          el(
            "td",
            { class: "rg-actions" },
            iconButton("target", `Go to pair ${i + 1}`, () => this.goTo(q)),
            iconButton("close", `Remove pair ${i + 1}`, () => {
              this.save({ pairs: this.saved.pairs.filter((x) => x.id !== q.id) });
              this.refit(true);
            }),
          ),
        ),
      );
      return el("table", { class: "rg-pairs" }, el("thead", {}, el("tr", {}, ...["#", "Use", `Fixed ${axes} (mm)`, `Moving ${axes} (mm)`, "Error", ""].map((x) => el("th", {}, x)))), el("tbody", {}, ...rows));
    });
    const model = select(
      (["translation", "rigid", "similarity", "affine"] as Model[]).map((m): [string, string] => [m, `${m[0].toUpperCase()}${m.slice(1)} (${MINIMUM[m]}+ pairs)`]),
      this.saved.model,
      (v) => {
        this.save({ model: v as Model });
        this.refit(true);
      },
      "Model",
    );
    const live = toggle("Live", this.saved.live, (on) => this.save({ live: on }), { info: "Moves the layer with each pair; when off, Apply moves it." });
    const stats = region((key: { text: string; error: boolean }) => (key.text ? el("p", { class: key.error ? "hint" : "readout" }, key.text) : null));
    const apply = button("Apply", () => this.apply(), undefined, "btn small");
    const clearPairs = button("Clear pairs", () => this.save({ pairs: [] }));
    const warp = button("Warp through the pairs", () => void this.warp());

    // ---- Transform file.
    const transformFormat = select(
      [
        ["lta", "FreeSurfer LTA"],
        ["itk", "ITK / ANTs"],
        ["plain", "4 × 4 text"],
      ],
      this.transformFormat,
      (v) => {
        this.transformFormat = v as typeof this.transformFormat;
        this.keepFormats();
      },
      "Format",
    );
    const file = el("input", { type: "file", accept: ".txt,.lta,.mat,.tfm,.xfm,.dat", hidden: true, "aria-label": "Transform file to import" }) as HTMLInputElement;
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      // Emptied, so choosing the same file again (after mending it, or the fixed image) reads it again.
      file.value = "";
      if (chosen) void this.importFile(chosen);
    });
    const saveTransform = button("Save transform", () => void this.exportFile(this.transformFormat), undefined, "btn small");
    const importButton = button("Import…", () => file.click());

    // ---- Image.
    const imageFormat = select(
      [
        ["nii.gz", "NIfTI (.nii.gz)"],
        ["nii", "NIfTI (.nii)"],
        ["mgz", "FreeSurfer (.mgz)"],
        ["mgh", "FreeSurfer (.mgh)"],
        ["zarr", "OME-Zarr"],
      ],
      this.imageFormat,
      (v) => {
        this.imageFormat = v as ImageFormat;
        this.keepFormats();
      },
      "Format",
    );
    const voxels = select(
      [
        ["resample", "Resampled"],
        ["header", "Unchanged (new header)"],
      ],
      this.headerOnly ? "header" : "resample",
      (v) => ((this.headerOnly = v === "header"), sync()),
      "Voxels",
    );
    const method = select(
      [
        ["nearest", "Nearest neighbour"],
        ["linear", "Trilinear"],
        ["cubic", "Cubic"],
      ],
      this.method,
      (v) => (this.method = v as Method),
      "Sample method",
    );
    const grid = select([], "", (v) => (this.grid = v), "Onto the grid of");
    const saveImage = button("Save image…", () => void this.saveImage(), undefined, "btn small");
    const cancel = button("Cancel", () => this.saving?.abort());

    const main = el(
      "div",
      { class: "stack" },
      el("div", { class: "stack" }, field("Moving layer", layer), skipped),
      card(
        "registration.transform",
        "Transform",
        { open: true },
        tabList,
        transform,
        el("div", { class: "row" }, restore),
        following,
      ),
      card(
        "registration.straighten",
        "Straighten",
        { info: "As Freeview's landmarks: mark four points at the views' centre; the line #1 → #2 is turned onto one axis and #3 → #4 as near another as it can, about the volume's centre (the AC to the PC onto P → A, say)." },
        el("div", { class: "row" }, ...marks),
        el("div", { class: "grid-2" }, field("#1 → #2 points", directions[0]), field("#3 → #4 points", directions[1])),
        el("div", { class: "row" }, straighten),
        lines.straighten,
      ),
      card(
        "registration.landmarks",
        "Landmarks",
        { badge: pairsBadge, info: "A fixed point at the mouse: Alt+F. Its match in the moving layer: Alt+M. Drag a point in its annotation layer to move it." },
        el("div", { class: "row" }, fixedHere, movingHere),
        pairs,
        field("Model", model),
        live,
        stats,
        el("div", { class: "row" }, apply, clearPairs),
        el(
          "div",
          { class: "row" },
          warp,
          info("A new layer: the moving image warped so each fixed point lands on its pair, smoothly between (a thin-plate spline; four pairs or more, not all in one plane). It is computed as you view it; the moving layer stays as it is.", "About Warp"),
        ),
        lines.warp,
      ),
      card(
        "registration.transformFile",
        "Transform file",
        {
          info: "Saves the layer's new placement, relative to its file's, moving to fixed RAS mm. Imports LTA, ITK / ANTs (.txt, .mat), 4 × 4 text and MNI .xfm; register.dat and FSL .mat with the fixed image chosen under Image › Onto the grid of.",
        },
        field("Format", transformFormat),
        el("div", { class: "row" }, saveTransform, importButton, file),
        lines.file,
      ),
      card(
        "registration.image",
        "Image",
        {},
        el(
          "div",
          { class: "grid-2" },
          field("Format", imageFormat),
          field("Voxels", voxels, { info: "Resampled: the voxels moved into the grid, as Freeview saves a moved volume. Unchanged: the voxels as they are, with the new placement in the header." }),
          field("Sample method", method, { info: "Labels are always resampled nearest neighbour." }),
          field("Onto the grid of", grid),
        ),
        el("div", { class: "row" }, saveImage, cancel),
        lines.image,
      ),
    );
    host.append(el("div", { class: "rg" }, empty, main));

    /** Brings the panel up to date with the state, the layers and the fit. */
    const sync = () => {
      const { saved } = this;
      const candidates = all();
      const why = notOffered(ctx.viewer.layers().map((l) => ({ name: l.name, type: l.type, rank: ctx.viewer.layerTransform(l.name)?.rank })));
      if (candidates.length === 0) empty.update(why ? `No 3-D layer to move: ${why}.` : "No 3-D layer to move.");
      empty.hidden = candidates.length > 0;
      main.hidden = candidates.length === 0;
      if (candidates.length === 0) return;
      skipped.update(why);

      const name = this.layer();
      const has = name !== undefined;
      const t = name ? ctx.viewer.layerTransform(name) : undefined;
      setOptions(layer, [["", "Choose…"], ...candidates.map((n): [string, string] => [n, n])], name ?? "");

      // Transform.
      const named = t !== undefined && ["x", "y", "z"].every((n) => t.output.names.includes(n));
      const labels = named ? ["X (L-R)", "Y (P-A)", "Z (I-S)"] : (t?.output.names ?? ["x", "y", "z"]).map((n) => n.toUpperCase());
      const order = t ? axisOrder(t.output.names) : ([0, 1, 2] as const);
      const size = t ? this.extent(t, saved.start ?? Array.from(t.matrix)) : undefined;
      const ranges = [0, 1, 2].map((k) => {
        const extent = size?.[order[k]] ?? 256;
        const step = translationStep(extent);
        return { max: Number((Math.ceil(extent / step) * step).toPrecision(6)), step };
      });
      transform.update({ enabled: t !== undefined, labels, ranges });
      for (const a of axes) a.slider.set(a.get(saved.manual));
      flips.forEach((f, k) => f.set(saved.manual.flip[k]));
      around?.set(saved.manual.around);
      if (around) around.disabled = !t || turned(saved.manual);
      if (centre) centre.disabled = !t;
      tabButtons.forEach((b) => (b.disabled = !t));
      restore.disabled = saved.base === undefined && saved.start === undefined;
      following.set(saved.all === true);
      following.input.disabled = !has;

      // Straighten.
      marks.forEach((b, i) => {
        b.textContent = saved.marks?.[i] ? `#${i + 1} ✓` : `#${i + 1} here`;
        b.disabled = !has;
      });
      directions.forEach((d, k) => d.set((saved.lines ?? ["P→A", "I→S"])[k]));
      straighten.disabled = !has || !saved.marks || saved.marks.length < 4 || saved.marks.some((m) => !m);

      // Landmarks.
      const r = this.result;
      const residuals = r !== undefined && !("error" in r) ? r.residuals : [];
      let k = 0;
      const errors = saved.pairs.map((q) => (q.on && q.fixed && q.moving ? residuals[k++] : undefined));
      pairs.update({ pairs: saved.pairs, errors, names: t?.output.names ?? ["x", "y", "z"] });
      pairsBadge.textContent = saved.pairs.length ? `${saved.pairs.length} pair${saved.pairs.length === 1 ? "" : "s"}` : "";
      fixedHere.disabled = movingHere.disabled = !has;
      model.set(saved.model);
      live.set(saved.live);
      stats.update(
        r === undefined
          ? { text: "", error: false }
          : "error" in r
            ? { text: r.error, error: true }
            : (() => {
                const { determinant, scales } = describe(r.matrix);
                return { text: `RMS ${fmt(r.rms)} mm, largest ${fmt(r.max)} mm · scales ${scales.map((s) => s.toFixed(3)).join(", ")}${determinant < 0 ? " · mirrored" : ""}`, error: false };
              })(),
      );
      apply.disabled = !has || saved.live || r === undefined || "error" in r;
      clearPairs.disabled = saved.pairs.length === 0;
      warp.disabled = !has;

      // Transform file and image.
      transformFormat.set(this.transformFormat);
      saveTransform.disabled = importButton.disabled = !has;
      const segmentation = ctx.viewer.layers().find((l) => l.name === name)?.type === "segmentation";
      const grids = this.grids(name);
      if (this.grid && this.grid !== ENLARGE && !grids.includes(this.grid)) this.grid = "";
      imageFormat.set(this.imageFormat);
      voxels.set(this.headerOnly ? "header" : "resample");
      method.set(segmentation ? "nearest" : this.method);
      method.disabled = this.headerOnly || segmentation;
      setOptions(grid, [["", "Its own (cropped to it)"], [ENLARGE, "Its own, enlarged to hold it all"], ...grids.map((g): [string, string] => [g, g])], this.grid);
      grid.disabled = this.headerOnly;
      saveImage.disabled = !has || this.saving !== undefined;
      cancel.hidden = this.saving === undefined;
    };
    this.panelUpdate = sync;
    sync();
    return () => {
      if (this.panelUpdate === sync) this.panelUpdate = undefined;
      if (this.lines === lines) this.lines = undefined;
    };
  }
}

/** A select's options, replaced only when they change (so an open select stays open), and its value. */
function setOptions(s: Settable<HTMLSelectElement, string>, options: [string, string][], value: string): void {
  const key = JSON.stringify(options);
  if (s.getAttribute("data-options") !== key) {
    s.setAttribute("data-options", key);
    s.replaceChildren(...options.map(([v, text]) => el("option", { value: v }, text)));
    s.value = value;
  }
  s.set(value);
}

const STYLE = `
.rg { display: grid; gap: var(--sp-4); }
.rg-axis { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: center; gap: var(--sp-3); }
.rg-axis > span { color: var(--muted); font-size: var(--fs-body); white-space: nowrap; }
.rg-pairs { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
.rg-pairs th { text-align: left; color: var(--faint); font-weight: 500; font-size: var(--fs-caption); padding: var(--sp-1) var(--sp-2); }
.rg-pairs td { padding: var(--sp-1) var(--sp-2); border-top: 1px solid var(--line); }
.rg-actions { white-space: nowrap; text-align: right; }
`;

export const plugin: PluginModule = {
  activate(ctx: PlatformContext) {
    const style = el("style", {}, STYLE);
    document.head.append(style);
    ctx.subscriptions.push(() => style.remove());
    const registration = new Registration(ctx);
    ctx.ui.panel(REGISTRATION_PANEL, (host) => registration.render(host));
    ctx.commands.register("registration.fixedHere", () => registration.mark("fixed"));
    ctx.commands.register("registration.movingHere", () => registration.mark("moving"));
  },
};
