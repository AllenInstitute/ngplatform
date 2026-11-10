/**
 * The Atlas panel against a context that holds only what it uses (a viewer
 * with segmentation layers, their tables, the cursor and a global space;
 * the plugin's state; jobs) and a label counter whose answers the test
 * gives, when it chooses: the empty state, the tree set in place, counting
 * with its cancel and its restart, the counts kept, and Go to with its
 * progress, Cancel and a new Go to stopping the last.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json, LayerTransform, LookupTableInfo, PlatformContext } from "@ngplatform/sdk";
import { parseLookupTable } from "@ngplatform/sdk/lookup";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import type { Counted } from "../label_client.js";
import { countingLevel, LabelCounter } from "../labels.js";
import { AtlasPanel, type Counter, labelOf, physicalText } from "../plugin.js";

const ALLEN = "lut://AllenCCF2017";
const allen = parseLookupTable(readFileSync(new URL("./fixtures/allen_structure_graph.json", import.meta.url), "utf8"));
const MM = 1e-3;
const identity = () => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A promise and what settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const abortError = () => new DOMException("Aborted", "AbortError");

/** A count of a store: MOp1 (320) 10 voxels, MOp2/3 (943) 5, CA1 (382) 7, at 1 mm. */
function countedOf(store: string): Counted {
  const stats = (count: number) => ({ count, sum: [0, 0, 0] as [number, number, number], lo: [0, 0, 0] as [number, number, number], hi: [9, 9, 9] as [number, number, number] });
  return {
    store,
    level: 0,
    size: [10, 10, 10],
    voxelToRas: identity(),
    voxelVolume: 1,
    labels: new Map([
      [320n, stats(10)],
      [943n, stats(5)],
      [382n, stats(7)],
    ]),
  };
}

/** The label counter: each request waits until the test answers it, and is rejected when its signal aborts. */
class FakeCounter implements Counter {
  counts: { store: string; progress?: (done: number, total: number) => void; answer: ReturnType<typeof deferred<Counted>> }[] = [];
  centres: { values: bigint[]; signal?: AbortSignal; progress?: (done: number, total: number) => void; answer: ReturnType<typeof deferred<[number, number, number] | undefined>> }[] = [];
  count(store: string, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Counted> {
    const answer = deferred<Counted>();
    signal?.addEventListener("abort", () => answer.reject(abortError()));
    this.counts.push({ store, progress, answer });
    return answer.promise;
  }
  centre(_counted: Counted, values: bigint[], signal?: AbortSignal, progress?: (done: number, total: number) => void): Promise<[number, number, number] | undefined> {
    const answer = deferred<[number, number, number] | undefined>();
    signal?.addEventListener("abort", () => answer.reject(abortError()));
    this.centres.push({ values, signal, progress, answer });
    return answer.promise;
  }
  dispose = vi.fn();
}

/**
 * A synthetic label pyramid, 32³ at level 0 and halved (nearest voxel, as
 * many label pyramids are made) to 16³ and 8³: MOp1 (320) fills x < 16,
 * MOp2/3 (943) the rest below y = 8, and CA1 (382) is three voxels at odd
 * coordinates, so no coarser level has it.
 */
function pyramid(): { size: [number, number, number]; data: Uint32Array }[] {
  const n = 32;
  const data = new Uint32Array(n ** 3);
  for (let z = 0, i = 0; z < n; ++z) for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x, ++i) data[i] = x < 16 ? 320 : y < 8 ? 943 : 0;
  for (const x of [21, 23, 25]) data[x + n * (11 + n * 13)] = 382;
  const levels = [{ size: [n, n, n] as [number, number, number], data }];
  while (levels[levels.length - 1].size[0] > 8) {
    const { size, data: fine } = levels[levels.length - 1];
    const m = size[0] / 2;
    const coarse = new Uint32Array(m ** 3);
    for (let z = 0, i = 0; z < m; ++z) for (let y = 0; y < m; ++y) for (let x = 0; x < m; ++x, ++i) coarse[i] = fine[2 * x + size[0] * (2 * y + size[0] * 2 * z)];
    levels.push({ size: [m, m, m], data: coarse });
  }
  return levels;
}

