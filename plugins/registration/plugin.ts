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
import { storeOf } from "../volume-view/sources.js";
import { apply4, describe, fit, type Fit, identity4, invert4, type Mat4, MINIMUM, type Model, multiply4, type Vec3 } from "./fit.js";
import { needsGeometry, readTransformFile, type VolumeGeometry, writeItk, writeLta, writePlain } from "./formats.js";
import {
  axisOrder,
  identityManual,
  isIdentityManual,
  type Manual,
  manualMatrix,
  permute,
  readManual,
  SCALE_SLIDER,
  scaleFromSlider,
  sliderFromScale,
  translationStep,
  turned,
  unpermute,
} from "./manual.js";
import { REGISTRATION_PANEL } from "./manifest.js";
import type { SaveRequest } from "./save_worker.js";
import { DIRECTIONS, type Direction, straighten } from "./straighten.js";
import { ENLARGE, type Method, zipFiles } from "./volume_io.js";

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

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

/** A number for a typed field: no more decimals than `step` needs, and one more. */
function typedValue(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(step))));
  return String(Number(v.toFixed(decimals)));
}

type Tab = "rotate" | "translate" | "scale" | "flip";
type ImageFormat = SaveRequest["format"];

/** At most this much of an image is read for saving (its finest level that fits). */
const MAX_BYTES = 512 * 2 ** 20;

