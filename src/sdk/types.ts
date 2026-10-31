/**
 * The plugin API: everything a plugin may touch.
 *
 * Plugins never import Neuroglancer or the platform's internals.  They get a
 * `PlatformContext` on activation and work through it: commands, panels in
 * the docks, inspector sections, the workspace (scenes, datasets, layers),
 * the viewer's state, jobs, services and their own slice of the workspace
 * state.  Everything a plugin adds is owned by it, and deactivating the
 * plugin removes it all.
 */
import type { Schema } from "../core/schema.js";

export type { Schema };
export type Disposer = () => void;
export type Json = Record<string, unknown>;

// ---------------------------------------------------------------- manifest

export type DockSlot = "left" | "right" | "bottom";

export interface CommandContribution {
  id: string;
  title: string;
  group?: string;
  hint?: string;
  args?: Schema;
  when?: string;
}

export interface Manifest {
  /** Reverse-DNS and stable, e.g. "org.example.tractography". */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** SPDX identifier, shown to the user. GPL plugins ship separately from the core. */
  license?: string;
  engines?: { ngplatform?: string };
  /** ES module URL, for plugins loaded from outside the app bundle. */
  main?: string;
  /**
   * When to load the plugin's code.  Until then only this manifest is read.
   *   onStartup | onCommand:<id> | onView:<panel id> | onDatasetKind:<kind> | onOpen:<regex>
   */
  activation?: string[];
  /** Advisory: what the plugin says it will reach. Shown before installing. */
  permissions?: { network?: string[] };
  provides?: { services?: string[] };
  requires?: { services?: string[] };
  contributes?: {
    commands?: CommandContribution[];
    keybindings?: { key: string; command: string; args?: unknown; when?: string }[];
    panels?: { id: string; title: string; slot: DockSlot; order?: number; when?: string }[];
    inspector?: { id: string; title: string; order?: number; when?: string }[];
    datasetActions?: { command: string; title?: string; when?: string }[];
    openHandlers?: { id: string; pattern: string; title?: string }[];
    examples?: { id: string; title: string; description: string; remote?: boolean; state?: Json }[];
    appState?: { key: string; version: number };
    settings?: Record<string, Schema>;
    /** Context keys the plugin sets, so `when` clauses can be checked. */
    contextKeys?: string[];
  };
}

// ------------------------------------------------------------- workspace

export interface SceneInfo {
  id: string;
  name: string;
  active: boolean;
}

export interface DatasetInfo {
  id: string;
  name: string;
  /** The source, as a layer specification writes it. */
  source: unknown;
  /** Neuroglancer layer type that shows it ("image", "segmentation", "annotation", …) or "auto". */
  kind: string;
}

export interface SceneDatasetInfo extends DatasetInfo {
  /** Layers showing this dataset in the active scene, in draw order. */
  layers: LayerInfo[];
  visible: boolean;
}

export interface LayerInfo {
  name: string;
  type: string;
  visible: boolean;
  sources: string[];
  ready: boolean;
  error?: string;
  /** The dataset the layer shows. */
  dataset?: string;
}

export interface WorkspaceApi {
  scenes(): SceneInfo[];
  switchScene(id: string): void;
  newScene(options?: { copy?: boolean; name?: string }): string;

  /** Every dataset the workspace knows, shown in any scene or none. */
  datasets(): DatasetInfo[];
  /** The datasets the active scene shows, with their layers. */
  sceneDatasets(): SceneDatasetInfo[];
  /** Records a dataset and shows it in the active scene; returns its id. */
  addDataset(spec: { source: unknown; name?: string; kind?: string }): string;
  /**
   * Shows a dataset in the active scene through one more layer.  `layer`
   * overrides the layer specification (shader, segments, a different source
   * such as a derived store), which is how a plugin adds a filtered copy.
   */
  addLayer(datasetId: string, layer?: Json): string;
  removeDatasetFromScene(datasetId: string): void;

  selectedLayer(): string | undefined;
  selectLayer(name: string | undefined): void;
  /** The dataset of the selected layer. */
  selectedDataset(): DatasetInfo | undefined;

  onChanged(callback: () => void): Disposer;
}

export interface ViewerApi {
  /** The active scene's Neuroglancer state. */
  getState(): Json;
  /** Edits the state; only what changed is applied, as one undo step. */
  patchState(edit: (ng: Json) => void): void;
  onStateChanged(callback: () => void): Disposer;
  layers(): LayerInfo[];
  layerSpec(name: string): Json | undefined;
  setLayerVisible(name: string, visible: boolean): void;
  onLayersChanged(callback: () => void): Disposer;
  cursor(): { active: boolean; position: number[]; names: string[]; units: string[]; values: Record<string, unknown> };
  onCursorChanged(callback: () => void): Disposer;
  setPosition(position: number[]): void;
}

// --------------------------------------------------------------- context

export interface JobControl {
  progress(fraction: number | undefined, message?: string): void;
  /** Becomes true when the user cancels; check it between steps. */
  readonly cancelled: boolean;
}

export interface InspectorTarget {
  dataset: DatasetInfo | undefined;
  layer: LayerInfo | undefined;
}

export interface PlatformContext {
  readonly plugin: { id: string; version: string; manifest: Manifest };
  commands: {
    /** Supplies the code for a command declared in the manifest (or a new one, with `meta`). */
    register<A = unknown>(id: string, run: (args: A) => unknown | Promise<unknown>, meta?: Partial<CommandContribution>): Disposer;
    invoke<R = unknown>(id: string, args?: unknown): Promise<R | undefined>;
  };
  ui: {
    /** Renders a panel declared in the manifest; return a disposer for cleanup. */
    panel(id: string, render: (host: HTMLElement) => Disposer | void): Disposer;
    inspectorSection(id: string, render: (host: HTMLElement, target: InspectorTarget) => Disposer | void): Disposer;
    showPanel(id: string): void;
    toast(message: string, kind?: "info" | "error"): void;
    confirm(message: string): Promise<boolean>;
    /** A dialog generated from a schema; resolves undefined on cancel. */
    form<T>(title: string, schema: Schema, initial?: Partial<T>): Promise<T | undefined>;
  };
  workspace: WorkspaceApi;
  viewer: ViewerApi;
  /** This plugin's slice of the workspace state: undoable, in the link, migrated. */
  state: {
    get<T>(): T | undefined;
    set<T>(value: T): void;
    onChanged(callback: () => void): Disposer;
  };
  /** Per-user settings, kept in this browser, not in the link. */
  settings: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
  context: { set(key: string, value: unknown): void };
  jobs: { run<T>(title: string, work: (control: JobControl) => Promise<T>): Promise<T> };
  services: {
    provide<T>(name: string, implementation: T): Disposer;
    get<T>(name: string): Promise<T>;
  };
  open: {
    /** Handles text pasted into Open that matches a pattern the manifest declared. */
    handler(id: string, open: (text: string) => Promise<void> | void): Disposer;
  };
  log: {
    info(message: string): void;
    error(message: string): void;
  };
  /** Disposed when the plugin deactivates. */
  readonly subscriptions: Disposer[];
}

export interface PluginModule {
  activate(context: PlatformContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
