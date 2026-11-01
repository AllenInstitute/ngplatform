/**
 * The workspace store: the one place workspace state changes.
 *
 * It owns the `{ng, app}` loop: Neuroglancer's state for the active scene,
 * the platform's scenes and datasets, and every plugin's slice of `app`.
 * Each settled change becomes one undo step and is written to the address
 * bar.  Scenes, datasets and layers are changed through its methods, never
 * by reaching into the viewer, so a later "dataset" can differ from the
 * layers that show it without the UI noticing.
 */
import { type SliceSpec, readSlice, writeSlice } from "../core/app_state.js";
import { StateHistory } from "../core/history.js";
import { encodeFragment, type WorkspaceState } from "../core/state_io.js";
import {
  activeScene,
  addDataset as addDatasetRecord,
  addScene,
  type DatasetRecord,
  datasetKey,
  datasetOfLayer,
  emptyPlatform,
  forgetDataset,
  type Json,
  layerForDataset,
  layersOf,
  moveScene,
  PLATFORM_KEY,
  type PlatformState,
  readPlatform,
  removeScene,
  renameDataset,
  renameScene,
  type SceneDataset,
  sceneDatasets,
  switchScene,
  syncDatasets,
  uniqueName,
  unusedDatasets,
} from "../core/workspace.js";

/** What the store needs from the engine (the real one, or a fake in tests). */
export interface EngineLike {
  getState(): Json;
  setState(ng: Json): void;
  onStateChanged(callback: () => void): () => void;
  onLayersChanged(callback: () => void): () => void;
  layers(): { name: string; type: string; visible: boolean; ready: boolean }[];
  layerSpec(name: string): Json | undefined;
  addLayer(spec: Json, options?: { index?: number; select?: boolean }): string;
  removeLayer(name: string): void;
  renameLayer(name: string, newName: string): string | undefined;
  setLayerVisible(name: string, visible: boolean): void;
  moveLayer(name: string, index: number): void;
  selectedLayer(): string | undefined;
  selectLayer(name: string | undefined): void;
}

export interface StoreOptions {
  /** Inside a frame the address bar cannot carry the state. */
  framed: boolean;
  log(message: string, level?: "info" | "ok" | "error"): void;
  /** Settle delay after the last change, in ms. */
  settleDelay?: number;
  /** Where the link goes; replaced in tests. */
  writeUrl?: (hash: string) => void;
}

export class WorkspaceStore {
  readonly history = new StateHistory();
  private app: Json = {};
  private platform: PlatformState = emptyPlatform();
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHash = "";
  private lastEditKey: string | undefined;
  private listeners = new Set<() => void>();
  private sliceListeners = new Set<() => void>();

  constructor(
    readonly engine: EngineLike,
    private readonly options: StoreOptions,
  ) {
    engine.onStateChanged(() => this.scheduleSettle());
    // A layer's type resolves once its source loads: the dataset learns its kind.
    engine.onLayersChanged(() => this.scheduleSettle());
  }

  // ------------------------------------------------------------- reading

  /** The active scene's Neuroglancer state. */
  ng(): Json {
    return this.engine.getState();
  }

  state(): PlatformState {
    return this.platform;
  }

  /** The workspace as a link carries it. */
  workspace(): WorkspaceState {
    return { ng: this.ng(), app: this.appWithPlatform() };
  }

  serialize(): string {
    return JSON.stringify(this.workspace());
  }

  /** The active scene's datasets with their layers. */
  sceneDatasets(): SceneDataset[] {
    return sceneDatasets(this.platform, this.ng());
  }

  datasets(): DatasetRecord[] {
    return this.platform.datasets;
  }

  dataset(id: string): DatasetRecord | undefined {
    return this.platform.datasets.find((d) => d.id === id);
  }

  datasetOfLayer(layer: string): DatasetRecord | undefined {
    return datasetOfLayer(this.platform, this.ng(), layer);
  }

  /** Datasets in the workspace that the active scene does not show. */
  datasetsNotInScene(): DatasetRecord[] {
    const shown = new Set(this.sceneDatasets().map((d) => d.dataset.id));
    return this.platform.datasets.filter((d) => !shown.has(d.id));
  }

