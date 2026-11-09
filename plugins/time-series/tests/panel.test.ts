/**
 * The Time series class and its panel, against a context that holds only
 * what they use (a viewer with layers, transforms, a global space with t
 * and the mouse; the plugin's state; the tiny NIfTI fixture read through a
 * real reader in place of the worker): the empty state and the layers it
 * cannot read, the panel kept up to date in place while reading and
 * playing, pins, and Retry after the image could not be opened.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json, LayerTransform, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { openNifti } from "../../../src/virtual/images/nifti.js";
import { notRead, type SeriesSource, TimeSeries } from "../plugin.js";
import { ChunkCache, SeriesReader } from "../reader.js";

const FIXTURE = path.join(__dirname, "fixtures", "tiny.nii.gz");

/** Column-major homogeneous matrix from rows (n × (n + 1)). */
function columnMajor(rows: number[][]): Float64Array {
  const n = rows.length;
  const m = new Float64Array((n + 1) * (n + 1));
  for (let r = 0; r < n; ++r) for (let c = 0; c <= n; ++c) m[(n + 1) * c + r] = rows[r][c];
  m[(n + 1) * (n + 1) - 1] = 1;
  return m;
}

/** The fixture as Neuroglancer shows it: source t, x, y, z (1.5 s, 2, 2, 3 mm), as in time_series.test.ts. */
function movieTransform(): LayerTransform {
  const matrix = columnMajor([
    [1, 0, 0, 0, 0],
    [0, 1, 0, 0, -6],
    [0, 0, 1, 0, -4],
    [0, 0, 0, 1, 1],
  ]);
  return {
    rank: 4,
    input: { names: ["t", "x", "y", "z"], scales: [1.5, 2e-3, 2e-3, 3e-3], units: ["s", "m", "m", "m"], bounds: { lower: [-0.5, -0.5, -0.5, -0.5], upper: [11.5, 5.5, 4.5, 3.5] } },
    output: { names: ["t", "x", "y", "z"], scales: [1.5, 1e-3, 1e-3, 1e-3], units: ["s", "m", "m", "m"] },
    matrix,
    defaultMatrix: matrix,
  } as unknown as LayerTransform;
}

/** A 3-D image: no time. */
function stillTransform(): LayerTransform {
  const matrix = columnMajor([
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]);
  return {
    rank: 3,
    input: { names: ["x", "y", "z"], scales: [1e-3, 1e-3, 1e-3], units: ["m", "m", "m"], bounds: { lower: [0, 0, 0], upper: [10, 10, 10] } },
    output: { names: ["x", "y", "z"], scales: [1e-3, 1e-3, 1e-3], units: ["m", "m", "m"] },
    matrix,
    defaultMatrix: matrix,
  } as unknown as LayerTransform;
}

interface FakeLayer {
  name: string;
  source: string;
  transform: LayerTransform;
}