/** Registration's worker: geometry and saving, as promises with progress and cancel. */
class SaveClient {
  private worker = new Worker(new URL("./save_worker.ts", import.meta.url), { type: "module", name: "registration" });
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (what: string, done: number, total: number) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      if (msg.type === "progress") return p.progress?.(msg.what, msg.done, msg.total);
      this.pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
  }

  request<T>(message: object, progress?: (what: string, done: number, total: number) => void, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      signal?.addEventListener("abort", () => {
        if (!this.pending.delete(id)) return;
        this.worker.postMessage({ type: "cancel", id });
        reject(new DOMException("Aborted", "AbortError"));
      });
      this.worker.postMessage({ ...message, id });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** A file name from a layer's name. */
const fileName = (name: string) => name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "image";

/** A layer's source as a URL (its first, whatever form the spec gives it in). */
function sourceUrl(spec: Json | undefined): string | undefined {
  const source = (spec as { source?: unknown } | undefined)?.source;
  const first = Array.isArray(source) ? source[0] : source;
  if (typeof first === "string") return first;
  const url = (first as { url?: unknown } | undefined)?.url;
  return typeof url === "string" ? url : undefined;
}

type FilePicker = {
  showSaveFilePicker?(o?: unknown): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(o?: unknown): Promise<FileSystemDirectoryHandle>;
};

class Registration {
  private saved: Saved;
  private result: Fit | { error: string } | undefined;
  private panelUpdate: ((force?: boolean) => void) | undefined;
  private tab: Tab = "rotate";
  /** The image save's choices (this session only). */
  private imageFormat: ImageFormat = "nii.gz";
  private headerOnly = false;
  private method: Method = "linear";
  private grid = "";
  private transformFormat: "lta" | "itk" | "plain" = "lta";
  private saving: AbortController | undefined;
  private saveNote = "";
  private noteUpdate: (() => void) | undefined;
  private client: SaveClient | undefined;

  constructor(private readonly ctx: PlatformContext) {
    this.saved = readSaved(ctx.state.get());
    ctx.subscriptions.push(
      ctx.state.onChanged(() => {
        this.saved = readSaved(ctx.state.get());
        this.refit(false);
        this.panelUpdate?.();
      }),
      ctx.viewer.onLayersChanged(() => this.panelUpdate?.()),
      () => {
        this.saving?.abort();
        this.client?.dispose();
      },
    );
    this.refit(false);
  }

  private save(patch: Partial<Saved>): void {
    this.saved = { ...this.saved, ...patch };
    this.ctx.state.set(this.saved);
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
      this.ctx.ui.toast("Choose the moving layer in the Registration tab first.", "error");
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
    const pairs = [...this.saved.pairs];
    const open = pairs.find((q) => q[role] === undefined);
    if (open !== undefined) open[role] = point;
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
      this.straightenNote = `Straightened: #1 → #2 now points ${first}, #3 → #4 as near ${second} as it can.`;
    } catch (e) {
      this.straightenNote = `Could not straighten: ${(e as Error).message}.`;
    }
    this.panelUpdate?.();
  }

  private straightenNote = "";

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

  private worker(): SaveClient {
    return (this.client ??= new SaveClient());
  }

  /** The store an image layer reads (OME-Zarr, NIfTI as virtual Zarr, precomputed), for the worker. */
  private storeOf(layer: string): string | undefined {
    return storeOf(sourceUrl(this.ctx.viewer.layerSpec(layer)));
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

  private download(blob: Blob, name: string): void {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
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
      text = writeLta(r.move, { src, dst });
    } else {
      text = format === "itk" ? writeItk(r.move) : writePlain(r.move);
    }
    this.download(new Blob([text], { type: "text/plain" }), `${fileName(r.name)}_reg.${format === "lta" ? "lta" : "txt"}`);
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
    } catch (e) {
      this.ctx.ui.toast(`Could not read ${file.name}: ${(e as Error).message}`, "error");
    }
  }

  private note(text: string): void {
    this.saveNote = text;
    this.noteUpdate?.();
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
    if (store === undefined) {
      this.ctx.ui.toast("This layer's data cannot be read for saving: OME-Zarr, NIfTI and precomputed images can be.", "error");
      return;
    }
    const format = this.imageFormat;
    const base = `${fileName(r.name)}_registered`;
    const suffix = format === "zarr" ? ".ome.zarr" : `.${format}`;
    // Where to, asked first (a picker needs the click that asked for it).
    const picker = window as unknown as FilePicker;
    let file: FileSystemFileHandle | undefined;
    let folder: FileSystemDirectoryHandle | undefined;
    try {
      if (format === "zarr" && picker.showDirectoryPicker) folder = await picker.showDirectoryPicker({ id: "ngplatform-save", mode: "readwrite" });
      else if (format !== "zarr" && picker.showSaveFilePicker)
        file = await picker.showSaveFilePicker({ id: "ngplatform-save", suggestedName: base + suffix, types: [{ description: /^mg/.test(format) ? "FreeSurfer volume" : "NIfTI", accept: { "application/octet-stream": [suffix] } }] });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return;
      throw e;
    }
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
    };
    try {
      this.note("Reading…");
      const saved = await this.worker().request<{ files: [string, Uint8Array][]; level: number; voxelSize: number; size: number[] }>(
        { type: "save", ...request },
        (what, done, total) => this.note(total > 1 ? `${what}: ${Math.round((100 * done) / total)}%` : `${what}…`),
        controller.signal,
      );
      let where: string;
      if (format === "zarr") {
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
            if (++n % 50 === 0) this.note(`Writing: ${n.toLocaleString()} of ${files.size.toLocaleString()} files`);
          }
          where = `${folder.name}/${base}${suffix}`;
        } else {
          // No folder can be written here: the store as a zip.
          const zipped = new Map([...files].map(([path, bytes]) => [`${base}${suffix}/${path}`, bytes]));
          this.download(zipFiles(zipped), `${base}${suffix}.zip`);
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
          this.download(new Blob([bytes as BlobPart]), base + suffix);
          where = base + suffix;
        }
      }
      const resolution = saved.voxelSize >= 0.1 ? `${+saved.voxelSize.toFixed(2)} mm` : `${+(saved.voxelSize * 1000).toFixed(2)} µm`;
      const level = saved.level > 0 ? `, level ${saved.level} (${resolution}): the finest that fits in memory` : "";
      this.note(`Saved ${where}: ${saved.size.join(" × ")}${level}.`);
      this.ctx.log.info(`Saved ${r.name} as ${where}.`);
    } catch (e) {
      if ((e as DOMException).name === "AbortError") this.note("Cancelled.");
      else this.note(`Could not save: ${(e as Error).message}`);
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

  // ------------------------------------------------ panel

  /** Freeview's Transform Volume controls: Rotate, Translate, Scale and Flip tabs, a slider and a typed value an axis. */
  private transformControls(t: LayerTransform | undefined): HTMLElement {
    const m = this.saved.manual;
    const enabled = t !== undefined;
    const order = t ? axisOrder(t.output.names) : ([0, 1, 2] as [number, number, number]);
    const named = t !== undefined && ["x", "y", "z"].every((n) => t.output.names.includes(n));
    const labels = named ? ["X (L-R)", "Y (P-A)", "Z (I-S)"] : (t?.output.names ?? ["x", "y", "z"]).map((n) => n.toUpperCase());
    const start = t ? (this.saved.start ?? Array.from(t.matrix)) : undefined;
    const size = t && start ? this.extent(t, start) : undefined;
    const tabs = el("div", { class: "segmented rg-tabs", role: "tablist" });
    for (const [id, title] of [
      ["rotate", "Rotate"],
      ["translate", "Translate"],
      ["scale", "Scale"],
      ["flip", "Flip"],
    ] as [Tab, string][]) {
      tabs.append(
        el("button", { type: "button", role: "tab", "aria-pressed": String(this.tab === id), onclick: () => ((this.tab = id), this.panelUpdate?.(true)) }, title),
      );
    }
    /** One axis: a slider (moving the layer as it is dragged) and a typed value. */
    const axis = (k: number, o: { min: number; max: number; step: number; unit: string; slider: (v: number) => number; value: (n: number) => number; get: (m: Manual) => number; set: (m: Manual, v: number) => Manual; typedStep: number }) => {
      const range = el("input", { type: "range", min: o.min, max: o.max, step: o.step, disabled: !enabled, "aria-label": `${labels[k]} slider` }) as HTMLInputElement;
      const number = el("input", { type: "number", class: "text-input rg-num", step: o.typedStep, disabled: !enabled, "aria-label": labels[k] }) as HTMLInputElement;
      range.value = String(o.slider(o.get(m)));
      number.value = typedValue(o.get(m), o.typedStep);
      range.addEventListener("input", () => {
        const v = o.value(Number(range.value));
        number.value = typedValue(v, o.typedStep);
        this.applyManual(o.set(this.saved.manual, v), false);
      });
      range.addEventListener("change", () => this.applyManual(o.set(this.saved.manual, o.value(Number(range.value))), true));
      number.addEventListener("change", () => {
        const v = Number(number.value);
        if (!Number.isFinite(v)) return;
        this.applyManual(o.set(this.saved.manual, v), true);
      });
      return el("div", { class: "rg-axis" }, el("span", { class: "rg-axis-name" }, labels[k]), range, number, el("span", { class: "rg-unit" }, o.unit));
    };
    const body = el("div", { class: "rg-tab" });
    if (this.tab === "rotate") {
      for (let k = 0; k < 3; ++k) {
        body.append(
          axis(k, {
            min: -180,
            max: 180,
            step: 0.5,
            typedStep: 0.5,
            unit: "°",
            slider: (v) => ((((v + 180) % 360) + 360) % 360) - 180,
            value: (n) => n,
            get: (x) => x.rotate[k],
            set: (x, v) => ({ ...x, rotate: x.rotate.map((r, i) => (i === k ? v : r)) as Vec3 }),
          }),
        );
      }
      // The pivot, chosen before turning (Freeview disables the choice once turned).
      const fixedPivot = turned(m);
      const choice = (value: Manual["around"], text: string) => {
        const radio = el("input", { type: "radio", name: "rg-around", checked: m.around === value, disabled: !enabled || fixedPivot }) as HTMLInputElement;
        radio.addEventListener("change", () => this.save({ manual: { ...this.saved.manual, around: value } }));
        return el("label", { class: "field check" }, radio, el("span", {}, text));
      };
      body.append(
        el("div", { class: "rg-around" }, choice("centre", "Rotate around the centre of the volume"), choice("cursor", "Rotate around the cursor (the views' centre)")),
      );
      if (fixedPivot && m.pivot) body.append(el("p", { class: "note rg-tight" }, `Turning about ${m.pivot.map((v) => v.toFixed(1)).join(", ")} mm until the angles are back at 0.`));
    } else if (this.tab === "translate") {
      for (let k = 0; k < 3; ++k) {
        const extent = size?.[order[k]] ?? 256;
        const step = translationStep(extent);
        body.append(
          axis(k, {
            min: -Number((Math.ceil(extent / step) * step).toPrecision(6)),
            max: Number((Math.ceil(extent / step) * step).toPrecision(6)),
            step,
            typedStep: step,
            unit: "mm",
            slider: (v) => v,
            value: (n) => n,
            get: (x) => x.translate[k],
            set: (x, v) => ({ ...x, translate: x.translate.map((r, i) => (i === k ? v : r)) as Vec3 }),
          }),
        );
      }
      body.append(el("div", { class: "rg-row" }, el("button", { class: "btn outline small", type: "button", disabled: !enabled, onclick: () => this.centreToCursor() }, "Move centre to cursor")));
    } else if (this.tab === "scale") {
      for (let k = 0; k < 3; ++k) {
        body.append(
          axis(k, {
            min: 0,
            max: SCALE_SLIDER,
            step: 1,
            typedStep: 0.001,
            unit: "×",
            slider: sliderFromScale,
            value: scaleFromSlider,
            get: (x) => x.scale[k],
            set: (x, v) => ({ ...x, scale: x.scale.map((r, i) => (i === k ? (v > 0 ? v : r) : r)) as Vec3 }),
          }),
        );
      }
    } else {
      for (let k = 0; k < 3; ++k) {
        const box = el("input", { type: "checkbox", checked: m.flip[k], disabled: !enabled }) as HTMLInputElement;
        box.addEventListener("change", () => this.applyManual({ ...this.saved.manual, flip: this.saved.manual.flip.map((f, i) => (i === k ? box.checked : f)) as Manual["flip"] }, true));
        body.append(el("label", { class: "field check" }, box, el("span", {}, `Flip ${labels[k]}`)));
      }
    }
    return el("div", { class: "rg-transform" }, tabs, body);
  }

  private saveControls(name: string | undefined): HTMLElement {
    const has = name !== undefined;
    const select = (label: string, options: [string, string][], value: string, change: (v: string) => void, disabled = false) => {
      const s = el("select", { class: "text-input", "aria-label": label, disabled }) as HTMLSelectElement;
      for (const [v, text] of options) s.append(el("option", { value: v }, text));
      s.value = value;
      s.addEventListener("change", () => change(s.value));
      return el("label", { class: "field" }, el("span", {}, label), s);
    };
    const redraw = () => this.panelUpdate?.(true);
    const file = el("input", { type: "file", accept: ".txt,.lta,.mat,.tfm,.xfm,.dat", hidden: true }) as HTMLInputElement;
    file.addEventListener("change", () => file.files?.[0] && void this.importFile(file.files[0]));
    const segmentation = this.ctx.viewer.layers().find((l) => l.name === name)?.type === "segmentation";
    const grids = this.grids(name);
    if (this.grid && this.grid !== ENLARGE && !grids.includes(this.grid)) this.grid = "";
    const note = el("p", { class: "note rg-tight", role: "status" });
    this.noteUpdate = () => {
      note.textContent = this.saveNote;
      note.hidden = this.saveNote === "";
    };
    this.noteUpdate();
    return el(
      "div",
      { class: "rg-save" },
      el("h3", { class: "section-title" }, "Transform file"),
      el(
        "div",
        { class: "rg-row" },
        select("Format", [["lta", "FreeSurfer LTA"], ["itk", "ITK / ANTs"], ["plain", "4 × 4 text"]], this.transformFormat, (v) => (this.transformFormat = v as typeof this.transformFormat)),
      ),
      el(
        "div",
        { class: "rg-row" },
        el("button", { class: "btn small", type: "button", disabled: !has, title: "The layer's new placement, relative to its file's, moving to fixed RAS mm", onclick: () => void this.exportFile(this.transformFormat) }, "Save transform"),
        el("button", { class: "btn outline small", type: "button", disabled: !has, title: "LTA, ITK / ANTs (.txt, .mat), 4 × 4 text, MNI .xfm; register.dat and FSL .mat with the fixed image chosen under “Onto the grid of”", onclick: () => file.click() }, "Import…"),
        file,
      ),
      el("h3", { class: "section-title" }, "Image"),
      el(
        "div",
        { class: "rg-grid2" },
        select("Format", [["nii.gz", "NIfTI (.nii.gz)"], ["nii", "NIfTI (.nii)"], ["mgz", "FreeSurfer (.mgz)"], ["mgh", "FreeSurfer (.mgh)"], ["zarr", "OME-Zarr"]], this.imageFormat, (v) => (this.imageFormat = v as ImageFormat)),
        select("Voxels", [["resample", "Resampled"], ["header", "Unchanged (new header)"]], this.headerOnly ? "header" : "resample", (v) => ((this.headerOnly = v === "header"), redraw())),
        select("Sample method", [["nearest", "Nearest neighbour"], ["linear", "Trilinear"], ["cubic", "Cubic"]], segmentation ? "nearest" : this.method, (v) => (this.method = v as Method), this.headerOnly || segmentation),
        select("Onto the grid of", [["", "Its own (cropped to it)"], [ENLARGE, "Its own, enlarged to hold it all"], ...grids.map((g): [string, string] => [g, g])], this.grid, (v) => (this.grid = v), this.headerOnly),
      ),
      el(
        "p",
        { class: "note rg-tight" },
        this.headerOnly
          ? "The voxels as they are, with the new placement in the header."
          : segmentation
            ? "Labels are always resampled nearest neighbour."
            : "The voxels moved into the grid, as Freeview saves a moved volume.",
      ),
      el(
        "div",
        { class: "rg-row" },
        el("button", { class: "btn small", type: "button", disabled: !has || this.saving !== undefined, onclick: () => void this.saveImage() }, "Save image…"),
        this.saving ? el("button", { class: "btn outline small", type: "button", onclick: () => this.saving?.abort() }, "Cancel") : null,
      ),
      note,
    );
  }

  render(host: HTMLElement): () => void {
    let built = "";
    const draw = (force = false) => {
      const { saved } = this;
      const candidates = this.candidates();
      // Rebuilt only when something shown changes (not while a slider is dragged, which moves the layer only).
      const r0 = this.result;
      const signature = JSON.stringify([
        candidates,
        this.ctx.state.get(),
        r0 === undefined ? null : "error" in r0 ? r0.error : [r0.rms, r0.residuals],
        this.grids(this.layer()),
        this.saving !== undefined,
      ]);
      if (!force && signature === built && host.firstChild !== null) return;
      built = signature;
      const layer = el("select", { class: "text-input", "aria-label": "Moving layer" }) as HTMLSelectElement;
      layer.append(el("option", { value: "" }, "Choose…"));
      for (const n of candidates) layer.append(el("option", { value: n }, n));
      layer.value = this.layer() ?? "";
      layer.addEventListener("change", () => this.save({ layer: layer.value || undefined, base: undefined, pairs: [], start: undefined, manual: identityManual(this.saved.manual.around) }));
      const model = el("select", { class: "text-input", "aria-label": "Model" }) as HTMLSelectElement;
      for (const m of ["translation", "rigid", "similarity", "affine"]) model.append(el("option", { value: m }, `${m[0].toUpperCase()}${m.slice(1)} (${MINIMUM[m as Model]}+ pairs)`));
      model.value = saved.model;
      model.addEventListener("change", () => {
        this.save({ model: model.value as Model });
        this.refit(true);
      });
      const live = el("input", { type: "checkbox" }) as HTMLInputElement;
      live.checked = saved.live;
      live.addEventListener("change", () => this.save({ live: live.checked }));
      const r = this.result;
      const stats =
        r === undefined
          ? ""
          : "error" in r
            ? r.error
            : (() => {
                const { determinant, scales } = describe(r.matrix);
                return `RMS ${fmt(r.rms)} mm, largest ${fmt(r.max)} mm · scales ${scales.map((s) => s.toFixed(3)).join(", ")}${determinant < 0 ? " · mirrored!" : ""}`;
              })();
      const errors = r !== undefined && !("error" in r) ? r.residuals : [];
      let k = 0;
      const rows = saved.pairs.map((q, i) => {
        const on = el("input", { type: "checkbox", title: "Use this pair" }) as HTMLInputElement;
        on.checked = q.on;
        on.addEventListener("change", () => {
          this.save({ pairs: saved.pairs.map((x) => (x.id === q.id ? { ...x, on: on.checked } : x)) });
          this.refit(true);
        });
        const complete = q.on && q.fixed && q.moving;
        const error = complete ? errors[k++] : undefined;
        // In x, y, z order, whatever order the layer keeps its dimensions in.
        const names = (this.layer() && this.ctx.viewer.layerTransform(this.layer()!)?.output.names) || ["x", "y", "z"];
        const order = [0, 1, 2].sort((a, b) => (names[a] ?? "").localeCompare(names[b] ?? ""));
        const v = (p?: Vec3) => (p ? order.map((k) => `${names[k]} ${p[k].toFixed(1)}`).join("  ") : "—");
        return el(
          "tr",
          {},
          el("td", {}, String(i + 1)),
          el("td", {}, on),
          el("td", { class: "mono" }, v(q.fixed)),
          el("td", { class: "mono" }, v(q.moving)),
          el("td", { class: "mono" }, error === undefined ? "" : fmt(error)),
          el(
            "td",
            {},
            el("button", {
              class: "btn icon",
              type: "button",
              title: "Remove",
              onclick: () => {
                this.save({ pairs: saved.pairs.filter((x) => x.id !== q.id) });
                this.refit(true);
              },
            }, "×"),
          ),
        );
      });
      const name = this.layer();
      const hasLayer = name !== undefined;
      const t = name ? this.ctx.viewer.layerTransform(name) : undefined;
      const moved = saved.base !== undefined || saved.start !== undefined;
      host.replaceChildren(
        el(
          "div",
          { class: "rg" },
          el("label", { class: "field" }, el("span", {}, "Moving layer"), candidates.length ? layer : el("span", { class: "note" }, "No 3-D layer to move.")),
          el("h3", { class: "section-title" }, "Transform"),
          this.transformControls(t),
          el(
            "div",
            { class: "rg-row" },
            el("button", { class: "btn outline small", type: "button", disabled: !moved, title: "The transform the layer had before registering", onclick: () => this.restore() }, "Restore to original"),
          ),
          el(
            "label",
            { class: "field check", title: "Every other visible image and segmentation moves as this layer does (Freeview's Apply to all visible volumes)" },
            el("input", {
              type: "checkbox",
              checked: saved.all === true,
              disabled: !hasLayer,
              onchange: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                this.save({ all: on });
                this.syncFollowers(on);
              },
            }),
            el("span", {}, "Apply to all visible volumes"),
          ),
          el("h3", { class: "section-title" }, "Straighten with landmarks"),
          el("p", { class: "note rg-tight" }, "As Freeview's landmarks: mark four points on the image (the views' centre), then turn the line #1 → #2 onto one axis and #3 → #4 as near another as it can, about the volume's centre (for example the AC to the PC onto P → A)."),
          el(
            "div",
            { class: "rg-row" },
            ...[0, 1, 2, 3].map((i) =>
              el(
                "button",
                { class: "btn outline small", type: "button", disabled: !hasLayer, title: saved.marks?.[i] ? `#${i + 1}: ${saved.marks[i]!.map((v) => v.toFixed(1)).join(", ")} mm` : `Mark #${i + 1} at the views' centre`, onclick: () => this.markHere(i) },
                saved.marks?.[i] ? `#${i + 1} ✓` : `#${i + 1} here`,
              ),
            ),
          ),
          el(
            "div",
            { class: "rg-grid2" },
            ...([0, 1] as const).map((k) =>
              el(
                "label",
                { class: "field" },
                el("span", {}, k === 0 ? "#1 → #2 points" : "#3 → #4 points"),
                el(
                  "select",
                  {
                    onchange: (e: Event) => {
                      const lines = [...(saved.lines ?? ["P→A", "I→S"])] as [Direction, Direction];
                      lines[k] = (e.target as HTMLSelectElement).value as Direction;
                      this.save({ lines });
                    },
                  },
                  ...DIRECTIONS.map((d) => el("option", { value: d, ...(d === (saved.lines ?? ["P→A", "I→S"])[k] ? { selected: "" } : {}) }, d)),
                ),
              ),
            ),
          ),
          el(
            "div",
            { class: "rg-row" },
            el("button", { class: "btn small", type: "button", disabled: !hasLayer || !saved.marks || saved.marks.length < 4 || saved.marks.some((m) => !m), onclick: () => this.straightenNow() }, "Straighten"),
          ),
          this.straightenNote ? el("p", { class: "note" }, this.straightenNote) : null,
          el("h3", { class: "section-title" }, "Landmarks"),
          el("p", { class: "note rg-tight" }, "Point at a feature in the fixed data, Alt+F; the same feature in the moving layer, Alt+M."),
          el(
            "div",
            { class: "rg-row" },
            el("button", { class: "btn outline small", type: "button", disabled: !hasLayer, onclick: () => this.mark("fixed") }, "Fixed here"),
            el("button", { class: "btn outline small", type: "button", disabled: !hasLayer, onclick: () => this.mark("moving") }, "Moving here"),
          ),
          saved.pairs.length
            ? el("table", { class: "rg-pairs" }, el("thead", {}, el("tr", {}, ...["#", "", "Fixed (mm)", "Moving (mm)", "Error", ""].map((x) => el("th", {}, x)))), el("tbody", {}, ...rows))
            : null,
          el("label", { class: "field" }, el("span", {}, "Model"), model),
          el("label", { class: "field check" }, live, el("span", {}, "Live: move the layer with each pair")),
          stats ? el("p", { class: r && "error" in r ? "note error rg-tight" : "note rg-tight" }, stats) : null,
          el(
            "div",
            { class: "rg-row" },
            el("button", { class: "btn small", type: "button", disabled: !hasLayer || saved.live, onclick: () => this.apply() }, "Apply"),
            el("button", { class: "btn outline small", type: "button", disabled: !saved.pairs.length, onclick: () => this.save({ pairs: [] }) }, "Clear pairs"),
          ),
          this.saveControls(name),
        ),
      );
    };
    this.panelUpdate = draw;
    draw(true);
    return () => {
      if (this.panelUpdate === draw) this.panelUpdate = undefined;
      this.noteUpdate = undefined;
    };
  }
}

