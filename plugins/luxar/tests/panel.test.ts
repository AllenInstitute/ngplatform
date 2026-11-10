/**
 * The Luxar panel, drawn into the SDK's stand-in document against a
 * context with what the plugin uses: built from the shared parts, updated
 * in place, writing no state from viewing, a status for progress and
 * errors only, the slab in the data's own unit, and the segment cap said.
 * Each layer's reading worker is a stand-in the test answers for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerInfo, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";

// The splat worker's module is imported for its helpers, and sets `self.onmessage` as it loads.
vi.hoisted(() => {
  (globalThis as { self?: unknown }).self ??= globalThis;
});

import type { StoreInfo } from "../client.js";
import { LUXAR_CAN_DRAW } from "../manifest.js";
import { Luxar } from "../plugin.js";
import cave from "./fixtures/cave_minnie65_public.json";

const STORE = "https://data.test/tracts.zarrvectors/|zarr-vectors:";

/** A store's info as the worker sends it: `units` and `scales` per axis, `size` its bounds' upper corner. */
function storeInfo(o: { units: string; scale: number; size: number[]; primitive?: StoreInfo["primitive"]; attributes?: StoreInfo["attributes"] }): StoreInfo {
  return {
    axisNames: ["x", "y", "z"],
    axisUnits: [o.units, o.units, o.units],
    axisScales: [o.scale, o.scale, o.scale],
    bounds: { lower: [0, 0, 0], upper: o.size },
    levels: [{ index: 0, vertexCount: 100, chunkShape: [64, 64, 64], objectShare: 1, objects: 10 }],
    geometry: "streamline",
    primitive: o.primitive ?? "lines",
    attributes: o.attributes ?? [],
    warnings: [],
    objectRead: undefined,
  };
}

/** The reading workers made, for the test to answer as each would. */
let workers: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  terminated = false;
  /** The store's open each answer is for (the client ignores answers for another). */
  epoch: number | undefined;
  constructor() {
    workers.push(this);
  }
  postMessage(msg: { type: string; epoch?: number }) {
    if (msg.type === "open") this.epoch = msg.epoch;
  }
  terminate() {
    this.terminated = true;
  }
  /** Answers as the worker would, for its store's open. */
  say(data: Record<string, unknown>) {
    this.onmessage!({ data: { ...data, epoch: this.epoch } });
  }
}

/** The last worker's store opens, with `info`. */
const open = (info: StoreInfo) => workers[workers.length - 1].say({ type: "opened", info });

/**
 * A context with what Luxar uses.  `writes` counts the state written (each
 * an undo step); `context` holds the context keys set.
 */
function fakeContext(layers: LayerInfo[], saved?: unknown) {
  let state = saved;
  let writes = 0;
  const stateListeners = new Set<() => void>();
  const workspaceListeners = new Set<() => void>();
  const context = new Map<string, unknown>();
  const invoked: string[] = [];
  let selected: string | undefined;
  let shown: { all: boolean; size: number; has(id: bigint): boolean; ids(): BigUint64Array; notSelectedAlpha: number } | undefined;
  const ctx = {
    state: {
      get: () => state,
      set: (v: unknown) => {
        state = v;
        writes++;
        stateListeners.forEach((f) => f());
        workspaceListeners.forEach((f) => f());
      },
      onChanged: (f: () => void) => (stateListeners.add(f), () => stateListeners.delete(f)),
    },
    viewer: {
      layers: () => layers,
      layerSpec: () => undefined,
      visibleSegments: () => shown,
      onSegmentsChanged: () => () => {},
      onLayersChanged: () => () => {},
      onRendered: () => () => {},
      hideLayerDrawing: () => {},
      setTemporaryBackground: () => {},
      draw3d: () => ({ redraw() {}, dispose() {} }),
      getState: () => ({}),
      panels: () => [],
      layerTransform: () => undefined,
    },
    ui: {
      overlay: () => ({ element: document.createElement("div"), dispose() {} }),
      screenshotOverlay: () => () => {},
    },
    workspace: {
      onChanged: (f: () => void) => (workspaceListeners.add(f), () => workspaceListeners.delete(f)),
      selectedLayer: () => selected,
    },
    context: { set: (key: string, value: unknown) => void context.set(key, value) },
    commands: { invoke: async (id: string) => void invoked.push(id) },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    writes: () => writes,
    state: () => state as { layers: Record<string, Record<string, unknown>> } | undefined,
    context,
    invoked,
    select(name: string | undefined) {
      selected = name;
      workspaceListeners.forEach((f) => f());
    },
    show(n: number) {
      shown = { all: false, size: n, has: () => true, ids: () => BigUint64Array.from({ length: Math.min(n, 3) }, (_, i) => BigInt(i + 1)), notSelectedAlpha: 0 };
    },
  };
}

