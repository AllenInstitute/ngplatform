/**
 * Quick select's 3-D model method, "AI 3-D (MedSAM2)": a box (or clicks) in
 * a 2-D view segmented in its section by MedSAM2, then, with Spread, tracked
 * section by section through the volume as MedSAM2's video predictor does
 * (./medsam2.ts). It runs in this page, in a worker (./medsam2_worker.ts),
 * with ONNX Runtime Web from jsDelivr (as MobileSAM does).
 *
 * - The model's files (four ONNX graphs with float16 weights, 86 MB, and
 *   constants.json; manifest.json lists them) come from `medsam2Base()`:
 *   the address in localStorage `ngplatform.medsam2.url` when set, else
 *   `models/medsam2/` beside the app. They are downloaded on first use and
 *   kept in the browser's Cache Storage. tools/medsam2/ makes them.
 * - A prompt: the section round it (at least `context` voxels across, twice
 *   the prompt's size) is read, windowed as its layer shows it, resampled to
 *   512 × 512 and encoded; the prompt conditions the track; the mask comes
 *   back on the label grid, the parts holding a wanted click kept.
 * - Spread: the same crop and window in each section along the axis, up to
 *   `count` sections each way, a direction ending where the object is gone
 *   (the model's object score falls to 0 or below).
 */
import { MEDSAM2_LOW, MEDSAM2_SIZE, medsam2Image, medsam2Prompt } from "./medsam2.js";
import type { MedSam2Reply, MedSam2Request } from "./medsam2_worker.js";
import type { Mask, QuickSelectMethod, QuickSelectRequest } from "./quick_select.js";
import { cropBox, cropFor, keepParts, maskOnGrid, quantileWindow, sectionAxes, type Crop } from "./sam.js";
import { MODEL_CACHE, ORT_URL, type Provider } from "./sam_model.js";

export const MEDSAM2 = {
  id: "medsam2",
  name: "MedSAM2",
  licence: "Apache-2.0",
  home: "https://github.com/bowang-lab/MedSAM2",
  /** The files' size with float16 weights (tools/medsam2/half_weights.py). */
  bytes: 86_000_000,
};

/** ImageNet's mean and spread, MedSAM2's normalisation (constants.json has them too). */
const PIXEL = { pixel_mean: [0.485, 0.456, 0.406], pixel_std: [0.229, 0.224, 0.225] };

