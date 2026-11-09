/**
 * A context for the panel and session tests: the layers, the plugin's
 * state and settings, and paired computers each running a stand-in render
 * service that records what it is asked.  Only what the plugin uses.
 */
import { vi } from "vitest";
import type { Drawer3d, Frame3d, LayerInfo, PlatformContext } from "@ngplatform/sdk";
import type { SourceAxes } from "../view.js";

/** A request a stand-in service was sent. */
export interface Request {
  host: string;
  method: string;
  path: string;
  keepalive: boolean;
  body?: unknown;
}

/** A stand-in render service: answers the plugin's requests and records them. */
export class FakeService {
  readonly requests: Request[] = [];
  private sessions = 0;
  private versions = 0;
  /** Jobs it knows: id to what GET answers (the status and progress), and whether DELETE was asked. */
  readonly jobs = new Map<string, Record<string, unknown>>();
  /** The answer to GET /info: a host without the render service fails. */
  up = true;

  constructor(readonly host: string) {}

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ host: this.host, method, path, keepalive: init.keepalive === true, body });
    const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));
    const p = path.replace(/^render/, "").replace(/\?.*$/, "");
    if (!this.up) return Promise.reject(new Error("not answering"));
    if (p === "/info") return json({ service: "render", version: "test", gpu: { backend: "cuda", name: "Test GPU", free_mb: 4096, total_mb: 8192 }, presets: ["HiP-CT brain"], ffmpeg: true });
    if (p === "/presets") return json([{ name: "HiP-CT brain", modality: "HiP-CT", description: "", density: 40 }]);
    if (p === "/sessions" && method === "POST") {
      const id = `${this.host}-s${++this.sessions}`;
      return json({ id, status: "ready", progress: 1, message: "level 0 (10 × 10 × 10)", error: null, volume: { lo: 0, hi: 255, dtype: "uint8" }, labels: null, samples: 0, ms_per_pass: 0 });
    }
    if (/^\/sessions\/[^/]+$/.test(p) && method === "DELETE") return json({});
    if (/^\/sessions\/[^/]+\/view$/.test(p)) return json({ version: ++this.versions });
    if (/^\/sessions\/[^/]+\/resolve$/.test(p)) return json({}, 404);
    if (/^\/sessions\/[^/]+\/frame$/.test(p)) {
      // A long poll that ends only when the page stops asking.
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    const job = /^\/(stills|movies|splats)\/([^/]+)$/.exec(p);
    if (job) {
      const j = this.jobs.get(job[2]);
      if (j === undefined) return json({ error: "no such job" }, 404);
      if (method === "DELETE") j.status = "cancelled";
      return json(j);
    }
    const start = /^\/sessions\/[^/]+\/(stills|movies|splats)$/.exec(p);
    if (start) {
      const id = `${start[1]}-${this.jobs.size + 1}`;
      const j = { id, status: "running", progress: 0.25, message: "frame 1", error: null, file: null, folder: "", files: [], result: null };
      this.jobs.set(id, j);
      return json(j);
    }
    return json({ error: `not found: ${path}` }, 404);
  }

  /** The requests of a method to paths matching `pattern`. */
  asked(method: string, pattern: RegExp): Request[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }
}

/** An image layer read from an OME-Zarr store, and its source's axes as Neuroglancer reads them. */
export const IMAGE: LayerInfo = { name: "brain", type: "image", visible: true, sources: ["zarr://https://example.org/brain.ome.zarr/"], ready: true };
export const XYZ: SourceAxes = { names: ["z", "y", "x"], units: ["m", "m", "m"], bounds: { lower: [0, 0, 0], upper: [10, 10, 10] } };

