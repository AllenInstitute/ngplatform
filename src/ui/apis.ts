/**
 * The workspace and viewer APIs plugins see, built over the store and the
 * engine.  They hand out plain data (names, ids, JSON), never Neuroglancer
 * objects.
 */
import type { DatasetInfo, Json, LayerInfo, SceneDatasetInfo, ViewerApi, WorkspaceApi } from "../sdk/types.js";
import type { Workbench } from "./workbench.js";

export function createPlatformApis(wb: Workbench): { workspace: WorkspaceApi; viewer: ViewerApi } {
  const { store, engine } = wb;
  const info = (d: { id: string; name: string; source: unknown; kind: string }): DatasetInfo => ({
    id: d.id,
    name: d.name,
    source: d.source,
    kind: d.kind,
  });
  const layerInfos = (): LayerInfo[] =>
    engine.layers().map((l) => ({
      name: l.name,
      type: l.type,
      visible: l.visible,
      sources: l.sources,
      ready: l.ready,
      error: l.error,
      dataset: store.datasetOfLayer(l.name)?.id,
    }));

  const workspace: WorkspaceApi = {
    scenes: () => {
      const p = store.state();
      return p.scenes.map((s) => ({ id: s.id, name: s.name, active: s.id === p.activeScene }));
    },
    switchScene: (id) => store.switchScene(id),
    newScene: (options) => store.newScene(options),
    datasets: () => store.datasets().map(info),
    sceneDatasets: (): SceneDatasetInfo[] => {
      const layers = new Map(layerInfos().map((l) => [l.name, l]));
      return store.sceneDatasets().map((entry) => {
        const shown = entry.layers.map((n) => layers.get(n)).filter((l): l is LayerInfo => l !== undefined);
        return { ...info(entry.dataset), layers: shown, visible: shown.some((l) => l.visible) };
      });
    },
    addDataset: (spec) => store.addDataset(spec),
    addLayer: (datasetId, layer?: Json, options?: { quiet?: boolean }) => {
      const name = store.showDataset(datasetId, layer ?? {}, options);
      if (name === undefined) throw new Error(`no dataset ${datasetId}`);
      return name;
    },
    removeDatasetFromScene: (id) => store.removeDatasetFromScene(id),
    removeLayer: (name) => store.removeLayer(name),
    renameLayer: (name, newName) => {
      store.renameLayer(name, newName);
      return engine.layers().some((l) => l.name === newName) ? newName : name;
    },
    selectedLayer: () => engine.selectedLayer(),
    selectLayer: (name) => store.selectLayer(name),
    selectedDataset: () => {
      const name = engine.selectedLayer();
      const dataset = name === undefined ? undefined : store.datasetOfLayer(name);
      return dataset && info(dataset);
    },
    onChanged: (callback) => {
      const offs = [store.onChange(callback), engine.onSelectionChanged(callback)];
      return () => offs.forEach((off) => off());
    },
    local: {
      locate: (url) => {
        const at = wb.localData.parse(url);
        return at === undefined ? undefined : { writable: wb.localData.writable(at.id) };
      },
      write: async (url, data) => {
        const at = wb.localData.parse(url);
        if (at === undefined) throw new Error(`${url} is not on this computer`);
        await wb.localData.write(at.id, at.path, data as BufferSource | string);
      },
      open: async (file, options) => (await wb.localData.openFile(file, options?.derived === true)).map(({ source, name, kind }) => ({ source, name, kind })),
      close: (source) => wb.localData.close(source),
    },
  };

  const viewer: ViewerApi = {
    getState: () => store.ng(),
    patchState: (edit, options) => store.patchState(edit, options),
    onStateChanged: (callback) => engine.onStateChanged(callback),
    layers: layerInfos,
    layerSpec: (name) => engine.layerSpec(name),
    setLayerVisible: (name, visible) => store.setLayerVisible(name, visible),
    onLayersChanged: (callback) => engine.onLayersChanged(callback),
    cursor: () => {
      const c = engine.cursor();
      return { active: c.active, position: c.position, names: c.names, units: c.units, values: c.values };
    },
    onCursorChanged: (callback) => engine.onCursorChanged(callback),
    setPosition: (position) => engine.setPosition(position),
    segmentProperties: (layer) => engine.segmentProperties(layer),
    onSegmentPropertiesChanged: (layer, callback) => engine.onSegmentPropertiesChanged(layer, callback),
    setTemporaryVisibleSegments: (layer, ids) => engine.setTemporaryVisibleSegments(layer, ids),
    draw3d: (layer, drawer) => engine.draw3d(layer, drawer),
    panels: () => engine.panels(),
    layerTransform: (layer) => engine.layerTransform(layer),
    setLayerTransform: (layer, matrix) => {
      engine.setLayerTransform(layer, matrix);
      store.scheduleSettle();
    },
    onRendered: (callback) => engine.onRendered(callback),
  };

  return { workspace, viewer };
}
