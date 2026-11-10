/**
 * The Annotations panel's cards against a context that holds only what
 * they use (a viewer state with layers, the plugin's state): empty states
 * with their actions, explanations behind info, on/off controls from the
 * shared parts, Statistics cancelled and replaced, Labels' track-group
 * button saying why it is off, and edits waiting for an annotation being
 * drawn applied when drawing ends, with no polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { Annotate } from "../annotate.js";
import { AnnotatePanel } from "../annotate_panel.js";
import { Labels } from "../labels.js";
import { Measure } from "../measure_panel.js";
import { Statistics } from "../statistics_panel.js";
import type { ImageLevel, Voxels } from "../voxels.js";

const MM = 1e-3;

function fakeContext() {
  const ng: { dimensions: Record<string, [number, string]>; position: number[]; layers: Json[] } = {
    dimensions: { x: [MM, "m"], y: [MM, "m"], z: [MM, "m"] },
    position: [0, 0, 0],
    layers: [],
  };
  let state: unknown;
  let drawing = false;
  const listeners = { ng: new Set<() => void>(), state: new Set<() => void>(), layers: new Set<() => void>() };
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  const overlay = () => ({ element: document.createElement("div"), dispose: () => {} });
  const ctx = {
    viewer: {
      getState: () => ng,
      patchState: vi.fn((edit: (s: Json) => void) => {
        edit(ng as unknown as Json);
        fire(listeners.ng);
      }),
      layers: () => ng.layers.map((l) => ({ name: l.name as string, type: l.type as string, visible: true, sources: [] })),
      layerSpec: (name: string) => ng.layers.find((l) => l.name === name),
      layerTransform: () => undefined,
      onStateChanged: (f: () => void) => (listeners.ng.add(f), () => listeners.ng.delete(f)),
      onLayersChanged: (f: () => void) => (listeners.layers.add(f), () => listeners.layers.delete(f)),
      onCursorChanged: () => () => {},
      onRendered: () => () => {},
      cursor: () => ({ active: false, values: {} }),
      annotationInProgress: () => drawing,
      lookupTables: { catalogue: () => [] },
    },
    state: {
      get: () => state,
      set: (v: unknown) => ((state = JSON.parse(JSON.stringify(v))), fire(listeners.state)),
      onChanged: (f: () => void) => (listeners.state.add(f), () => listeners.state.delete(f)),
    },
    workspace: { scenes: () => [{ id: "s1", active: true }], selectLayer: vi.fn() },
    services: { get: () => new Promise(() => {}) },
    ui: { overlay, screenshotOverlay: () => () => {}, toast: vi.fn(), confirm: vi.fn(async () => true), showPanel: vi.fn() },
    commands: { register: () => () => {}, invoke: vi.fn(async () => undefined) },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    raw: ctx,
    ng,
    fireState: () => fire(listeners.ng),
    setDrawing: (on: boolean) => void (drawing = on),
  };
}

let dom: FakeDom;
beforeEach(() => (dom = fakeDocument()));
afterEach(() => {
  dom.restore();
  vi.unstubAllGlobals();
});

/** Every checkbox under `host` made by toggle() or checkbox() (in a label.choice). */
function handMade(host: HTMLElement): number {
  return [...host.querySelectorAll("input")].filter((i) => i.getAttribute("type") === "checkbox" && (i.parentNode as HTMLElement).className !== "choice").length;
}