  /** The names of the other scenes that show a dataset. */
  scenesShowing(id: string): string[] {
    const dataset = this.dataset(id);
    if (dataset === undefined) return [];
    return this.platform.scenes
      .filter((s) => s.id !== this.platform.activeScene && layersOf(s.ng ?? {}).some((l) => datasetKey(l) === dataset.key))
      .map((s) => s.name);
  }

  /** A new, empty annotation layer that annotations can be drawn into. */
  newAnnotationLayer(name = "annotations"): string {
    const taken = layersOf(this.ng()).map((l) => String(l.name));
    const added = this.engine.addLayer({ type: "annotation", source: "local://annotations", name: uniqueName(name, taken), tool: "annotatePoint" }, { select: true });
    this.settle();
    this.options.log(`Added the annotation layer “${added}”. Ctrl+click in a view to place a point; other shapes are in its Annotations tab.`, "ok");
    return added;
  }

  unusedDatasets(): DatasetRecord[] {
    return unusedDatasets(this.platform, this.ng());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.error("ngplatform listener failed", e);
      }
    }
  }

  private appWithPlatform(): Json {
    return { ...this.app, [PLATFORM_KEY]: this.platform };
  }

  // ------------------------------------------------------------ the loop

  scheduleSettle(): void {
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settle(), this.options.settleDelay ?? 400);
  }

  /** Records a settled state: one undo step, and the address bar updated. */
  settle(): void {
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    const ng = this.ng();
    const types = Object.fromEntries(this.engine.layers().map((l) => [l.name, l.type]));
    this.platform = syncDatasets(this.platform, ng, types);
    const workspace = { ng, app: this.appWithPlatform() };
    const snapshot = JSON.stringify(workspace);
    // Selecting a layer or pinning a pick is not an edit: it updates the
    // current undo entry instead of adding one.
    const editKey = editSignature(workspace);
    if (this.lastEditKey !== undefined && editKey === this.lastEditKey && !this.history.isAdopting) {
      this.history.replaceCurrent(snapshot);
    } else {
      this.history.record(snapshot);
    }
    this.lastEditKey = editKey;
    if (!this.options.framed) {
      const hash = "#!" + encodeFragment(JSON.stringify(workspace));
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        (this.options.writeUrl ?? defaultWriteUrl)(hash);
      }
    }
    this.notify();
  }

  /** The hash this store last wrote, so the shell can ignore its own hash changes. */
  get currentHash(): string {
    return this.lastHash;
  }

  private apply(state: WorkspaceState): void {
    const { [PLATFORM_KEY]: _platform, ...rest } = state.app;
    this.app = rest;
    this.platform = readPlatform(state.app);
    this.engine.setState(state.ng);
    this.notifySlices();
  }

  /** Replaces the whole workspace. */
  open(state: WorkspaceState, from: string): void {
    this.apply(state);
    this.settle();
    const n = layersOf(state.ng).length;
    const scenes = this.platform.scenes.length;
    this.options.log(
      `Opened ${n} layer${n === 1 ? "" : "s"}${scenes > 1 ? ` and ${scenes} scenes` : ""} from ${from}.`,
      "ok",
    );
  }

  /** Opens a Neuroglancer state as a new scene beside the current ones. */
  openAsScene(ng: Json, name: string, from: string): void {
    const { platform, ng: _empty } = addScene(this.platform, this.ng(), { name });
    this.platform = platform;
    this.engine.setState(ng);
    this.settle();
    this.options.log(`Opened ${from} as the scene “${activeScene(this.platform).name}”.`, "ok");
  }

  undo(): boolean {
    this.settle();
    return this.restore(this.history.undo(), "Undid the last change.");
  }

  redo(): boolean {
    return this.restore(this.history.redo(), "Redid the change.");
  }

  private restore(snapshot: string | undefined, verb: string): boolean {
    if (snapshot === undefined) return false;
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.apply(JSON.parse(snapshot) as WorkspaceState);
    this.settle();
    this.options.log(verb);
    return true;
  }

  /** Edits the active scene's state; only what changed is applied. */
  patchState(edit: (ng: Json) => void): void {
    const ng = structuredClone(this.ng());
    edit(ng);
    this.engine.setState(ng);
    this.scheduleSettle();
  }

  // -------------------------------------------------------------- scenes

  private changePlatform(platform: PlatformState, ng?: Json): void {
    this.platform = platform;
    if (ng !== undefined) this.engine.setState(ng);
    this.settle();
  }

  switchScene(id: string): void {
    if (id === this.platform.activeScene) return;
    const { platform, ng } = switchScene(this.platform, this.ng(), id);
    this.changePlatform(platform, ng);
  }

  newScene(options: { copy?: boolean; name?: string } = {}): string {
    const { platform, ng, id } = addScene(this.platform, this.ng(), options);
    this.changePlatform(platform, ng);
    this.options.log(`Added the scene “${activeScene(this.platform).name}”.`);
    return id;
  }

  renameScene(id: string, name: string): void {
    this.changePlatform(renameScene(this.platform, id, name));
  }

  deleteScene(id: string): void {
    const scene = this.platform.scenes.find((s) => s.id === id);
    const { platform, ng } = removeScene(this.platform, this.ng(), id);
    if (platform === this.platform) return;
    this.changePlatform(platform, id === this.platform.activeScene ? ng : undefined);
    this.options.log(`Deleted the scene “${scene?.name}”.`);
  }

  moveScene(id: string, toIndex: number): void {
    this.changePlatform(moveScene(this.platform, id, toIndex));
  }

  // ------------------------------------------------------------ datasets

  /** Records a dataset and shows it in the active scene through a new layer; returns its id. */
  addDataset(spec: { source: unknown; name?: string; kind?: string }): string {
    const name = spec.name ?? "dataset";
    const { platform, dataset } = addDatasetRecord(this.platform, spec.source, name, spec.kind ?? "auto");
    this.platform = platform;
    this.showDataset(dataset.id);
    return dataset.id;
  }

  /** Shows a workspace dataset in the active scene through a new layer. */
  showDataset(id: string, overrides: Json = {}): string | undefined {
    const dataset = this.dataset(id);
    if (dataset === undefined) return undefined;
    const spec = { ...layerForDataset(dataset, this.ng()), ...overrides };
    const name = this.engine.addLayer(spec, { select: true });
    this.settle();
    this.options.log(`Added “${dataset.name}” to the scene.`, "ok");
    return name;
  }

  /** Another layer of a dataset already in the scene, copied from `fromLayer` (or fresh). */
  addLayerView(id: string, fromLayer?: string): string | undefined {
    const dataset = this.dataset(id);
    if (dataset === undefined) return undefined;
    const ng = this.ng();
    const taken = layersOf(ng).map((l) => String(l.name));
    const base = fromLayer !== undefined ? this.engine.layerSpec(fromLayer) : undefined;
    const name = uniqueName(`${dataset.name} (view)`, taken);
    const spec = base !== undefined ? { ...structuredClone(base), name } : layerForDataset(dataset, ng, name);
    const after = fromLayer !== undefined ? taken.indexOf(fromLayer) + 1 : undefined;
    const added = this.engine.addLayer(spec, { index: after, select: true });
    this.settle();
    return added;
  }

  removeDatasetFromScene(id: string): void {
    const entry = this.sceneDatasets().find((d) => d.dataset.id === id);
    if (entry === undefined) return;
    for (const layer of entry.layers) this.engine.removeLayer(layer);
    this.settle();
    this.options.log(`Removed “${entry.dataset.name}” from the scene. It stays in the workspace.`);
  }

  /** Drops a dataset from the workspace and every scene. */
  deleteDataset(id: string): void {
    const dataset = this.dataset(id);
    if (dataset === undefined) return;
    const entry = this.sceneDatasets().find((d) => d.dataset.id === id);
    for (const layer of entry?.layers ?? []) this.engine.removeLayer(layer);
    const scenes = this.platform.scenes.map((s) => {
      if (s.ng === undefined) return s;
      const layers = layersOf(s.ng).filter((l) => datasetKey(l) !== dataset.key);
      return { ...s, ng: { ...s.ng, layers } };
    });
    this.platform = forgetDataset({ ...this.platform, scenes }, id);
    this.settle();
    this.options.log(`Deleted “${dataset.name}” from the workspace.`);
  }

  renameDataset(id: string, name: string): void {
    const before = this.dataset(id);
    if (before === undefined || name.trim() === "" || name.trim() === before.name) return;
    this.platform = renameDataset(this.platform, id, uniqueName(name.trim(), this.platform.datasets.filter((d) => d.id !== id).map((d) => d.name)));
    // A dataset shown through one layer carries its name.
    const entry = this.sceneDatasets().find((d) => d.dataset.id === id);
    if (entry !== undefined && entry.layers.length === 1 && entry.layers[0] === before.name) {
      this.engine.renameLayer(entry.layers[0], this.dataset(id)!.name);
    }
    this.settle();
  }

  setDatasetVisible(id: string, visible: boolean): void {
    const entry = this.sceneDatasets().find((d) => d.dataset.id === id);
    for (const layer of entry?.layers ?? []) this.engine.setLayerVisible(layer, visible);
    this.scheduleSettle();
  }

  /** Moves a dataset's layers, as a block, before the dataset now at `toIndex`. */
  moveDataset(id: string, toIndex: number): void {
    const entries = this.sceneDatasets();
    const from = entries.findIndex((e) => e.dataset.id === id);
    if (from === -1) return;
    const order = [...entries];
    const [moved] = order.splice(from, 1);
    order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, moved);
    const names = order.flatMap((e) => e.layers);
    names.forEach((name, i) => this.engine.moveLayer(name, i));
    this.scheduleSettle();
  }

  // -------------------------------------------------------------- layers

  selectLayer(name: string | undefined): void {
    this.engine.selectLayer(name);
  }

  selectDataset(id: string): void {
    const entry = this.sceneDatasets().find((d) => d.dataset.id === id);
    if (entry !== undefined) this.engine.selectLayer(entry.layers[0]);
  }

  renameLayer(name: string, newName: string): void {
    if (newName.trim() === "" || newName === name) return;
    this.engine.renameLayer(name, newName.trim());
    this.scheduleSettle();
  }

  removeLayer(name: string): void {
    this.engine.removeLayer(name);
    this.scheduleSettle();
  }

  setLayerVisible(name: string, visible: boolean): void {
    this.engine.setLayerVisible(name, visible);
    this.scheduleSettle();
  }

  // -------------------------------------------------------- plugin slices

  getSlice<T>(spec: SliceSpec<T>): T {
    return readSlice(this.app, spec);
  }

  setSlice<T>(spec: SliceSpec<T>, value: T): void {
    this.app = writeSlice(this.app, spec, value);
    this.notifySlices();
    this.settle();
  }

  /** Raw access for the plugin host, which knows each plugin's key and version. */
  rawSlice(key: string): unknown {
    const stored = this.app[key];
    return typeof stored === "object" && stored !== null && "data" in stored ? (stored as { data: unknown }).data : undefined;
  }

  setRawSlice(key: string, version: number, value: unknown): void {
    this.app = { ...this.app, [key]: { version, data: value } };
    this.notifySlices();
    this.settle();
  }

  onSliceChanged(listener: () => void): () => void {
    this.sliceListeners.add(listener);
    return () => this.sliceListeners.delete(listener);
  }

  private notifySlices(): void {
    for (const listener of this.sliceListeners) listener();
  }
}

/** The workspace without the parts that only record what is selected. */
function editSignature(workspace: { ng: Json; app: Json }): string {
  const { selectedLayer: _selectedLayer, selection: _selection, ...ng } = workspace.ng;
  return JSON.stringify({ ng, app: workspace.app });
}

function defaultWriteUrl(hash: string): void {
  try {
    history.replaceState(null, "", hash);
  } catch {
    // A host that forbids it keeps the old address; Share still works.
  }
}