const STYLE = `
.rg { display: grid; gap: 8px; }
.rg .section-title { margin: 8px 0 0; }
.rg-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rg-tight { margin: 0; }
.rg-pairs { width: 100%; border-collapse: collapse; font-size: 12px; }
.rg-pairs th { text-align: left; color: var(--faint); font-weight: 500; padding: 2px 4px; }
.rg-pairs td { padding: 2px 4px; border-top: 1px solid var(--line); }
.rg-pairs td.mono { font-family: var(--mono); font-size: 11px; }
.rg-transform { display: grid; gap: 8px; }
.rg-tabs { align-self: start; justify-self: start; }
.rg-tab { display: grid; gap: 6px; }
.rg-axis { display: grid; grid-template-columns: 58px minmax(60px, 1fr) 76px 18px; align-items: center; gap: 6px; font-size: 12px; }
.rg-axis-name { color: var(--muted); white-space: nowrap; }
.rg-axis input[type="range"] { width: 100%; min-width: 0; accent-color: var(--select); }
.rg-num { height: 24px; padding: 0 4px; font: 12px/1 var(--mono); min-width: 0; width: 100%; }
.rg-unit { color: var(--faint); }
.rg-around { display: grid; gap: 4px; }
.rg-save { display: grid; gap: 8px; }
.rg-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.rg-grid2 select { min-width: 0; width: 100%; }
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
