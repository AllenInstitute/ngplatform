/**
 * The plugin API: everything a plugin may touch.
 *
 * There are two kinds of plugin:
 *
 *  - A **data type** plugin teaches Neuroglancer a format (a data source,
 *    with code in Neuroglancer's workers).  It has no platform code; the
 *    catalogue names its Neuroglancer modules.
 *  - A **tool** plugin adds to the workspace around the viewer: a tab in the
 *    left dock, commands, analyses.  It never imports Neuroglancer or the
 *    platform's internals: it gets a `PlatformContext` on activation and
 *    works through it.  Everything it adds is owned by it, and deactivating
 *    it removes it all.
 *
 * Either kind is switched on or off in the Plugins tab, which reloads the
 * page with the same link.
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

export type PluginKind = "datatype" | "tool";

/**
 * A kind of file a data type plugin reads in place as a virtual store: the
 * keys under the file's own URL (<file>/zarr.json, <file>/0/…) made from it
 * as they are asked for, by a worker.  Local data lists such files and
 * routes their keys to the worker (see @ngplatform/sdk/virtual).
 */
export interface VirtualFormat {
  /** File names it reads. */
  pattern: RegExp;
  /** Their extensions, for file pickers (".trk"). */
  extensions: string[];
  /** What such a file is, for lists ("TrackVis tractogram"). */
  format: string;
  /** The dataset's layer type ("image", "segmentation", "auto"). */
  kind: string;
  /** The layer source for the store served at `url` (the file's own URL). */
  source(url: string): string;
  /** A worker answering the store's keys (made once, when first needed). */
  worker(): Worker;
  /**
   * Several such files in one folder can open as one store: the folder's
   * `@all<extension>`, which the worker gets as one text file, each file's
   * text after a `# @file <name>` line (for text formats such as SWC).
   */
  collect?: { extension: string; label: string };
}

