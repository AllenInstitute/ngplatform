/**
 * The workspace and viewer APIs plugins see, built over the store and the
 * engine.  They hand out plain data (names, ids, JSON), never Neuroglancer
 * objects.
 */
import { catalogueUrl, loadLookupTable, LOOKUP_TABLES, lookupTitle } from "../engine/lookup_tables.js";
import type { DatasetInfo, Json, LayerInfo, SceneDatasetInfo, ViewerApi, WorkspaceApi } from "../sdk/types.js";
import { allow, decodePipeline, engineSource, ownPython, pipelineCode } from "../virtual/computed.js";
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
      return p.scenes.map((s) => ({ id: s.id, name: s.name, active: s.id === p.activeScene, ...(s.kind !== undefined ? { kind: s.kind } : {}) }));
    },
    switchScene: (id) => store.switchScene(id),
    newScene: (options) => store.newScene(options),
    renameScene: (id, name) => store.renameScene(id, name),
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
    renameLayer: (name, newName) => store.renameLayer(name, newName),
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
    undoSteps: () => store.history.ends(),
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
      sourceFile: async (source) => (await wb.localData.sourceFile(source))?.file,
      send: (url, message) => wb.localData.send(url, message),
    },
    computed: {
      url: async (pipeline) => {
        const spec = { ...pipeline, source: engineSource(pipeline.source) };
        await allow(spec);
        return wb.computed.url(spec);
      },
      ownPython,
      pipelineOf: async (source) => {
        const code = pipelineCode(source);
        return code === undefined ? undefined : decodePipeline(code).catch(() => undefined);
      },
      status: () => wb.computed.status,
      onChanged: (callback) => wb.computed.onChange(callback),
    },
  };

  const viewer: ViewerApi = {
    getState: () => store.ng(),
    patchState: (edit, options) => store.patchState(edit, options),
    onStateChanged: (callback) => engine.onStateChanged(callback),
    layersGeneration: () => engine.layersGeneration(),
    statePart: (key) => engine.statePart(key),
    layers: layerInfos,
    layerSpec: (name) => engine.layerSpec(name),
    setLayerVisible: (name, visible) => store.setLayerVisible(name, visible),
    onLayersChanged: (callback) => engine.onLayersChanged(callback),
    cursor: () => {
      const c = engine.cursor();
      return { active: c.active, position: c.position, names: c.names, units: c.units, values: c.values };
    },
    onCursorChanged: (callback) => engine.onCursorChanged(callback),
    setPosition: (position, options) => (options?.quiet ? store.quietly(() => engine.setPosition(position)) : engine.setPosition(position)),
    localPosition: (layer) => engine.localPosition(layer),
    setLocalPosition: (layer, position, options) => (options?.quiet ? store.quietly(() => engine.setLocalPosition(layer, position)) : engine.setLocalPosition(layer, position)),
    segmentProperties: (layer) => engine.segmentProperties(layer),
    onSegmentPropertiesChanged: (layer, callback) => engine.onSegmentPropertiesChanged(layer, callback),
    setTemporaryVisibleSegments: (layer, ids) => engine.setTemporaryVisibleSegments(layer, ids),
    visibleSegments: (layer) => engine.visibleSegments(layer),
    segmentColour: (layer, id) => engine.segmentColour(layer, id),
    onSegmentsChanged: (layer, callback) => engine.onSegmentsChanged(layer, callback),
    hideLayerDrawing: (layer, hidden) => engine.hideDrawing(layer, hidden),
    annotationInProgress: () => engine.annotationInProgress(),
    setSurfaceOverlay: (layer, map) => engine.setSurfaceOverlay(layer, map),
    setTemporaryBackground: (rgb) => engine.setTemporaryBackground(rgb),
    draw3d: (layer, drawer) => engine.draw3d(layer, drawer),
    panels: () => engine.panels(),
    layerTransform: (layer) => engine.layerTransform(layer),
    setLayerTransform: (layer, matrix) => {
      engine.setLayerTransform(layer, matrix);
      store.scheduleSettle();
    },
    onRendered: (callback) => engine.onRendered(callback),
    reloadData: (url) => {
      // Every chunk source Neuroglancer has made is in its chunk manager's
      // memo, keyed by its options, which name the store's URL; a volume's
      // chunk sources (all its levels) are found by that.
      // Each is held a moment: the worker answers an invalidation with an
      // update, and a source let go before it arrives (a level scrolled out
      // of view) would leave Neuroglancer an update for nothing.
      const memo = (engine.viewer.chunkManager.memoize as unknown as { map: Map<string, { invalidateCache?(): void; addRef(): void; dispose(): void }> }).map;
      for (const [key, source] of memo) {
        if (!key.includes(url) || source.invalidateCache === undefined) continue;
        source.addRef();
        source.invalidateCache();
        setTimeout(() => source.dispose(), 2000);
      }
    },
    lookupTables: {
      catalogue: () => LOOKUP_TABLES.map((t) => ({ url: catalogueUrl(t), title: t.title, group: t.group, description: t.description, fetched: t.url !== undefined })),
      load: (url) => loadLookupTable(url),
      title: (url) => lookupTitle(url),
      of: (layer) => engine.lookupTable(layer),
      apply: async (layer, url) => {
        await engine.setLookupTable(layer, url);
        store.scheduleSettle();
      },
    },
  };

  return { workspace, viewer };
}
