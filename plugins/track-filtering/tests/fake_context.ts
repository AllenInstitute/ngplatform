/**
 * A context for TrackGroups without a viewer or workers: one Zarr Vectors
 * tractogram (six streamlines, a length each), the plugin's state, the
 * viewer's state as a plain object, files on this computer, and a region
 * reader whose answers the test gives, when it chooses.
 */
import { vi } from "vitest";
import type { Json, LayerInfo, PlatformContext, RunnerJob, SegmentProperties } from "@ngplatform/sdk";
import type { LabelsEngine } from "../labels_client.js";
import type { Engines, Saved } from "../plugin.js";
import type { RoiGeometry } from "../roi.js";
import type { Curves, RoiEngine, RoiResult, StoreInfo } from "../roi_client.js";

/** The tractogram: a store on this computer, so its groups can be written into it. */
export const STORE = "http://127.0.0.1:4180/local/d1/tracts.zarr/";
export const SOURCE = `${STORE}|zarr-vectors:`;

export const INFO: StoreInfo = {
  axisNames: ["x", "y", "z"],
  axisUnits: ["m", "m", "m"],
  axisScales: [1e-3, 1e-3, 1e-3],
  coordinateOffset: undefined,
  bounds: { lower: [-50, -50, -50], upper: [50, 50, 50] },
  levels: [
    { index: 0, vertexCount: 600, chunkShape: [32, 32, 32] },
    { index: 1, vertexCount: 60, chunkShape: [64, 64, 64] },
  ],
  geometry: "streamline",
  objects: true,
};

/** A promise and what settles it. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** Streamlines along x through each id's own y, two points each, for a `curves` answer. */
export function curvesOf(ids: BigUint64Array, level = 0): Curves {
  const offsets = Uint32Array.from({ length: ids.length + 1 }, (_, i) => 2 * i);
  const positions = new Float32Array(6 * ids.length);
  ids.forEach((id, i) => positions.set([-10, Number(id), 0, 10, Number(id), 0], 6 * i));
  return { ids, offsets, positions, level, ms: 1 };
}

/** The region reader: every request waits until the test answers it. */
export class FakeRoiEngine {
  readonly ready: Promise<StoreInfo>;
  direct = undefined;
  readonly evaluations: { geometry: RoiGeometry; level: number; answer(ids: bigint[]): void; fail(e: Error): void }[] = [];
  readonly reads: { ids: BigUint64Array; level: number; signal?: AbortSignal; progress?: (done: number, total: number) => void; answer(curves?: Curves): void }[] = [];
  disposed = false;

  constructor(info: StoreInfo = INFO) {
    this.ready = Promise.resolve(info);
  }

  evaluate(geometry: RoiGeometry, level: number): Promise<RoiResult> {
    const d = deferred<RoiResult>();
    this.evaluations.push({
      geometry,
      level,
      answer: (ids) => d.resolve({ ids: BigUint64Array.from(ids), level, chunks: 1, bytes: 0, ms: 1 }),
      fail: (e) => d.reject(e),
    });
    return d.promise;
  }