export interface Manifest {
  /** Reverse-DNS and stable, e.g. "org.example.tractography". */
  id: string;
  name: string;
  version: string;
  /** "datatype": a format Neuroglancer reads.  "tool": a workspace tool. */
  kind: PluginKind;
  /** One sentence, shown under the plugin's name. */
  description?: string;
  /** A short user guide in Markdown (## headings, lists, `code`, [links](…)), behind "Read more". */
  guide?: string;
  /** Where to find out more: repositories, specifications, papers. */
  links?: { title: string; url: string }[];
  /** On for a browser that has not chosen; off unless stated. */
  enabledByDefault?: boolean;
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
  /** Plugins that must be on for this one to be (switching it on switches them on). */
  requires?: { plugins?: string[]; services?: string[] };
  contributes?: {
    commands?: CommandContribution[];
    keybindings?: { key: string; command: string; args?: unknown; when?: string }[];
    panels?: { id: string; title: string; slot: DockSlot; order?: number; when?: string }[];
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
  /** Removes one layer (a view of a dataset) from the active scene. */
  removeLayer(name: string): void;
  /** Renames a layer; returns the name it got (made unique). */
  renameLayer(name: string, newName: string): string;

  selectedLayer(): string | undefined;
  selectLayer(name: string | undefined): void;
  /** The dataset of the selected layer. */
  selectedDataset(): DatasetInfo | undefined;

  onChanged(callback: () => void): Disposer;

  /** Data opened from this computer (Add → Local), which plugins can write into. */
  local: {
    /** Whether a URL is under local data, and whether its folder can be written. */
    locate(url: string): { writable: boolean } | undefined;
    /** Writes a file at a URL under local data (asking to edit the folder the first time). */
    write(url: string, data: Uint8Array | string): Promise<void>;
    /**
     * Opens a file made in the page (a NIfTI image, a mesh…) as data on this
     * computer, for this visit; the datasets in it, to add with addDataset.
     */
    open(file: File, options?: { derived?: boolean }): Promise<{ source: string; name: string; kind: string }[]>;
    /** Lets go of a file opened with `open`, given its source. */
    close(source: string): void;
  };
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
  /**
   * A segmentation layer's segment properties (one row per segment: numeric
   * columns, and tags), once its source has supplied them.
   */
  segmentProperties(layer: string): SegmentProperties | undefined;
  onSegmentPropertiesChanged(layer: string, callback: () => void): Disposer;
  /**
   * Shows only these segments in a layer, without saving them in the state
   * (a filter result is recomputed from the plugin's own state instead).
   * `undefined` restores the layer's ordinary visible segments.
   */
  setTemporaryVisibleSegments(layer: string, ids: BigUint64Array | undefined): void;
  /**
   * Draws in Neuroglancer's 3-D view, as part of a layer: `drawer.draw` runs
   * in each frame the 3-D panel draws while the layer is visible, between
   * Neuroglancer's own opaque drawing, so depth tests both ways.  Returns
   * a handle to ask for another frame and to stop.
   */
  draw3d(layer: string, drawer: Drawer3d): { redraw(): void; dispose(): void };
  /** The view panels shown now, and where a global position is in each (for overlays). */
  panels(): ViewPanelInfo[];
  /** Calls back after each frame the views draw. */
  onRendered(callback: () => void): Disposer;
  /**
   * A layer's first data source's transform, from its source space to the
   * global one, and the transform the source itself gives (its default).
   * Matrices are homogeneous, column-major, in multiples of each side's
   * scales (as Neuroglancer keeps them); scales are in the units given.
   */
  layerTransform(layer: string): LayerTransform | undefined;
  /** Sets a layer's transform matrix (same form as `layerTransform`'s), as one undo step. */
  setLayerTransform(layer: string, matrix: Float64Array): void;
}

export interface LayerTransform {
  rank: number;
  /** The source's own space; `bounds` is its extent there, in input coordinates, when the source gives one. */
  input: { names: string[]; scales: number[]; units: string[]; bounds?: { lower: number[]; upper: number[] } };
  output: { names: string[]; scales: number[]; units: string[] };
  matrix: Float64Array;
  /** The transform the source gives itself, in the same form (and output scales) as `matrix`. */
  defaultMatrix: Float64Array;
}

export interface ViewPanelInfo {
  kind: "2d" | "3d";
  element: HTMLElement;
  /**
   * Where a global position (all global dimensions) shows: CSS pixels from
   * the panel's top left, and depth (-1..1 within the view; for a 2-D view,
   * within its section's thickness).  Undefined behind the camera.
   */
  project(global: ArrayLike<number>): { x: number; y: number; depth: number } | undefined;
}

/** One frame of the 3-D view, as a plugin draws into it. */
export interface Frame3d {
  gl: WebGL2RenderingContext;
  /**
   * Display coordinates to clip space (column-major).  Display coordinates
   * are the global coordinates of the three displayed dimensions, in their
   * own units: a dimension with scale 1e-3 m counts millimetres.
   */
  viewProjection: Float32Array;
  invViewProjection: Float32Array;
  /** The displayed dimensions: names, and scale and unit of one coordinate (e.g. 0.001, "m"). */
  dimensions: { names: string[]; scales: number[]; units: string[] };
  /** The view's position, in display coordinates. */
  position: [number, number, number];
  width: number;
  height: number;
  /** Fragment output locations: colour, depth (as 1 - gl_FragDepth, in all four channels) and pick id (0 for none). */
  outputs: { color: number; z: number; pick: number };
  /** The camera is moving: draw something cheaper if there is a choice. */
  moving: boolean;
}

export interface Drawer3d {
  draw(frame: Frame3d): void;
  /**
   * Where Neuroglancer's sections may show in this frame (display
   * coordinates), e.g. only on the faces of a cut the drawer leaves; asked
   * after `draw`, only in frames it drew.  Undefined leaves them alone.
   */
  sectionClip?(frame: Omit<Frame3d, "gl">): { lower: number[]; upper: number[] } | undefined;
  /** False while it has nothing to draw yet (screenshots wait for it). */
  isReady?(): boolean;
  dispose?(): void;
}

export interface SegmentProperties {
  ids: BigUint64Array;
  numeric: { id: string; description: string | undefined; values: ArrayLike<number>; min: number; max: number }[];
  /** `values[i]` lists segment i's tags as character codes indexing `names`. */
  tags: { names: string[]; descriptions: string[]; values: string[] } | undefined;
}

// --------------------------------------------------------------- context

export interface JobControl {
  progress(fraction: number | undefined, message?: string): void;
  /** Becomes true when the user cancels; check it between steps. */
  readonly cancelled: boolean;
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
    showPanel(id: string): void;
    /**
     * Shows a view beside Neuroglancer's (where its 3-D panel would be),
     * until the disposer is called.  One view at a time: a new one replaces
     * the last.
     */
    view(render: (host: HTMLElement) => Disposer | void): Disposer;
    toast(message: string, kind?: "info" | "error"): void;
    /**
     * A switch beside "Sections" in the 3-D panel, for something the plugin
     * draws there; until the disposer is called.
     */
    viewToggle(spec: { label: string; title?: string; value: boolean; onChange(value: boolean): void }): { set(value: boolean): void; dispose(): void };
    /** An element over the views (pointer events pass through it, not its children), until disposed. */
    overlay(): { element: HTMLElement; dispose(): void };
    /** Paints over each screenshot Neuroglancer takes, in its canvas's pixels, until disposed. */
    screenshotOverlay(paint: (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void): Disposer;
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
  /** Sign-in: a provider adds its services to the Auth tab. */
  auth: {
    register(provider: AuthProvider): Disposer;
  };
  /** Disposed when the plugin deactivates. */
  readonly subscriptions: Disposer[];
}

// ------------------------------------------------------------------ sign-in

/** Where a service's sign-in stands. */
export interface AuthStatus {
  state: "signed-in" | "signed-out" | "expired" | "unknown" | "error";
  /** Who is signed in, when the service says. */
  user?: string;
  detail?: string;
}

/** One thing to sign in to: an auth server, a bucket, a project. */
export interface AuthService {
  id: string;
  title: string;
  /** What uses it (the datasets, apps or URLs). */
  detail?: string;
  /** The addresses typed into the Auth tab that led here (removable there). */
  manual?: string[];
  status(signal?: AbortSignal): Promise<AuthStatus>;
  /** Called from a click: it may open a sign-in window at once. */
  signIn?(): Promise<void>;
  signOut?(): Promise<void>;
}

/**
 * A kind of sign-in (middleauth is built in): which services the workspace
 * needs, given its data sources and the servers added by hand.
 */
export interface AuthProvider {
  id: string;
  title: string;
  /** One line for the Auth tab. */
  description?: string;
  /** Whether this provider takes a server typed into the Auth tab (a URL). */
  accepts?(server: string): boolean;
  services(input: { sources: string[]; manual: string[] }): Promise<AuthService[]>;
}

export interface PluginModule {
  activate(context: PlatformContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
