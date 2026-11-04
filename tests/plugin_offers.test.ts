/**
 * Offers of the plugins that are off: when each applies (plugins/offers.ts),
 * which are looked for and toasted (src/platform/plugin_offers.ts), and a
 * workspace naming a plugin that is off, its state kept.
 */
import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../plugins/index.js";
import { OFFERS, type OfferScene } from "../plugins/offers.js";
import {
  holdsState,
  listNames,
  loadOfferPrefs,
  offerCandidates,
  offersToToast,
  offWithState,
  saveOfferPrefs,
} from "../src/platform/plugin_offers.js";
import { resolveEnabled } from "../src/platform/plugin_switches.js";
import type { Json } from "../src/core/workspace.js";
import { type EngineLike, WorkspaceStore } from "../src/platform/workspace_store.js";

type Layer = OfferScene["layers"][number];

function scene(layers: Layer[], extra: Partial<OfferScene> & { files?: Record<string, unknown> } = {}): OfferScene & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    layers,
    hasTimeAxis: () => false,
    hasLookupTable: () => false,
    isLocal: (url) => url.includes("/local/"),
    json: async (url) => {
      fetched.push(url);
      return extra.files?.[url];
    },
    fetched,
    ...extra,
  };
}

const applies = (id: string, s: OfferScene) => Promise.resolve(OFFERS[id].applies(s));
const ids = (prefix: string) => `org.ngplatform.${prefix}`;

const TRK = { name: "tracts", type: "segmentation", sources: ["http://localhost/ngplatform/local/abc/brain.trk/|zarr-vectors:"] };
const IMAGE = { name: "T1", type: "image", sources: ["zarr://https://host/data/t1.ome.zarr/"] };
const LABELS = { name: "aseg", type: "segmentation", sources: ["https://host/data/aseg.ome.zarr/|zarr3:"] };

