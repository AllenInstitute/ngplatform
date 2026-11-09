/**
 * The Orientations class and its panel, against a context that holds only
 * what they use (image layers over synthetic stores, a global space, a
 * cursor, the plugin's state) and a client that reads in the test rather
 * than in a worker: the empty state, the cards and the fields for each
 * kind of data, the panel kept up to date in place (a cursor move changes
 * one line's text), viewing that writes no state, opening retried a few
 * times then Retry, and a lost 2-D context reported with Retry.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { computeGlyphs } from "../glyphs.js";
import { CONTEXT_LOST } from "../overlay.js";
import { type Client, OPEN_ATTEMPTS, OPEN_WAIT_MS, Orientations, plugin, readSaved, type Saved } from "../plugin.js";
import { OrientationReader } from "../reader.js";
import { fakeGl } from "./fake_gl.js";
import { buildStore, crossingSh, type Store, storeFetch, tensorField } from "./synthetic.js";

const MM = 1e-3;
const stores: Record<string, Store> = {};

beforeAll(() => {
  stores["https://example.test/tensor.ome.zarr/"] = buildStore(tensorField([16, 16, 4]));
  stores["https://example.test/sh.ome.zarr/"] = buildStore(crossingSh([16, 16, 4]));
});

/** A client that reads in the test, as the worker would (./worker.ts); `fail` makes opening throw. */
function testClient(o: { fail?: () => boolean; failGlyphs?: () => boolean } = {}) {
  const reader = new OrientationReader();
  let levels: { voxelToRas: Float64Array; components: number }[] = [];
  const opens: string[] = [];
  const glyphReads: number[] = [];
  const client: Client = {
    async open(url) {
      opens.push(url);
      if (o.fail?.()) throw new Error("the server did not answer");
      const opened = await reader.open(url);
      levels = opened.levels;
      return opened;
    },
    async glyphs(level, request, options, signal) {
      glyphReads.push(level);
      if (o.failGlyphs?.()) throw new Error("a chunk could not be decoded");
      const voxels = await reader.voxels(level, request, signal ?? new AbortController().signal);
      return { set: computeGlyphs(voxels.indices, voxels.values, levels[level].components, levels[level].voxelToRas, options), voxels: voxels.count };
    },
    values: (level, request, signal) => reader.voxels(level, request, signal ?? new AbortController().signal),
    dispose: vi.fn(),
  };
  return { client, opens, glyphReads };
}

/** A context with what the plugin uses: image layers, a 1 mm global space, a cursor, its state. */
function fakeContext() {
  const layers: { name: string; url: string }[] = [];
  let state: unknown;
  const sets: unknown[] = [];
  let cursor: number[] | undefined;
  const listeners = { state: new Set<() => void>(), layers: new Set<() => void>(), ng: new Set<() => void>(), cursor: new Set<() => void>() };
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  const panels = new Map<string, (host: HTMLElement) => (() => void) | void>();
  const invoked: string[] = [];
  const subscriptions: (() => void)[] = [];
  const overlays: HTMLElement[] = [];
  // Views: none, or only a 3-D view (glyphs on three planes through the position).
  let views: unknown[] = [];
  const ng = { dimensions: { x: [MM, "m"], y: [MM, "m"], z: [MM, "m"] }, position: [8, 8, 2], layers: [] as unknown[] };
  const ctx = {
    viewer: {
      layers: () => layers.map((l) => ({ name: l.name, type: "image", visible: true, sources: [l.url], ready: true })),
      layerTransform: () => undefined,
      getState: () => ng,
      patchState: vi.fn(),
      reloadData: vi.fn(),
      panels: () => views,
      draw3d: () => ({ redraw: vi.fn(), dispose: vi.fn() }),
      onStateChanged: (f: () => void) => (listeners.ng.add(f), () => listeners.ng.delete(f)),
      onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
      onRendered: () => () => {},
      onCursorChanged: (f: () => void) => (listeners.cursor.add(f), () => listeners.cursor.delete(f)),
      cursor: () => ({ active: cursor !== undefined, position: cursor ?? [], names: ["x", "y", "z"], units: ["m", "m", "m"], values: {} }),
    },
    state: {
      get: () => state,
      set: (v: unknown) => (sets.push(v), (state = JSON.parse(JSON.stringify(v))), fire(listeners.state)),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    ui: {
      panel: (id: string, render: (host: HTMLElement) => (() => void) | void) => (panels.set(id, render), () => panels.delete(id)),
      viewToggle: () => ({ set: vi.fn(), dispose: vi.fn() }),
      overlay: () => {
        const element = document.createElement("div");
        overlays.push(element);
        return { element, dispose: vi.fn() };
      },
      screenshotOverlay: () => () => {},
      toast: vi.fn(),
    },
    services: { provide: vi.fn() },
    commands: { register: () => () => {}, invoke: async (id: string) => void invoked.push(id) },
    workspace: { local: { send: vi.fn(async () => Promise.reject(new Error("not local"))) } },
    log: { info: vi.fn() },
    subscriptions,
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    panels,
    invoked,
    overlays,
    /** Every state the plugin wrote. */
    sets,
    saved: () => readSaved(state),
    add(name: string, url: string) {
      layers.push({ name, url });
      fire(listeners.layers);
    },
    /** The mouse over the views at this global position (mm), or off them. */
    point(at?: number[]) {
      cursor = at;
      fire(listeners.cursor);
    },
    view3d() {
      views = [{ kind: "3d", element: { clientHeight: 400, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }) } }];
    },
    listeners: () => listeners.state.size + listeners.layers.size + listeners.ng.size + listeners.cursor.size,
    dispose: () => subscriptions.forEach((d) => d()),
  };
}