function fakeContext() {
  const layers: FakeLayer[] = [];
  const ng = {
    dimensions: { x: [1e-3, "m"], y: [1e-3, "m"], z: [1e-3, "m"], t: [1.5, "s"] } as Record<string, [number, string]>,
    position: [-2.4, 2.9, 4.6, 5.5],
    layers: [] as Json[],
  };
  let state: unknown;
  let cursor: number[] | undefined;
  const listeners = { state: new Set<() => void>(), layers: new Set<() => void>(), ng: new Set<() => void>(), cursor: new Set<() => void>() };
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  const invoked: string[] = [];
  const ctx = {
    viewer: {
      layers: () => layers.map((l) => ({ name: l.name, type: "image", visible: true })),
      layerTransform: (name: string) => layers.find((l) => l.name === name)?.transform,
      layerSpec: (name: string) => {
        const l = layers.find((x) => x.name === name);
        return l && { type: "image", source: l.source };
      },
      localPosition: () => undefined,
      getState: () => ng,
      onStateChanged: (f: () => void) => (listeners.ng.add(f), () => listeners.ng.delete(f)),
      onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
      onCursorChanged: (f: () => void) => (listeners.cursor.add(f), () => listeners.cursor.delete(f)),
      cursor: () => ({ active: cursor !== undefined, position: cursor ?? [], names: ["x", "y", "z", "t"], units: ["m", "m", "m", "s"], values: {} }),
      setPosition: vi.fn((p: number[], _options?: { quiet?: boolean }) => {
        ng.position = p.map((v, i) => (Number.isNaN(v) ? ng.position[i] : v));
        fire(listeners.ng);
      }),
      setLocalPosition: vi.fn(),
      setSurfaceOverlay: vi.fn(),
      reloadData: vi.fn(),
    },
    state: {
      get: () => state,
      set: (v: unknown) => ((state = JSON.parse(JSON.stringify(v))), fire(listeners.state)),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    settings: { get: (key: string) => (key === "rate" ? 30 : undefined), set: vi.fn() },
    ui: { toast: vi.fn() },
    commands: { invoke: async (id: string) => void invoked.push(id) },
    workspace: { local: { locate: () => undefined, send: vi.fn() } },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    raw: ctx,
    ng,
    invoked,
    saved: () => state as { pins: { id: number; label: string }[] },
    add(name: string, source: string, transform: LayerTransform) {
      layers.push({ name, source, transform });
      fire(listeners.layers);
    },
    /** The mouse over the views at this global position (x, y, z mm, t), or off them. */
    point(at?: number[]) {
      cursor = at;
      fire(listeners.cursor);
    },
  };
}

/** The fixture read in place of the worker; `failOpen` makes the next opens fail. */
function fixtureSource(store: { get(key: string): Promise<Uint8Array | undefined> }) {
  const reader = new SeriesReader(new ChunkCache(1 << 20));
  let failOpen = 0;
  const opened: string[] = [];
  const source: SeriesSource = {
    open: async (url: string) => {
      opened.push(url);
      if (failOpen > 0) {
        failOpen--;
        throw new Error("the store did not answer");
      }
      return reader.open(url);
    },
    mean: async (_url, voxels, options = {}) => reader.mean(voxels, options.signal ?? new AbortController().signal, options.progress, options.plan),
    meanIfCached: async (_url, voxels) => reader.meanIfCached(voxels),
    dispose: vi.fn(),
  };
  return { source, opened, failNextOpen: () => void failOpen++, store };
}

/** The button under `root` named `label` (its aria-label). */
function byLabel(root: Element, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
}

/** Lets the reads waiting settle. */
async function settle(until: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(until()).toBe(true), { timeout: 2000, interval: 5 });
}

describe("why an image layer is not offered", () => {
  it("names those that cannot be read, then those with no time axis, and leaves out those loading", () => {
    expect(notRead([{ name: "bold", time: true, readable: true }])).toBe("");
    expect(
      notRead([
        { name: "T1", time: false, readable: true },
        { name: "movie", time: true, readable: false },
        { name: "T2", time: false, readable: false },
        { name: "loading", time: undefined, readable: true },
      ]),
    ).toBe("“movie”: its format isn't readable here; “T1”, “T2” have no time axis");
    // Beside images it can read: only those with time it cannot.
    expect(notRead([{ name: "T1", time: false, readable: true }], false)).toBe("");
  });
});