/** Where the model's files are: localStorage `ngplatform.medsam2.url` when set, else `models/medsam2/` beside the app. */
export function medsam2Base(): string {
  try {
    const set = typeof localStorage !== "undefined" ? localStorage.getItem("ngplatform.medsam2.url") : null;
    if (set) return new URL(set.endsWith("/") ? set : `${set}/`, location.href).href;
  } catch {
    // Storage refused: the default.
  }
  return new URL("models/medsam2/", typeof document !== "undefined" ? document.baseURI : location.href).href;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** A track's prompt and where it is, so Spread follows the mask the prompt made. */
interface Track {
  key: string;
  image: string;
  axis: number;
  index: number;
  crop: Crop;
  window: [number, number];
  /** The prompt as given (its JSON, to tell whether a later request is the same). */
  prompt: string;
  /** The prompt in the model's pixels. */
  tensors: { coords: Float32Array; labels: Int32Array };
}

export class MedSam2Model {
  state: "unknown" | "absent" | "kept" | "loading" | "ready" | "failed" = "unknown";
  kept = 0;
  bytes = MEDSAM2.bytes;
  progress: { loaded: number; total: number } | undefined;
  error = "";
  provider: Provider = "auto";
  running = "";
  threads = 1;
  /** The last section's encoding, and the last mask's time (conditioning or a tracking step), ms. */
  encodeMs: number | undefined;
  decodeMs: number | undefined;
  private worker: Worker | undefined;
  private loaded: Promise<void> | undefined;
  private next = 0;
  private readonly waiting = new Map<number, { resolve(r: MedSam2Reply): void; reject(e: Error): void; progress?(loaded: number, total: number): void }>();
  private readonly listeners = new Set<() => void>();
  private track: Track | undefined;

  constructor() {
    void this.refreshKept();
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.listeners.forEach((l) => l());
  }

  /** The model's files kept in this browser (those under its address). */
  async refreshKept(): Promise<void> {
    let n = 0;
    if (typeof caches !== "undefined") {
      const base = medsam2Base();
      const cache = await caches.open(MODEL_CACHE).catch(() => undefined);
      for (const request of (await cache?.keys().catch(() => [])) ?? []) {
        if (!request.url.startsWith(base) || request.url.endsWith("manifest.json")) continue;
        const r = await cache!.match(request);
        if (r) n += Number(r.headers.get("content-length")) || 0;
      }
    }
    this.kept = n;
    if (this.state === "unknown" || this.state === "absent" || this.state === "kept") this.state = n > 0 ? "kept" : "absent";
    this.changed();
  }

  /** Drops the model's files from this browser (and the worker). */
  async forget(): Promise<void> {
    this.stop();
    if (typeof caches !== "undefined") {
      const base = medsam2Base();
      const cache = await caches.open(MODEL_CACHE).catch(() => undefined);
      for (const request of (await cache?.keys().catch(() => [])) ?? []) if (request.url.startsWith(base)) await cache!.delete(request);
    }
    this.state = "unknown";
    await this.refreshKept();
  }

  setProvider(provider: Provider): void {
    if (provider === this.provider) return;
    this.provider = provider;
    this.stop();
    this.state = this.kept > 0 ? "kept" : "absent";
    this.changed();
  }

  get started(): boolean {
    return this.worker !== undefined;
  }

  /** Lets the worker go (Quick select was left); the next prompt starts it again. */
  release(): void {
    if (this.worker === undefined) return;
    this.stop();
    this.state = this.kept > 0 ? "kept" : "absent";
    this.changed();
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.loaded = undefined;
    this.track = undefined;
    this.running = "";
    for (const w of this.waiting.values()) w.reject(new Error("The model was stopped."));
    this.waiting.clear();
  }

  private call(request: WithoutId<MedSam2Request>, transfer: Transferable[] = [], progress?: (loaded: number, total: number) => void): Promise<Extract<MedSam2Reply, { ok: true }>> {
    if (this.worker === undefined) {
      this.worker = new Worker(new URL("./medsam2_worker.ts", import.meta.url), { type: "module", name: "MedSAM2" });
      this.worker.onmessage = (e: MessageEvent<MedSam2Reply>) => {
        const r = e.data;
        const w = this.waiting.get(r.id);
        if (w === undefined) return;
        if ("op" in r && r.op === "progress") {
          w.progress?.(r.loaded, r.total);
          return;
        }
        this.waiting.delete(r.id);
        if ("error" in r) w.reject(new Error(r.error));
        else w.resolve(r);
      };
      this.worker.onerror = (e) => {
        for (const w of this.waiting.values()) w.reject(new Error(e.message || "MedSAM2's worker failed."));
        this.waiting.clear();
      };
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (r: MedSam2Reply) => void, reject, progress });
      this.worker!.postMessage({ ...request, id }, transfer);
    });
  }

  /** The model loaded in the worker: its files downloaded (or read from the browser), its sessions built. */
  load(progress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.loaded === undefined) {
      this.state = "loading";
      this.error = "";
      this.changed();
      let told = 0;
      this.loaded = this.call({ op: "load", ort: ORT_URL, provider: this.provider, cache: MODEL_CACHE, base: medsam2Base() }, [], (loaded, total) => {
        this.progress = { loaded, total };
        this.bytes = total;
        if (loaded - told >= total / 100 || loaded === total) {
          told = loaded;
          progress?.(loaded, total);
          this.changed();
        }
      }).then(
        (r) => {
          this.state = "ready";
          this.progress = undefined;
          this.running = r.provider ?? "";
          this.threads = r.threads ?? 1;
          if (r.bytes) this.bytes = r.bytes;
          void this.refreshKept();
          this.changed();
        },
        (e: Error) => {
          this.state = "failed";
          this.error = e.message;
          this.progress = undefined;
          this.loaded = undefined;
          this.worker?.terminate();
          this.worker = undefined;
          this.changed();
          throw e;
        },
      );
    }
    return this.loaded;
  }

  private async ready(request: Pick<QuickSelectRequest, "progress">, signal: AbortSignal): Promise<void> {
    if (this.state !== "ready") {
      const mb = (this.bytes / 1e6).toFixed(0);
      request.progress?.(this.kept > 0 ? `Loading ${MEDSAM2.name} (kept in this browser)…` : `Downloading ${MEDSAM2.name} (${mb} MB, ${MEDSAM2.licence}) once; it is kept in this browser…`, 0);
    }
    await this.load((loaded, total) => request.progress?.(`Downloading ${MEDSAM2.name}: ${(loaded / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB (${MEDSAM2.licence})…`, loaded / total));
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  }

  /** A section of the crop read, windowed and encoded (unless the worker still has it); its key. */
  private async encodeSection(t: Pick<Track, "image" | "axis" | "crop" | "window">, index: number, read: NonNullable<QuickSelectRequest["read"]>, signal: AbortSignal): Promise<string> {
    const key = `${t.image}|${t.axis}/${index}|${t.crop.lo.join(",")}|${t.crop.size.join(",")}|${t.window.join(",")}`;
    if ((await this.call({ op: "has", key })).has) return key;
    const box = cropBox({ ...t.crop, index });
    const block = await read(box.lo, box.hi, signal);
    if (block === undefined) throw new Error("Could not read the image there.");
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const image = medsam2Image(block, { ...t.crop, index }, t.window, PIXEL);
    const r = await this.call({ op: "encode", key, image }, [image.buffer]);
    this.encodeMs = r.ms;
    return key;
  }

  /** The section's mask for the request's prompts (and the track it starts, for Spread). */
  async segment(request: Omit<QuickSelectRequest, "image">, signal: AbortSignal): Promise<Mask> {
    const { axis, read, source } = request;
    if (axis === undefined) throw new Error("MedSAM2 works in a 2-D view: draw a box or click there.");
    if (read === undefined || source === undefined) throw new Error("MedSAM2 needs the image's values: choose an image under “Image values”.");
    const [ua, wa] = sectionAxes(axis);
    const given = request.prompts ?? (request.prompt.kind === "box" ? { box: { lo: request.prompt.lo, hi: request.prompt.hi }, points: [] } : { points: [{ at: request.prompt.at, positive: true }] });
    const index = given.box ? given.box.lo[axis] : Math.round(given.points[0].at[axis]);
    const prompt = {
      box: given.box && { lo: [given.box.lo[ua], given.box.lo[wa]] as [number, number], hi: [given.box.hi[ua], given.box.hi[wa]] as [number, number] },
      points: given.points.map((p) => ({ u: Math.round(p.at[ua]), w: Math.round(p.at[wa]), positive: p.positive })),
    };
    const us = [...(prompt.box ? [prompt.box.lo[0], prompt.box.hi[0] - 1] : []), ...prompt.points.map((p) => p.u)];
    const ws = [...(prompt.box ? [prompt.box.lo[1], prompt.box.hi[1] - 1] : []), ...prompt.points.map((p) => p.w)];
    const lo: [number, number] = [Math.min(...us), Math.min(...ws)];
    const hi: [number, number] = [Math.max(...us) + 1, Math.max(...ws) + 1];
    // Room round the prompt for the object to move into from section to section.
    const crop = cropFor(axis, index, lo, hi, { context: request.context ?? 256, margin: 2, spacing: [source.spacing[ua], source.spacing[wa]], extent: [source.size[ua], source.size[wa]] });
    await this.ready(request, signal);
    let window = source.window;
    if (window === undefined) {
      const box = cropBox(crop);
      const block = await read(box.lo, box.hi, signal);
      if (block === undefined) throw new Error("Could not read the image there.");
      window = quantileWindow(block.data);
    }
    const t = { image: source.key, axis, crop, window };
    request.progress?.("Computing the section's features…");
    const key = await this.encodeSection(t, index, read, signal);
    request.progress?.("Computing the mask…");
    const tensors = medsam2Prompt(crop, prompt);
    const r = await this.call({ op: "condition", key, index, coords: tensors.coords.slice(), labels: tensors.labels.slice(), frames: source.size[axis] });
    this.decodeMs = r.ms;
    this.track = { ...t, key, index, prompt: JSON.stringify(given), tensors };
    this.changed();
    const mask = maskOnGrid(r.mask!, crop, source.size, { size: MEDSAM2_SIZE, low: MEDSAM2_LOW });
    return keepParts(mask, given.points.filter((p) => p.positive).map((p) => p.at));
  }

  /**
   * The masks of up to `count` sections each way from the prompted one, tracked from its prompt (the section's
   * own mask not among them); a direction ends where the object is gone.
   */
  async propagate(request: Omit<QuickSelectRequest, "image">, count: number, signal: AbortSignal): Promise<Mask[]> {
    const { read, source, axis } = request;
    if (axis === undefined || read === undefined || source === undefined) throw new Error("MedSAM2 tracks from a prompt in a 2-D view, with an image chosen under “Image values”.");
    const given = JSON.stringify(request.prompts ?? (request.prompt.kind === "box" ? { box: { lo: request.prompt.lo, hi: request.prompt.hi }, points: [] } : { points: [{ at: request.prompt.at, positive: true }] }));
    // The track the prompt started, else started again (another prompt came since, or the model was let go).
    if (this.track === undefined || this.track.prompt !== given || this.track.image !== source.key || this.track.axis !== axis) await this.segment(request, signal);
    else await this.ready(request, signal);
    const t = this.track!;
    const masks: Mask[] = [];
    const n = source.size[axis];
    let done = 0;
    for (const reverse of [false, true]) {
      // The prompted section conditioned again, so each direction starts from the prompt alone (as MedSAM2's 3-D inference does).
      await this.encodeSection(t, t.index, read, signal);
      await this.call({ op: "condition", key: t.key, index: t.index, coords: t.tensors.coords.slice(), labels: t.tensors.labels.slice(), frames: n });
      await this.call({ op: "begin", reverse });
      for (let k = 1; k <= count; ++k) {
        const f = t.index + (reverse ? -k : k);
        if (f < 0 || f >= n) break;
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        ++done;
        request.progress?.(`Tracking: section ${f} (${done} of up to ${2 * count})…`, done / (2 * count));
        const key = await this.encodeSection(t, f, read, signal);
        const r = await this.call({ op: "step", f, key });
        this.decodeMs = r.ms;
        this.changed();
        if (!(r.score! > 0)) break;
        const mask = maskOnGrid(r.mask!, { ...t.crop, index: f }, source.size, { size: MEDSAM2_SIZE, low: MEDSAM2_LOW });
        if (!mask.data.some((v) => v)) break;
        masks.push(mask);
      }
    }
    return masks;
  }
}

/** The method, for the quick-select registry. */
export function medsam2Method(model: MedSam2Model): QuickSelectMethod {
  return {
    id: MEDSAM2.id,
    title: `AI 3-D (${MEDSAM2.name})`,
    description: `${MEDSAM2.name} (${MEDSAM2.licence}), run in this page: a box (or clicks: Shift or Alt for what is not wanted) in a 2-D view segments its section; Spread then tracks it through the next sections, as MedSAM2 tracks an organ through a scan. About ${(MEDSAM2.bytes / 1e6).toFixed(0)} MB, downloaded on first use and kept in this browser.`,
    prompts: ["box", "point"],
    refines: true,
    run: (request, signal) => model.segment(request, signal),
    propagate: (request, count, signal) => model.propagate(request, count, signal),
  };
}
