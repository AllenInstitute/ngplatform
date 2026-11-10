/**
 * A context with what the Segmentation editor touches (layers, scenes, a
 * Neuroglancer state that edits apply to, the log), and browser storage in
 * memory: for tests that run the editor itself.
 */
import { vi } from "vitest";
import type { Json, PlatformContext } from "@ngplatform/sdk";

/** Browser storage in memory, as much as keep.ts uses; `full` refuses every write. */
export function memoryStorage(full = false) {
  const files = new Map<string, unknown>();
  const folder = (path: string): unknown => ({
    kind: "directory",
    getDirectoryHandle: async (name: string) => folder(`${path}/${name}`),
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({
        write: async (d: unknown) => {
          if (full) throw new DOMException("full", "QuotaExceededError");
          files.set(`${path}/${name}`, d);
        },
        close: async () => {},
      }),
    }),
    removeEntry: async (name: string) => void files.delete(`${path}/${name}`),
    entries: async function* () {},
  });
  return { files, storage: { getDirectory: async () => folder(""), persist: async () => true, persisted: async () => true, estimate: async () => ({}) } };
}

/** A context with what the editor touches; layers and scenes the test sets. */
export function fakeContext() {
  const layers: { name: string; type: string; visible: boolean; sources: string[]; ready: boolean }[] = [];
  const scenes = [
    { id: "s1", name: "One", active: true },
    { id: "s2", name: "Two", active: false },
  ];
  const listeners = { layers: new Set<() => void>(), state: new Set<() => void>() };
  // The Neuroglancer state edits apply to: a layer spec for each layer.
  const ng: { layers: Json[] } = { layers: [] };
  let saved: unknown;
  const log = { info: vi.fn(), error: vi.fn() };
  /** The overlays made over the views (the tool bar's among them). */
  const overlays: HTMLElement[] = [];
  const none = () => () => {};
  const ctx = {
    viewer: {
      layers: () => layers,
      layerSpec: (name: string) => ng.layers.find((l) => l.name === name),
      layerTransform: () => undefined,
      getState: () => ng,
      patchState: vi.fn((edit: (s: Json) => void) => edit(ng as unknown as Json)),
      panels: () => [],
      setTemporaryVisibleSegments: vi.fn(),
      onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
      onStateChanged: none,
      onRendered: none,
      onCursorChanged: none,
      reloadData: vi.fn(),
    },
    workspace: {
      scenes: () => scenes,
      local: { open: async (f: File) => [{ source: `zarr3://http://local/${f.name}`, name: f.name, kind: "segmentation" }], close: vi.fn() },
      datasets: () => [],
      addDataset: vi.fn((spec: { name: string; source: { url: string } }) => {
        layers.push({ name: spec.name, type: "segmentation", visible: true, sources: [spec.source.url], ready: true });
        ng.layers.push({ name: spec.name, type: "segmentation", source: spec.source as unknown as Json });
        return spec.name;
      }),
      selectLayer: vi.fn(),
      removeLayer: vi.fn(),
      undoSteps: () => ({}),
      onChanged: none,
    },
    ui: {
      overlay: () => {
        const element = document.createElement("div");
        overlays.push(element);
        return { element, dispose: () => {} };
      }, toast: vi.fn(), confirm: vi.fn(async () => true), showPanel: vi.fn() },
    services: { provide: none, get: () => new Promise(() => {}) },
    commands: { register: none, invoke: vi.fn() },
    state: {
      get: () => saved,
      set: vi.fn((v: unknown) => {
        saved = JSON.parse(JSON.stringify(v));
        listeners.state.forEach((f) => f());
      }),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    jobs: { run: vi.fn() },
    context: { set: vi.fn() },
    log,
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    layers,
    ng,
    overlays,
    scenes,
    log,
    fireLayers: () => [...listeners.layers].forEach((f) => f()),
  };
}