/** The 2-D sections card, the slab's. */
const slabCard = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-card=luxar.slab]")!;

const tracts: LayerInfo = { name: "my tracts", type: "segmentation", visible: true, ready: true, sources: [STORE] };

describe("the Luxar panel", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
    workers = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("requestAnimationFrame", () => 0);
  });
  afterEach(() => {
    dom.restore();
    vi.unstubAllGlobals();
  });

  it("offers to open data, in one line, when there is nothing it can draw", () => {
    const f = fakeContext([]);
    const host = dom.host();
    new Luxar(f.ctx).render(host);
    const empty = host.querySelector<HTMLElement>(".empty-state")!;
    expect(dom.text(empty)).toBe("Nothing here Luxar can draw. Open data…");
    empty.querySelector("button")!.click();
    expect(f.invoked).toEqual(["dataset.add"]);
    // No settings for no layer; nothing written.
    expect(host.querySelector("[data-card=luxar.look]")).toBeNull();
    expect(f.writes()).toBe(0);
  });

  it("lists each layer by its own name with a switch, made by the SDK, and draws it when switched on", () => {
    const f = fakeContext([tracts]);
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    const list = host.querySelector(".list")!;
    expect(dom.text(list)).toBe("my tracts");
    // Every on/off control is the SDK's (in a label.choice), and the layer's drawing is a switch.
    const boxes = host.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect((b as unknown as { parentNode: Element }).parentNode.className).toBe("choice");
    const draw = list.querySelector<HTMLInputElement>("input[role=switch]")!;
    expect(f.writes()).toBe(0);
    dom.check(draw, true);
    expect(f.writes()).toBe(1);
    expect(f.state()!.layers["my tracts"].on).toBe(true);
    expect(workers.length).toBe(1);
    // No private styles: no lx- classes, no headings of its own, no notes.
    const all = host.querySelectorAll("div, span, p, label, details, summary, input, select, button");
    expect([...all].some((e) => /\blx-/.test(e.className))).toBe(false);
    expect(host.querySelectorAll("h3, .note").length).toBe(0);
    luxar.dispose();
  });

  it("writes nothing from viewing, even as its store opens with an attribute to colour by", async () => {
    const f = fakeContext([tracts], { version: 2, layers: { "my tracts": { on: true, colourBy: "attribute" } }, momentum: false });
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    open(storeInfo({ units: "m", scale: 0.001, size: [150, 180, 140], attributes: [{ id: "fa", name: "FA", components: 1 }] }));
    // The attribute shown is the one drawn, chosen without an undo step.
    await vi.waitFor(() => expect(host.querySelector<HTMLSelectElement>("select[aria-label=Attribute]")?.value).toBe("fa"));
    expect(f.writes()).toBe(0);
    luxar.dispose();
  });

  it("updates in place: the same cards and controls, set from the state", async () => {
    const f = fakeContext([tracts], { version: 2, layers: { "my tracts": { on: true } }, momentum: false });
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    open(storeInfo({ units: "m", scale: 0.001, size: [150, 180, 140] }));
    await vi.waitFor(() => expect(slabCard(host).querySelector(".slider")).not.toBeNull());
    const cards = host.querySelectorAll("details");
    const brightness = host.querySelector<HTMLInputElement>("input[type=number][aria-label=Brightness]")!;
    // An undo (or another tab) changes the state: shown, nothing drawn again.
    f.ctx.state.set({ version: 2, layers: { "my tracts": { on: true, exposure: 2 } }, momentum: false });
    expect(brightness.value).toBe("2");
    expect(host.querySelectorAll("details")).toEqual(cards);
    expect(host.querySelector("input[type=number][aria-label=Brightness]")).toBe(brightness);
    // While it is being typed in, a change waits.
    brightness.focus();
    brightness.value = "3";
    f.ctx.state.set({ version: 2, layers: { "my tracts": { on: true, exposure: -1 } }, momentum: false });
    expect(brightness.value).toBe("3");
    brightness.blur();
    expect(brightness.value).toBe("-1");
    luxar.dispose();
  });

  it("gives the slab in the data's unit: millimetres for a brain, micrometres for EM in nanometres", async () => {
    const slab = (host: HTMLElement) => {
      const part = host.querySelector("[data-card=luxar.slab]")!;
      return [part.querySelector<HTMLInputElement>("input[type=number]")!.value, dom.text(part.querySelector(".slider-unit")!)];
    };
    // A tractogram in mm: 4 mm, as before.
    let f = fakeContext([tracts], { version: 2, layers: { "my tracts": { on: true } }, momentum: false });
    let host = dom.host();
    let luxar = new Luxar(f.ctx);
    luxar.render(host);
    expect(slabCard(host).querySelector(".slider")).toBeNull();
    open(storeInfo({ units: "m", scale: 0.001, size: [150, 180, 140] }));
    await vi.waitFor(() => expect(slab(host)).toEqual(["4", "mm"]));
    luxar.dispose();

    // A mesh in nm, 0.8 mm across (in 4 × 4 × 40 nm voxels): 20 µm.
    const em: LayerInfo = { ...tracts, name: "cells", sources: ["https://data.test/cells.zarrvectors/|zarr-vectors:"] };
    f = fakeContext([em], { version: 2, layers: { cells: { on: true } }, momentum: false });
    host = dom.host();
    luxar = new Luxar(f.ctx);
    luxar.render(host);
    open({ ...storeInfo({ units: "m", scale: 4e-9, size: [200_000, 200_000, 20_000], primitive: "triangles" }), axisScales: [4e-9, 4e-9, 4e-8] });
    await vi.waitFor(() => expect(slab(host)).toEqual(["20", "µm"]));
    // Set to 5 µm: saved in mm; Reset follows the data again.
    const number = slabCard(host).querySelector<HTMLInputElement>("input[type=number]")!;
    dom.type(number, "5");
    expect(f.state()!.layers.cells.slab).toBeCloseTo(0.005);
    expect(slab(host)).toEqual(["5", "µm"]);
    dom.find(host.querySelector("[data-card=luxar.slab]")!, "button", "Reset").click();
    expect(f.state()!.layers.cells.slab).toBeUndefined();
    expect(slab(host)).toEqual(["20", "µm"]);
    luxar.dispose();
  });

  it("reports opening and errors only, with Retry, and is hidden once drawn", async () => {
    const f = fakeContext([tracts], { version: 2, layers: { "my tracts": { on: true } }, momentum: false });
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    const status = host.querySelector<HTMLElement>(".status-line")!;
    expect(dom.text(status)).toBe("Opening the store…");
    workers[0].say({ type: "error", message: "403 Forbidden" });
    await vi.waitFor(() => expect(dom.text(status)).toBe("Could not open the store: 403 Forbidden Retry"));
    dom.find(status, "button", "Retry").click();
    expect(workers.length).toBe(2);
    expect(workers[0].terminated).toBe(true);
    open(storeInfo({ units: "m", scale: 0.001, size: [150, 180, 140] }));
    await vi.waitFor(() => expect(status.hidden).toBe(true));
    expect(f.writes()).toBe(0);
    luxar.dispose();
  });

  it("says when a segmentation shows more segments than are drawn", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ type: "segmentation", mesh: "mesh" })));
    const seg: LayerInfo = { name: "Cells (v1300)", type: "segmentation", visible: true, ready: true, sources: ["precomputed://https://em.test/seg"] };
    const f = fakeContext([seg]);
    f.show(14_203);
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    await vi.waitFor(() => expect(dom.text(host.querySelector(".list")!)).toBe("Cells (v1300) Showing 2,000 of 14,203 segments"));
    f.show(12);
    f.select(undefined);
    expect(dom.text(host.querySelector(".list")!)).toBe("Cells (v1300)");
    luxar.dispose();
  });

  it("says a segmentation refused for want of a sign-in needs one, with Sign in, not that it has no meshes", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    const seg: LayerInfo = { name: "Cells (CAVE)", type: "segmentation", visible: true, ready: true, sources: ["graphene://middleauth+https://cave.test/segmentation/table/t"] };
    const f = fakeContext([seg]);
    f.show(3);
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    // Listed, so the panel can say why it is not drawn.
    await vi.waitFor(() => expect(dom.text(host.querySelector(".list")!)).toBe("Cells (CAVE)"));
    const status = host.querySelector<HTMLElement>(".status-line")!;
    expect(dom.text(status)).toBe("Sign in to read this layer's meshes. Sign in…");
    dom.find(status, "button", "Sign in…").click();
    expect(f.invoked).toEqual(["settings.signIn"]);
    // No worker for a layer that cannot be read.
    expect(workers.length).toBe(0);
    luxar.dispose();
  });

  it("lists a CAVE layer added by its URL (type auto while refused) with Sign in, as recorded from minnie65_public", async () => {
    // CAVE's recorded 401 for the info (cave_minnie65_public.json), and its auth_info.
    vi.stubGlobal("fetch", async (url: string) => {
      const r = cave.responses.find((x) => x.url === String(url));
      return r === undefined ? new Response("", { status: 404 }) : new Response(r.body, { status: r.status, headers: r.headers as Record<string, string> });
    });
    const added: LayerInfo = { name: "minnie65_public", type: "auto", visible: true, ready: false, sources: ["graphene://middleauth+https://minnie.microns-daf.com/segmentation/table/minnie65_public"] };
    // A precomputed source of unknown type is not taken for a segmentation.
    const unknown: LayerInfo = { name: "maybe", type: "auto", visible: true, ready: false, sources: ["precomputed://https://em.test/x"] };
    const f = fakeContext([added, unknown]);
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    await vi.waitFor(() => expect(dom.text(host.querySelector(".list")!)).toBe("minnie65_public"));
    expect(dom.text(host.querySelector<HTMLElement>(".status-line")!)).toBe("Sign in to read this layer's meshes. Sign in…");
    expect(workers.length).toBe(0);
    luxar.dispose();
  });

  it("notes what a store says of itself under its row, once each: segments with no mesh, a fragment that failed", async () => {
    const f = fakeContext([tracts], { version: 2, layers: { "my tracts": { on: true } }, momentum: false });
    const host = dom.host();
    const luxar = new Luxar(f.ctx);
    luxar.render(host);
    const list = host.querySelector(".list")!;
    expect(dom.text(list)).toBe("my tracts");
    open({ ...storeInfo({ units: "m", scale: 0.001, size: [150, 180, 140] }), warnings: ["3 of 40 segments had no mesh"] });
    await vi.waitFor(() => expect(dom.text(list)).toBe("my tracts 3 of 40 segments had no mesh"));
    // Said later by the worker, and again: shown once.
    workers[0].say({ type: "warning", message: "a mesh fragment could not be read" });
    workers[0].say({ type: "warning", message: "a mesh fragment could not be read" });
    await vi.waitFor(() => expect(dom.text(list)).toBe("my tracts 3 of 40 segments had no mesh. a mesh fragment could not be read"));
    // Not in the status line, which is for progress and errors.
    expect(host.querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
    expect(f.writes()).toBe(0);
    luxar.dispose();
  });

  it("offers its toggle command for any layer it can draw, and only those", () => {
    const image: LayerInfo = { name: "template", type: "image", visible: true, ready: true, sources: ["zarr://https://data.test/t.ome.zarr"] };
    const other: LayerInfo = { name: "points", type: "annotation", visible: true, ready: true, sources: ["local://annotations"] };
    const f = fakeContext([tracts, image, other]);
    const luxar = new Luxar(f.ctx);
    f.select("template");
    expect(f.context.get(LUXAR_CAN_DRAW)).toBe(true);
    f.select("my tracts");
    expect(f.context.get(LUXAR_CAN_DRAW)).toBe(true);
    f.select("points");
    expect(f.context.get(LUXAR_CAN_DRAW)).toBe(false);
    luxar.dispose();
    expect(f.context.get(LUXAR_CAN_DRAW)).toBe(false);
  });
});
