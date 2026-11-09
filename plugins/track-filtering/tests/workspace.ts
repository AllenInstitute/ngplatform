/**
 * A context over the workspace store itself (as the shell makes one), for
 * what depends on its undo steps: one annotation layer of three points
 * along x, 1 mm voxels.
 */
import type { Json, PlatformContext } from "@ngplatform/sdk";
import { WorkspaceStore } from "../../../src/platform/workspace_store.js";
import { FakeEngine } from "../../../tests/fake_engine.js";
import { FILTERING_STATE_KEY } from "../manifest.js";

export const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A workspace of one annotation layer (points along x, 1 mm voxels), and a context over the store as the shell makes one. */
export function workspace() {
  const engine = new FakeEngine();
  const store = new WorkspaceStore(engine, { framed: false, log: () => {}, settleDelay: 1, writeUrl: () => {} });
  const points = [0, 3, 50].map((x, i) => ({ type: "point", id: `p${i}`, point: [x, 0, 0] }));
  store.open(
    {
      ng: {
        dimensions: { x: [1e-3, "m"], y: [1e-3, "m"], z: [1e-3, "m"] },
        position: [0, 0, 0],
        crossSectionScale: 0.1,
        layers: [{ name: "marks", type: "annotation", source: "local://annotations", annotations: points }],
      },
      app: {},
    },
    "test",
  );
  const sourcesOf = (spec: Json | undefined) => {
    const source = spec?.source as unknown;
    return [typeof source === "string" ? source : String((source as { url?: string } | undefined)?.url ?? "")];
  };
  const layers = () => engine.layers().map((l) => ({ ...l, sources: sourcesOf(engine.layerSpec(l.name)) }));
  const none = () => () => {};
  const ctx = {
    state: {
      get: () => store.rawSlice(FILTERING_STATE_KEY, 2),
      set: (value: unknown) => store.setRawSlice(FILTERING_STATE_KEY, 2, value),
      onChanged: (callback: () => void) => store.onSliceChanged(callback),
    },
    workspace: {
      sceneDatasets: () =>
        store.sceneDatasets().map((e) => ({ ...e.dataset, layers: layers().filter((l) => e.layers.includes(l.name)), visible: true })),
      selectedDataset: () => undefined,
      addLayer: (id: string, layer?: Json, options?: { quiet?: boolean }) => store.showDataset(id, layer ?? {}, options)!,
      renameLayer: (name: string, to: string) => store.renameLayer(name, to),
      removeLayer: (name: string) => store.removeLayer(name),
      onChanged: (callback: () => void) => store.onChange(callback),
      local: { locate: () => undefined },
    },
    viewer: {
      getState: () => engine.getState(),
      layerSpec: (name: string) => engine.layerSpec(name),
      layers,
      patchState: (edit: (ng: Json) => void, options?: { quiet?: boolean }) => store.patchState(edit, options),
      onStateChanged: (callback: () => void) => engine.onStateChanged(callback),
      onLayersChanged: none,
      onSegmentPropertiesChanged: none,
      segmentProperties: () => undefined,
      setTemporaryVisibleSegments: () => {},
      setLayerVisible: (name: string, visible: boolean) => store.setLayerVisible(name, visible),
    },
    runner: { onChanged: none, available: () => false },
    ui: { toast: () => {}, showPanel: () => {} },
    log: { info: () => {}, error: () => {} },
  };
  return { engine, store, ctx: ctx as unknown as PlatformContext };
}
