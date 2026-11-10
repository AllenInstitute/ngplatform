/**
 * Luxar's layers over their lifetime, against a stand-in context, document,
 * WebGL and reading workers: a segmentation's next mesh store takes on the
 * worker of the one before (nothing read again but the new segment);
 * however many layers, the 2-D views use one WebGL context; switching on,
 * off and on again, removing a layer and switching the plugin off free
 * their workers, contexts and copies; and the 2-D views wait quietly while
 * their context is lost and draw again once it is restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerInfo, PlatformContext } from "@ngplatform/sdk";
import { FakeEvent, type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";

// The splat worker's module is imported for its helpers, and sets `self.onmessage` as it loads.
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import type { StoreInfo } from "../client.js";
import { LayerView } from "../layer_view.js";
import { Luxar, SEGMENT_SETTLE_MS } from "../plugin.js";
import { sharedContext2d } from "../shared2d.js";
import { DEFAULT_STYLE } from "../style.js";

const INFO: StoreInfo = {
  axisNames: ["x", "y", "z"],
  axisUnits: ["m", "m", "m"],
  axisScales: [0.001, 0.001, 0.001],
  bounds: { lower: [0, 0, 0], upper: [100, 100, 100] },
  levels: [{ index: 0, vertexCount: 100, chunkShape: [64, 64, 64], objectShare: 1, objects: 10 }],
  geometry: "streamline",
  primitive: "lines",
  attributes: [],
  warnings: [],
  objectRead: undefined,
};

let workers: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  terminated = false;
  posted: { type: string; epoch?: number; storeUrl?: string }[] = [];
  constructor() {
    workers.push(this);
  }
  postMessage(msg: { type: string; epoch?: number }) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  /** The last store opened in it. */
  get opened() {
    return this.posted.filter((m) => m.type === "open").at(-1)!;
  }
  /** Answers as the worker would, for its last store's open. */
  say(data: Record<string, unknown>) {
    this.onmessage?.({ data: { ...data, epoch: this.opened.epoch } });
  }
}

/** WebGL as far as Luxar's setup asks: every call answers, contexts made and given back are counted. */
const gl = { made: 0, lost: 0 };
function fakeGl(): WebGL2RenderingContext {
  const own: Record<string, unknown> = {
    getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext: () => void gl.lost++ } : name === "EXT_color_buffer_float" ? {} : null),
    checkFramebufferStatus: () => 1,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
  };
  return new Proxy(own, { get: (t, p) => (p in t ? t[p as string] : typeof p === "string" && /^[A-Z0-9_]+$/.test(p) ? 1 : () => ({})) }) as unknown as WebGL2RenderingContext;
}

/** Canvases that give a counted WebGL2 context, or a 2-D one to copy into. */
function canvases(dom: FakeDom) {
  const doc = dom.document as unknown as { createElement(tag: string): Record<string, unknown> };
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag: string) => {
    const e = create(tag);
    if (tag === "canvas") {
      let context: unknown;
      e.getContext = (kind: string) => {
        if (kind === "2d") return (context ??= { clearRect() {}, drawImage() {} });
        if (context === undefined) {
          gl.made++;
          context = fakeGl();
        }
        return context;
      };
    }
    return e;
  };
}

/** A context with what Luxar uses; layers and segments the test changes. */
function fakeContext(layers: LayerInfo[], saved: unknown) {
  let state = saved;
  const layerListeners = new Set<() => void>();
  const segmentListeners = new Map<string, Set<() => void>>();
  let shown = { all: false, size: 1, has: (id: bigint): boolean => id === 5n, ids: () => BigUint64Array.from([5n]), notSelectedAlpha: 0 };
  const panel = { kind: "2d", element: document.createElement("div"), project: (p: number[]) => [p[0], p[1], p[2]] };
  const ctx = {
    state: { get: () => state, set: (v: unknown) => void (state = v), onChanged: () => () => {} },
    viewer: {
      layers: () => layers,
      layerSpec: () => undefined,
      visibleSegments: () => shown,
      segmentColour: () => [1, 1, 1],
      onSegmentsChanged: (name: string, f: () => void) => {
        const set = segmentListeners.get(name) ?? new Set();
        segmentListeners.set(name, set);
        set.add(f);
        return () => set.delete(f);
      },
      onLayersChanged: (f: () => void) => (layerListeners.add(f), () => layerListeners.delete(f)),
      onRendered: () => () => {},
      hideLayerDrawing: () => {},
      setTemporaryBackground: () => {},
      draw3d: () => ({ redraw() {}, dispose() {} }),
      getState: () => ({}),
      panels: () => [panel],
      layerTransform: () => undefined,
    },
    ui: {
      overlay: () => ({ element: document.createElement("div"), dispose() {} }),
      screenshotOverlay: () => () => {},
    },
    workspace: { onChanged: () => () => {}, selectedLayer: () => undefined },
    context: { set: () => {} },
    commands: { invoke: async () => {} },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    layersChanged: () => layerListeners.forEach((f) => f()),
    showSegments(ids: bigint[]) {
      shown = { all: false, size: ids.length, has: (id: bigint) => ids.includes(id), ids: () => BigUint64Array.from(ids), notSelectedAlpha: 0 };
      segmentListeners.forEach((set) => set.forEach((f) => f()));
    },
  };
}

/** The 2-D views' frames, run when the test says. */
let frames: (() => void)[] = [];
const flush = () => {
  for (let i = 0; i < 5 && frames.length > 0; ++i) {
    const now = frames;
    frames = [];
    now.forEach((f) => f());
  }
};

const views = (luxar: Luxar) => (luxar as unknown as { views: Map<string, LayerView> }).views;

