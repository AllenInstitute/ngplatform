/**
 * Quick select's model method, "AI (MobileSAM)": MobileSAM (Apache-2.0), a
 * small Segment Anything, run in this page by ONNX Runtime Web in a worker
 * (./sam_worker.ts).
 *
 * - The model's two ONNX files (an image encoder, 28 MB, and SAM's prompt
 *   decoder, 16.5 MB, as published at huggingface.co/Acly/MobileSAM, at a
 *   pinned commit) are downloaded the first time the method runs and kept
 *   in the browser's Cache Storage (`ngplatform-models`); the tab shows
 *   their size, a progress bar while they come, and Forget.
 * - ONNX Runtime Web 1.30.0 (MIT; the version chunkmirage's ONNX stage is
 *   built against, vendor/chunkmirage/web/package.json) is loaded from
 *   jsDelivr at that pinned version when the method first runs, as
 *   Pyodide is, rather than installed: its WASM build (14 MB), or its
 *   WebGPU build (27 MB) when the browser has a GPU adapter.
 * - A prompt in a 2-D view: the section round it (./sam.ts `cropFor`, at
 *   least `context` voxels across) is read on the label grid, windowed as
 *   its layer shows it, resampled to 1024², and encoded once; the encoding
 *   is kept (by image, section, crop and window), so later clicks in that
 *   crop run the decoder alone.  The decoder takes the box and the points
 *   (wanted, or not with Shift or Alt); its mask comes back on the grid,
 *   the parts holding a wanted click kept.
 */
import { cropBox, cropFor, cropServes, keepParts, LOW_RES, maskOnGrid, MODEL_SIZE, modelImage, promptTensors, quantileWindow, sectionAxes, type Crop, type SamPrompt } from "./sam.js";
import type { Mask, QuickSelectMethod, QuickSelectRequest } from "./quick_select.js";
import type { ModelFile, SamReply, SamRequest } from "./sam_worker.js";

export const ORT_VERSION = "1.30.0";
export const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const HF = "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8";

export const MOBILE_SAM = {
  id: "mobilesam",
  name: "MobileSAM",
  licence: "Apache-2.0",
  home: "https://github.com/ChaoningZhang/MobileSAM",
  files: "https://huggingface.co/Acly/MobileSAM",
  encoder: { url: `${HF}/mobile_sam_image_encoder.onnx`, bytes: 28157093 } as ModelFile,
  decoder: { url: `${HF}/sam_mask_decoder_single.onnx`, bytes: 16501323 } as ModelFile,
};
export const MODEL_CACHE = "ngplatform-models";
export const MODEL_BYTES = MOBILE_SAM.encoder.bytes + MOBILE_SAM.decoder.bytes;

export type Provider = "auto" | "webgpu" | "wasm";

/** A request without its id (the call gives it one). */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** The model's files kept in this browser: their bytes (0 for none). */
export async function keptBytes(): Promise<number> {
  if (typeof caches === "undefined") return 0;
  const cache = await caches.open(MODEL_CACHE).catch(() => undefined);
  let n = 0;
  for (const f of [MOBILE_SAM.encoder, MOBILE_SAM.decoder]) {
    const r = await cache?.match(f.url);
    if (r) n += Number(r.headers.get("content-length")) || (await r.clone().blob()).size;
  }
  return n;
}

/** The model as the page has it: its files' state, the runtime it runs on, the last timings. */
export class SamModel {
  /** absent: not in this browser; kept: in it, not loaded; loading: downloading or building; ready; failed. */
  state: "unknown" | "absent" | "kept" | "loading" | "ready" | "failed" = "unknown";
  kept = 0;
  progress: { loaded: number; total: number } | undefined;
  error = "";
  provider: Provider = "auto";
  /** What runs it once loaded: "webgpu" or "wasm", and WASM's threads. */
  running = "";
  threads = 1;
  /** The last image embedding's time and the last mask's (ms). */
  encodeMs: number | undefined;
  decodeMs: number | undefined;
  private worker: Worker | undefined;
  private loaded: Promise<void> | undefined;
  private next = 0;
  private readonly waiting = new Map<number, { resolve(r: SamReply): void; reject(e: Error): void; progress?(loaded: number, total: number): void }>();
  private readonly listeners = new Set<() => void>();
  /** The embeddings the worker keeps (as many as it keeps, the last used last). */
  private embeddings: { key: string; image: string; crop: Crop; window: [number, number] }[] = [];

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