describe("the Time series panel", () => {
  let dom: FakeDom;
  let f: ReturnType<typeof fakeContext>;
  let src: ReturnType<typeof fixtureSource>;
  let series: TimeSeries | undefined;

  beforeEach(async () => {
    dom = fakeDocument();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const store = await openNifti(new Blob([fs.readFileSync(FIXTURE)]), "tiny");
    vi.stubGlobal("fetch", async (url: string) => {
      const data = await store.get(String(url).replace("http://nifti.test/", ""));
      return data === undefined ? new Response(null, { status: 404 }) : new Response(data as BodyInit);
    });
    f = fakeContext();
    src = fixtureSource(store);
  });

  afterEach(() => {
    series?.dispose();
    series = undefined;
    vi.unstubAllGlobals();
    dom.restore();
  });

  const open = () => {
    series = new TimeSeries(f.ctx, src.source);
    const host = dom.host();
    series.render(host);
    return host;
  };
  const ready = (host: HTMLElement) => settle(() => dom.text(host).includes("time point 6 of 0–11"));

  it("shows one line and Open data with nothing to plot, and why each image is left out", async () => {
    f.add("T1", "zarr://https://example.org/t1.ome.zarr", stillTransform());
    f.add("movie", "precomputed://https://example.org/movie", movieTransform());
    const host = open();
    await settle(() => dom.text(host).includes("No image with a time axis."));
    expect(dom.text(host)).toContain("“movie”: its format isn't readable here; “T1” has no time axis");
    dom.find(host, "button", "Open data…").click();
    expect(f.invoked).toEqual(["dataset.add"]);
    expect(host.querySelector<HTMLElement>(".ts")!.hidden).toBe(true);
  });

  it("names an image it cannot read beside the one it plots", async () => {
    f.add("bold", "zarr://http://nifti.test/", movieTransform());
    f.add("movie", "precomputed://https://example.org/movie", movieTransform());
    const host = open();
    await ready(host);
    expect(dom.text(host)).toContain("“movie”: its format isn't readable here");
    expect(dom.text(host)).not.toContain("No image with a time axis");
  });

  it("plots the voxel under the mouse without drawing its controls again", async () => {
    f.add("bold", "zarr://http://nifti.test/", movieTransform());
    const host = open();
    await ready(host);
    const selects = host.querySelectorAll("select");
    const options = [...selects].map((s) => [...s.children]);
    const play = byLabel(host, "Play (Alt+Shift+P)")!;
    // Voxel (2, 3, 1) at x 2·2 − 6, y 3·2 − 4, z 1·3 + 1 mm.
    f.point([-2, 2, 4, 5.5]);
    await settle(() => dom.text(host).includes("Mouse: x 2, y 3, z 1"));
    expect(host.querySelectorAll("select")).toEqual(selects);
    expect([...host.querySelectorAll("select")].map((s) => [...s.children])).toEqual(options);
    expect(byLabel(host, "Play (Alt+Shift+P)")!).toBe(play);
    expect(src.opened).toEqual(["http://nifti.test/"]);
  });

  it("plays with only the readout and the slider changing, and no undo steps", async () => {
    f.add("bold", "zarr://http://nifti.test/", movieTransform());
    const host = open();
    await ready(host);
    const legend = host.querySelector(".ts-legend")!;
    const keys = [...legend.children];
    const selects = host.querySelectorAll("select");
    const range = host.querySelector("input[type=range]") as HTMLInputElement;
    expect(range.getAttribute("max")).toBe("11");
    byLabel(host, "Play (Alt+Shift+P)")!.click();
    expect(byLabel(host, "Pause (Alt+Shift+P)")!).toBeTruthy();
    await settle(() => dom.text(host).includes("time point 8 of 0–11"));
    series!.toggle();
    expect(byLabel(host, "Play (Alt+Shift+P)")!).toBeTruthy();
    const shown = Number(/time point (\d+)/.exec(dom.text(host))![1]);
    expect(range.value).toBe(String(shown));
    expect(host.querySelectorAll("select")).toEqual(selects);
    expect([...legend.children]).toEqual(keys);
    expect(f.raw.viewer.setPosition.mock.calls.every(([, o]) => o?.quiet === true)).toBe(true);
  });

  it("steps with the transport buttons and the slider", async () => {
    f.add("bold", "zarr://http://nifti.test/", movieTransform());
    const host = open();
    await ready(host);
    byLabel(host, "Last time point")!.click();
    await settle(() => dom.text(host).includes("time point 11 of 0–11"));
    byLabel(host, "Previous time point")!.click();
    await settle(() => dom.text(host).includes("time point 10 of 0–11"));
    dom.type(host.querySelector("input[type=number]") as HTMLInputElement, "3");
    await settle(() => dom.text(host).includes("time point 3 of 0–11"));
    // Steps (not playing) are undo steps.
    expect(f.raw.viewer.setPosition.mock.calls.at(-1)![1]).toEqual({ quiet: false });
  });

  it("pins the voxel under the mouse, and removes the pin from the legend", async () => {
    f.add("bold", "zarr://http://nifti.test/", movieTransform());
    const host = open();
    await ready(host);
    f.point([-2, 2, 4, 5.5]);
    await settle(() => dom.text(host).includes("Mouse: x 2, y 3, z 1"));
    dom.find(host, "button", "Pin").click();
    expect(f.saved().pins.map((p) => p.label)).toEqual(["x 2, y 3, z 1"]);
    await settle(() => !dom.text(host).includes("…"));
    byLabel(host, "Remove x 2, y 3, z 1")!.click();
    expect(f.saved().pins).toEqual([]);
    expect(byLabel(host, "Remove x 2, y 3, z 1")).toBeUndefined();
  });

  it("offers Retry when the image could not be opened, and opens it again", async () => {
    src.failNextOpen();
    f.add("bold", "zarr://http://nifti.test/", movieTransform());
    const host = open();
    await settle(() => dom.text(host).includes("Could not read bold: the store did not answer"));
    dom.find(host.querySelector(".status-line")!, "button", "Retry").click();
    await ready(host);
    expect(host.querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
    expect(src.opened).toEqual(["http://nifti.test/", "http://nifti.test/"]);
  });
});