describe("when a plugin is offered", () => {
  it("offers Track filtering (and Luxar) for a tractogram or any Zarr Vectors store, not for a label volume", async () => {
    expect(await applies(ids("track-filtering"), scene([TRK]))).toBe(true);
    expect(await applies(ids("track-filtering"), scene([{ name: "s", type: "segmentation", sources: ["https://b/s.zarrvectors/"] }]))).toBe(true);
    expect(await applies(ids("luxar"), scene([TRK]))).toBe(true);
    expect(await applies(ids("track-filtering"), scene([IMAGE, LABELS]))).toBe(false);
    // A tractogram's layer is a segmentation layer to Neuroglancer: no Segmentation offer for it.
    expect(await applies(ids("segmentation"), scene([TRK]))).toBe(false);
  });

  it("offers Filters and Volume rendering for an image, Registration for two", async () => {
    expect(await applies(ids("filters"), scene([IMAGE]))).toBe(true);
    expect(await applies(ids("volume-view"), scene([IMAGE]))).toBe(true);
    expect(await applies(ids("registration"), scene([IMAGE]))).toBe(false);
    expect(await applies(ids("registration"), scene([IMAGE, { ...IMAGE, name: "T2" }]))).toBe(true);
    expect(await applies(ids("filters"), scene([TRK]))).toBe(false);
  });

  it("offers Segmentation for a label volume, Atlas when it has a lookup table", async () => {
    expect(await applies(ids("segmentation"), scene([LABELS]))).toBe(true);
    expect(await applies(ids("atlas"), scene([LABELS]))).toBe(false);
    expect(await applies(ids("atlas"), scene([LABELS], { hasLookupTable: (n) => n === "aseg" }))).toBe(true);
  });

  it("offers Annotations for an annotation layer", async () => {
    expect(await applies(ids("annotations"), scene([IMAGE]))).toBe(false);
    expect(await applies(ids("annotations"), scene([IMAGE, { name: "points", type: "annotation", sources: ["local://annotations"] }]))).toBe(true);
    // Not Track filtering's regions layer, which it writes from its groups.
    expect(await applies(ids("annotations"), scene([TRK, { name: "tracts regions", type: "annotation", sources: ["local://annotations"], managed: true }]))).toBe(false);
  });

  it("offers Time series for an image with a time axis, or a surface with a CIFTI series on this computer", async () => {
    expect(await applies(ids("time-series"), scene([IMAGE]))).toBe(false);
    expect(await applies(ids("time-series"), scene([IMAGE], { hasTimeAxis: (n) => n === "T1" }))).toBe(true);
    const surface = { name: "lh.white", type: "segmentation", sources: ["http://localhost/ngplatform/local/s1/lh.white/|zarr-vectors:"] };
    const header = "http://localhost/ngplatform/local/s1/lh.white/headers/surface/zarr.json";
    expect(await applies(ids("time-series"), scene([surface], { files: { [header]: { attributes: { maps: {} } } } }))).toBe(false);
    expect(await applies(ids("time-series"), scene([surface], { files: { [header]: { attributes: { time_series: { rest: {} } } } } }))).toBe(true);
    // Stores on the web are not asked for a header (CIFTI series come from this computer).
    const remote = scene([{ ...surface, sources: ["https://b/s.zarrvectors/|zarr-vectors:"] }]);
    expect(await applies(ids("time-series"), remote)).toBe(false);
    expect(remote.fetched).toEqual([]);
  });

  it("offers Orientations for an image with tensor or SH components, not for RGB", async () => {
    const url = "https://host/data/t1.ome.zarr/";
    const group = (c: number) => ({
      [`${url}zarr.json`]: { attributes: { ome: { multiscales: [{ axes: [{ name: "c", type: "channel" }, { name: "z" }, { name: "y" }, { name: "x" }], datasets: [{ path: "0" }] }] } } },
      [`${url}0/zarr.json`]: { shape: [c, 10, 10, 10] },
    });
    expect(await applies(ids("orientations"), scene([IMAGE], { files: group(6) }))).toBe(true);
    expect(await applies(ids("orientations"), scene([IMAGE], { files: group(45) }))).toBe(true);
    expect(await applies(ids("orientations"), scene([IMAGE], { files: group(3) }))).toBe(false);
    expect(await applies(ids("orientations"), scene([IMAGE]))).toBe(false);
  });

  it("offers Collections when a group above an image is an OME collection", async () => {
    const files = { "https://host/data/zarr.json": { attributes: { ome: { type: "collection", nodes: [] } } } };
    expect(await applies(ids("collections"), scene([IMAGE], { files }))).toBe(true);
    const none = scene([IMAGE]);
    expect(await applies(ids("collections"), none)).toBe(false);
    expect(none.fetched).toEqual(["https://host/data/zarr.json"]);
  });
});

describe("which offers are shown", () => {
  const entries = CATALOGUE.map((e) => ({ id: e.manifest.id, hasOffer: e.offer !== undefined }));
  const enabled = resolveEnabled(
    CATALOGUE.map((e) => e.manifest),
    {},
  ).enabled;
  const fresh = { off: false, dismissed: [], toasted: [] };

  it("looks for every tool that is off, except those said Not now to, and none once offers are off", () => {
    const candidates = offerCandidates(entries, enabled, fresh);
    expect(candidates).toContain(ids("track-filtering"));
    expect(candidates).not.toContain(ids("zarr-vectors"));
    expect(offerCandidates(entries, new Set([...enabled, ids("track-filtering")]), fresh)).not.toContain(ids("track-filtering"));
    expect(offerCandidates(entries, enabled, { ...fresh, dismissed: [ids("track-filtering")] })).not.toContain(ids("track-filtering"));
    expect(offerCandidates(entries, enabled, { ...fresh, off: true })).toEqual([]);
  });

  it("toasts an offer once per browser, only the ones worth a toast, and not one the workspace notice names", () => {
    const isToast = (id: string) => OFFERS[id]?.toast === true;
    const applicable = [ids("track-filtering"), ids("luxar"), ids("filters")];
    expect(offersToToast(applicable, isToast, fresh)).toEqual([ids("track-filtering")]);
    expect(offersToToast(applicable, isToast, { ...fresh, toasted: [ids("track-filtering")] })).toEqual([]);
    expect(offersToToast(applicable, isToast, fresh, [ids("track-filtering")])).toEqual([]);
  });

  it("keeps Not now, offers off and toasts shown in this browser", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(loadOfferPrefs(storage)).toEqual(fresh);
    saveOfferPrefs({ off: true, dismissed: ["a"], toasted: ["b"] }, storage);
    expect(loadOfferPrefs(storage)).toEqual({ off: true, dismissed: ["a"], toasted: ["b"] });
    data.set("ngplatform.offers", "not json");
    expect(loadOfferPrefs(storage)).toEqual(fresh);
  });

  it("names plugins in a sentence", () => {
    expect(listNames(["A"])).toBe("A");
    expect(listNames(["A", "B"])).toBe("A and B");
    expect(listNames(["A", "B", "C"])).toBe("A, B and C");
  });
});

