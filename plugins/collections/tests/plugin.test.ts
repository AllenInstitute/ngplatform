/**
 * The Collections class and its panel, against a context holding only what
 * they use (scenes, datasets and layers with transforms; the plugin's
 * state; a sheet; fetch answering from a table, when the test says):
 * discovery and its timeouts, opening and following a tab's collection,
 * generations, label images, hidden members and why, From the view, the
 * affine grid, and the panel kept up to date in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayerTransform, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { Collections, EXAMPLE_URL, GROUPS_KEPT, groupsKept, ORDER_WAIT, plugin, READ_TIMEOUT, type Saved, twelveNumbers } from "../plugin.js";
import { SHOWN } from "../graph_view.js";
import { ADD_COLLECTION, COLLECTION_KIND, COLLECTIONS_PANEL } from "../manifest.js";

const MM = 1e-3;
const identity = () => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A promise and what settles it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

/** Lets the promises waiting settle. */
const settle = async () => {
  for (let i = 0; i < 60; ++i) await Promise.resolve();
};

/** Answers fetch from `table` (URL to JSON, a status, a promise the test settles, or an error thrown). */
type Answer = unknown | { status: number } | Promise<unknown> | Error;
function fakeFetch(table: Map<string, Answer>) {
  const asked: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    asked.push(url);
    let a = table.get(url);
    if (a instanceof Promise) a = await a;
    if (a instanceof Error) throw a;
    if (a === undefined) return { ok: false, status: 404, statusText: "Not Found", json: async () => undefined };
    if (typeof a === "object" && a !== null && "status" in a) return { ok: false, status: (a as { status: number }).status, statusText: "", json: async () => undefined };
    return { ok: true, status: 200, statusText: "OK", json: async () => structuredClone(a) };
  });
  return { fetch, asked };
}

interface FakeLayer {
  name: string;
  type: string;
  source: string;
  visible: boolean;
  matrix: Float64Array;
}

