/**
 * The worker running MedSAM2 (./medsam2_model.ts): ONNX Runtime Web from
 * its pinned URL, on WebGPU when the browser has a GPU adapter and the
 * graphs build there, else on WebAssembly (threads when the page is
 * cross-origin isolated). The model's files (manifest.json beside them
 * lists them and their sizes) are downloaded on first use and kept in the
 * browser's Cache Storage. Sections' features are kept here (the last few),
 * and the track (./medsam2.ts `Tracker`) lives here, so a step sends a
 * section's image and gets its mask back.
 *
 * Calls run one at a time, in order (ORT's WebGPU build allows one
 * suspended call per instance).
 */
/// <reference lib="webworker" />
import { type Features, type MedSam2Constants, Tracker } from "./medsam2.js";
import { encode, type MedSam2Sessions, type OrtModule, type OrtSession, ortGraphs } from "./medsam2_graphs.js";
import { fetchKept } from "./model_files.js";

interface Ort extends OrtModule {
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
  InferenceSession: { create(bytes: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel?: string }): Promise<OrtSession> };
}

/** manifest.json: each graph's file and size, and the constants'. */
export interface MedSam2Manifest {
  version: string;
  files: Record<"encoder" | "attention" | "heads" | "memoryEncoder" | "constants", { name: string; bytes: number }>;
}

export type MedSam2Request =
  | { id: number; op: "load"; ort: string; provider: "auto" | "webgpu" | "wasm"; cache: string; base: string }
  | { id: number; op: "encode"; key: string; image: Float32Array }
  | { id: number; op: "has"; key: string }
  | { id: number; op: "condition"; key: string; index: number; coords: Float32Array; labels: Int32Array; frames: number }
  | { id: number; op: "begin"; reverse: boolean }
  | { id: number; op: "step"; f: number; key: string }
  | { id: number; op: "forget" };

export type MedSam2Reply =
  | { id: number; op: "progress"; loaded: number; total: number }
  | { id: number; ok: true; provider?: string; threads?: number; bytes?: number; ms?: number; mask?: Float32Array; score?: number; has?: boolean }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let ort: Ort | undefined;
let sessions: MedSam2Sessions | undefined;
let constants: MedSam2Constants | undefined;
let provider = "";
let threads = 1;
let tracker: Tracker | undefined;
/** Sections' features by key, the last used last: about 3.5 MB each. */
const features = new Map<string, Features>();
const KEEP = 8;

let turn: Promise<unknown> = Promise.resolve();
scope.onmessage = (e: MessageEvent<MedSam2Request>) => {
  const r = e.data;
  turn = turn.then(() => handle(r)).catch(() => {});
};

function post(reply: MedSam2Reply, transfer: Transferable[] = []): void {
  scope.postMessage(reply, transfer);
}

function featuresOf(key: string): Features {
  const f = features.get(key);
  if (f === undefined) throw new Error("The section's features were let go: encode it again.");
  features.delete(key);
  features.set(key, f);
  return f;
}

async function handle(r: MedSam2Request): Promise<void> {
  try {
    switch (r.op) {
      case "load": {
        const bytes = await load(r);
        post({ id: r.id, ok: true, provider, threads, bytes });
        return;
      }
      case "encode": {
        const t0 = performance.now();
        const f = await encode(ort!, sessions!, r.image);
        features.delete(r.key);
        features.set(r.key, f);
        while (features.size > KEEP) features.delete(features.keys().next().value!);
        post({ id: r.id, ok: true, ms: performance.now() - t0 });
        return;
      }
      case "has":
        post({ id: r.id, ok: true, has: features.has(r.key) });
        return;
      case "condition": {
        const t0 = performance.now();
        tracker = new Tracker(ortGraphs(ort!, sessions!), constants!, r.frames);
        const out = await tracker.condition(r.index, featuresOf(r.key), r.coords, r.labels);
        // A copy sent (the tracker keeps its own: the prompted section's memory is made from it later).
        const mask = out.mask.slice();
        post({ id: r.id, ok: true, mask, score: out.score, ms: performance.now() - t0 }, [mask.buffer]);
        return;
      }
      case "begin":
        if (tracker === undefined) throw new Error("Nothing to track: segment a section first.");
        await tracker.begin(r.reverse);
        post({ id: r.id, ok: true });
        return;
      case "step": {
        if (tracker === undefined) throw new Error("Nothing to track: segment a section first.");
        const t0 = performance.now();
        const out = await tracker.step(r.f, featuresOf(r.key));
        const mask = out.mask.slice();
        post({ id: r.id, ok: true, mask, score: out.score, ms: performance.now() - t0 }, [mask.buffer]);
        return;
      }
      case "forget":
        features.clear();
        tracker = undefined;
        post({ id: r.id, ok: true });
        return;
    }
  } catch (e) {
    post({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** The manifest: from the files' address, else (offline) as kept in the browser. */
async function manifestAt(base: string, cacheName: string): Promise<MedSam2Manifest> {
  const url = new URL("manifest.json", base).href;
  const cache = typeof caches !== "undefined" ? await caches.open(cacheName).catch(() => undefined) : undefined;
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const text = await response.text();
    await cache?.put(url, new Response(text, { headers: { "content-type": "application/json" } })).catch(() => {});
    return JSON.parse(text) as MedSam2Manifest;
  } catch (e) {
    const kept = await cache?.match(url);
    if (kept) return (await kept.json()) as MedSam2Manifest;
    throw new Error(`MedSAM2's files are not at ${base} (${e instanceof Error ? e.message : String(e)}).`);
  }
}

async function load(r: Extract<MedSam2Request, { op: "load" }>): Promise<number> {
  const manifest = await manifestAt(r.base, r.cache);
  const names = ["encoder", "attention", "heads", "memoryEncoder", "constants"] as const;
  const total = names.reduce((n, k) => n + manifest.files[k].bytes, 0);
  if (sessions !== undefined && constants !== undefined) return total;
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
    // Each version's files under their own addresses (manifest.version), so a new version is downloaded, not mixed.
    const url = new URL(file.name, r.base).href + `?v=${encodeURIComponent(manifest.version)}`;
    bytes[k] = await fetchKept(r.cache, { url, bytes: file.bytes }, (loaded) => post({ id: r.id, op: "progress", loaded: base + loaded, total }));
    before += file.bytes;
  }
  constants = JSON.parse(new TextDecoder().decode(bytes.constants)) as MedSam2Constants;
  const o = ort;
  const build = async (providers: string[]): Promise<MedSam2Sessions> => {
    const create = (b: Uint8Array) => o.InferenceSession.create(b, { executionProviders: providers, graphOptimizationLevel: "all" });
    return { encoder: await create(bytes.encoder!), attention: await create(bytes.attention!), heads: await create(bytes.heads!), memoryEncoder: await create(bytes.memoryEncoder!) };
  };
  if (wantGpu) {
    try {
      sessions = await build(["webgpu"]);
      provider = "webgpu";
    } catch {
      sessions = undefined;
    }
  }
  if (sessions === undefined) {
    sessions = await build(["wasm"]);
    provider = "wasm";
  }
  return total;
}
