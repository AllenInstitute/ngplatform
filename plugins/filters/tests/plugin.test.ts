/**
 * The Filters panel: which images it offers, how a filtered layer is first
 * shown, and the panel itself (drawn into the SDK's stand-in document,
 * against a context holding only what it uses): its empty state, its
 * controls updated in place, adding a view, tuning a selected one in
 * place, and letting go of its listeners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputedPipeline, LayerTransform, PlatformContext } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { newStep, type Step } from "../pipeline.js";
import { displayOf, plugin, uniqueName, unfilterable } from "../plugin.js";

/** A source's axes as layerTransform gives them: names, units and extents (bounds from 0). */
const axes = (...a: [string, string, number][]): Pick<LayerTransform, "input"> => ({
  input: { names: a.map((x) => x[0]), units: a.map((x) => x[1]), scales: a.map(() => 1), bounds: { lower: a.map(() => 0), upper: a.map((x) => x[2]) } },
});
const VOLUME = axes(["x", "m", 100], ["y", "m", 100], ["z", "m", 80]);

describe("the images offered", () => {
  it("are 3-D: one channel and one time point, or a singleton axis of either", () => {
    expect(unfilterable(VOLUME)).toBeUndefined();
    expect(unfilterable(axes(["c'", "", 1], ["t", "s", 1], ["z", "m", 10], ["y", "m", 10], ["x", "m", 10]))).toBeUndefined();
    expect(unfilterable({ input: { names: ["x", "y", "z"], units: ["m", "m", "m"], scales: [1, 1, 1] } })).toBeUndefined();
  });

  it("are not 2-D images, channels (RGB among them) or time series, each with why", () => {
    expect(unfilterable(axes(["x", "m", 512], ["y", "m", 512]))).toBe("2-D");
    expect(unfilterable(axes(["x", "m", 512], ["y", "m", 512], ["z", "m", 1]))).toBe("2-D");
    expect(unfilterable(axes(["x", "m", 512], ["y", "m", 512], ["z", "m", 9], ["c^", "", 3]))).toBe("3 channels");
    expect(unfilterable(axes(["t", "s", 12], ["z", "m", 9], ["y", "m", 9], ["x", "m", 9]))).toBe("a time series of 12");
    expect(unfilterable(axes(["x", "m", 9], ["y", "m", 9], ["z", "m", 9], ["t'", "", 5]))).toBe("a time series of 5");
    expect(unfilterable(undefined)).toBe("still loading");
  });
});

describe("a filtered layer is first shown", () => {
  const image = { shader: "#uicontrol invlerp normalized\nvoid main() {}", shaderControls: { normalized: { range: [0, 900] } }, opacity: 0.8 };
  it("as the image, when the steps keep its values", () => {
    expect(displayOf([newStep("gaussian"), newStep("median")], image)).toEqual(image);
    expect(displayOf([newStep("dog"), newStep("python")], image)).toEqual(image);
  });

  it("in a range of its own for vesselness and a difference of Gaussians, which are not the image's values", () => {
    expect(displayOf([newStep("gaussian"), newStep("frangi")], image)).toEqual({ shaderControls: { normalized: { range: [0, 0.3] } } });
    expect(displayOf([newStep("dog")], image)).toEqual({ shaderControls: { normalized: { range: [64, 192] } } });
  });

  it("as Neuroglancer shows it otherwise: labels, masks", () => {
    expect(displayOf([newStep("threshold")], image)).toBeUndefined();
    expect(displayOf([{ ...newStep("python"), code: "#output uint32 label\n" }], image)).toBeUndefined();
  });

  it("named apart from the other layers", () => {
    expect(uniqueName("a", ["b"])).toBe("a");
    expect(uniqueName("a", ["a", "a 2"])).toBe("a 3");
  });
});

interface FakeLayer {
  name: string;
  type: string;
  source: unknown;
  [key: string]: unknown;
}

/**
 * A context with what the panel uses: Neuroglancer's layers (each with its
 * source's axes), patched as patchState does; the computed engine, whose
 * URLs carry their pipeline; the plugin's state; the selection.
 */
