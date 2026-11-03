/**
 * The workspace store against a fake engine: scenes, datasets, undo and the
 * link, with no viewer.
 */
import { describe, expect, it } from "vitest";
import type { Json } from "../src/core/workspace.js";
import { type EngineLike, WorkspaceStore } from "../src/platform/workspace_store.js";

class FakeEngine implements EngineLike {
  ng: Json = {};
  selected: string | undefined;
  setStateCalls = 0;
  private listeners = new Set<() => void>();

  private layerList(): Json[] {
    return (this.ng.layers as Json[] | undefined) ?? [];
  }
  private changed() {
    for (const l of this.listeners) l();
  }
  getState(): Json {
    return structuredClone(this.ng);
  }
  setState(ng: Json): void {
    this.setStateCalls++;
    this.ng = structuredClone(ng);
    this.changed();
  }
  onStateChanged(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  onLayersChanged() {
    return () => {};
  }
  layers() {
    return this.layerList().map((l) => ({
      name: String(l.name),
      type: l.type === "auto" ? "image" : String(l.type ?? "image"),
      visible: l.visible !== false,
      ready: true,
    }));
  }
  layerSpec(name: string) {
    return this.layerList().find((l) => l.name === name);
  }
  addLayer(spec: Json, options: { index?: number; select?: boolean } = {}) {
    const layers = this.layerList();
    layers.splice(options.index ?? layers.length, 0, spec);
    this.ng = { ...this.ng, layers };
    if (options.select) this.selected = String(spec.name);
    this.changed();
    return String(spec.name);
  }
  removeLayer(name: string) {
    this.ng = { ...this.ng, layers: this.layerList().filter((l) => l.name !== name) };
    this.changed();
  }
  renameLayer(name: string, newName: string) {
    this.ng = { ...this.ng, layers: this.layerList().map((l) => (l.name === name ? { ...l, name: newName } : l)) };
    this.changed();
    return newName;
  }
  setLayerVisible(name: string, visible: boolean) {
    this.ng = { ...this.ng, layers: this.layerList().map((l) => (l.name === name ? { ...l, visible } : l)) };
    this.changed();
  }
  moveLayer(name: string, index: number) {
    const layers = this.layerList();
    const from = layers.findIndex((l) => l.name === name);
    const [layer] = layers.splice(from, 1);
    layers.splice(index, 0, layer);
    this.ng = { ...this.ng, layers };
    this.changed();
  }
  selectedLayer() {
    return this.selected;
  }
  selectLayer(name: string | undefined) {
    this.selected = name;
  }
}

function setup() {
  const engine = new FakeEngine();
  const urls: string[] = [];
  const store = new WorkspaceStore(engine, { framed: false, log: () => {}, settleDelay: 1, writeUrl: (h) => urls.push(h) });
  return { engine, store, urls };
}

const IMAGE = "precomputed://gs://b/image";
const TRACTS = "https://b/s.zarrvectors/|zarr-vectors:";

describe("WorkspaceStore", () => {
  it("opens a plain Neuroglancer state as one scene with its datasets", () => {
    const { store, urls } = setup();
    store.open({ ng: { layers: [{ name: "img", type: "image", source: IMAGE }] }, app: {} }, "test");
    store.noteInput();
    expect(store.state().scenes).toHaveLength(1);
    expect(store.datasets().map((d) => d.name)).toEqual(["img"]);
    expect(urls.at(-1)).toMatch(/^#!/);
    const link = JSON.parse(decodeURI(urls.at(-1)!.slice(2)).replace(/%2C/g, ","));
    expect(link.ng.layers[0].source).toBe(IMAGE);
    expect(link.app.platform.datasets[0].name).toBe("img");
  });

  it("adds datasets as layers, toggles and renames them, and removes them from the scene only", () => {
    const { store, engine } = setup();
    store.open({ ng: {}, app: {} }, "test");
    store.noteInput();
    const id = store.addDataset({ source: TRACTS, name: "tracts" });
    expect(engine.selected).toBe("tracts");
    store.setDatasetVisible(id, false);
    expect(engine.layers()[0].visible).toBe(false);
    store.renameDataset(id, "Hemisphere");
    expect(engine.layers()[0].name).toBe("Hemisphere");
    const view = store.addLayerView(id, "Hemisphere");
    expect(view).toBe("Hemisphere (view)");
    expect(store.sceneDatasets()[0].layers).toEqual(["Hemisphere", "Hemisphere (view)"]);
    store.removeDatasetFromScene(id);
    expect(engine.layers()).toEqual([]);
    expect(store.datasetsNotInScene().map((d) => d.name)).toEqual(["Hemisphere"]);
    store.showDataset(id);
    expect(engine.layers().map((l) => l.name)).toEqual(["Hemisphere"]);
  });

  it("keeps each scene's state when switching, and shares datasets across scenes", () => {
    const { store, engine } = setup();
    store.open({ ng: { layers: [{ name: "img", type: "image", source: IMAGE }], layout: "xy" }, app: {} }, "test");
    store.noteInput();
    const first = store.state().activeScene;
    const second = store.newScene();
    expect(engine.ng).toEqual({ layout: "xy" });
    const tracts = store.addDataset({ source: TRACTS, name: "tracts" });
    store.switchScene(first);
    expect(engine.layers().map((l) => l.name)).toEqual(["img"]);
    store.showDataset(tracts);
    expect(store.sceneDatasets().map((d) => d.dataset.name)).toEqual(["img", "tracts"]);
    store.switchScene(second);
    expect(engine.layers().map((l) => l.name)).toEqual(["tracts"]);
    // The whole workspace survives a round trip through its link.
    const { store: reopened, engine: engine2 } = setup();
    reopened.open(JSON.parse(store.serialize()), "link");
    expect(reopened.state().scenes.map((s) => s.name)).toEqual(["Scene 1", "Scene 2"]);
    expect(engine2.layers().map((l) => l.name)).toEqual(["tracts"]);
    reopened.switchScene(first);
    expect(engine2.layers().map((l) => l.name)).toEqual(["img", "tracts"]);
  });

  it("undoes and redoes scene and dataset changes", () => {
    const { store, engine } = setup();
    store.open({ ng: {}, app: {} }, "test");
    store.noteInput();
    store.addDataset({ source: IMAGE, name: "img" });
    store.newScene({ name: "Other" });
    expect(store.state().scenes).toHaveLength(2);
    expect(store.undo()).toBe(true);
    expect(store.state().scenes).toHaveLength(1);
    expect(engine.layers().map((l) => l.name)).toEqual(["img"]);
    expect(store.undo()).toBe(true);
    expect(engine.layers()).toEqual([]);
    expect(store.redo()).toBe(true);
    expect(engine.layers().map((l) => l.name)).toEqual(["img"]);
  });

  it("deletes a dataset from every scene", () => {
    const { store, engine } = setup();
    store.open({ ng: {}, app: {} }, "test");
    store.noteInput();
    const id = store.addDataset({ source: IMAGE, name: "img" });
    store.newScene({ copy: true });
    store.deleteDataset(id);
    expect(engine.layers()).toEqual([]);
    store.switchScene(store.state().scenes[0].id);
    expect(engine.layers()).toEqual([]);
    expect(store.datasets()).toEqual([]);
  });

  it("opens a state as a new scene beside the current ones", () => {
    const { store, engine } = setup();
    store.open({ ng: { layers: [{ name: "img", source: IMAGE }] }, app: {} }, "test");
    store.noteInput();
    store.openAsScene({ layers: [{ name: "t", source: TRACTS }] }, "From link", "a link");
    expect(store.state().scenes.map((s) => s.name)).toEqual(["Scene 1", "From link"]);
    expect(engine.layers().map((l) => l.name)).toEqual(["t"]);
  });

  it("keeps plugin slices in the workspace, undoably", () => {
    const { store } = setup();
    store.open({ ng: {}, app: {} }, "test");
    store.noteInput();
    store.setRawSlice("org.x", 1, { a: 1 });
    expect(store.rawSlice("org.x")).toEqual({ a: 1 });
    expect(JSON.parse(store.serialize()).app["org.x"]).toEqual({ version: 1, data: { a: 1 } });
    store.undo();
    expect(store.rawSlice("org.x")).toBeUndefined();
  });
});

describe("undo granularity", () => {
  it("does not make selecting a layer an undo step", () => {
    const { store, engine } = setup();
    store.open({ ng: { layers: [{ name: "a", source: IMAGE }] }, app: {} }, "test");
    store.noteInput();
    store.setLayerVisible("a", false);
    store.settle();
    engine.setState({ ...engine.ng, selectedLayer: { layer: "a" } });
    store.settle();
    expect(store.undo()).toBe(true);
    expect(engine.layers()[0].visible).toBe(true);
  });
  it("does not make a quiet edit (a plugin's, on the user's behalf) an undo step", () => {
    const { store, engine } = setup();
    store.open({ ng: { layers: [{ name: "a", source: IMAGE }], layout: "xy" }, app: {} }, "test");
    store.noteInput();
    store.patchState((ng) => {
      ng.layout = "3d";
    });
    store.patchState(
      (ng) => {
        (ng.layers as Json[])[0].source = [IMAGE, "http://app/local/derived-0123abcd/g.trk/|zarr-vectors:"];
      },
      { quiet: true },
    );
    // Undo undoes the user's layout, not the plugin's source.
    expect(store.undo()).toBe(true);
    expect(engine.ng.layout).toBe("xy");
    // The derived source does not make the layer a dataset of its own.
    expect(store.datasets().length).toBe(1);
  });
});

describe("quiet changes", () => {
  it("makes a run of quiet moves (playing through time) no undo step, and the user's next change its own", () => {
    const { store, engine } = setup();
    store.open({ ng: { layers: [{ name: "a", source: IMAGE }], position: [0, 0, 0, 0] }, app: {} }, "test");
    store.noteInput();
    store.patchState((ng) => {
      ng.layout = "3d";
    });
    store.settle();
    for (let t = 1; t <= 5; ++t) {
      store.quietly(() => engine.setState({ ...engine.ng, position: [t, 0, 0, 0] }));
      // Settling between moves (a slow rate) still adds no step.
      if (t % 2 === 0) store.settle();
    }
    store.settle();
    expect(store.historyRows().map((r) => r.label)).toEqual(["Opened", "Layout: 3d"]);
    // The link has the position shown.
    expect(JSON.parse(store.serialize()).ng.position).toEqual([5, 0, 0, 0]);
    // A quiet move still settling is settled before the user's input, which is then a step of its own.
    store.quietly(() => engine.setState({ ...engine.ng, position: [6, 0, 0, 0] }));
    store.noteInput();
    store.setLayerVisible("a", false);
    store.settle();
    expect(store.historyRows()).toHaveLength(3);
    expect(store.undo()).toBe(true);
    expect(engine.layers()[0].visible).toBe(true);
    expect(engine.ng.position).toEqual([6, 0, 0, 0]);
    expect(store.undo()).toBe(true);
    expect(engine.ng.layout).toBeUndefined();
  });

  it("records a change of the user's still settling before a quiet move", () => {
    const { store, engine } = setup();
    store.open({ ng: { layers: [{ name: "a", source: IMAGE }], position: [0, 0, 0] }, app: {} }, "test");
    store.noteInput();
    store.patchState((ng) => {
      ng.layout = "3d";
    });
    store.quietly(() => engine.setState({ ...engine.ng, position: [1, 0, 0] }));
    store.settle();
    expect(store.historyRows().map((r) => r.label)).toEqual(["Opened", "Layout: 3d"]);
    expect(store.undo()).toBe(true);
    expect(engine.ng.layout).toBeUndefined();
  });
});

describe("opening", () => {
  it("counts what follows opening on its own as part of opening, until the user acts", () => {
    const { store, engine } = setup();
    store.open({ ng: { layers: [{ name: "a", source: IMAGE, type: "auto" }] }, app: {} }, "test");
    // The engine resolves the layer's type: not a step.
    engine.setState({ ...engine.ng, layers: [{ name: "a", source: IMAGE, type: "image" }] });
    store.settle();
    expect(store.historyRows().map((r) => r.label)).toEqual(["Opened"]);
    store.noteInput();
    store.patchState((ng) => {
      ng.layout = "3d";
    });
    store.settle();
    expect(store.historyRows().map((r) => r.label)).toEqual(["Opened", "Layout: 3d"]);
    expect(store.goToHistory(0)).toBe(true);
    expect(engine.ng.layout).toBeUndefined();
    expect(store.historyRows().map((r) => r.state)).toEqual(["current", "undone"]);
  });
});

describe("sign-ins", () => {
  it("rewrites a layer's source as one undo step, in the link, keeping its dataset", () => {
    const { store, engine, urls } = setup();
    store.open({ ng: { layers: [{ name: "img", type: "image", source: IMAGE }] }, app: {} }, "test");
    store.noteInput();
    store.setLayerSource("img", "precomputed://gs+google://b/image", "Sign-in for “img”: Google");
    expect(engine.ng.layers).toEqual([{ name: "img", type: "image", source: "precomputed://gs+google://b/image" }]);
    expect(store.datasets().map((d) => [d.name, d.source])).toEqual([["img", "precomputed://gs+google://b/image"]]);
    expect(decodeURIComponent(urls.at(-1)!)).toContain("gs+google://b/image");
    expect(store.historyRows().map((r) => r.label)).toEqual(["Opened", "Sign-in for “img”: Google"]);
    expect(store.undo()).toBe(true);
    expect((engine.ng.layers as Json[])[0].source).toBe(IMAGE);
    expect(store.datasets()).toHaveLength(1);
  });

  it("points layers and datasets at local data opened again under a new id, as one step", () => {
    const { store, engine } = setup();
    const OLD = "https://app/local/aaa/";
    const NEW = "https://app/local/bbb/";
    store.open({ ng: { layers: [{ name: "t", type: "segmentation", source: `${OLD}t.trk/|zarr-vectors:` }, { name: "img", type: "image", source: IMAGE }] }, app: {} }, "test");
    store.noteInput();
    expect(store.relinkSources(OLD, NEW, "Local data opened again")).toBe(1);
    expect((engine.ng.layers as Json[]).map((l) => l.source)).toEqual([`${NEW}t.trk/|zarr-vectors:`, IMAGE]);
    expect(store.datasets().find((d) => d.name === "t")?.source).toBe(`${NEW}t.trk/|zarr-vectors:`);
    expect(store.historyRows().map((r) => r.label)).toEqual(["Opened", "Local data opened again"]);
    expect(store.relinkSources(OLD, NEW, "again")).toBe(0);
  });
});