  async refreshKept(): Promise<void> {
    this.kept = await keptBytes().catch(() => 0);
    if (this.state === "unknown" || this.state === "absent" || this.state === "kept") this.state = this.kept >= MODEL_BYTES ? "kept" : "absent";
    this.changed();
  }

  /** Drops the files kept in this browser (and the worker): the next run downloads them again. */
  async forget(): Promise<void> {
    this.stop();
    if (typeof caches !== "undefined") await caches.delete(MODEL_CACHE).catch(() => false);
    this.state = "unknown";
    await this.refreshKept();
  }

  /** Runs on another provider from the next prompt (the worker starts again). */
  setProvider(provider: Provider): void {
    if (provider === this.provider) return;
    this.provider = provider;
    this.stop();
    this.state = this.kept >= MODEL_BYTES ? "kept" : "absent";
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
    this.embeddings = [];
    this.running = "";
    for (const w of this.waiting.values()) w.reject(new Error("The model was stopped."));
    this.waiting.clear();
  }

  private call(request: WithoutId<SamRequest>, transfer: Transferable[] = [], progress?: (loaded: number, total: number) => void): Promise<SamReply> {
    if (this.worker === undefined) {
      this.worker = new Worker(new URL("./sam_worker.ts", import.meta.url), { type: "module", name: "quick select model" });
      this.worker.onmessage = (e: MessageEvent<SamReply>) => {
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
        for (const w of this.waiting.values()) w.reject(new Error(e.message || "The model's worker failed."));
        this.waiting.clear();
      };
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, progress });
      this.worker!.postMessage({ ...request, id }, transfer);
    });
  }

  /** The model loaded in the worker: downloaded (or read from the browser), its sessions built. */
  load(progress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.loaded === undefined) {
      this.state = "loading";
      this.error = "";
      this.changed();
      let told = 0;
      this.loaded = this.call({ op: "load", ort: ORT_URL, provider: this.provider, cache: MODEL_CACHE, encoder: MOBILE_SAM.encoder, decoder: MOBILE_SAM.decoder }, [], (loaded, total) => {
        this.progress = { loaded, total };
        // The bar moves in steps of 1 %, not each block.
        if (loaded - told >= total / 100 || loaded === total) {
          told = loaded;
          progress?.(loaded, total);
          this.changed();
        }
      }).then(
        (r) => {
          this.state = "ready";
          this.progress = undefined;
          if ("provider" in r) {
            this.running = r.provider ?? "";
            this.threads = r.threads ?? 1;
          }
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

  /** A mask for `prompt` in a section of the image; `progress` hears what takes a while. */
  async segment(request: QuickSelectRequest, signal: AbortSignal): Promise<Mask> {
    const { axis, read, source } = request;
    if (axis === undefined) throw new Error("AI quick select works in a 2-D view: draw a box or click there.");
    if (read === undefined || source === undefined) throw new Error("AI quick select needs the image's values: choose an image under “Image values”.");
    const [ua, wa] = sectionAxes(axis);
    const given = request.prompts ?? (request.prompt.kind === "box" ? { box: { lo: request.prompt.lo, hi: request.prompt.hi }, points: [] } : { points: [{ at: request.prompt.at, positive: true }] });
    const index = given.box ? given.box.lo[axis] : Math.round(given.points[0].at[axis]);
    const prompt: SamPrompt = {
      box: given.box && { lo: [given.box.lo[ua], given.box.lo[wa]], hi: [given.box.hi[ua], given.box.hi[wa]] },
      points: given.points.map((p) => ({ u: Math.round(p.at[ua]), w: Math.round(p.at[wa]), positive: p.positive })),
    };
    // What the prompt spans in the section (u, w; hi exclusive).
    const us = [...(prompt.box ? [prompt.box.lo[0], prompt.box.hi[0] - 1] : []), ...prompt.points.map((p) => p.u)];
    const ws = [...(prompt.box ? [prompt.box.lo[1], prompt.box.hi[1] - 1] : []), ...prompt.points.map((p) => p.w)];
    const lo: [number, number] = [Math.min(...us), Math.min(...ws)];
    const hi: [number, number] = [Math.max(...us) + 1, Math.max(...ws) + 1];
    const spacing: [number, number] = [source.spacing[ua], source.spacing[wa]];
    const extent: [number, number] = [source.size[ua], source.size[wa]];
    const context = request.context ?? 256;
    const fresh = cropFor(axis, index, lo, hi, { context, spacing, extent });

    if (this.state !== "ready") {
      const mb = (MODEL_BYTES / 1e6).toFixed(1);
      request.progress?.(this.kept >= MODEL_BYTES ? `Loading ${MOBILE_SAM.name} (kept in this browser)…` : `Downloading ${MOBILE_SAM.name} (${mb} MB, ${MOBILE_SAM.licence}) once; it is kept in this browser…`, 0);
    }
    await this.load((loaded, total) => request.progress?.(`Downloading ${MOBILE_SAM.name}: ${(loaded / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB (${MOBILE_SAM.licence})…`, loaded / total));
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");

    // An embedding kept for this image, section and window whose crop holds the prompt well inside, and is not much larger than a fresh one.
    const window = source.window;
    const sameWindow = (w: [number, number]) => window === undefined || (w[0] === window[0] && w[1] === window[1]);
    let kept = [...this.embeddings].reverse().find((e) => e.image === source.key && e.crop.axis === axis && e.crop.index === index && sameWindow(e.window) && cropServes(e.crop, lo, hi) && e.crop.size[0] <= 2 * fresh.size[0]);
    for (let attempt = 0; attempt < 2; ++attempt) {
      if (kept === undefined) {
        kept = await this.embed(fresh, source.key, window, read, request, signal);
      }
      const t = promptTensors(kept.crop, prompt);
      const r = await this.call({ op: "decode", key: kept.key, coords: t.coords, labels: t.labels, size: MODEL_SIZE });
      if (!("has" in r) || !r.has || r.lowRes === undefined) {
        // The worker let it go (or started again): encode it again.
        this.embeddings = this.embeddings.filter((e) => e !== kept);
        kept = undefined;
        continue;
      }
      this.decodeMs = r.ms;
      this.embeddings = [...this.embeddings.filter((e) => e !== kept), kept];
      this.changed();
      // Parts away from every wanted click (another structure alike) are dropped.
      return keepParts(maskOnGrid(r.lowRes, kept.crop, source.size, { low: r.low ?? LOW_RES }), given.points.filter((p) => p.positive).map((p) => p.at));
    }
    throw new Error("The model lost the image's embedding.");
  }

  /** Reads, windows and encodes a crop; the embedding's record. */
  private async embed(crop: Crop, image: string, window: [number, number] | undefined, read: NonNullable<QuickSelectRequest["read"]>, request: QuickSelectRequest, signal: AbortSignal) {
    const box = cropBox(crop);
    const block = await read(box.lo, box.hi, signal);
    if (block === undefined) throw new Error("Could not read the image there.");
    const w = window ?? quantileWindow(block.data);
    request.progress?.("Computing the image's embedding…");
    const input = modelImage(block, crop, w);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const key = `${image}|${crop.axis}/${crop.index}|${crop.lo.join(",")}|${crop.size.join(",")}|${w.join(",")}`;
    const r = await this.call({ op: "encode", key, image: input, size: MODEL_SIZE }, [input.buffer]);
    if ("ms" in r) this.encodeMs = r.ms;
    const record = { key, image, crop, window: w };
    this.embeddings = [...this.embeddings.filter((e) => e.key !== key), record].slice(-12);
    request.progress?.("Computing the mask…");
    return record;
  }
}

/** The method, for the quick-select registry. */
export function samMethod(model: SamModel): QuickSelectMethod {
  return {
    id: MOBILE_SAM.id,
    title: `AI (${MOBILE_SAM.name})`,
    description: `${MOBILE_SAM.name} (${MOBILE_SAM.licence}), run in this page: a box, or clicks on what is wanted (Shift+click or Alt+click: not wanted), in a 2-D view. ${(MODEL_BYTES / 1e6).toFixed(1)} MB, downloaded on first use and kept in this browser.`,
    prompts: ["box", "point"],
    refines: true,
    run: (request, signal) => model.segment(request, signal),
  };
}