function fakeContext() {
  const ng: { layers: FakeLayer[]; selectedLayer?: { layer?: string } } = { layers: [] };
  const transforms = new Map<string, Pick<LayerTransform, "input"> | undefined>();
  let state: unknown;
  const listeners = { layers: new Set<() => void>(), workspace: new Set<() => void>(), state: new Set<() => void>(), computed: new Set<() => void>() };
  const on = (set: Set<() => void>) => (f: () => void) => (set.add(f), () => set.delete(f));
  const fire = (set: Set<() => void>) => [...set].forEach((f) => f());
  const pipelines = new Map<string, ComputedPipeline>();
  /** The engine's URL for a pipeline, held until `release` (to ask meanwhile). */
  let hold: Promise<void> | undefined;
  const patches: { quiet: boolean }[] = [];
  const invoked: string[] = [];
  const panels = new Map<string, (host: HTMLElement) => (() => void) | void>();
  let datasets = 0;
  const ctx = {
    subscriptions: [] as (() => void)[],
    viewer: {
      layers: () => ng.layers.map((l) => ({ name: l.name, type: l.type, visible: true, ready: true, sources: [] })),
      layerSpec: (name: string) => ng.layers.find((l) => l.name === name),
      layerTransform: (name: string) => transforms.get(name),
      onLayersChanged: on(listeners.layers),
      patchState: (edit: (ng: unknown) => void, options?: { quiet?: boolean }) => {
        edit(ng);
        patches.push({ quiet: options?.quiet === true });
        fire(listeners.layers);
      },
    },
    workspace: {
      onChanged: on(listeners.workspace),
      selectedLayer: () => ng.selectedLayer?.layer,
      addDataset: vi.fn((spec: { source: string; name: string; kind: string }) => {
        const name = uniqueName(spec.name, ng.layers.map((l) => l.name));
        ng.layers.push({ name, type: spec.kind, source: spec.source });
        const id = `d${++datasets}`;
        fire(listeners.layers);
        return id;
      }),
      sceneDatasets: () => [{ id: `d${datasets}`, layers: [{ name: ng.layers.at(-1)!.name }] }],
      computed: {
        url: async (p: ComputedPipeline) => {
          await hold;
          const url = `https://app/virtual/ngp/p${pipelines.size}/`;
          pipelines.set(url, structuredClone(p));
          return url;
        },
        pipelineOf: async (source: string) => pipelines.get(source),
        status: () => ({ status: "", computed: 0, dropped: 0, failed: 0, failure: null }),
        onChanged: on(listeners.computed),
        ownPython: (code: string) => code,
      },
    },
    state: {
      get: () => state,
      set: (v: unknown) => ((state = v), fire(listeners.state)),
      onChanged: on(listeners.state),
    },
    commands: { invoke: async (id: string) => void invoked.push(id) },
    ui: { panel: (id: string, render: (host: HTMLElement) => (() => void) | void) => (panels.set(id, render), () => panels.delete(id)) },
  };
  return {
    ctx: ctx as unknown as PlatformContext,
    ng,
    patches,
    invoked,
    pipelines,
    addDataset: ctx.workspace.addDataset,
    listeners: () => Object.values(listeners).reduce((n, s) => n + s.size, 0),
    /** Adds an image layer with these axes (a 3-D volume unless given; null: still loading). */
    image(name: string, t: Pick<LayerTransform, "input"> | null = VOLUME, extra: Record<string, unknown> = {}) {
      ng.layers.push({ name, type: "image", source: `zarr3://https://data/${name}.zarr`, ...extra });
      transforms.set(name, t ?? undefined);
      fire(listeners.layers);
    },
    select(name: string | undefined) {
      ng.selectedLayer = { layer: name };
      fire(listeners.workspace);
    },
    /** Holds the engine's answer until the returned function is called. */
    holdUrls(): () => void {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => ((hold = undefined), release());
    },
    async open(dom: FakeDom) {
      await plugin.activate(ctx as unknown as PlatformContext);
      const host = dom.host();
      const dispose = panels.get("filters.panel")!(host);
      return { host, dispose };
    },
  };
}