export function fakeContext(options: { layers?: LayerInfo[]; axes?: Record<string, SourceAxes>; state?: unknown; settings?: Map<string, unknown>; hosts?: string[] } = {}) {
  let layers = options.layers ?? [];
  let state: unknown = options.state;
  const axes = options.axes ?? {};
  const settings = options.settings ?? new Map<string, unknown>();
  const services = new Map((options.hosts ?? ["workstation"]).map((h) => [h, new FakeService(h)]));
  const listeners = { layers: new Set<() => void>(), state: new Set<() => void>(), hosts: new Set<() => void>(), cursor: new Set<() => void>() };
  const panels = new Map<string, (host: HTMLElement) => (() => void) | void>();
  const drawers: Drawer3d[] = [];
  const ng: Record<string, unknown> = { position: [0, 0, 0], projectionOrientation: [0, 0, 0, 1], projectionScale: 256, layout: "xy-3d" };
  const invoked: string[] = [];
  const toasts: string[] = [];
  const hostInfo = (name: string) => ({ name, address: `http://${name}:7000`, available: true, info: { hostname: name, platform: "linux", gpus: [], services: { render: { state: "ready" } } } });
  const host = (name: string) => {
    const s = services.get(name);
    return s && { name, address: `http://${name}:7000`, available: () => true, info: () => hostInfo(name), fetch: (path: string, init?: RequestInit) => s.fetch(path, init) };
  };
  const ctx = {
    plugin: { id: "org.ngplatform.anatomical-rendering", version: "test", manifest: {} },
    commands: {
      register: () => () => undefined,
      invoke: async (id: string) => void invoked.push(id),
    },
    ui: {
      panel: (id: string, render: (host: HTMLElement) => (() => void) | void) => (panels.set(id, render), () => panels.delete(id)),
      viewToggle: () => ({ set: vi.fn(), dispose: vi.fn() }),
      toast: (message: string) => void toasts.push(message),
      confirm: async () => true,
      sheet: vi.fn(() => () => undefined),
    },
    viewer: {
      layers: () => layers,
      onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
      onCursorChanged: (f: () => void) => (listeners.cursor.add(f), () => listeners.cursor.delete(f)),
      cursor: () => ({ active: false, position: [], names: [], units: [], values: {} }),
      getState: () => ng,
      patchState: (edit: (ng: unknown) => void) => edit(ng),
      layerTransform: (name: string) => (axes[name] ? { rank: axes[name].names.length, input: axes[name], output: axes[name], matrix: new Float64Array(), defaultMatrix: new Float64Array() } : undefined),
      draw3d: (_layer: string, drawer: Drawer3d) => {
        drawers.push(drawer);
        return { redraw: () => undefined, dispose: () => undefined };
      },
    },
    state: {
      get: () => state,
      set: (v: unknown) => ((state = v), listeners.state.forEach((f) => f())),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    settings: {
      get: (k: string) => settings.get(k),
      set: (k: string, v: unknown) => void settings.set(k, structuredClone(v)),
    },
    hosts: {
      list: () => [...services.keys()].map(hostInfo),
      onChanged: (f: () => void) => (listeners.hosts.add(f), () => listeners.hosts.delete(f)),
      get: (name: string) => host(name),
      pick: () => {
        const first = [...services.keys()][0];
        return first === undefined ? undefined : host(first);
      },
    },
    jobs: { run: async <T>(_title: string, work: (c: { progress: () => void; cancelled: boolean }) => Promise<T>) => work({ progress: () => undefined, cancelled: false }) },
    log: { info: vi.fn(), error: vi.fn() },
    subscriptions: [] as (() => void)[],
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    services,
    panels,
    drawers,
    ng,
    invoked,
    toasts,
    settings,
    listeners: () => Object.values(listeners).reduce((n, l) => n + l.size, 0),
    state: () => state,
    setLayers(next: LayerInfo[]) {
      layers = next;
      listeners.layers.forEach((f) => f());
    },
  };
}

/** A frame of the 3-D view as Neuroglancer gives a drawer (no GL: the drawer has no picture yet, so it only reads the camera). */
export function frame3d(options: { moving?: boolean; turn?: number } = {}): Frame3d {
  const inv = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -0.1, options.turn ?? 0, 0, 0, 1]);
  return {
    gl: undefined as unknown as WebGL2RenderingContext,
    viewProjection: inv,
    invViewProjection: inv,
    dimensions: { names: ["x", "y", "z"], scales: [1e-3, 1e-3, 1e-3], units: ["m", "m", "m"] },
    position: [0, 0, 0],
    width: 800,
    height: 600,
    outputs: { color: 0, z: 1, pick: 2 },
    moving: options.moving === true,
  };
}
