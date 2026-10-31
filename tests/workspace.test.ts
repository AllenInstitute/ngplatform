import { describe, expect, it } from "vitest";
import {
  addDataset,
  addScene,
  datasetKey,
  datasetOfLayer,
  emptyPlatform,
  layerForDataset,
  layersOf,
  moveScene,
  normaliseUrl,
  readPlatform,
  removeScene,
  renameScene,
  sceneDatasets,
  sourceUrls,
  switchScene,
  syncDatasets,
  uniqueName,
  unusedDatasets,
} from "../src/core/workspace.js";

let n = 0;
const ids = (prefix: string) => `${prefix}${++n}`;

const TRACTS = "https://bucket/store.zarrvectors/|zarr-vectors:";
const IMAGE = "precomputed://gs://b/image";

describe("layers and datasets", () => {
  it("reads layers in either list or object form", () => {
    expect(layersOf({ layers: [{ name: "a", source: "x" }] }).map((l) => l.name)).toEqual(["a"]);
    expect(layersOf({ layers: { a: "x", b: { source: "y" } } })).toEqual([
      { name: "a", source: "x" },
      { source: "y", name: "b" },
    ]);
    expect(layersOf({})).toEqual([]);
  });

  it("takes source URLs from strings, objects and lists", () => {
    expect(sourceUrls("a")).toEqual(["a"]);
    expect(sourceUrls({ url: "b", transform: {} })).toEqual(["b"]);
    expect(sourceUrls(["a", { url: "b" }, { other: 1 }, " "])).toEqual(["a", "b"]);
  });

  it("matches sources regardless of trailing slashes", () => {
    expect(normaliseUrl("https://x/store/|zarr-vectors:")).toBe("https://x/store|zarr-vectors:");
    expect(normaliseUrl(" https://x/store/ ")).toBe("https://x/store");
    expect(datasetKey({ source: "https://x/s/|zarr-vectors:" })).toBe(datasetKey({ source: { url: "https://x/s|zarr-vectors:" } }));
  });

  it("gives a layer without a data source its own dataset", () => {
    expect(datasetKey({ name: "notes", source: "local://annotations" })).toBe("layer:notes");
    expect(datasetKey({ name: "empty" })).toBe("layer:empty");
  });

  it("names uniquely", () => {
    expect(uniqueName("a", ["b"])).toBe("a");
    expect(uniqueName("a", ["a", "a 2"])).toBe("a 3");
  });

  it("records a dataset per source, and learns its kind once the layer resolves", () => {
    const ng = {
      layers: [
        { name: "tracts", type: "auto", source: TRACTS },
        { name: "tracts filtered", type: "auto", source: TRACTS },
        { name: "image", type: "image", source: IMAGE },
      ],
    };
    let p = syncDatasets(emptyPlatform(ids), ng, {}, ids);
    expect(p.datasets.map((d) => [d.name, d.kind])).toEqual([
      ["tracts", "auto"],
      ["image", "image"],
    ]);
    p = syncDatasets(p, ng, { tracts: "segmentation" }, ids);
    expect(p.datasets[0].kind).toBe("segmentation");
    const entries = sceneDatasets(p, ng);
    expect(entries.map((e) => [e.dataset.name, e.layers])).toEqual([
      ["tracts", ["tracts", "tracts filtered"]],
      ["image", ["image"]],
    ]);
    expect(datasetOfLayer(p, ng, "tracts filtered")?.name).toBe("tracts");
    // Unchanged input returns the same object, so callers can skip work.
    expect(syncDatasets(p, ng, { tracts: "segmentation" }, ids)).toBe(p);
  });

  it("adds a dataset once per source, and makes layers for it", () => {
    const first = addDataset(emptyPlatform(ids), IMAGE, "image", "image", ids);
    const again = addDataset(first.platform, IMAGE + "/", "copy", "image", ids);
    expect(again.dataset.id).toBe(first.dataset.id);
    expect(again.platform.datasets).toHaveLength(1);
    const spec = layerForDataset(first.dataset, { layers: [{ name: "image", source: "x" }] });
    expect(spec).toEqual({ type: "image", source: IMAGE, name: "image 2" });
  });

  it("lists datasets no scene shows", () => {
    let p = syncDatasets(emptyPlatform(ids), { layers: [{ name: "a", source: "x" }, { name: "b", source: "y" }] }, {}, ids);
    expect(unusedDatasets(p, { layers: [{ name: "a", source: "x" }] }).map((d) => d.name)).toEqual(["b"]);
    const added = addScene(p, { layers: [{ name: "a", source: "x" }] }, { copy: false }, ids);
    p = added.platform;
    // "a" is still shown by the (now inactive) first scene.
    expect(unusedDatasets(p, {}).map((d) => d.name)).toEqual(["b"]);
  });
});

