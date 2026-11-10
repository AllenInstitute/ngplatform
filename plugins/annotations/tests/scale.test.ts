/**
 * The Annotations sections with 10^5 annotations: moving the view (a
 * change of state that leaves the layers as they are) neither writes out
 * the state nor scans the annotations again, in any section; a change to a
 * layer does.  The Measure table draws 500 rows at a time, and its CSV has
 * every measurement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { Annotate } from "../annotate.js";
import { Labels } from "../labels.js";
import { Measure, ROWS_STEP } from "../measure_panel.js";
import { Statistics } from "../statistics_panel.js";
import type { Voxels } from "../voxels.js";

const MM = 1e-3;
const N = 100_000;

/** A viewer whose state is written out afresh on each read (as Neuroglancer's is), with a layers generation. */
function fakeContext(options: { generation: boolean }) {
  const ng: { dimensions: Record<string, [number, string]>; position: number[]; layers: Json[]; selectedLayer?: Json; selection?: Json } = {
    dimensions: { x: [MM, "m"], y: [MM, "m"], z: [MM, "m"] },
    position: [0, 0, 0],
    layers: [],
  };
  let generation = 0;
  let state: unknown;
  const reads = { full: 0 };
  const listeners = { ng: new Set<() => void>(), state: new Set<() => void>(), layers: new Set<() => void>() };
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  const overlay = () => ({ element: document.createElement("div"), dispose: () => {} });
  const commands = new Map<string, () => unknown>();
  const viewer: Record<string, unknown> = {
    getState: () => {
      reads.full++;
      return structuredClone(ng);
    },
    patchState: (edit: (s: Json) => void) => {
      edit(ng as unknown as Json);
      generation++;
      fire(listeners.ng);
    },
    layers: () => ng.layers.map((l) => ({ name: l.name as string, type: l.type as string, visible: true, sources: [] })),
    layerSpec: (name: string) => {
      const l = ng.layers.find((x) => x.name === name);
      // Only image and segmentation layers are asked for here (their source): an annotation layer's would be its annotations too.
      return l && { name: l.name, type: l.type, source: l.source };
    },
    layerTransform: () => undefined,
    onStateChanged: (f: () => void) => (listeners.ng.add(f), () => listeners.ng.delete(f)),
    onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
    onCursorChanged: () => () => {},
    onRendered: () => () => {},
    cursor: () => ({ active: false, values: {} }),
    annotationInProgress: () => false,
    lookupTables: { catalogue: () => [] },
  };
  if (options.generation) {
    viewer.layersGeneration = () => generation;
    viewer.statePart = (key: string) => structuredClone((ng as Record<string, unknown>)[key]);
  }
  const ctx = {
    viewer,
    state: {
      get: () => state,
      set: (v: unknown) => ((state = JSON.parse(JSON.stringify(v))), fire(listeners.state)),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    workspace: { scenes: () => [{ id: "s1", active: true }], selectLayer: vi.fn() },
    services: { get: () => new Promise(() => {}) },
    ui: { overlay, screenshotOverlay: () => () => {}, toast: vi.fn(), confirm: vi.fn(async () => true), showPanel: vi.fn() },
    commands: { register: (id: string, f: () => unknown) => (commands.set(id, f), () => commands.delete(id)), invoke: vi.fn(async () => undefined) },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    ng,
    reads,
    commands,
    /** Moves the view: the state changes, no layer does. */
    move: (i: number) => {
      ng.position = [i, i / 2, 0];
      fire(listeners.ng);
    },
  };
}

/** 10^5 lines (each measured) in one layer. */
function lines(n: number): Json {
  const annotations: Json[] = [];
  for (let i = 0; i < n; ++i) annotations.push({ id: `a${i}`, type: "line", pointA: [i, 0, 0], pointB: [i, 3, 4], description: i % 10 === 0 ? `line ${i}` : "" });
  return { name: "lines", type: "annotation", source: "local://annotations", annotations };
}

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
  vi.stubGlobal("requestAnimationFrame", () => 0);
});
afterEach(() => {
  dom.restore();
  vi.unstubAllGlobals();
});