/** The elements under `e`. */
const count = (e: Element): number => [...e.children].reduce((n, c) => n + 1 + count(c), 0);

/** Lets fetches, reads and timers settle. */
const settle = async (ms = 0) => {
  for (let i = 0; i < 5; ++i) await vi.advanceTimersByTimeAsync(ms / 5 + 1);
  for (let i = 0; i < 20; ++i) await new Promise((r) => setImmediate(r));
};

describe("the Orientations panel", () => {
  let dom: FakeDom;
  let gl: ReturnType<typeof fakeGl>;
  let frames: (() => void)[];

  beforeEach(() => {
    dom = fakeDocument();
    gl = fakeGl();
    // Canvases answer with a fake WebGL2 context.
    const create = dom.document.createElement.bind(dom.document);
    (dom.document as { createElement: unknown }).createElement = (tag: string) => {
      const e = create(tag) as HTMLElement & { getContext?: unknown };
      if (tag === "canvas") e.getContext = () => gl.gl;
      return e;
    };
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    vi.stubGlobal("fetch", storeFetch(stores));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    dom.restore();
  });

  function open(f: ReturnType<typeof fakeContext>, client = testClient()) {
    const o = new Orientations(f.ctx, () => client.client);
    const host = dom.host();
    const off = o.render(host);
    return { o, host, off, client };
  }
  const status = (host: HTMLElement) => host.querySelector<HTMLElement>(".status-line")!;

  it("offers to open data while the scene has no image", () => {
    const f = fakeContext();
    const { host, o } = open(f);
    expect(dom.text(host)).toBe("No image in this scene. Open data…");
    dom.find(host, "button", "Open data…").click();
    expect(f.invoked).toEqual(["dataset.add"]);
    f.add("dti", "zarr://https://example.test/tensor.ome.zarr/");
    expect(host.querySelector<HTMLElement>(".empty-state")!.hidden).toBe(true);
    o.dispose();
  });

  it("says when no image has an axis of components, still naming the image", async () => {
    const f = fakeContext();
    f.add("plain", "zarr://https://example.test/plain.ome.zarr/");
    const { host, o } = open(f);
    dom.check(dom.find<HTMLInputElement>(host, "input.switch"), true);
    await settle();
    expect(dom.text(host)).toContain("None of these images has an axis of components (c).");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Image"]')!.value).toBe("plain");
    o.dispose();
  });

  it("groups its controls in cards, every on/off control the SDK's, and shows the fields for the data it reads", async () => {
    const f = fakeContext();
    f.add("dti", "zarr://https://example.test/tensor.ome.zarr/");
    const { host, o } = open(f);
    expect([...host.querySelectorAll("summary")].map((s) => dom.text(s as unknown as HTMLElement))).toEqual(["Image", "Glyphs", "Views", "Voxel"]);
    const boxes = [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    // The switch, three flips, and the two kinds of view: all in the SDK's labelled controls.
    expect(boxes).toHaveLength(6);
    expect(boxes.every((b) => (b.parentNode as HTMLElement).className === "choice")).toBe(true);
    expect(boxes.filter((b) => b.getAttribute("role") === "switch")).toHaveLength(1);
    // Nothing to say before the image is read.
    expect(status(host).hidden).toBe(true);

    dom.check(dom.find<HTMLInputElement>(host, "input.switch"), true);
    expect(f.saved().on).toBe(true);
    await settle();
    expect(status(host).hidden).toBe(true);
    const text = dom.text(host);
    expect(text).toContain("Tensors in FSL order · 4 levels, 2 mm, 4 mm, 8 mm, 16 mm");
    expect(text).toContain("Tensor order");
    expect(text).toContain("Tensor glyph");
    expect(text).not.toContain("SH basis");
    expect(text).not.toContain("ODF glyph");
    // The status says nothing of what the panel shows, and no glyph counts.
    expect(text).not.toMatch(/glyphs at/);

    // Read as spherical harmonics of order 2 instead: their fields, not the tensors'.
    const kind = host.querySelector<HTMLSelectElement>('select[aria-label="Voxels hold"]')!;
    kind.value = "sh";
    dom.fire(kind, "change");
    await settle();
    expect(f.saved().kind).toBe("sh");
    expect(dom.text(host)).toContain("SH basis");
    expect(dom.text(host)).not.toContain("Tensor order");
    o.dispose();
  });

  it("is updated in place: a change of state, a cursor move or a glyph read keeps its controls, and the cursor changes one line", async () => {
    const f = fakeContext();
    f.add("dti", "zarr://https://example.test/tensor.ome.zarr/");
    f.add("odf", "zarr://https://example.test/sh.ome.zarr/");
    const { host, o } = open(f);
    dom.check(dom.find<HTMLInputElement>(host, "input.switch"), true);
    await settle();
    const image = host.querySelector<HTMLSelectElement>('select[aria-label="Image"]')!;
    const size = host.querySelector<HTMLElement>(".slider")!;
    const voxel = dom.find(host, "p.readout");
    expect(voxel.textContent).toBe("No voxel under the mouse.");

    // Another state (as undo would bring): the same controls, showing it.
    f.ctx.state.set({ ...f.saved(), size: 2, flips: [true, false, false] } satisfies Saved);
    await settle();
    expect(host.querySelector('select[aria-label="Image"]')).toBe(image);
    expect(host.querySelector(".slider")).toBe(size);
    expect(host.querySelector<HTMLInputElement>("input[type=number]")!.value).toBe("2");
    const flipX = dom.find(host, "label.choice", "Flip x").querySelector<HTMLInputElement>("input")!;
    expect(flipX.checked).toBe(true);

    // The mouse over voxel (3, 12, 1), 2 mm voxels: its tensor read, in the Voxel card's line.
    const children = count(host);
    const sets = f.sets.length;
    f.point([6, 24, 2]);
    await settle(200);
    expect(voxel.textContent).toMatch(/^Voxel 3, 12, 1 \(2 mm\): FA /);
    expect(count(host)).toBe(children);
    f.point();
    await settle(200);
    // Off the image: as it was.
    f.point([-50, 0, 0]);
    await settle(200);
    expect(voxel.textContent).toBe("No voxel under the mouse.");
    // Frames drawn (and reads made) write no state: viewing is not an undo step.
    frames.splice(0).forEach((run) => run());
    await settle();
    expect(f.sets.length).toBe(sets);

    // Choosing the other image: kept as the layer drawn.
    image.value = "odf";
    dom.fire(image, "change");
    await settle();
    expect(f.saved().layer).toBe("odf");
    expect(dom.text(host)).toContain("Spherical harmonics, order 8");
    expect(host.querySelector('select[aria-label="Image"]')).toBe(image);
    o.dispose();
  });

  it("tries opening an image a few times, waiting longer each time, then offers Retry", async () => {
    const f = fakeContext();
    f.add("dti", "zarr://https://example.test/tensor.ome.zarr/");
    let failing = true;
    const client = testClient({ fail: () => failing });
    const { host, o } = open(f, client);
    dom.check(dom.find<HTMLInputElement>(host, "input.switch"), true);
    await settle();
    expect(client.opens).toHaveLength(1);
    expect(dom.text(status(host))).toBe("Could not read the image: the server did not answer. Trying again…");
    expect(() => dom.find(status(host), "button", "Retry")).toThrow();
    // Not before the wait is up; then again, and after twice the wait, once more.
    await settle(OPEN_WAIT_MS / 2);
    expect(client.opens).toHaveLength(1);
    await settle(OPEN_WAIT_MS);
    expect(client.opens).toHaveLength(2);
    await settle(2 * OPEN_WAIT_MS + 100);
    expect(client.opens).toHaveLength(OPEN_ATTEMPTS);
    expect(dom.text(status(host))).toBe("Could not read the image: the server did not answer Retry");
    // Given up: no more tries, whatever happens in the views.
    await settle(60_000);
    f.add("other", "https://example.org/plain.png");
    await settle();
    expect(client.opens).toHaveLength(OPEN_ATTEMPTS);
    failing = false;
    dom.find(status(host), "button", "Retry").click();
    await settle();
    expect(client.opens).toHaveLength(OPEN_ATTEMPTS + 1);
    expect(status(host).hidden).toBe(true);
    expect(dom.text(host)).toContain("Tensors in FSL order");
    o.dispose();
  });

  it("says when the 2-D glyphs' context is lost, and Retry draws them on a new canvas", async () => {
    const f = fakeContext();
    f.add("dti", "zarr://https://example.test/tensor.ome.zarr/");
    const { host, o } = open(f);
    dom.check(dom.find<HTMLInputElement>(host, "input.switch"), true);
    await settle();
    const canvas = f.overlays[0].querySelector("canvas")!;
    gl.lose();
    dom.fire(canvas, "webglcontextlost");
    expect(dom.text(status(host))).toBe(`${CONTEXT_LOST} Retry`);
    gl = fakeGl();
    dom.find(status(host), "button", "Retry").click();
    expect(status(host).hidden).toBe(true);
    expect([...f.overlays[0].querySelectorAll("canvas")]).toHaveLength(1);
    expect(f.overlays[0].querySelector("canvas")).not.toBe(canvas);
    o.dispose();
  });

  it("reads glyphs for a view, says when a read fails, and Retry reads it again; the controls kept throughout", async () => {
    const f = fakeContext();
    f.add("dti", "zarr://https://example.test/tensor.ome.zarr/");
    f.view3d();
    let failing = true;
    const client = testClient({ failGlyphs: () => failing });
    const { host, o } = open(f, client);
    dom.check(dom.find<HTMLInputElement>(host, "input.switch"), true);
    await settle();
    const size = host.querySelector(".slider");
    const sets = f.sets.length;
    // A view must want the same for a moment before it is read.
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const frame = async () => {
      frames.splice(0).forEach((run) => run());
      now += 150;
      await settle(150);
    };
    for (let i = 0; i < 4 && client.glyphReads.length === 0; ++i) await frame();
    expect(client.glyphReads).toHaveLength(1);
    expect(dom.text(status(host))).toBe("Could not read glyphs: a chunk could not be decoded Retry");
    // Not read again on its own for the same view.
    await frame();
    await frame();
    expect(client.glyphReads).toHaveLength(1);
    failing = false;
    dom.find(status(host), "button", "Retry").click();
    for (let i = 0; i < 4 && client.glyphReads.length === 1; ++i) await frame();
    expect(client.glyphReads).toHaveLength(2);
    expect(status(host).hidden).toBe(true);
    expect(o.describe().join("\n")).toMatch(/3-D view: \d+ glyphs at/);
    expect(host.querySelector(".slider")).toBe(size);
    expect(f.sets.length).toBe(sets);
    o.dispose();
  });

  it("lets go of everything when its panel closes and the plugin stops", () => {
    const f = fakeContext();
    f.add("dti", "zarr://https://example.test/tensor.ome.zarr/");
    plugin.activate(f.ctx);
    const host = dom.host();
    const off = f.panels.get("orientations.panel")!(host);
    expect(dom.text(host)).toContain("Orientation glyphs");
    if (typeof off === "function") off();
    f.dispose();
    expect(f.listeners()).toBe(0);
  });
});
