/**
 * The worker running SAM-Med3D (./sammed3d_model.ts): ONNX Runtime Web from
 * its pinned URL, on WebGPU when the browser has a GPU adapter and the
 * graphs build there, else WebAssembly. The model's files (manifest.json
 * beside them lists them and their sizes) are downloaded on first use and
 * kept in the browser's Cache Storage. A cube's embedding is kept (the last
 * two), and with it the last mask's low-resolution logits, which the next
 * click on that cube refines (as SAM-Med3D's inference feeds them back).
 */
/// <reference lib="webworker" />
import { fetchKept } from "./model_files.js";

interface Tensor {
  data: ArrayLike<number>;
  dims: readonly number[];
}
interface Session {
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}
interface Ort {
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
  Tensor: new (type: "float32" | "int32", data: Float32Array | Int32Array, dims: number[]) => Tensor;
  InferenceSession: { create(bytes: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel?: string }): Promise<Session> };
}

export interface SamMed3dManifest {
  version: string;
  files: Record<"encoder" | "decoder" | "constants", { name: string; bytes: number }>;
}

export type SamMed3dRequest =
  | { id: number; op: "load"; ort: string; provider: "auto" | "webgpu" | "wasm"; cache: string; base: string }
  | { id: number; op: "encode"; key: string; image: Float32Array }
  | { id: number; op: "has"; key: string }
  | { id: number; op: "decode"; key: string; points: Float32Array; labels: Int32Array; refine: boolean };

export type SamMed3dReply =
  | { id: number; op: "progress"; loaded: number; total: number }
  | { id: number; ok: true; provider?: string; threads?: number; bytes?: number; ms?: number; mask?: Float32Array; iou?: number; has?: boolean }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const LOW = 32 * 32 * 32;

let ort: Ort | undefined;
let encoder: Session | undefined;
let decoder: Session | undefined;
let provider = "";
let threads = 1;
/** Cubes' embeddings (384 × 8³) and their last mask's logits, by key, the last used last. */
const cubes = new Map<string, { embedding: Tensor; last?: Float32Array }>();
const KEEP = 2;

let turn: Promise<unknown> = Promise.resolve();
scope.onmessage = (e: MessageEvent<SamMed3dRequest>) => {
  const r = e.data;
  turn = turn.then(() => handle(r)).catch(() => {});
};

function post(reply: SamMed3dReply, transfer: Transferable[] = []): void {
  scope.postMessage(reply, transfer);
}

async function handle(r: SamMed3dRequest): Promise<void> {
  try {
    switch (r.op) {
      case "load": {
        const bytes = await load(r);
        post({ id: r.id, ok: true, provider, threads, bytes });
        return;
      }
      case "encode": {
        const t0 = performance.now();
        const out = await encoder!.run({ image: new ort!.Tensor("float32", r.image, [1, 1, 128, 128, 128]) });
        cubes.delete(r.key);
        cubes.set(r.key, { embedding: out.embedding });
        while (cubes.size > KEEP) cubes.delete(cubes.keys().next().value!);
        post({ id: r.id, ok: true, ms: performance.now() - t0 });
        return;
      }
      case "has":
        post({ id: r.id, ok: true, has: cubes.has(r.key) });
        return;
      case "decode": {
        const cube = cubes.get(r.key);
        if (cube === undefined) throw new Error("The cube's embedding was let go: encode it again.");
        const o = ort!;
        const n = r.labels.length;
        const t0 = performance.now();
        const prev = r.refine && cube.last ? cube.last : new Float32Array(LOW);
        const out = await decoder!.run({
          embedding: cube.embedding,
          points: new o.Tensor("float32", r.points, [1, n, 3]),
          labels: new o.Tensor("int32", r.labels, [1, n]),
          prev_mask: new o.Tensor("float32", prev, [1, 1, 32, 32, 32]),
        });
        const mask = Float32Array.from(out.mask.data as Float32Array);
        cube.last = mask.slice();
        post({ id: r.id, ok: true, mask, iou: (out.iou.data as Float32Array)[0], ms: performance.now() - t0 }, [mask.buffer]);
        return;
      }
    }
  } catch (e) {
    post({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

async function manifestAt(base: string, cacheName: string): Promise<SamMed3dManifest> {
  const url = new URL("manifest.json", base).href;
  const cache = typeof caches !== "undefined" ? await caches.open(cacheName).catch(() => undefined) : undefined;
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const text = await response.text();
    await cache?.put(url, new Response(text, { headers: { "content-type": "application/json" } })).catch(() => {});
    return JSON.parse(text) as SamMed3dManifest;
  } catch (e) {
    const kept = await cache?.match(url);
    if (kept) return (await kept.json()) as SamMed3dManifest;
    throw new Error(`SAM-Med3D's files are not at ${base} (${e instanceof Error ? e.message : String(e)}).`);
  }
}

async function load(r: Extract<SamMed3dRequest, { op: "load" }>): Promise<number> {
  const manifest = await manifestAt(r.base, r.cache);
  const names = ["encoder", "decoder", "constants"] as const;
  const total = names.reduce((n, k) => n + manifest.files[k].bytes, 0);
  if (encoder !== undefined && decoder !== undefined) return total;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const wantGpu = r.provider !== "wasm" && gpu !== undefined && (await gpu.requestAdapter().catch(() => null)) !== null;
  const bundle = wantGpu ? "ort.webgpu.bundle.min.mjs" : "ort.wasm.bundle.min.mjs";
  if (ort === undefined) {
    ort = (await import(/* @vite-ignore */ `${r.ort}${bundle}`)) as Ort;
    ort.env.wasm.wasmPaths = r.ort;
    threads = self.crossOriginIsolated && navigator.hardwareConcurrency ? Math.min(8, navigator.hardwareConcurrency) : 1;
    ort.env.wasm.numThreads = threads;
  }
  const bytes: Partial<Record<(typeof names)[number], Uint8Array>> = {};
  let before = 0;
  for (const k of names) {
    const file = manifest.files[k];
    const base = before;
    const url = new URL(file.name, r.base).href + `?v=${encodeURIComponent(manifest.version)}`;
    bytes[k] = await fetchKept(r.cache, { url, bytes: file.bytes }, (loaded) => post({ id: r.id, op: "progress", loaded: base + loaded, total }));
    before += file.bytes;
  }
  const o = ort;
  const build = async (providers: string[]) => {
    const create = (b: Uint8Array) => o.InferenceSession.create(b, { executionProviders: providers, graphOptimizationLevel: "all" });
    return [await create(bytes.encoder!), await create(bytes.decoder!)] as const;
  };
  if (wantGpu) {
    try {
      [encoder, decoder] = await build(["webgpu"]);
      provider = "webgpu";
    } catch {
      encoder = decoder = undefined;
    }
  }
  if (encoder === undefined || decoder === undefined) {
    [encoder, decoder] = await build(["wasm"]);
    provider = "wasm";
  }
  return total;
}