describe("Luxar's layers over their lifetime", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
    canvases(dom);
    workers = [];
    frames = [];
    gl.made = gl.lost = 0;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
  });
  afterEach(() => {
    dom.restore();
    vi.unstubAllGlobals();
  });

  it("hands a segmentation's worker to its next mesh store: one worker, the new segments read in it", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ type: "segmentation", mesh: "mesh" })));
    const seg: LayerInfo = { name: "cells", type: "segmentation", visible: true, ready: true, sources: ["precomputed://https://em.test/seg"] };
    const f = fakeContext([seg], { layers: { cells: { ...DEFAULT_STYLE, on: true } } });
    const luxar = new Luxar(f.ctx);
    await vi.waitFor(() => expect(workers.length).toBe(1));
    const worker = workers[0];
    expect(worker.opened.storeUrl).toBe("precomputed-meshes:https://em.test/seg/#segments=5");
    worker.say({ type: "opened", info: { ...INFO, primitive: "triangles" } });
    // Three segments clicked one after another: one new store, once they settle.
    f.showSegments([5n, 6n]);
    f.showSegments([5n, 6n, 7n]);
    f.showSegments([5n, 6n, 7n, 8n]);
    await new Promise((resolve) => setTimeout(resolve, SEGMENT_SETTLE_MS + 30));
    expect(workers.length).toBe(1);
    expect(worker.terminated).toBe(false);
    const opens = worker.posted.filter((m) => m.type === "open");
    expect(opens.map((m) => m.storeUrl)).toEqual(["precomputed-meshes:https://em.test/seg/#segments=5", "precomputed-meshes:https://em.test/seg/#segments=5,6,7,8"]);
    expect(opens[1].epoch).not.toBe(opens[0].epoch);
    // The new store's view answers to the new open only; the old view keeps drawing meanwhile.
    const view = views(luxar).get("cells")!;
    expect(view.storeUrl).toBe(opens[1].storeUrl);
    worker.onmessage!({ data: { type: "opened", info: INFO, epoch: opens[0].epoch } });
    expect(view.client.info).toBeUndefined();
    worker.say({ type: "opened", info: { ...INFO, primitive: "triangles" } });
    expect(view.client.info?.primitive).toBe("triangles");
    luxar.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("uses one WebGL context for the 2-D views however many layers: on, off, on again, a layer removed, then off", () => {
    const N = 8;
    const layers: LayerInfo[] = Array.from({ length: N }, (_, i) => ({ name: `tracts ${i}`, type: "segmentation", visible: true, ready: true, sources: [`https://data.test/t${i}.zarrvectors/|zarr-vectors:`] }));
    const on = (v: boolean) => Object.fromEntries(layers.map((l) => [l.name, { ...DEFAULT_STYLE, on: v }]));
    const f = fakeContext(layers, { layers: on(true) });
    const luxar = new Luxar(f.ctx);
    expect(workers.length).toBe(N);
    workers.forEach((w) => w.say({ type: "opened", info: INFO }));
    flush();
    // Before, a context per layer (8); now one, and one budget for every layer's copies.
    expect(gl.made).toBe(1);
    const shared = sharedContext2d()!;
    expect(shared.layers).toBe(N);
    expect(shared.pool.size).toBe(N);

    // Off: every worker stops, and the context is given back.
    for (const l of layers) luxar.setStyle(l.name, { on: false });
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(sharedContext2d()).toBeUndefined();
    expect(gl.lost).toBe(1);
    expect(shared.pool.size).toBe(0);

    // On again: new workers, one context again.
    for (const l of layers) luxar.setStyle(l.name, { on: true });
    expect(workers.length).toBe(2 * N);
    workers.slice(N).forEach((w) => w.say({ type: "opened", info: INFO }));
    flush();
    expect(gl.made).toBe(2);
    expect(sharedContext2d()!.layers).toBe(N);

    // A layer removed: its worker stops, its share of the context goes.
    const removed = layers.pop()!;
    const its = views(luxar).get(removed.name)!.client as unknown as { worker: FakeWorker };
    f.layersChanged();
    expect(its.worker.terminated).toBe(true);
    expect(workers.filter((w) => !w.terminated).length).toBe(N - 1);
    expect(sharedContext2d()!.layers).toBe(N - 1);

    // The plugin off: everything freed.
    luxar.dispose();
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(sharedContext2d()).toBeUndefined();
    expect(gl.lost).toBe(2);
  });

  it("waits quietly while the 2-D context is lost, and draws again once it is restored", () => {
    const layer: LayerInfo = { name: "tracts", type: "segmentation", visible: true, ready: true, sources: ["https://data.test/t.zarrvectors/|zarr-vectors:"] };
    const f = fakeContext([layer], { layers: { tracts: { ...DEFAULT_STYLE, on: true } } });
    const luxar = new Luxar(f.ctx);
    workers[0].say({ type: "opened", info: INFO });
    flush();
    const shared = sharedContext2d()!;
    const canvas = shared.canvas as unknown as { dispatchEvent(e: FakeEvent): boolean };
    const lost = new FakeEvent("webglcontextlost");
    canvas.dispatchEvent(lost);
    // Asked to be restored; nothing drawn, and no problem said meanwhile.
    expect(lost.defaultPrevented).toBe(true);
    expect(shared.lost).toBe(true);
    const view = views(luxar).get("tracts")!;
    view.redraw();
    flush();
    expect(view.report().error).toBeUndefined();
    canvas.dispatchEvent(new FakeEvent("webglcontextrestored"));
    expect(frames.length).toBeGreaterThan(0);
    flush();
    expect(shared.lost).toBe(false);
    // The same context, restored: not a new one.
    expect(gl.made).toBe(1);
    expect(view.report().error).toBeUndefined();
    expect(shared.pool.size).toBe(1);
    luxar.dispose();
  });
});