/** Every section listening to the state, as the plugin sets them up; the time per move. */
function everySection(generation: boolean) {
  const f = fakeContext({ generation });
  f.ng.layers.push(lines(N));
  const annotate = new Annotate(f.ctx);
  // The annotation table (and the Annotate card) redraw when the model says so.
  let notified = 0;
  annotate.onChange(() => notified++);
  const labels = new Labels(f.ctx);
  const measure = new Measure(f.ctx, {} as Voxels);
  const statistics = new Statistics(f.ctx, {} as Voxels);
  const hosts = { labels: dom.host(), measure: dom.host(), statistics: dom.host() };
  labels.render(hosts.labels);
  measure.render(hosts.measure);
  statistics.render(hosts.statistics);
  labels.add({ kind: "annotation", layer: "lines", annotation: "a7" }, "a label");
  // Without a generation each move takes seconds: a few are enough to time.
  const moves = generation ? 20 : 3;
  f.reads.full = 0;
  notified = 0;
  const t0 = performance.now();
  for (let i = 1; i <= moves; ++i) f.move(i);
  const perMove = (performance.now() - t0) / moves;
  return { f, annotate, measure, hosts, perMove, readsPerMove: f.reads.full / moves, notified: () => notified };
}

describe("10^5 annotations", () => {
  it("moving the view writes out no state and rescans nothing; a layer's change does", () => {
    const before = everySection(false);
    const after = everySection(true);
    console.log(`per camera move with ${N} annotations: ${before.perMove.toFixed(1)} ms (${before.readsPerMove} full reads) without a layers generation, ${after.perMove.toFixed(2)} ms (${after.readsPerMove} full reads) with one`);
    expect(before.readsPerMove).toBeGreaterThan(0);
    expect(after.readsPerMove).toBe(0);
    expect(before.notified()).toBe(3);
    expect(after.notified()).toBe(0);
    expect(after.perMove).toBeLessThan(before.perMove / 10);
    // A layer that changes is read again, once for every section.
    const { f, annotate, measure, hosts } = after;
    f.reads.full = 0;
    const l = annotate.layer("lines")!;
    annotate.write("lines", { ...l.spec, annotations: [...l.spec.annotations, { id: "new", type: "line", pointA: [0, 0, 0], pointB: [0, 0, 10] }] }, l.meta);
    expect(f.reads.full).toBe(1);
    expect(after.notified()).toBeGreaterThan(0);
    expect(measure.measurements().length).toBe(N + 1);
    expect(dom.text(hosts.measure)).toContain(`Showing ${ROWS_STEP} of 100,001`);
  }, 60_000);

  it("the Measure table draws 500 rows at a time, Show more adds rows, and the CSV has every one", async () => {
    const f = fakeContext({ generation: true });
    f.ng.layers.push(lines(1234));
    const measure = new Measure(f.ctx, {} as Voxels);
    const host = dom.host();
    measure.render(host);
    expect(host.querySelectorAll("tr").length).toBe(1 + ROWS_STEP);
    expect(dom.text(host)).toContain("Showing 500 of 1,234");
    dom.find(host, "button", "Show 500 more").click();
    expect(host.querySelectorAll("tr").length).toBe(1 + 1000);
    dom.find(host, "button", "Show 234 more").click();
    expect(host.querySelectorAll("tr").length).toBe(1 + 1234);
    expect(dom.text(host)).not.toContain("Showing");
    // The CSV: a header and every measurement.
    let saved: Blob | undefined;
    vi.stubGlobal("URL", { createObjectURL: (b: Blob) => ((saved = b), "blob:x"), revokeObjectURL: () => {} });
    f.commands.get("annotations.exportMeasurements")!();
    const text = await saved!.text();
    expect(text.trim().split("\n").length).toBe(1 + 1234);
  });
});