class Engine implements EngineLike {
  ng: Json = {};
  private listeners = new Set<() => void>();
  getState = () => structuredClone(this.ng);
  setState(ng: Json) {
    this.ng = structuredClone(ng);
    for (const l of this.listeners) l();
  }
  onStateChanged(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  onLayersChanged = () => () => {};
  layers = () => ((this.ng.layers as Json[] | undefined) ?? []).map((l) => ({ name: String(l.name), type: String(l.type ?? "image"), visible: true, ready: true }));
  layerSpec = (name: string) => ((this.ng.layers as Json[] | undefined) ?? []).find((l) => l.name === name);
  addLayer(spec: Json) {
    this.setState({ ...this.ng, layers: [...((this.ng.layers as Json[] | undefined) ?? []), spec] });
    return String(spec.name);
  }
  removeLayer() {}
  renameLayer(_: string, n: string) {
    return n;
  }
  setLayerVisible() {}
  moveLayer() {}
  selectedLayer = () => undefined;
  selectLayer() {}
}

describe("a workspace naming a plugin that is off", () => {
  const manifests = CATALOGUE.map((e) => e.manifest);
  const enabled = resolveEnabled(manifests, {}).enabled;
  const groups = { version: 2, data: { editing: "cc", groups: [{ id: "cc", name: "Corpus callosum", rois: [] }] } };
  const labels = { version: 1, data: { layers: { points: { fields: [] } } } };

  it("names Track filtering and Annotations, keeps their state through edits and in the link", () => {
    const store = new WorkspaceStore(new Engine(), { framed: false, log: () => {}, settleDelay: 1, writeUrl: () => {} });
    store.open({ ng: { layers: [{ name: "img", type: "image", source: "precomputed://gs://b/i" }] }, app: { trackFiltering: groups, labels, luxar: { version: 1, data: {} } } }, "a link");
    store.noteInput();
    const off = offWithState(manifests, enabled, (key) => store.rawSlice(key));
    // Luxar's slice is empty: nothing to say of it.
    expect(off.sort()).toEqual([ids("annotations"), ids("track-filtering")]);
    expect(offWithState(manifests, new Set([...enabled, ids("track-filtering")]), (key) => store.rawSlice(key))).toEqual([ids("annotations")]);
    // An edit, a new scene and back: the plugins' state is still there, and in the link.
    store.addDataset({ source: "precomputed://gs://b/j", name: "j" });
    store.newScene({});
    store.switchScene(store.state().scenes[0].id);
    const link = JSON.parse(store.serialize());
    expect(link.app.trackFiltering).toEqual(groups);
    expect(link.app.labels).toEqual(labels);
  });

  it("counts an empty slice as nothing", () => {
    expect(holdsState(undefined)).toBe(false);
    expect(holdsState({})).toBe(false);
    expect(holdsState([])).toBe(false);
    expect(holdsState({ groups: [] })).toBe(true);
    expect(holdsState(0)).toBe(true);
  });
});
