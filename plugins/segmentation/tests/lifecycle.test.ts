/**
 * The editor's sessions over their life: a label layer removed from its
 * scene lets its volume go once the browser keeps it (Activity says so,
 * and that undo brings it back), stays open when the browser cannot keep
 * it, and is not let go when another scene is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { Editor, RELEASE_WAIT } from "../editor.js";
import { forgetPersist } from "../keep.js";
import { LabelVolume } from "../label_volume.js";
import { Session } from "../session.js";
import type { Voxels } from "../../annotations/voxels.js";

const PLACE = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Browser storage in memory, as much as keep.ts uses; `full` refuses every write. */
function memoryStorage(full = false) {
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
function fakeContext() {
  const layers: { name: string; type: string; visible: boolean; sources: string[]; ready: boolean }[] = [];
  const scenes = [
    { id: "s1", name: "One", active: true },
    { id: "s2", name: "Two", active: false },
  ];
  const listeners = { layers: new Set<() => void>() };
  const log = { info: vi.fn(), error: vi.fn() };
  const none = () => () => {};
  const ctx = {
    viewer: {
      layers: () => layers,
      layerSpec: () => undefined,
      layerTransform: () => undefined,
      getState: () => ({ layers: [] }),
      patchState: vi.fn(),
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
        return spec.name;
      }),
      selectLayer: vi.fn(),
      removeLayer: vi.fn(),
      undoSteps: () => ({}),
    },
    ui: { overlay: () => ({ element: document.createElement("div"), dispose: () => {} }), toast: vi.fn(), confirm: vi.fn(async () => true), showPanel: vi.fn() },
    services: { provide: none, get: () => new Promise(() => {}) },
    commands: { register: none, invoke: vi.fn() },
    state: { get: () => undefined, set: vi.fn(), onChanged: none },
    jobs: { run: vi.fn() },
    context: { set: vi.fn() },
    log,
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    layers,
    scenes,
    log,
    fireLayers: () => [...listeners.layers].forEach((f) => f()),
  };
}

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
  forgetPersist();
});
afterEach(() => {
  vi.useRealTimers();
  dom.restore();
  vi.unstubAllGlobals();
});

/** An editor with one label volume open, painted (2 unsaved changes). */
async function withVolume(full = false) {
  const { files, storage } = memoryStorage(full);
  vi.stubGlobal("navigator", { storage });
  const f = fakeContext();
  const editor = new Editor(f.ctx, {} as Voxels);
  const volume = new LabelVolume([64, 64, 64], "uint8", PLACE, "t");
  volume.chunk(0, true)![1] = 3;
  const session = await Session.open(f.ctx, {} as Voxels, volume, "Labels");
  (editor as unknown as { adopt(s: Session, edit?: boolean): void }).adopt(session, false);
  session.unsaved = 2;
  session.changed([0]);
  const dispose = vi.spyOn(session, "dispose");
  return { ...f, files, editor, session, dispose };
}

/** Lets the editor's wait pass, and what it writes settle. */
async function afterWait() {
  await vi.advanceTimersByTimeAsync(RELEASE_WAIT + 10);
  for (let i = 0; i < 20; ++i) await Promise.resolve();
}

describe("a label layer removed", () => {
  it("lets its volume go once the browser keeps it, and says so in Activity", async () => {
    vi.useFakeTimers();
    const w = await withVolume();
    expect(w.editor.sessions).toHaveLength(1);
    w.layers.splice(0);
    w.fireLayers();
    await afterWait();
    await vi.waitFor(() => expect(w.editor.sessions).toHaveLength(0));
    expect(w.dispose).toHaveBeenCalledWith();
    // Its chunk is kept (the stroke not yet kept was written first).
    expect([...w.files.keys()].some((k) => k.endsWith("/c0"))).toBe(true);
    expect(w.log.info.mock.calls.map((c) => c[0]).join("\n")).toContain("“Labels” was removed: its label volume is closed, and its 2 unsaved changes kept in this browser. Undo brings the layer back");
    expect(w.editor.current).toBeUndefined();
  });

  it("stays open when the browser cannot keep its changes, and Activity says so", async () => {
    vi.useFakeTimers();
    const w = await withVolume(true);
    w.layers.splice(0);
    w.fireLayers();
    await afterWait();
    await vi.waitFor(() => expect(w.log.error.mock.calls.map((c) => c[0]).join("\n")).toContain("“Labels” was removed, but this browser could not keep its 2 unsaved changes"));
    expect(w.editor.sessions).toHaveLength(1);
    expect(w.dispose).not.toHaveBeenCalled();
  });

  it("is not let go when another scene is shown, or when the layer comes back within the wait", async () => {
    vi.useFakeTimers();
    const w = await withVolume();
    const shown = [...w.layers];
    // Another scene: its layers are others.
    w.scenes[0].active = false;
    w.scenes[1].active = true;
    w.layers.splice(0);
    w.fireLayers();
    await afterWait();
    expect(w.editor.sessions).toHaveLength(1);
    // Back, then removed and put back at once (a layer replaced).
    w.scenes[0].active = true;
    w.scenes[1].active = false;
    w.layers.push(...shown);
    w.fireLayers();
    w.layers.splice(0);
    w.fireLayers();
    w.layers.push(...shown);
    w.fireLayers();
    await afterWait();
    expect(w.editor.sessions).toHaveLength(1);
    expect(w.dispose).not.toHaveBeenCalled();
  });
});