describe("Annotate", () => {
  it("with no layer offers + New layer, and with one its groups and fields, each with its action and its info", () => {
    const f = fakeContext();
    const model = new Annotate(f.ctx);
    const host = dom.host();
    new AnnotatePanel(f.ctx, model).render(host);
    expect(dom.text(host)).toContain("No annotation layer yet.");
    dom.find(host, "button", "+ New layer").click();
    expect(f.ng.layers.map((l) => l.name)).toEqual(["annotations"]);
    model.notify();
    expect(dom.text(host)).toContain("No groups.");
    expect(dom.text(host)).toContain("No fields.");
    // Explanations are behind info, not in the panel.
    expect(host.querySelectorAll("span.info").length).toBeGreaterThanOrEqual(3);
    expect(dom.text(host)).not.toContain("shown or hidden together");
    dom.find(host, "button", "+ Group").click();
    model.notify();
    expect(host.querySelectorAll("div.an-group").length).toBe(1);
    expect(handMade(host)).toBe(0);
    // A field being added stays while a group changes.
    dom.find(host, "button", "+ Field").click();
    const name = host.querySelector("div.an-form")!.querySelector("input.text-input")!;
    dom.find(host, "button", "+ Group").click();
    model.notify();
    expect(host.querySelector("div.an-form")!.querySelector("input.text-input")).toBe(name);
  });

  it("applies an edit made while an annotation is drawn when drawing ends, without polling", () => {
    vi.useFakeTimers();
    try {
      const f = fakeContext();
      const model = new Annotate(f.ctx);
      model.newLayer();
      const l = model.layer("annotations")!;
      f.raw.viewer.patchState.mockClear();
      f.setDrawing(true);
      model.write("annotations", { ...l.spec, annotations: [{ id: "a", type: "point", point: [1, 2, 3] }] }, l.meta);
      expect(f.raw.viewer.patchState).not.toHaveBeenCalled();
      // Nothing is checked on a timer.
      vi.advanceTimersByTime(5000);
      expect(f.raw.viewer.patchState).not.toHaveBeenCalled();
      // Drawing ends: the annotation is added, the state changes.
      f.setDrawing(false);
      f.fireState();
      expect(f.raw.viewer.patchState).toHaveBeenCalledTimes(1);
      expect((f.ng.layers[0].annotations as Json[]).map((a) => a.id)).toEqual(["a"]);
      // Dropped with Escape (no change of state): a key ends the wait.
      f.setDrawing(true);
      model.write("annotations", model.layer("annotations")!.spec, model.layer("annotations")!.meta);
      f.setDrawing(false);
      dom.fire(document, "keyup", "Escape");
      vi.advanceTimersByTime(0);
      expect(f.raw.viewer.patchState).toHaveBeenCalledTimes(2);
      model.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Measure", () => {
  it("with nothing measured offers to draw a line, and says how behind an info", () => {
    const f = fakeContext();
    const host = dom.host();
    new Measure(f.ctx, {} as Voxels).render(host);
    expect(dom.text(host)).toContain("Nothing measured yet.");
    expect(dom.text(host)).not.toContain("Ctrl+click");
    expect(host.querySelector("span.info")).not.toBeNull();
    dom.find(host, "button", "Draw a line").click();
    const layer = f.ng.layers.find((l) => l.name === "measurements")!;
    expect(layer.tool).toBe("annotateLine");
  });
});

describe("Statistics", () => {
  const image = { name: "img", type: "image", source: "zarr://https://example.org/img.ome.zarr" };
  const box = { name: "boxes", type: "annotation", annotations: [{ id: "b1", type: "axis_aligned_bounding_box", pointA: [0, 0, 0], pointB: [5, 5, 5] }] };

  it("offers Open data… without an image, and a box to draw without a region", () => {
    const f = fakeContext();
    const host = dom.host();
    new Statistics(f.ctx, {} as Voxels).render(host);
    dom.find(host, "button", "Open data…").click();
    expect(f.raw.commands.invoke).toHaveBeenCalledWith("dataset.add");
    f.ng.layers.push(image);
    f.fireState();
    dom.find(host, "button", "Draw a box").click();
    expect(f.ng.layers.find((l) => l.name === "measurements")!.tool).toBe("annotateBoundingBox");
  });

  it("is cancelled, and a new request replaces the one under way", async () => {
    const f = fakeContext();
    f.ng.layers.push(image, box);
    // The image's levels come when told.
    const waiting: ((l: ImageLevel[]) => void)[] = [];
    const voxels = { levels: () => new Promise<ImageLevel[]>((resolve) => waiting.push(resolve)) } as unknown as Voxels;
    const host = dom.host();
    new Statistics(f.ctx, voxels).render(host);
    const status = dom.find(host, "div.status-line");
    dom.find(host, "button", "Compute").click();
    expect(dom.text(status)).toBe("Reading…");
    dom.find(host, "button", "Cancel").click();
    expect(status.hidden).toBe(true);
    expect(() => dom.find(host, "button", "Cancel")).toThrow();
    // What it was reading comes later: nothing is said or added.
    waiting.shift()!([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(status.hidden).toBe(true);
    // Compute again, and again while it runs: the first is let go.
    dom.find(host, "button", "Compute").click();
    dom.find(host, "button", "Compute").click();
    waiting.shift()!([]);
    await vi.waitFor(() => expect(waiting.length).toBe(1));
    expect(dom.text(status)).toBe("Reading…");
    waiting.shift()!([]);
    await vi.waitFor(() => expect(status.className).toContain("error"));
    expect(dom.text(status)).toContain("Could not compute: img is not placed in 3-D here");
  });
});

describe("Labels", () => {
  it("says why + Track groups is off, offers + At the position when empty, and uses the shared controls", () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const f = fakeContext();
    const labels = new Labels(f.ctx);
    const host = dom.host();
    labels.render(host);
    const groups = dom.find<HTMLButtonElement>(host, "button", "+ Track groups");
    expect(groups.disabled).toBe(true);
    expect(dom.text(host)).toContain("No track groups yet");
    expect(dom.text(host)).toContain("No labels yet.");
    dom.find(host, "button", "+ At the position").click();
    expect(host.querySelectorAll("div.label-row").length).toBe(1);
    expect(handMade(host)).toBe(0);
    expect(host.querySelector("input.colour-input")).not.toBeNull();
    labels.dispose();
  });
});