  curves(ids: BigUint64Array, level: number, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Curves> {
    const d = deferred<Curves>();
    // As the worker does: a cancelled read stops, and says so.
    signal?.addEventListener("abort", () => d.reject(new DOMException("Aborted", "AbortError")));
    this.reads.push({ ids, level, signal, progress, answer: (curves) => d.resolve(curves ?? curvesOf(ids, level)) });
    return d.promise;
  }

  async objectIds(segmentIds: BigUint64Array): Promise<{ objectIds: BigUint64Array; missing: number }> {
    return { objectIds: segmentIds, missing: 0 };
  }

  async groups(): Promise<{ names: string[]; members: BigUint64Array[]; levelPath: string }> {
    return { names: [], members: [], levelPath: "0" };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Six streamlines, ids 0–5, lengths 10–60; tags when asked for (0, 2, 4 are "left"; 3 is "short"). */
export function properties(withTags = false): SegmentProperties {
  return {
    ids: BigUint64Array.from([0n, 1n, 2n, 3n, 4n, 5n]),
    numeric: [{ id: "length", description: "Streamline length, mm", values: Float32Array.from([10, 20, 30, 40, 50, 60]), min: 10, max: 60 }],
    tags: withTags ? { names: ["left", "short"], descriptions: ["Left hemisphere", ""], values: ["\u0000", "", "\u0000", "\u0001", "\u0000", ""] } : undefined,
  };
}

export interface World {
  ctx: PlatformContext;
  engines: Engines;
  /** The region readers made, newest last. */
  readers: FakeRoiEngine[];
  /** Every value the plugin wrote into its state. */
  writes: Saved[];
  ng: Json;
  toasts: { message: string; kind?: string }[];
  /** Files opened in the page (a group's own store, a density map) and let go. */
  opened: File[];
  openAnswers: Deferred<{ source: string; name: string; kind: string }[]>[];
  closed: string[];
  datasets: unknown[];
  /** Layers the visible segments were set for, last value each. */
  visible: Map<string, BigUint64Array>;
  addLayer: ReturnType<typeof vi.fn>;
  jobs: { kind: string; args: Record<string, unknown> }[];
  setState(saved: unknown): void;
  /** Tells the plugin a layer's segment properties changed (a layer replaced: undo). */
  propertiesChanged(layer: string): void;
}

/**
 * A world with the tractogram open (layer "tracts") and `saved` as the
 * plugin's state; groups with a `layer` get that layer.  `open` answers
 * opening a file in the page at once, unless `holdOpens`; `data: false`
 * is a scene with nothing to filter.
 */
export function world(saved: Partial<Saved> = {}, options: { tags?: boolean; holdOpens?: boolean; runner?: boolean; data?: boolean } = {}): World {
  let state: unknown = { groups: [], ...saved };
  const writes: Saved[] = [];
  const listeners = { state: new Set<() => void>(), workspace: new Set<() => void>(), viewer: new Set<() => void>(), runner: new Set<() => void>() };
  const propsListeners = new Map<string, Set<() => void>>();
  const groupLayers = (saved.groups ?? []).filter((g) => g.layer !== undefined).map((g) => ({ name: g.layer!, type: "segmentation", source: { url: SOURCE, subsources: { objects: false, meshes: false } } }));
  const ng: Json = {
    dimensions: { x: [1e-3, "m"], y: [1e-3, "m"], z: [1e-3, "m"] },
    position: [0, 0, 0],
    crossSectionScale: 0.1,
    layers: [{ name: "tracts", type: "segmentation", source: SOURCE }, ...groupLayers],
  };
  const specs = () => ng.layers as Json[];
  const sourceOf = (spec: Json) => {
    const s = spec.source as unknown;
    const first = Array.isArray(s) ? s[0] : s;
    return typeof first === "string" ? first : String((first as { url?: string }).url ?? "");
  };
  const layers = (): LayerInfo[] => specs().map((l) => ({ name: String(l.name), type: String(l.type), visible: l.visible !== false, sources: [sourceOf(l)], ready: true, dataset: "d1" }));
  const props = properties(options.tags);
  const readers: FakeRoiEngine[] = [];
  const engines: Engines = {
    roi: () => {
      const reader = new FakeRoiEngine();
      readers.push(reader);
      return reader as unknown as RoiEngine;
    },
    labels: () => ({ dispose() {} }) as unknown as LabelsEngine,
  };
  const toasts: World["toasts"] = [];
  const opened: File[] = [];
  const openAnswers: World["openAnswers"] = [];
  const closed: string[] = [];
  const datasets: unknown[] = [];
  const visible = new Map<string, BigUint64Array>();
  const jobs: World["jobs"] = [];
  let derived = 0;
  const notifyViewer = () => listeners.viewer.forEach((f) => f());
  const addLayer = vi.fn((_dataset: string, spec: Json) => {
    let name = String(spec.name);
    const taken = new Set(specs().map((l) => l.name));
    for (let k = 2; taken.has(name); ++k) name = `${spec.name} ${k}`;
    specs().push({ ...spec, name });
    queueMicrotask(() => listeners.workspace.forEach((f) => f()));
    return name;
  });
  const ctx = {
    state: {
      get: () => state,
      set: (value: unknown) => {
        state = value;
        writes.push(JSON.parse(JSON.stringify(value)));
        listeners.state.forEach((f) => f());
      },
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    workspace: {
      sceneDatasets: () => (options.data === false ? [] : [{ id: "d1", name: "tracts", source: SOURCE, kind: "segmentation", visible: true, layers: layers() }]),
      selectedDataset: () => undefined,
      addLayer,
      removeLayer: (name: string) => {
        ng.layers = specs().filter((l) => l.name !== name);
      },
      renameLayer: (name: string, to: string) => {
        const spec = specs().find((l) => l.name === name);
        if (spec !== undefined) spec.name = to;
        return to;
      },
      addDataset: (d: unknown) => void datasets.push(d),
      onChanged: (f: () => void) => (listeners.workspace.add(f), () => listeners.workspace.delete(f)),
      local: {
        locate: (url: string) => (url.startsWith(STORE) ? { writable: true } : undefined),
        write: vi.fn(async () => {}),
        open: (file: File) => {
          opened.push(file);
          const answer = deferred<{ source: string; name: string; kind: string }[]>();
          openAnswers.push(answer);
          if (!options.holdOpens) answer.resolve([{ source: `http://127.0.0.1:4180/local/derived-${++derived}/${file.name}`, name: file.name, kind: "segmentation" }]);
          return answer.promise;
        },
        close: (source: string) => void closed.push(source),
        send: () => Promise.reject(new Error("not a file")),
        sourceFile: async () => undefined,
      },
    },
    viewer: {
      getState: () => ng,
      layers,
      layerSpec: (name: string) => specs().find((l) => l.name === name),
      patchState: (edit: (ng: Json) => void) => {
        edit(ng);
        notifyViewer();
      },
      onStateChanged: (f: () => void) => (listeners.viewer.add(f), () => listeners.viewer.delete(f)),
      onLayersChanged: () => () => {},
      segmentProperties: (name: string) => (name === "tracts" ? props : undefined),
      onSegmentPropertiesChanged: (name: string, f: () => void) => {
        const set = propsListeners.get(name) ?? new Set();
        propsListeners.set(name, set);
        set.add(f);
        return () => set.delete(f);
      },
      setTemporaryVisibleSegments: (layer: string, ids: BigUint64Array) => void visible.set(layer, ids),
      setLayerVisible: (name: string, shown: boolean) => {
        const spec = specs().find((l) => l.name === name);
        if (spec !== undefined) spec.visible = shown;
      },
      cursor: () => ({ active: false, position: [], names: [], units: [], values: {} }),
      layerTransform: () => undefined,
      setPosition: vi.fn(),
    },
    runner: {
      onChanged: (f: () => void) => (listeners.runner.add(f), () => listeners.runner.delete(f)),
      available: () => options.runner === true,
      pathOf: async () => "/data/tracts.zarr",
      start: async (kind: string, args: Record<string, unknown>): Promise<RunnerJob> => {
        jobs.push({ kind, args });
        return { id: "j1", kind, title: "Filter tracts.zarr", state: "running", created: 0, started: 0, finished: null, progress: null, message: "", outputs: [], pid: 1 } as unknown as RunnerJob;
      },
      wait: () => new Promise<RunnerJob>(() => {}),
    },
    ui: {
      panel: () => () => {},
      showPanel: () => {},
      toast: (message: string, kind?: string) => void toasts.push({ message, kind }),
      form: async (_title: string, _schema: unknown, initial: unknown) => initial,
    },
    log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    commands: { invoke: vi.fn(async () => {}) },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    engines,
    readers,
    writes,
    ng,
    toasts,
    opened,
    openAnswers,
    closed,
    datasets,
    visible,
    addLayer,
    jobs,
    setState(next) {
      state = next;
      listeners.state.forEach((f) => f());
    },
    propertiesChanged(layer) {
      propsListeners.get(layer)?.forEach((f) => f());
    },
  };
}

/** A group of the tractogram with one sphere, shown as layer "Group 1". */
export function sphereGroup(id = "g1", name = "Group 1") {
  return {
    id,
    name,
    colour: "#e4572e",
    rois: [{ id: `${id}r`, shape: "sphere" as const, center: [0, 0, 0] as [number, number, number], radius: 5, size: [10, 10, 10] as [number, number, number], op: "and" as const }],
    filter: { ranges: {}, includeTags: [], excludeTags: [] },
    layer: name,
    source: STORE.replace(/\/$/, ""),
  };
}