/** Counts the synthetic pyramid as the worker would, its first count held to 8³ voxels (as 64 M holds a large image to a coarse level). */
class PyramidCounter implements Counter {
  readonly levels = pyramid();
  requests: { level: number | undefined; signal?: AbortSignal; progress?: (done: number, total: number) => void; go: () => void }[] = [];
  count(store: string, progress?: (done: number, total: number) => void, signal?: AbortSignal, level?: number): Promise<Counted> {
    return new Promise<Counted>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(abortError()));
      const go = () => {
        const sizes = this.levels.map((l) => l.size);
        const at = level ?? countingLevel(sizes, 8 ** 3);
        const { size, data } = this.levels[at];
        const counter = new LabelCounter();
        counter.add(data, { lo: [0, 0, 0], hi: size, start: 0, stride: [1, size[0], size[0] * size[1]] });
        const r = counter.result();
        const scale = 2 ** at;
        const labels = new Map(Array.from(r.labels, (l, i) => [BigInt(l), { count: r.counts[i], sum: [0, 0, 0] as [number, number, number], lo: [0, 0, 0] as [number, number, number], hi: [0, 0, 0] as [number, number, number] }]));
        // The first count read 8³ voxels in a millisecond: 32³ takes well under a minute at that rate.
        resolve({ store, level: at, size, sizes, seconds: 0.001, voxelToRas: Float64Array.from([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]), voxelVolume: scale ** 3, labels });
      };
      this.requests.push({ level, signal, progress, go });
    });
  }
  centre(): Promise<[number, number, number] | undefined> {
    return Promise.resolve(undefined);
  }
  dispose = vi.fn();
}