function fakeContext(datasets: { name: string; source: string }[] = []) {
  const layers: FakeLayer[] = [];
  const scenes = [{ id: "s1", name: "Scene 1", active: true, kind: undefined as string | undefined }];
  let state: unknown;
  const writes: Saved[] = [];
  const listeners = { state: new Set<() => void>(), workspace: new Set<() => void>() };
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  const panels = new Map<string, (host: HTMLElement) => (() => void) | void>();
  const commands = new Map<string, () => unknown>();
  const sheets: { title: string; body: HTMLElement; closed: boolean }[] = [];
  const added: { source: string; name: string; kind?: string }[] = [];
  const transforms: { layer: string; matrix: number[] }[] = [];
  const subscriptions: (() => void)[] = [];
  const transformOf = (l: FakeLayer): LayerTransform =>
    ({
      rank: 3,
      input: { names: ["x", "y", "z"], scales: [MM, MM, MM], units: ["m", "m", "m"] },
      output: { names: ["x", "y", "z"], scales: [MM, MM, MM], units: ["m", "m", "m"] },
      matrix: l.matrix,
      defaultMatrix: identity(),
    }) as unknown as LayerTransform;
  const ctx = {
    workspace: {
      scenes: () => scenes,
      datasets: () => datasets.map((d, i) => ({ id: `d${i}`, ...d })),
      sceneDatasets: () => layers.map((l) => ({ id: `ds-${l.name}`, name: l.name, source: l.source, layers: [{ name: l.name, sources: [l.source] }] })),
      onChanged: (f: () => void) => (listeners.workspace.add(f), () => listeners.workspace.delete(f)),
      newScene: vi.fn((o: { name: string; kind: string }) => {
        for (const s of scenes) s.active = false;
        scenes.push({ id: `s${scenes.length + 1}`, name: o.name, active: true, kind: o.kind });
        layers.length = 0;
        return scenes.at(-1)!.id;
      }),
      addDataset: vi.fn((spec: { source: string; name: string; kind?: string }) => {
        added.push(spec);
        layers.push({ name: spec.name, type: spec.kind ?? "image", source: spec.source, visible: true, matrix: identity() });
        return `ds-${spec.name}`;
      }),
      removeLayer: vi.fn((name: string) => void layers.splice(layers.findIndex((l) => l.name === name), 1)),
      renameLayer: vi.fn(),
      renameScene: vi.fn((id: string, name: string) => void (scenes.find((s) => s.id === id)!.name = name)),
      selectLayer: vi.fn(),
      computed: { url: vi.fn(async () => "computed://warped") },
    },
    state: {
      get: () => state,
      set: (v: unknown) => {
        state = JSON.parse(JSON.stringify(v));
        writes.push(state as Saved);
        fire(listeners.state);
      },
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    viewer: {
      layerSpec: (name: string) => {
        const l = layers.find((x) => x.name === name);
        return l && { type: l.type, source: l.source, visible: l.visible };
      },
      patchState: (edit: (ng: unknown) => void) => {
        const ng = { layers: layers.map((l) => ({ name: l.name, visible: l.visible })) };
        edit(ng);
        for (const s of ng.layers) layers.find((l) => l.name === s.name)!.visible = s.visible;
      },
      layerTransform: (name: string) => {
        const l = layers.find((x) => x.name === name);
        return l && transformOf(l);
      },
      setLayerTransform: (name: string, m: Float64Array) => {
        layers.find((x) => x.name === name)!.matrix = Float64Array.from(m);
        transforms.push({ layer: name, matrix: Array.from(m) });
      },
    },
    ui: {
      panel: (id: string, render: (host: HTMLElement) => (() => void) | void) => (panels.set(id, render), () => panels.delete(id)),
      sheet: (title: string, draw: (body: HTMLElement, close: () => void) => void) => {
        const sheet = { title, body: document.createElement("div"), closed: false };
        document.body.append(sheet.body);
        sheets.push(sheet);
        draw(sheet.body, () => void (sheet.closed = true));
      },
      toast: vi.fn(),
    },
    commands: { register: (id: string, run: () => unknown) => (commands.set(id, run), () => commands.delete(id)) },
    log: { info: vi.fn(), error: vi.fn() },
    subscriptions,
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    raw: ctx,
    layers,
    scenes,
    writes,
    sheets,
    added,
    transforms,
    panels,
    commands,
    saved: () => state as Saved,
    /** The state as an undo or a reload would leave it (the plugin did not write it). */
    setState(v: unknown) {
      state = v;
      fire(listeners.state);
    },
    switchTo(id: string) {
      for (const s of scenes) s.active = s.id === id;
      fire(listeners.workspace);
    },
    layer: (name: string) => layers.find((l) => l.name === name)!,
  };
}

/** A collection document: members (`path` relative to it) placed into "world" (µm) by translations along x; `extra` transforms and systems added. */
function collection(name: string, nodes: { id: string; path: string; at?: number; attributes?: unknown }[], extra: { systems?: unknown[]; transforms?: unknown[] } = {}) {
  return {
    ome: {
      type: "collection",
      name,
      attributes: {
        scene: {
          coordinateSystems: [{ id: "world", name: "World", axes: ["z", "y", "x"].map((n) => ({ name: n, unit: "micrometer" })) }, ...(extra.systems ?? [])],
          coordinateTransformations: [
            ...nodes.filter((n) => n.at !== undefined).map((n) => ({ type: "translation", translation: [0, 0, n.at], input: { id: n.id }, output: { id: "world" } })),
            ...(extra.transforms ?? []),
          ],
        },
      },
      nodes: nodes.map((n) => ({ type: "multiscale", name: n.id.toUpperCase(), id: n.id, path: { type: "zarr", path: n.path }, ...(n.attributes ? { attributes: n.attributes } : {}) })),
    },
  };
}

let dom: FakeDom;
let table: Map<string, Answer>;
let fetched: ReturnType<typeof fakeFetch>;
let n = 0;
/** A fresh host for each test, so images read once per page are read again. */
const host = () => `https://t${++n}.example.org`;

beforeEach(() => {
  dom = fakeDocument();
  table = new Map();
  fetched = fakeFetch(table);
  vi.stubGlobal("fetch", fetched.fetch);
  vi.stubGlobal("location", { href: "http://127.0.0.1:4180/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  dom.restore();
});

describe("finding collections above the workspace's images", () => {
  it("asks each parent group once, and offers the collection found in the panel", async () => {
    const h = host();
    table.set(`${h}/atlas/zarr.json`, collection("Atlas set", []));
    const w = fakeContext([{ name: "brain", source: `zarr://${h}/atlas/brain.ome.zarr` }]);
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await settle();
    expect(fetched.asked).toEqual([`${h}/atlas/zarr.json`]);
    expect(dom.text(panel)).toContain("This workspace's images belong to: Atlas set Open in a tab");
    expect(dom.text(panel)).toContain("No collection open.");
    await c.discover();
    expect(fetched.asked).toHaveLength(1);
  });

  it("gives up on a group that does not answer in time, and says so in the log", async () => {
    const h = host();
    table.set(`${h}/slow/zarr.json`, new DOMException("timed out", "TimeoutError"));
    const w = fakeContext([{ name: "brain", source: `zarr://${h}/slow/brain.ome.zarr` }]);
    new Collections(w.ctx);
    await settle();
    expect(w.raw.log.error).toHaveBeenCalledWith(`Looking for a collection at ${h}/slow: no answer in ${READ_TIMEOUT / 1000} s.`);
    // Every read is given a deadline.
    expect((fetched.fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
});

describe("opening a collection in a tab", () => {
  it("says plainly when the address does not answer in time", async () => {
    const h = host();
    table.set(`${h}/c.json`, new DOMException("timed out", "TimeoutError"));
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    expect(await c.openUrl(`${h}/c.json`)).toBe(false);
    expect(dom.text(panel)).toContain(`Could not read the collection at ${h}/c.json: no answer in 15 s`);
    expect(w.raw.workspace.newScene).not.toHaveBeenCalled();
  });

  it("opens the example in a tab of its own: a layer per member, placed in its first system", async () => {
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    expect(await c.openUrl(EXAMPLE_URL)).toBe(true);
    await settle();
    expect(w.raw.workspace.newScene).toHaveBeenCalledWith({ name: "srb_gallery", kind: COLLECTION_KIND });
    expect(w.saved()).toEqual({ url: EXAMPLE_URL, system: "gallery" });
    expect(w.added.map((a) => a.kind)).toEqual(["image", "image", "image"]);
    // Moved right by 170 000 µm: 170 mm along x (Neuroglancer's matrix is column-major, in 1 µm voxels here: mm / 1e-3 m).
    expect(w.layer("SRB 2026a, moved right").matrix[12]).toBeCloseTo(170);
    const text = dom.text(panel);
    expect(text).toContain("Members 3");
    expect(text).toContain("viewed");
    expect(text).not.toContain("No collection open.");
    // No notes repeating the graph: the members' tags say it.
    expect(text).not.toMatch(/Warped:|Hidden \(no transform|From the example|Changed from/);
  });

  it("adds a label image as a segmentation, by its metadata or its labels group", async () => {
    const h = host();
    table.set(`${h}/seg.ome.zarr/zarr.json`, { attributes: { ome: { "image-label": { version: "0.5" }, multiscales: [] } } });
    const doc = collection("labelled", [
      { id: "img", path: `${h}/img.ome.zarr`, at: 0 },
      { id: "seg", path: `${h}/seg.ome.zarr`, at: 0 },
      { id: "cells", path: `${h}/img.ome.zarr/labels/cells`, at: 0 },
    ]);
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(doc);
    await settle();
    expect(w.added.map((a) => `${a.name} ${a.kind}`)).toEqual(["IMG image", "SEG segmentation", "CELLS segmentation"]);
    expect(dom.text(dom.find(panel, ".cl-member", undefined))).not.toContain("labels");
    expect([...panel.querySelectorAll(".cl-tag")].filter((t) => dom.text(t) === "labels")).toHaveLength(2);
  });

  it("names each member's Zarr version in its source, from the metadata it read, so Neuroglancer looks for no other's", async () => {
    const h = host();
    table.set(`${h}/v3.ome.zarr/zarr.json`, { zarr_format: 3, node_type: "group", attributes: { ome: { multiscales: [] } } });
    table.set(`${h}/v2.ome.zarr/.zattrs`, { multiscales: [] });
    const doc = collection("versions", [
      { id: "v3", path: `${h}/v3.ome.zarr`, at: 0 },
      { id: "v2", path: `${h}/v2.ome.zarr`, at: 0 },
      { id: "none", path: `${h}/none.ome.zarr`, at: 0 },
    ]);
    const w = fakeContext();
    const c = new Collections(w.ctx);
    c.render(dom.host());
    await c.openDocument(doc);
    await settle();
    expect(w.added.map((a) => a.source)).toEqual([`zarr3://${h}/v3.ome.zarr/`, `zarr2://${h}/v2.ome.zarr/`, `zarr://${h}/none.ome.zarr/`]);
    // The metadata read once each, to tell labels from images: no other read to name the version.
    expect(fetched.asked.filter((u) => u.startsWith(`${h}/v3.ome.zarr/`))).toEqual([`${h}/v3.ome.zarr/zarr.json`]);
  });

  it("hides a member it cannot place, and names the transform kinds it does not apply", async () => {
    const h = host();
    const doc = collection("partly", [{ id: "a", path: `${h}/a.zarr`, at: 5 }, { id: "b", path: `${h}/b.zarr` }, { id: "c", path: `${h}/c.zarr` }], {
      transforms: [{ type: "byDimension", input: { id: "b" }, output: { id: "world" }, transformations: [] }],
    });
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(doc);
    await settle();
    expect(w.layer("A").visible).toBe(true);
    expect(w.layer("B").visible).toBe(false);
    expect(dom.text(panel)).toContain("Hidden: byDimension transforms are not applied here.");
    expect(dom.text(panel)).toContain("Hidden: no transform to this system.");
  });

  it("says a system's unit it does not know is read as mm", async () => {
    const h = host();
    const doc = collection("odd", [{ id: "a", path: `${h}/a.zarr`, at: 0 }], { systems: [{ id: "px", axes: ["z", "y", "x"].map((name) => ({ name, unit: "pixel" })) }] });
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(doc);
    await settle();
    expect(dom.text(panel)).toContain("unit 'pixel' read as mm");
    expect(dom.text(panel)).not.toMatch(/unit 'micrometer'/);
  });
});

describe("placing many members", () => {
  it("places the others while one member's metadata hangs, in the collection's order", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = host();
      // B's metadata never answers.
      table.set(`${h}/b.zarr/zarr.json`, new Promise(() => {}));
      const doc = collection("slow one", ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ id, path: `${h}/${id}.zarr`, at: i })));
      const w = fakeContext();
      const c = new Collections(w.ctx);
      void c.openDocument(doc);
      await settle();
      // A at once; the rest wait their turn behind B, but only for a while.
      expect(w.added.map((a) => a.name)).toEqual(["A"]);
      await vi.advanceTimersByTimeAsync(ORDER_WAIT);
      await settle();
      expect(w.added.map((a) => a.name)).toEqual(["A", "C", "D", "E", "F"]);
      expect(w.transforms.map((t) => t.layer)).toEqual(["A", "C", "D", "E", "F"]);
      expect(w.layer("F").matrix[12]).toBeCloseTo(0.005);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for several members' metadata at once, and adds their layers in order", async () => {
    const h = host();
    const answers = ["a", "b", "c"].map((id) => {
      const d = deferred<unknown>();
      table.set(`${h}/${id}.zarr/zarr.json`, d.promise);
      return d;
    });
    const doc = collection("three", ["a", "b", "c"].map((id) => ({ id, path: `${h}/${id}.zarr`, at: 0 })));
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const opening = c.openDocument(doc);
    await settle();
    // All three asked before any answered.
    expect(fetched.asked.filter((u) => u.endsWith("/zarr.json"))).toHaveLength(3);
    // Answered last to first: still added first to last.
    for (const d of answers.reverse()) {
      d.resolve({ attributes: { ome: { multiscales: [] } } });
      await settle();
    }
    await opening;
    expect(w.added.map((a) => a.name)).toEqual(["A", "B", "C"]);
  });

  it("answers once a collection is read without waiting for its members, when asked not to (the Add collection sheet)", async () => {
    const h = host();
    const hung = deferred<unknown>();
    table.set(`${h}/a.zarr/zarr.json`, hung.promise);
    const w = fakeContext();
    const c = new Collections(w.ctx);
    // The member's metadata never answers here, yet the collection is open.
    expect(await c.openDocument(collection("one", [{ id: "a", path: `${h}/a.zarr`, at: 0 }]), undefined, false)).toBe(true);
    expect(w.added).toHaveLength(0);
    hung.resolve({ attributes: { ome: { multiscales: [] } } });
    await settle();
    expect(w.added.map((a) => a.name)).toEqual(["A"]);
  });

  it("keeps at most GROUPS_KEPT images' metadata, and lets go of it when another collection opens", async () => {
    const h = host();
    const many = Array.from({ length: GROUPS_KEPT + 20 }, (_, i) => ({ id: `m${i}`, path: `${h}/m${i}.zarr`, at: 0 }));
    const w = fakeContext();
    const c = new Collections(w.ctx);
    await c.openDocument(collection("many", many));
    expect(w.added).toHaveLength(GROUPS_KEPT + 20);
    expect(groupsKept()).toBe(GROUPS_KEPT);
    await c.openDocument(collection("two", many.slice(0, 2)));
    expect(groupsKept()).toBe(2);
  });
});

describe("following the tab's state", () => {
  it("reads the collection again after an undo or a reload, and the newer one when two race", async () => {
    const h = host();
    const first = deferred<unknown>();
    table.set(`${h}/one.json`, first.promise);
    table.set(`${h}/two.json`, collection("two", []));
    const w = fakeContext();
    w.scenes[0].kind = COLLECTION_KIND;
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    w.setState({ url: `${h}/one.json` });
    await settle();
    expect(dom.text(panel)).toContain("Reading the collection…");
    // While one.json is read, the state moves on to two.json (an undo): that one is shown.
    w.setState({ url: `${h}/two.json` });
    first.resolve(collection("one", []));
    await settle();
    expect((panel.querySelector(".cl-name") as HTMLInputElement).value).toBe("two");
    expect(dom.text(panel)).not.toContain("Reading the collection…");
    // An edited document is kept whole in the state, and read from there.
    w.setState({ doc: collection("three", []) });
    await settle();
    expect((panel.querySelector(".cl-name") as HTMLInputElement).value).toBe("three");
    expect(fetched.asked.filter((u) => u.endsWith(".json") && u.includes(h))).toEqual([`${h}/one.json`, `${h}/two.json`]);
  });

  it("does nothing outside a collection's tab", async () => {
    const w = fakeContext();
    const c = new Collections(w.ctx);
    w.setState({ url: "https://x.example.org/c.json" });
    await c.follow();
    expect(fetched.asked).toEqual([]);
  });
});

describe("generations", () => {
  it("stops placing for a system once another is chosen", async () => {
    const h = host();
    const meta = deferred<unknown>();
    table.set(`${h}/a.zarr/zarr.json`, meta.promise);
    const doc = collection("two systems", [{ id: "a", path: `${h}/a.zarr`, at: 1000 }], {
      systems: [{ id: "atlas", axes: ["z", "y", "x"].map((name) => ({ name, unit: "micrometer" })) }],
      transforms: [{ type: "translation", translation: [0, 0, 7000], input: { id: "a" }, output: { id: "atlas" } }],
    });
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const opening = c.openDocument(doc);
    await settle();
    // Still asking whether A is a label image: the choice of another system overtakes it.
    const choosing = c.choose("atlas");
    meta.resolve({ attributes: { ome: { multiscales: [] } } });
    await Promise.all([opening, choosing]);
    await settle();
    expect(w.transforms.map((t) => t.matrix[12])).toEqual([7]);
    expect(w.saved().system).toBe("atlas");
  });

  it("stops when the person switches to another scene", async () => {
    const h = host();
    const meta = deferred<unknown>();
    table.set(`${h}/a.zarr/zarr.json`, meta.promise);
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const opening = c.openDocument(collection("c", [{ id: "a", path: `${h}/a.zarr`, at: 0 }]));
    await settle();
    w.switchTo("s1");
    meta.resolve({});
    await opening;
    expect(w.added).toEqual([]);
  });
});

describe("building in the panel", () => {
  it("writes where a moved layer is as its transform, From the view", async () => {
    const h = host();
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(collection("c", [{ id: "a", path: `${h}/a.zarr`, at: 0 }]));
    await settle();
    // Moved 2 mm along y in the viewer.
    w.layer("A").matrix[13] = 2;
    dom.find(panel, "button", "From the view").click();
    await settle();
    const ts = (w.saved().doc as ReturnType<typeof collection>).ome.attributes.scene.coordinateTransformations;
    expect(ts).toEqual([{ type: "translation", translation: [0, 2000, 0], input: { id: "a" }, output: { id: "world" } }]);
  });

  it("takes an affine from its 3 × 4 grid, or twelve numbers pasted", async () => {
    const h = host();
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(collection("c", [{ id: "a", path: `${h}/a.zarr` }]));
    await settle();
    const kind = dom.find<HTMLSelectElement>(panel, 'select[aria-label="Kind"]');
    kind.value = "affine";
    dom.fire(kind, "change");
    const cells = [...panel.querySelector(".cl-matrix")!.querySelectorAll("input")];
    expect(cells).toHaveLength(12);
    expect(cells.map((x) => (x as HTMLInputElement).value)).toEqual(["1", "0", "0", "0", "0", "1", "0", "0", "0", "0", "1", "0"]);
    dom.type(cells[3] as HTMLInputElement, "5");
    dom.find(panel, "button", "Add relationship").click();
    await settle();
    let ts = (w.saved().doc as ReturnType<typeof collection>).ome.attributes.scene.coordinateTransformations;
    // A member to World: a translation of 5 along x, the simplest form, on z, y, x.
    expect(ts.at(-1)).toEqual({ type: "translation", translation: [0, 0, 5], input: { id: "a" }, output: { id: "world" } });
    const paste = dom.find<HTMLInputElement>(panel, 'input[aria-label="Paste twelve numbers"]');
    dom.type(paste, "0 -1 0 1, 1 0 0 2; 0 0 1 3");
    expect([...panel.querySelector(".cl-matrix")!.querySelectorAll("input")].map((x) => (x as HTMLInputElement).value)).toEqual(["0", "-1", "0", "1", "1", "0", "0", "2", "0", "0", "1", "3"]);
    dom.find(panel, "button", "Add relationship").click();
    await settle();
    ts = (w.saved().doc as ReturnType<typeof collection>).ome.attributes.scene.coordinateTransformations;
    expect(ts.at(-1)).toEqual({ type: "affine", affine: [[1, 0, 0, 3], [0, 0, 1, 2], [0, -1, 0, 1]], input: { id: "a" }, output: { id: "world" } });
    dom.type(paste, "1 2 3");
    expect(w.raw.ui.toast).toHaveBeenCalledWith("Paste twelve numbers: rows x, y, z, each a b c t.", "error");
    expect(twelveNumbers("[[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]")).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it("keeps what is being typed while the collection changes, and removes with an icon button", async () => {
    const h = host();
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(collection("c", [{ id: "a", path: `${h}/a.zarr`, at: 0 }, { id: "b", path: `${h}/b.zarr`, at: 0 }]));
    await settle();
    const address = dom.find<HTMLInputElement>(panel, 'input[aria-label="Image address"]');
    address.value = "https://half-typed";
    const remove = dom.find(panel, 'button[aria-label="Remove B"]');
    expect(remove.className).toBe("btn icon");
    remove.click();
    await settle();
    expect(dom.find<HTMLInputElement>(panel, 'input[aria-label="Image address"]')).toBe(address);
    expect(address.value).toBe("https://half-typed");
    expect(dom.text(panel)).toContain("Members 1");
    expect(w.layers.map((l) => l.name)).toEqual(["A"]);
  });

  it("saves the JSON with the shared download", async () => {
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(collection("My set", []));
    dom.find(panel, "button", "Download JSON").click();
    expect(created).toHaveBeenCalledTimes(1);
    created.mockRestore();
  });
});

describe("the graph by keyboard", () => {
  it("takes the focus at one box, moves with the arrow keys, and chooses with Enter, at a hundred members", async () => {
    const h = host();
    const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, path: `${h}/m${i}.zarr`, at: i }));
    const doc = collection("hundred", nodes, {
      systems: [{ id: "mni", name: "MNI", axes: ["z", "y", "x"].map((name) => ({ name, unit: "millimeter" })) }],
      transforms: [{ type: "scale", scale: [1e-3, 1e-3, 1e-3], input: { id: "world" }, output: { id: "mni" } }],
    });
    const w = fakeContext();
    const c = new Collections(w.ctx);
    const panel = dom.host();
    c.render(panel);
    await c.openDocument(doc);
    await settle();
    const boxes = () => [...panel.querySelectorAll(".cl-node")] as HTMLElement[];
    const graph = panel.querySelector(".cl-graph")!;
    expect(graph.getAttribute("role")).toBe("group");
    // World's 100 members folded; one box in the tab order, the system viewed.
    expect(boxes()).toHaveLength(1 + (SHOWN - 1) + 1 + 1);
    expect(boxes().filter((b) => b.getAttribute("tabindex") === "0").map((b) => b.getAttribute("data-key"))).toEqual(["s:world"]);
    expect(boxes()[0].getAttribute("aria-label")).toBe("system World, viewed, 100 members, scale → MNI");
    expect(boxes()[1].getAttribute("aria-label")).toBe("member M0, in system World, translation");
    boxes()[0].focus();
    dom.fire(document.activeElement!, "keydown", "ArrowDown");
    expect(document.activeElement).toBe(boxes()[1]);
    dom.fire(document.activeElement!, "keydown", "ArrowRight");
    expect(document.activeElement?.getAttribute("data-key")).toBe("m:s:world:M1");
    // The roving tabindex follows.
    expect(boxes().filter((b) => b.getAttribute("tabindex") === "0")).toEqual([document.activeElement]);
    // Enter on a member selects its layer.
    dom.fire(document.activeElement!, "keydown", "Enter");
    expect(w.raw.workspace.selectLayer).toHaveBeenCalledWith("M1");
    // Enter on "+N more" opens the group; the focus stays on that box.
    dom.fire(document.activeElement!, "keydown", "End");
    dom.fire(document.activeElement!, "keydown", "ArrowUp");
    expect(document.activeElement?.getAttribute("data-key")).toBe(`m:s:world:M${SHOWN - 2}`);
    dom.fire(document.activeElement!, "keydown", "ArrowRight");
    expect(document.activeElement?.getAttribute("data-key")).toBe("more:s:world");
    expect(dom.text(document.activeElement!)).toContain(`+${100 - (SHOWN - 1)} more`);
    dom.fire(document.activeElement!, "keydown", "Enter");
    await settle();
    expect(boxes()).toHaveLength(1 + 100 + 1 + 1);
    expect(document.activeElement?.getAttribute("data-key")).toBe("more:s:world");
    expect(dom.text(document.activeElement!)).toContain("Show fewer");
    // Enter on a system views in it, as a click does; the focus comes back to it once drawn again.
    dom.fire(document.activeElement!, "keydown", "End");
    expect(document.activeElement?.getAttribute("data-key")).toBe("s:mni");
    dom.fire(document.activeElement!, "keydown", "Enter");
    for (let i = 0; i < 10; ++i) await settle();
    expect(w.saved().system).toBe("mni");
    expect(document.activeElement?.getAttribute("data-key")).toBe("s:mni");
    expect(document.activeElement?.getAttribute("aria-label")).toContain("system MNI, viewed");
  });
});

describe("the Add collection sheet", () => {
  it("makes a collection of the scene's ticked images, its checkboxes the SDK's", async () => {
    const w = fakeContext();
    w.raw.workspace.addDataset({ source: "zarr://https://x.example.org/one.ome.zarr", name: "one" });
    w.raw.workspace.addDataset({ source: "zarr://https://x.example.org/two.ome.zarr", name: "two" });
    w.added.length = 0;
    // Its style goes in the head.
    Object.assign(document, { head: dom.host() });
    plugin.activate(w.ctx);
    w.commands.get(ADD_COLLECTION)!();
    const sheet = w.sheets[0].body;
    const boxes = [...sheet.querySelectorAll('input[type="checkbox"]')];
    expect(boxes.every((b) => (b.parentNode as HTMLElement | null)?.className === "choice")).toBe(true);
    dom.check(boxes[1] as HTMLInputElement, false);
    dom.find(sheet, "button", "Make the collection").click();
    await settle();
    expect(w.sheets[0].closed).toBe(true);
    const doc = w.saved().doc as ReturnType<typeof collection>;
    expect(doc.ome.nodes.map((x) => x.name)).toEqual(["one"]);
    expect(w.panels.has(COLLECTIONS_PANEL)).toBe(true);
  });

  it("says why an address could not be opened, in the sheet", async () => {
    const w = fakeContext();
    const c = new Collections(w.ctx);
    c.showAddSheet();
    const sheet = w.sheets[0].body;
    dom.find(sheet, "button", "Open").click();
    await settle();
    expect(dom.text(sheet)).toContain("Enter a collection's address");
    expect(w.sheets[0].closed).toBe(false);
  });
});