describe("scenes", () => {
  const sceneA = { layers: [{ name: "a", source: "x" }], dimensions: { x: [1, "m"] }, layout: "xy" };

  it("adds an empty scene that keeps the space and layout, and a copy that keeps everything", () => {
    const p0 = emptyPlatform(ids);
    const empty = addScene(p0, sceneA, {}, ids);
    expect(empty.ng).toEqual({ dimensions: { x: [1, "m"] }, layout: "xy" });
    expect(empty.platform.scenes.map((s) => s.name)).toEqual(["Scene 1", "Scene 2"]);
    expect(empty.platform.activeScene).toBe(empty.id);
    // The scene left behind carries its state.
    expect(empty.platform.scenes[0].ng).toEqual(sceneA);
    const copy = addScene(p0, sceneA, { copy: true }, ids);
    expect(copy.ng).toEqual(sceneA);
    expect(copy.ng).not.toBe(sceneA);
    expect(copy.platform.scenes[1].name).toBe("Scene 1 copy");
  });

  it("switches scenes, storing the live state on the one left", () => {
    const p0 = emptyPlatform(ids);
    const first = p0.activeScene;
    const { platform: p1, id: second } = addScene(p0, sceneA, {}, ids);
    const liveB = { layers: [{ name: "b", source: "y" }] };
    const back = switchScene(p1, liveB, first);
    expect(back.ng).toEqual(sceneA);
    expect(back.platform.activeScene).toBe(first);
    expect(back.platform.scenes.find((s) => s.id === second)?.ng).toEqual(liveB);
    // The active scene never carries a stored state.
    expect(back.platform.scenes.find((s) => s.id === first)?.ng).toBeUndefined();
    expect(switchScene(back.platform, sceneA, first).platform).toBe(back.platform);
  });

  it("removes scenes, never the last, moving to a neighbour when it was active", () => {
    const p0 = emptyPlatform(ids);
    expect(removeScene(p0, sceneA, p0.activeScene).platform).toBe(p0);
    const { platform: p1, id: second } = addScene(p0, sceneA, {}, ids);
    const removed = removeScene(p1, {}, second);
    expect(removed.platform.scenes).toHaveLength(1);
    expect(removed.platform.activeScene).toBe(p0.activeScene);
    expect(removed.ng).toEqual(sceneA);
  });

  it("renames and reorders", () => {
    const p0 = emptyPlatform(ids);
    const { platform: p1, id } = addScene(p0, {}, {}, ids);
    expect(renameScene(p1, id, "  Left ").scenes[1].name).toBe("Left");
    expect(renameScene(p1, id, "  ").scenes[1].name).toBe("Scene 2");
    expect(moveScene(p1, id, 0).scenes.map((s) => s.id)).toEqual([id, p0.activeScene]);
  });

  it("repairs a platform record from a link", () => {
    expect(readPlatform({}).scenes).toHaveLength(1);
    const p = readPlatform({ platform: { scenes: [{ id: "s1", name: "A" }, { bogus: true }], activeScene: "nope", datasets: [{ id: "d", key: "k" }] } });
    expect(p.scenes).toEqual([{ id: "s1", name: "A" }]);
    expect(p.activeScene).toBe("s1");
    expect(p.datasets[0]).toMatchObject({ id: "d", key: "k", name: "k", kind: "auto" });
  });
});
