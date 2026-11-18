/**
 * The worker running quick select's model (./sam_model.ts): ONNX Runtime
 * Web, loaded from its pinned URL, on WebGPU when the browser has a GPU
 * adapter and the model's sessions build there, else on WebAssembly (with
 * threads when the page is cross-origin isolated, else one).  The model's
 * files are downloaded on first use and kept in the browser's Cache
 * Storage; each section's image embedding is kept here (the last few), so
 * a second prompt on a section runs the decoder alone.
 *
 * Calls run one at a time, in order (as chunkmirage's `exclusive` in
 * vendor/chunkmirage/web/src/onnx.ts: ORT's WebGPU build allows one
 * suspended call per instance).
 */
/// <reference lib="webworker" />
import { fetchKept, type ModelFile } from "./model_files.js";

export type { ModelFile };

// The part of onnxruntime-web's interface used here (the package is loaded from its URL, not installed).
interface Tensor {
  data: ArrayLike<number>;
  dims: readonly number[];
}
interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}
interface Ort {
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => Tensor;
  InferenceSession: { create(bytes: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel?: string }): Promise<Session> };
}


export type SamRequest =
  | { id: number; op: "load"; ort: string; provider: "auto" | "webgpu" | "wasm"; cache: string; encoder: ModelFile; decoder: ModelFile }
  | { id: number; op: "encode"; key: string; image: Float32Array; size: number }
  | { id: number; op: "decode"; key: string; coords: Float32Array; labels: Float32Array; size: number }
  | { id: number; op: "forget" };

export type SamReply =
  | { id: number; op: "progress"; loaded: number; total: number; what: string }
  | { id: number; ok: true; provider?: string; threads?: number; ms?: number; lowRes?: Float32Array; low?: number; iou?: number; has?: boolean }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let ort: Ort | undefined;
let encoder: Session | undefined;
let decoder: Session | undefined;
let provider = "";
let threads = 1;
/** Embeddings by key, the last used last; about 4 MB each. */
const embeddings = new Map<string, Tensor>();
const KEEP = 12;

let turn: Promise<unknown> = Promise.resolve();

scope.onmessage = (e: MessageEvent<SamRequest>) => {
  const r = e.data;
  turn = turn.then(() => handle(r)).catch(() => {});
};

async function handle(r: SamRequest): Promise<void> {
  try {
    switch (r.op) {
      case "load":
        await load(r);
        post({ id: r.id, ok: true, provider, threads });
        return;
      case "encode": {
        const t0 = performance.now();
        const o = ort!;
        const out = await encoder!.run({ [encoder!.inputNames[0]]: new o.Tensor("float32", r.image, [r.size, r.size, 3]) });
        embeddings.delete(r.key);
        embeddings.set(r.key, out[encoder!.outputNames[0]]);
        while (embeddings.size > KEEP) embeddings.delete(embeddings.keys().next().value!);
        post({ id: r.id, ok: true, ms: performance.now() - t0 });
        return;
      }
      case "decode": {
        const embedding = embeddings.get(r.key);
        if (embedding === undefined) {
          post({ id: r.id, ok: true, has: false });
          return;
        }
        embeddings.delete(r.key);
        embeddings.set(r.key, embedding);
        const o = ort!;
        const n = r.labels.length;
        const t0 = performance.now();
        const out = await decoder!.run({
          image_embeddings: embedding,
          point_coords: new o.Tensor("float32", r.coords, [1, n, 2]),
          point_labels: new o.Tensor("float32", r.labels, [1, n]),
          mask_input: new o.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
          has_mask_input: new o.Tensor("float32", new Float32Array([0]), [1]),
          orig_im_size: new o.Tensor("float32", new Float32Array([r.size, r.size]), [2]),
        });
        const low = out.low_res_masks;
        const lowRes = Float32Array.from(low.data as Float32Array);
        const iou = out.iou_predictions.data[0];
        post({ id: r.id, ok: true, has: true, lowRes, low: low.dims[3], iou, ms: performance.now() - t0 }, [lowRes.buffer]);
        return;
      }
      case "forget":
        embeddings.clear();
        post({ id: r.id, ok: true });
        return;
    }
  } catch (e) {
    post({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function post(reply: SamReply, transfer: Transferable[] = []): void {
  scope.postMessage(reply, transfer);
}

async function load(r: Extract<SamRequest, { op: "load" }>): Promise<void> {
  if (encoder !== undefined && decoder !== undefined) return;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const wantGpu = r.provider !== "wasm" && gpu !== undefined && (await gpu.requestAdapter().catch(() => null)) !== null;
  // The WebGPU build runs the WASM provider too (its asyncify runtime, larger); the WASM build alone is smaller.
  const bundle = wantGpu ? "ort.webgpu.bundle.min.mjs" : "ort.wasm.bundle.min.mjs";
  if (ort === undefined) {
    ort = (await import(/* @vite-ignore */ `${r.ort}${bundle}`)) as Ort;
    ort.env.wasm.wasmPaths = r.ort;
    // Threads need SharedArrayBuffer, so cross-origin isolation; without it, one.
    threads = self.crossOriginIsolated && navigator.hardwareConcurrency ? Math.min(8, navigator.hardwareConcurrency) : 1;
    ort.env.wasm.numThreads = threads;
  }
  const total = r.encoder.bytes + r.decoder.bytes;
  let before = 0;
  const files: Uint8Array[] = [];
  for (const [what, file] of [["encoder", r.encoder], ["decoder", r.decoder]] as const) {
    const base = before;
    files.push(await fetchKept(r.cache, file, (loaded) => post({ id: r.id, op: "progress", loaded: base + loaded, total, what })));
    before += file.bytes;
  }
  const o = ort;
  const create = async (bytes: Uint8Array, providers: string[]) => o.InferenceSession.create(bytes, { executionProviders: providers, graphOptimizationLevel: "all" });
  if (wantGpu) {
    try {
      encoder = await create(files[0], ["webgpu"]);
      decoder = await create(files[1], ["webgpu"]);
      provider = "webgpu";
    } catch {
      encoder = decoder = undefined;
    }
  }
  if (encoder === undefined || decoder === undefined) {
    encoder = await create(files[0], ["wasm"]);
    decoder = await create(files[1], ["wasm"]);
    provider = "wasm";
  }
}