/** Lets the panel's promises (a pipeline read back, a URL worked out) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the Filters panel", () => {
  let dom: FakeDom;
  beforeEach(() => {
    dom = fakeDocument();
  });
  afterEach(() => dom.restore());

  it("offers to open data with no image it can filter, and says why the others are not offered", async () => {
    const f = fakeContext();
    const { host } = await f.open(dom);
    const empty = host.querySelector<HTMLElement>(".empty-state")!;
    expect(dom.text(empty)).toBe("No 3-D image to filter. Open data…");
    empty.querySelector("button")!.click();
    expect(f.invoked).toEqual(["dataset.add"]);

    f.image("photo", axes(["x", "m", 512], ["y", "m", 512]));
    f.image("rgb", axes(["x", "m", 9], ["y", "m", 9], ["z", "m", 9], ["c^", "", 3]));
    expect(empty.hidden).toBe(false);
    f.image("loading", null);
    // One still loading is neither offered nor listed, until it has loaded.
    expect(dom.text(host)).toContain("Not offered: photo (2-D), rgb (3 channels).");
    expect(dom.text(host)).not.toContain("Add filtered view");

    f.image("brain");
    expect(empty.hidden).toBe(true);
    const image = host.querySelector<HTMLSelectElement>("select")!;
    expect(image.getAttribute("aria-label")).toBe("Image");
    expect(Array.from(image.children).map((o) => o.textContent)).toEqual(["brain"]);
    expect(image.value).toBe("brain");
  });

  it("is built from cards and the shared controls, and updates in place", async () => {
    const f = fakeContext();
    f.image("brain");
    const { host } = await f.open(dom);
    expect(Array.from(host.querySelectorAll("details.card")).map((c) => c.getAttribute("data-card"))).toEqual(["filters.image", "filters.step.0"]);
    for (const s of host.querySelectorAll("select")) expect(s.className).toBe("text-input");
    const remove = host.querySelector<HTMLButtonElement>("button[aria-label=\"Remove this step\"]")!;
    expect(remove.className).toBe("btn icon");
    expect(remove.disabled).toBe(true);

    // Sigma: a slider, bounded.
    const sigma = host.querySelector(".slider")!.querySelector<HTMLInputElement>("input.num-input")!;
    expect(sigma.getAttribute("max")).toBe("10");
    dom.type(sigma, "500");
    expect((f.ctx.state.get() as { steps: Step[] }).steps[0].sigma).toBe(10);
    expect(host.querySelector(".card-badge")!.textContent).toBe("gaussian σ 10");

    // A second step, its filter changed: the cards stay, only its settings are drawn again.
    dom.find(host, "button", "Add step").click();
    expect(remove.disabled).toBe(false);
    const cards = host.querySelectorAll("details.card");
    const kind = cards[2].querySelector<HTMLSelectElement>("select")!;
    kind.value = "morphology";
    dom.fire(kind, "change");
    expect(host.querySelectorAll("details.card")).toEqual(cards);
    expect(dom.text(cards[2])).toContain("Open (removes small objects)");
    const radius = cards[2].querySelector<HTMLInputElement>("input.num-input")!;
    expect(radius.getAttribute("max")).toBe("15");

    // Undo brings the old steps back into the same controls.
    f.ctx.state.set({ image: "brain", steps: [{ kind: "gaussian", sigma: 2 }] });
    expect(host.querySelectorAll("details.card").length).toBe(2);
    expect(host.querySelector(".slider")!.querySelector<HTMLInputElement>("input.num-input")!.value).toBe("2");
  });

  it("adds a filtered view named and shown from the image asked for, even if it changes meanwhile", async () => {
    const f = fakeContext();
    f.image("brain", VOLUME, { shaderControls: { normalized: { range: [0, 900] } } });
    f.image("other");
    const { host } = await f.open(dom);
    const release = f.holdUrls();
    dom.find(host, "button", "Add filtered view").click();
    const image = host.querySelector<HTMLSelectElement>("select")!;
    image.value = "other";
    dom.fire(image, "change");
    release();
    await settle();
    expect(f.addDataset).toHaveBeenCalledWith({ source: "https://app/virtual/ngp/p0/", name: "brain (gaussian σ 1)", kind: "image" });
    expect([...f.pipelines.values()][0].source).toBe("zarr3://https://data/brain.zarr");
    const added = f.ng.layers.at(-1)!;
    expect(added.shaderControls).toEqual({ normalized: { range: [0, 900] } });
    // The look was set on the user's behalf, in the same undo step as the layer.
    expect(f.patches).toEqual([{ quiet: true }]);
    expect(host.querySelector<HTMLElement>(".status-line")!.hidden).toBe(true);
  });

  it("tunes a selected filtered view in place, as one undo step, rather than adding another", async () => {
    const f = fakeContext();
    f.image("brain");
    const { host } = await f.open(dom);
    dom.find(host, "button", "Add filtered view").click();
    await settle();
    expect(f.addDataset).toHaveBeenCalledTimes(1);

    // Another image selected: its steps are elsewhere, so the panel adds.
    f.select("brain");
    await settle();
    expect(dom.find(host, "button", "Add filtered view")).toBeTruthy();

    f.select("brain (gaussian σ 1)");
    await settle();
    expect(dom.text(host)).toContain("Tuning “brain (gaussian σ 1)”.");
    const sigma = host.querySelector(".slider")!.querySelector<HTMLInputElement>("input.num-input")!;
    dom.type(sigma, "3");
    dom.find(host, "button", "Update the view").click();
    await settle();
    expect(f.addDataset).toHaveBeenCalledTimes(1);
    expect(f.ng.layers.map((l) => l.name)).toEqual(["brain", "brain (gaussian σ 3)"]);
    const tuned = f.ng.layers[1];
    expect(tuned.source).toBe("https://app/virtual/ngp/p1/");
    expect(f.pipelines.get(tuned.source as string)!.ops).toEqual([{ op: "gaussian", sigma: 3 }]);
    expect(f.ng.selectedLayer?.layer).toBe("brain (gaussian σ 3)");
    // One edit the user made: an undo step of its own.
    expect(f.patches.at(-1)).toEqual({ quiet: false });
    // Still the layer tuned; Add as a new view adds one beside it.
    expect(dom.text(host)).toContain("Tuning “brain (gaussian σ 3)”.");
    dom.find(host, "button", "Add as a new view").click();
    await settle();
    expect(f.addDataset).toHaveBeenCalledTimes(2);
  });

  it("does not write the workspace for looking: a selected view's steps are shown, not saved", async () => {
    const f = fakeContext();
    f.image("brain");
    const { host } = await f.open(dom);
    dom.find(host, "button", "Add filtered view").click();
    await settle();
    f.ctx.state.set({ image: "brain", steps: [{ kind: "median", radius: 4 }] });
    f.select("brain (gaussian σ 1)");
    await settle();
    expect(host.querySelector(".card-badge")!.textContent).toBe("gaussian σ 1");
    expect(f.ctx.state.get()).toEqual({ image: "brain", steps: [{ kind: "median", radius: 4 }] });
  });

  it("reports a step left empty, and a failure, as errors until the steps change", async () => {
    const f = fakeContext();
    f.image("brain");
    const { host } = await f.open(dom);
    const status = host.querySelector<HTMLElement>(".status-line")!;
    f.ctx.state.set({ image: "brain", steps: [{ kind: "threshold", low: null }] });
    dom.find(host, "button", "Add filtered view").click();
    expect(dom.text(status)).toBe("Step 1 has an empty setting.");
    expect(f.addDataset).not.toHaveBeenCalled();
    dom.type(host.querySelector<HTMLInputElement>("input.num-input")!, "40");
    expect(status.hidden).toBe(true);
  });

  it("lets go of its listeners when switched off", async () => {
    const f = fakeContext();
    f.image("brain");
    const { dispose } = await f.open(dom);
    expect(f.listeners()).toBe(4);
    dispose?.();
    f.ctx.subscriptions.forEach((off) => off());
    expect(f.listeners()).toBe(0);
  });
});