function fakeContext() {
  const layers: { name: string; type: string; source: string; table?: string }[] = [];
  const ng: { dimensions: Record<string, [number, string]>; position: number[]; layers: Json[] } = { dimensions: { x: [MM, "m"], y: [MM, "m"], z: [MM, "m"] }, position: [0, 0, 0], layers: [] };
  let state: unknown;
  const listeners = { state: new Set<() => void>(), layers: new Set<() => void>(), ng: new Set<() => void>(), cursor: new Set<() => void>() };
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  let cursorValue: unknown;
  const jobs: { title: string; cancelled: boolean }[] = [];
  const subscriptions: (() => void)[] = [];
  const names = ["x", "y", "z"];
  const transform = {
    rank: 3,
    input: { names, scales: [MM, MM, MM], units: ["m", "m", "m"] },
    output: { names, scales: [MM, MM, MM], units: ["m", "m", "m"] },
    matrix: identity(),
    defaultMatrix: identity(),
  } as unknown as LayerTransform;
  const catalogue: LookupTableInfo[] = [{ url: ALLEN, title: "Allen Mouse CCFv3", group: "Mouse", fetched: true }];
  const ctx = {
    viewer: {
      layers: () => layers.map((l) => ({ name: l.name, type: l.type, visible: true })),
      layerSpec: (name: string) => {
        const l = layers.find((x) => x.name === name);
        return l && { type: l.type, source: l.source };
      },
      layerTransform: (name: string) => (layers.some((l) => l.name === name) ? transform : undefined),
      getState: () => ng,
      patchState: vi.fn((edit: (s: Json) => void) => {
        edit(ng as unknown as Json);
        fire(listeners.ng);
      }),
      onStateChanged: (f: () => void) => (listeners.ng.add(f), () => listeners.ng.delete(f)),
      onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
      onCursorChanged: (f: () => void) => (listeners.cursor.add(f), () => listeners.cursor.delete(f)),
      cursor: () => ({ active: true, position: [], names, units: ["m", "m", "m"], values: cursorValue === undefined ? {} : { seg: cursorValue } }),
      setPosition: vi.fn((p: number[]) => void (ng.position = [...p])),
      lookupTables: {
        catalogue: () => catalogue,
        title: (url: string) => (url === ALLEN ? "Allen Mouse CCFv3" : "my table"),
        of: (name: string) => layers.find((l) => l.name === name)?.table,
        load: vi.fn(async () => allen),
        apply: vi.fn(async (name: string, url: string | undefined) => {
          layers.find((l) => l.name === name)!.table = url;
          fire(listeners.layers);
        }),
      },
    },
    state: {
      get: () => state,
      set: vi.fn((v: unknown) => ((state = JSON.parse(JSON.stringify(v))), fire(listeners.state))),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    jobs: {
      run: <T>(title: string, work: (control: { progress(): void; readonly cancelled: boolean }) => Promise<T>) => {
        const job = { title, cancelled: false };
        jobs.push(job);
        return work({ progress: () => undefined, get cancelled() { return job.cancelled; } });
      },
    },
    commands: { invoke: vi.fn(async () => undefined) },
    ui: { toast: vi.fn() },
    subscriptions,
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    raw: ctx,
    ng,
    jobs,
    add(name: string, o: { type?: string; source?: string; table?: string } = {}) {
      layers.push({ name, type: "segmentation", source: `zarr://https://example.org/${name}.ome.zarr`, ...o });
      fire(listeners.layers);
    },
    remove(name: string) {
      layers.splice(layers.findIndex((l) => l.name === name), 1);
      fire(listeners.layers);
    },
    hover(value: unknown) {
      cursorValue = value;
      fire(listeners.cursor);
    },
    dispose: () => subscriptions.forEach((d) => d()),
  };
}

/** Lets promises settle. */
const settle = async () => {
  for (let i = 0; i < 10; ++i) await Promise.resolve();
};

describe("physical text", () => {
  it("names lengths and volumes in the unit that suits them", () => {
    expect(physicalText(1)).toBe("1 mm");
    expect(physicalText(0.025)).toBe("25 µm");
    expect(physicalText(8e-6)).toBe("8 nm");
    expect(physicalText(1500, 3)).toBe("1500 mm³");
    expect(physicalText(2e6 * 1e3, 3)).toBe("2 m³");
    expect(physicalText(0.0005, 3)).toBe("500000 µm³");
    expect(physicalText(0, 3)).toBe("0 mm³");
  });

  it("reads the segment id from Neuroglancer's selected value", () => {
    expect(labelOf({ value: "320" })).toBe(320n);
    expect(labelOf({ value: { value: 5 } })).toBe(5n);
    expect(labelOf({ value: "x" })).toBeUndefined();
  });
});

describe("the Atlas panel", () => {
  let dom: FakeDom;
  let world: ReturnType<typeof fakeContext>;
  let counter: FakeCounter;
  let host: HTMLElement;

  beforeEach(() => {
    dom = fakeDocument();
    world = fakeContext();
    counter = new FakeCounter();
    host = dom.host();
  });
  afterEach(() => {
    world.dispose();
    dom.restore();
  });

  const open = async () => {
    new AtlasPanel(world.ctx, counter).render(host);
    await settle();
  };
  const card = (id: string) => host.querySelector(`[data-card=${id}]`) as HTMLDetailsElement;
  const rows = () => [...host.querySelectorAll("[role=treeitem]")] as HTMLElement[];
  const row = (name: string) => rows().find((r) => dom.text(r.querySelector(".at-name")!) === name)!;

  it("says only what is missing, with its action, when there is no segmentation", async () => {
    await open();
    expect(dom.text(host)).toBe("No segmentation in this scene. Open data…");
    dom.find(host, "button", "Open data…").click();
    expect(world.raw.commands.invoke).toHaveBeenCalledWith("dataset.add");
    world.add("seg");
    expect(card("atlas.atlas").hidden).toBe(false);
    expect(dom.text(card("atlas.regions"))).toContain("This layer has no lookup table. Choose an atlas");
    // No narration: no status shows.
    for (const s of host.querySelectorAll<HTMLElement>(".status-line")) expect(s.hidden).toBe(true);
    expect(world.raw.state.set).not.toHaveBeenCalled();
  });

  it("reads the table chosen, lists its tree, and counts the image once", async () => {
    world.add("seg");
    await open();
    const table = host.querySelector("select[aria-label=Atlas]") as HTMLSelectElement;
    table.value = ALLEN;
    dom.fire(table, "change");
    await settle();
    expect(world.raw.viewer.lookupTables.apply).toHaveBeenCalledWith("seg", ALLEN);
    expect(dom.text(card("atlas.regions"))).toContain("22");
    // The single root is opened.
    expect(rows().map((r) => dom.text(r.querySelector(".at-name")!))).toEqual(["root", "Basic cell groups and regions", "fiber tracts", "ventricular systems"]);
    expect(counter.counts).toHaveLength(1);
    expect(dom.text(card("atlas.volumes"))).toContain("Counting the voxels…");
    counter.counts[0].progress!(1, 4);
    expect(dom.text(card("atlas.volumes"))).toContain("Counting the voxels… 25%");
    counter.counts[0].answer.resolve(countedOf(counter.counts[0].store));
    await settle();
    expect(card("atlas.volumes").querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
    expect(dom.text(card("atlas.volumes"))).toContain("10 × 10 × 10 voxels of 1 mm");
    // Only regions with voxels: grey matter's 22 voxels, not the ventricles.
    expect(rows().map((r) => dom.text(r.querySelector(".at-name")!))).toEqual(["root", "Basic cell groups and regions"]);
    expect(dom.text(row("root"))).toContain("22 mm³");
    // Moving the view counts nothing again.
    world.raw.viewer.patchState(() => undefined);
    await settle();
    expect(counter.counts).toHaveLength(1);
  });

  it("marks the region chosen in place, without drawing the tree again", async () => {
    world.add("seg", { table: ALLEN });
    await open();
    const before = rows();
    row("fiber tracts").querySelector<HTMLElement>(".at-node")!.click();
    // The same row elements, not new ones.
    expect(rows().every((r, i) => r === before[i])).toBe(true);
    expect(row("fiber tracts").getAttribute("aria-selected")).toBe("true");
    expect(row("root").getAttribute("aria-selected")).toBe("false");
    expect(dom.text(card("atlas.region"))).toContain("fiber tracts");
    expect(dom.text(card("atlas.region"))).not.toContain("No region chosen.");
    // Opening a region lists its children.
    dom.fire(row("Basic cell groups and regions").querySelector(".at-caret")!, "click");
    expect(rows().length).toBeGreaterThan(before.length);
    // Show only makes its values the layer's segments, as one patch.
    dom.find(host, "button", "Show only").click();
    expect(world.raw.viewer.patchState).toHaveBeenCalledTimes(1);
  });

  it("is a WAI-ARIA tree: items with their level, opened state and selection, children in a group, one item in the tab order", async () => {
    world.add("seg", { table: ALLEN });
    await open();
    const tree = host.querySelector("[role=tree]")!;
    expect(tree.getAttribute("aria-label")).toBe("Regions");
    const root = row("root");
    expect([root.getAttribute("aria-level"), root.getAttribute("aria-expanded"), root.getAttribute("aria-selected")]).toEqual(["1", "true", "false"]);
    // Its children are in its group, a level down; a leaf has no opened state.
    const group = root.querySelector("[role=group]")!;
    expect(group.querySelectorAll("[role=treeitem]")).toHaveLength(3);
    expect(row("fiber tracts").getAttribute("aria-level")).toBe("2");
    expect(row("fiber tracts").hasAttribute("aria-expanded")).toBe(false);
    expect(row("Basic cell groups and regions").getAttribute("aria-expanded")).toBe("false");
    // Named by its own row, not its children's.
    expect(root.getAttribute("aria-label")).toBe("root");
    expect(rows().filter((r) => r.getAttribute("tabindex") === "0")).toEqual([root]);
  });

  it("moves, opens, closes, jumps and chooses by keyboard, opening a region in place", async () => {
    world.add("seg", { table: ALLEN });
    await open();
    const key = (k: string) => dom.fire(document.activeElement!, "keydown", k);
    const at = () => dom.text(document.activeElement!.querySelector(".at-name")!);
    row("root").focus();
    key("ArrowDown");
    expect(at()).toBe("Basic cell groups and regions");
    expect(document.activeElement!.getAttribute("tabindex")).toBe("0");
    expect(row("root").getAttribute("tabindex")).toBe("-1");
    // Right opens it, in place: the items already drawn are the same elements.
    const before = rows();
    key("ArrowRight");
    expect(row("Basic cell groups and regions").getAttribute("aria-expanded")).toBe("true");
    expect(rows()).toHaveLength(before.length + 1);
    expect(before.every((r) => rows().includes(r))).toBe(true);
    expect(at()).toBe("Basic cell groups and regions");
    // Right again goes to its first child; Left back to the parent; Left again closes it.
    key("ArrowRight");
    expect(at()).toBe("Cerebrum");
    expect(row("Cerebrum").getAttribute("aria-level")).toBe("3");
    key("ArrowLeft");
    expect(at()).toBe("Basic cell groups and regions");
    key("ArrowLeft");
    expect(row("Basic cell groups and regions").getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toHaveLength(before.length);
    // Home and End; Up at the top stays.
    key("End");
    expect(at()).toBe("ventricular systems");
    key("Home");
    expect(at()).toBe("root");
    key("ArrowUp");
    expect(at()).toBe("root");
    // A letter goes to the next region starting with it; letters typed together, to one starting with them all.
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    key("f");
    expect(at()).toBe("fiber tracts");
    clock.mockReturnValue(20_000);
    key("v");
    expect(at()).toBe("ventricular systems");
    clock.mockReturnValue(30_000);
    key("b");
    key("a");
    expect(at()).toBe("Basic cell groups and regions");
    clock.mockReturnValue(40_000);
    key("v");
    clock.mockRestore();
    // Enter chooses, as a click does.
    key("Enter");
    expect(row("ventricular systems").getAttribute("aria-selected")).toBe("true");
    expect(dom.text(card("atlas.region"))).toContain("ventricular systems");
    // Drawn again (the counts arrive, the tree listing only regions in the image), the focus stays on the same region.
    key("Home");
    const old = row("root");
    counter.counts[0].answer.resolve(countedOf(counter.counts[0].store));
    await settle();
    expect(row("root")).not.toBe(old);
    expect(document.activeElement).toBe(row("root"));
  });

  it("shows every segment with Show all, listed, so the 3-D view draws their meshes", async () => {
    world.add("seg", { table: ALLEN });
    world.ng.layers.push({ name: "seg", type: "segmentation" });
    await open();
    row("fiber tracts").querySelector<HTMLElement>(".at-node")!.click();
    dom.find(host, "button", "Show only").click();
    const spec = () => world.ng.layers[0] as { segments?: string[]; visible?: boolean };
    expect(spec().segments).toEqual(["1009"]);
    // A label in the image but not in the table is shown too.
    const counted = countedOf(counter.counts[0].store);
    counted.labels.set(5000n, counted.labels.get(320n)!);
    counter.counts[0].answer.resolve(counted);
    await settle();
    dom.find(host, "button", "Show all").click();
    // Not an empty list (every segment in the slices, no mesh in 3-D): every value of the table and the image.
    const shown = spec().segments!;
    expect(shown).toHaveLength(23);
    expect(shown).toEqual(expect.arrayContaining(["997", "320", "943", "382", "1009", "73", "5000"]));
    expect(spec().visible).toBe(true);
  });

  it("uses the SDK's checkbox and no inline styles outside the tree's rows", async () => {
    world.add("seg", { table: ALLEN });
    await open();
    const only = dom.find(host, "label", "Only regions in the image");
    expect(only.className).toBe("choice");
    const styled = (e: Element): Element[] => [...(e.getAttribute("style") ? [e] : []), ...[...e.children].flatMap(styled)];
    expect(styled(host).every((e) => e.className.startsWith("at-node") || e.className.startsWith("at-swatch"))).toBe(true);
  });

  it("starts a cancelled count again when asked, or when Go to needs it", async () => {
    world.add("seg", { table: ALLEN });
    await open();
    expect(counter.counts).toHaveLength(1);
    world.jobs[0].cancelled = true;
    counter.counts[0].progress!(1, 4);
    await settle();
    expect(dom.text(card("atlas.volumes"))).toContain("Counting cancelled.");
    // Nothing starts it by itself.
    world.raw.viewer.patchState(() => undefined);
    await settle();
    expect(counter.counts).toHaveLength(1);
    dom.find(card("atlas.volumes"), "button", "Count again").click();
    await settle();
    expect(counter.counts).toHaveLength(2);
    counter.counts[1].answer.reject(new Error("no array"));
    await settle();
    expect(dom.text(card("atlas.volumes"))).toContain("Could not count the voxels: no array Retry");
    // Go to needs the counts: it counts again.
    row("root").querySelector<HTMLElement>(".at-node")!.click();
    dom.find(card("atlas.region"), "button", "Go to").click();
    await settle();
    expect(counter.counts).toHaveLength(3);
    expect(dom.text(card("atlas.region"))).toContain("Going to root…");
  });

  it("goes to a region with progress; Cancel, or a new Go to, stops the one under way", async () => {
    world.add("seg", { table: ALLEN });
    await open();
    counter.counts[0].answer.resolve(countedOf(counter.counts[0].store));
    await settle();
    row("root").querySelector<HTMLElement>(".at-node")!.click();
    const region = card("atlas.region");
    // Hidden until a Go to is under way.
    const cancel = [...region.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    expect(cancel.hidden).toBe(true);
    dom.find(region, "button", "Go to").click();
    await settle();
    expect(counter.centres).toHaveLength(1);
    expect(cancel.hidden).toBe(false);
    counter.centres[0].progress!(1, 2);
    expect(dom.text(region)).toContain("Going to root… 50%");
    // A second click stops the first.
    dom.find(region, "button", "Go to").click();
    await settle();
    expect(counter.centres[0].signal!.aborted).toBe(true);
    expect(counter.centres).toHaveLength(2);
    expect(dom.text(region)).toContain("Going to root…");
    cancel.click();
    await settle();
    expect(counter.centres[1].signal!.aborted).toBe(true);
    expect(cancel.hidden).toBe(true);
    expect(region.querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
    expect(world.raw.viewer.setPosition).not.toHaveBeenCalled();
    // One that finishes moves the views to the voxel (1 mm voxels at the origin: voxel 3, 4, 5 is at 3, 4, 5).
    dom.find(region, "button", "Go to").click();
    await settle();
    counter.centres[2].answer.resolve([3, 4, 5]);
    await settle();
    expect(world.raw.viewer.setPosition).toHaveBeenCalledWith([3, 4, 5]);
    expect(region.querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
    // A region with no voxels says so in the panel.
    dom.find(region, "button", "Go to").click();
    await settle();
    counter.centres[3].answer.resolve(undefined);
    await settle();
    expect(dom.text(region)).toContain("root has no voxels in seg.");
  });

  it("keeps the last few images' counts, not every one", async () => {
    for (let i = 0; i < 6; ++i) world.add(`seg${i}`, { table: ALLEN });
    await open();
    const layer = host.querySelector('select[aria-label="Segmentation layer"]') as HTMLSelectElement;
    const pick = async (name: string) => {
      layer.value = name;
      dom.fire(layer, "change");
      await settle();
      const last = counter.counts[counter.counts.length - 1];
      last.answer.resolve(countedOf(last.store));
      await settle();
    };
    await pick("seg0");
    for (let i = 1; i < 6; ++i) await pick(`seg${i}`);
    const counted = counter.counts.length;
    // seg5 is kept; seg0 has been let go, and is counted again.
    layer.value = "seg5";
    dom.fire(layer, "change");
    await settle();
    expect(counter.counts).toHaveLength(counted);
    await pick("seg0");
    expect(counter.counts).toHaveLength(counted + 1);
    expect(world.raw.state.set).toHaveBeenLastCalledWith({ layer: "seg0" });
  });

  it("names the region under the cursor with its path", async () => {
    world.add("seg", { table: ALLEN });
    await open();
    world.hover({ value: "320" });
    expect(dom.text(host.querySelector(".at-cursor")!)).toContain("Layer 1 MOp1 · 320");
    expect(dom.text(host.querySelector(".at-cursor")!)).toContain("Somatomotor areas › Primary motor area");
    world.hover({ value: "123456" });
    expect(dom.text(host.querySelector(".at-cursor")!)).toBe("123456 (not in the table)");
  });

  describe("a region of a few voxels at full resolution", () => {
    let pyramidCounter: PyramidCounter;
    const openPyramid = async () => {
      pyramidCounter = new PyramidCounter();
      new AtlasPanel(world.ctx, pyramidCounter).render(host);
      await settle();
    };
    const names = () => rows().map((r) => dom.text(r.querySelector(".at-name")!));
    const openAll = async () => {
      // Opens every region in the tree, down to the leaves.
      for (let more = true; more; ) {
        more = false;
        for (const r of rows()) {
          if (r.getAttribute("aria-expanded") === "false") {
            dom.fire(r.querySelector(".at-caret")!, "click");
            more = true;
            break;
          }
        }
      }
    };

    it("is missed at a coarse level, said to be unseen there (not absent), and found by the finer count that follows", async () => {
      world.add("seg", { table: ALLEN });
      await openPyramid();
      expect(pyramidCounter.requests.map((r) => r.level)).toEqual([undefined]);
      pyramidCounter.requests[0].go();
      await settle();
      // The first count is at 8³ (level 2): CA1 is not in it.
      expect(dom.text(card("atlas.volumes"))).toContain("8 × 8 × 8 voxels of 4 mm (level 2)");
      await openAll();
      expect(names()).not.toContain("Field CA1");
      expect(dom.text(card("atlas.regions"))).toMatch(/\d+ more not seen at level 2; they may be smaller than a voxel there\./);
      expect(dom.text(card("atlas.regions"))).not.toContain("No regions in the image.");
      // A finer count follows by itself: level 0 fits the time budget at the first count's rate.
      expect(pyramidCounter.requests.map((r) => r.level)).toEqual([undefined, 0]);
      expect(dom.text(card("atlas.volumes"))).toContain("Counting at level 0 (full resolution)…");
      expect(dom.find(card("atlas.volumes"), "button", "Cancel").hidden).toBe(false);
      pyramidCounter.requests[1].go();
      await settle();
      expect(dom.text(card("atlas.volumes"))).toContain("32 × 32 × 32 voxels of 1 mm");
      expect(dom.text(card("atlas.volumes"))).not.toContain("not seen");
      await openAll();
      expect(names()).toContain("Field CA1");
      expect(dom.text(row("Field CA1"))).toContain("3 mm³");
      expect(dom.text(card("atlas.regions"))).not.toContain("not seen");
    });

    it("keeps the coarse counts when the finer count is cancelled, and counts at full resolution when asked", async () => {
      world.add("seg", { table: ALLEN });
      await openPyramid();
      pyramidCounter.requests[0].go();
      await settle();
      dom.find(card("atlas.volumes"), "button", "Cancel").click();
      await settle();
      expect(pyramidCounter.requests[1].signal!.aborted).toBe(true);
      // The coarse counts stay, no error, and what they may miss is said, with the count that would not.
      expect(card("atlas.volumes").querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
      expect(dom.text(card("atlas.volumes"))).toContain("(level 2)");
      expect(dom.text(card("atlas.volumes"))).toMatch(/regions of the table not seen at level 2/);
      row("root").querySelector<HTMLElement>(".at-node")!.click();
      expect(dom.text(card("atlas.region"))).toContain("voxels, with its descendants");
      dom.find(card("atlas.volumes"), "button", "Count at full resolution").click();
      await settle();
      expect(pyramidCounter.requests.map((r) => r.level)).toEqual([undefined, 0, 0]);
      pyramidCounter.requests[2].go();
      await settle();
      await openAll();
      expect(names()).toContain("Field CA1");
    });
  });
});
