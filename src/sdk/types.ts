/**
 * The plugin API: everything a plugin may touch.
 *
 * There are two kinds of plugin:
 *
 *  - A **data type** plugin teaches Neuroglancer a format (a data source,
 *    with code in Neuroglancer's workers).  It has no platform code; the
 *    catalogue names its Neuroglancer modules.
 *  - A **tool** plugin adds to the workspace around the viewer: a panel in the
 *    Tools dock, commands, analyses.  It never imports Neuroglancer or the
 *    platform's internals: it gets a `PlatformContext` on activation and
 *    works through it.  Everything it adds is owned by it, and deactivating
 *    it removes it all.
 *
 * Either kind is switched on or off in the Plugins panel (left dock).  A
 * tool comes on at once; a data type, or turning a plugin off, reloads the
 * page with the same link.
 */
import type { LookupEntry, LookupTable } from "../core/lookup_table.js";
import type { Schema } from "../core/schema.js";

export type { LookupEntry, LookupTable, Schema };
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
  /**
   * Another file the store needs, beside it in the same folder (an edge
   * list's node table): candidate names for it, given the file's name; the
   * first found is used.  The worker gets the file's text, a `# @file
   * <name>` line, then the other file's text; the other file is not listed
   * as a dataset of its own.
   */
  companion?: (name: string) => string[];
  /**
   * Files beside it that its store reads too (a surface's thickness and
   * parcellation): given the file's path from the picked folder and a way
   * to name the files in a folder, their paths relative to the file's
   * folder ("lh.thickness", "../label/lh.aparc.annot").  Found once per
   * file; the worker gets them unread with every request
   * (`VirtualRequest.related`) and reads what it needs.
   */
  related?(path: string, list: (folder: string) => Promise<string[]>): Promise<string[]>;
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
  /** A short user guide in Markdown (## headings, lists, `code`, [links](…)), behind "About" in the Plugins panel. */
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
    /**
     * A panel in the `left` slot is a tool: it goes to the Tools dock, listed
     * under `group` ("Image", "Labels", "Space", "Vectors"; "Other" when not
     * given).  `minSize`: pixels the dock grows to, at least, when the panel
     * is shown (not saved as the dock's size).
     */
    panels?: { id: string; title: string; slot: DockSlot; group?: string; order?: number; when?: string; minSize?: number }[];
    datasetActions?: { command: string; title?: string; when?: string }[];
    openHandlers?: { id: string; pattern: string; title?: string }[];
    examples?: { id: string; title: string; description: string; remote?: boolean; state?: Json }[];
    appState?: { key: string; version: number };
    settings?: Record<string, Schema>;
    /** Context keys the plugin sets, so `when` clauses can be checked. */
    contextKeys?: string[];
    /**
     * Kinds of scene the plugin adds: each a tab in the scene bar (`title`)
     * while the plugin is on, which makes the scene the first time it is
     * clicked; switching to one shows `panel`.  With `add`, the scene bar
     * instead always has a tab `add.title` (with a +) that runs
     * `add.command`: the plugin makes the scenes of its kind itself, as many
     * as it likes.
     */
    sceneKinds?: { kind: string; title: string; panel?: string; add?: { title: string; command: string } }[];
  };
}

// ------------------------------------------------------------- workspace

export interface SceneInfo {
  id: string;
  name: string;
  active: boolean;
  /** A scene kind a plugin contributes (`contributes.sceneKinds`); none for an ordinary scene. */
  kind?: string;
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

/** One change in the workspace's undo history. */
export interface UndoStep {
  label: string;
  /** When it was made, in ms since 1970. */
  time: number;
}

export interface WorkspaceApi {
  scenes(): SceneInfo[];
  switchScene(id: string): void;
  /** A new scene (blank, or a copy of the active one); `kind` makes it a scene of a kind the plugin contributes. */
  newScene(options?: { copy?: boolean; name?: string; kind?: string }): string;
  renameScene(id: string, name: string): void;

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
  /** With `quiet`, the layer joins the current undo step (one a plugin adds on the user's behalf). */
  addLayer(datasetId: string, layer?: Json, options?: { quiet?: boolean }): string;
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
  /**
   * The ends of the workspace's undo history: the change undo would take
   * back and the one redo would bring back, each with its label and when it
   * was made (ms since 1970).  A plugin with an undo of its own (strokes)
   * compares times to undo whichever came last.
   */
  undoSteps(): { undo?: UndoStep; redo?: UndoStep };

  /** Data opened from this computer (Open a file…, or Add data → Local file or folder…), which plugins can write into. */
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
    /** The file on this computer a layer's source reads (an image or tractogram opened from it), if any. */
    sourceFile(source: string): Promise<File | undefined>;
    /**
     * Sends a message to the store a format's worker serves from a file on
     * this computer (`url` under it), and returns its answer: for stores
     * whose values the page chooses, such as the time point of a CIFTI
     * series on a surface (then `ViewerApi.reloadData` shows them).
     */
    send(url: string, message: unknown): Promise<unknown>;
  };

  /**
   * Images computed as they are viewed, by chunkmirage's browser engine
   * (src/virtual/computed.ts): a pipeline of chunkmirage ops over an image
   * the viewer reads, served as OME-Zarr.
   */
  computed: {
    /**
     * The source URL of `pipeline` ({source, ops, chunk}: chunkmirage's
     * pipeline spec, its source a layer's source URL), to add with
     * addDataset.  Python the pipeline carries is allowed in this browser.
     */
    url(pipeline: ComputedPipeline): Promise<string>;
    /** Marks Python as the plugin's own, which a link from elsewhere may run without asking. */
    ownPython(code: string): string;
    /** The pipeline a computed layer's source carries, if it is one. */
    pipelineOf(source: string): Promise<ComputedPipeline | undefined>;
    /** What the engine is doing, and its counts of chunks computed, dropped and failed. */
    status(): { status: string; computed: number; dropped: number; failed: number; failure: { view: string; message: string } | null };
    onChanged(callback: () => void): Disposer;
  };
}

/** A pipeline of chunkmirage ops (its PipelineSpec, as the browser engine takes it). */
export interface ComputedPipeline {
  /** The image read: a layer's source URL (zarr3://, n5://, precomputed://, or a file on this computer). */
  source: string;
  /** chunkmirage's op specs, in order: {op: "gaussian", sigma: 2}, {op: "python", code}. */
  ops?: Record<string, unknown>[];
  /** Output chunks, one size per axis (z, y, x). */
  chunk: number[];
  /** Non-spatial axes pinned: {c: 1, t: 0}. */
  select?: Record<string, number>;
  /**
   * The source warped by landmark pairs instead of ops: a thin-plate spline
   * from the fixed points (mm, the global space) to the moving ones (mm, the
   * source's own space); the output keeps the source's grid and levels.
   * Or warped through a displacement field (OME-NGFF 0.6's
   * `displacements`, an OME-Zarr multiscale group at `url`, its
   * displacement axis before z, y, x): the output voxel's place p (mm; x,
   * y, z) goes through the affines `before` (4 × 4, 16 numbers row-major,
   * mm, in order), then q → q + D(q) (or, with `invert`, the x with
   * x + D(x) = q), then `after`, to its place in the source (mm).
   * `components` names the axes of the vector's components in order (by
   * default the field's spatial axes); displacements are in the field's
   * spatial unit.  `fields`: several such parts, one after another (a
   * chain through more than one field).
   */
  warp?:
    | { kind: "tps"; fixed: number[][]; moving: number[][] }
    | FieldWarpPart
    | { kind: "fields"; parts: FieldWarpPart[] };
}

/** A displacement field between affines, as a warp or a part of one (see `ComputedPipeline.warp`). */
export interface FieldWarpPart {
  kind: "field";
  url: string;
  before?: number[][];
  after?: number[][];
  invert?: boolean;
  components?: string[];
  /** A coordinate field (OME-NGFF 0.6's `coordinates`): its values are places in the source, not displacements. */
  absolute?: boolean;
}

export interface ViewerApi {
  /** The active scene's Neuroglancer state. */
  getState(): Json;
  /**
   * Edits the state; only what changed is applied, as one undo step.  With
   * `quiet`, an edit made on the user's behalf (pointing a layer at data the
   * plugin made, say) amends the current step instead, so undo still undoes
   * what the user did.
   */
  patchState(edit: (ng: Json) => void, options?: { quiet?: boolean }): void;
  onStateChanged(callback: () => void): Disposer;
  /**
   * A number that changes whenever a layer changes (its specification, its
   * annotations among it, or the list of layers), but not when the view
   * moves: a plugin reading layers out of `getState` (which writes out every
   * annotation) can keep what it read until this changes.
   */
  layersGeneration?(): number;
  /**
   * One top-level key of the state (`selection`, `selectedLayer`,
   * `dimensions`, `position`…) without writing out the rest: cheap, where
   * `getState` writes out every layer.  Not for `layers` (use `getState`).
   */
  statePart?(key: string): unknown;
  layers(): LayerInfo[];
  layerSpec(name: string): Json | undefined;
  setLayerVisible(name: string, visible: boolean): void;
  onLayersChanged(callback: () => void): Disposer;
  cursor(): { active: boolean; position: number[]; names: string[]; units: string[]; values: Record<string, unknown> };
  onCursorChanged(callback: () => void): Disposer;
  /**
   * Moves the global position (NaN leaves a dimension where it is).  With
   * `quiet`, the move makes no undo step of its own: it amends the current
   * one, as a run of quiet moves does (playing through time), until the
   * user next acts.
   */
  setPosition(position: number[], options?: { quiet?: boolean }): void;
  /**
   * A layer's local dimensions (those its sources name with a trailing
   * `'`, such as `t'`: each layer has its own position along them) and
   * its position there, in their coordinates; undefined until it loads.
   */
  localPosition(layer: string): { names: string[]; scales: number[]; units: string[]; position: number[] } | undefined;
  /** Moves a layer's local position (NaN leaves a dimension where it is); `quiet` as for setPosition. */
  setLocalPosition(layer: string, position: number[], options?: { quiet?: boolean }): void;
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
   * What a segmentation layer shows, as Neuroglancer would draw it (were its
   * drawing hidden or not): every object (`all`: no segment chosen, and the
   * layer shows all then), or those `has` says yes to.  The segments are a
   * plugin's temporary set when one is set, else the layer's own.
   */
  visibleSegments(layer: string): VisibleSegments | undefined;
  /** A segment's colour as Neuroglancer colours it in a segmentation layer (stated, default or hashed; with its saturation), RGB 0 to 1. */
  segmentColour(layer: string, id: bigint): [number, number, number] | undefined;
  /** Calls back when what a segmentation layer shows, or how its segments are coloured, changes. */
  onSegmentsChanged(layer: string, callback: () => void): Disposer;
  /**
   * Hides a layer's own drawing, or shows it again, for a plugin that draws
   * the layer itself: not saved in the link, and kept hidden through undo
   * and scene switches.  An image layer's opacity is set to 0 (the link
   * keeps its own); a segmentation layer's segments are shown as a
   * temporary set naming no object, and its notSelectedAlpha set to 0 (the
   * link keeps its own), so Neuroglancer neither draws nor reads its
   * chunks, while `visibleSegments` still says what it shows (a plugin's
   * temporary set made meanwhile included, and its notSelectedAlpha).
   */
  hideLayerDrawing(layer: string, hidden: boolean): void;
  /** Shows a surface map (an attribute of a surface layer's store) as its overlay, as Display → Surface's Overlay does; false when the layer is not a surface. */
  setSurfaceOverlay(layer: string, map: string): boolean;
  /** Whether an annotation is being drawn in steps (a polyline, a line, a box): a plugin's edits to annotation layers wait for it. */
  annotationInProgress(): boolean;
  /** Sets the 2-D views' background (rgb, 0 to 1) for a while, or puts it back (`undefined`): not saved in the link. */
  setTemporaryBackground(rgb: [number, number, number] | undefined): void;
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
   * Matrices are homogeneous, column-major, as Neuroglancer keeps them:
   * the linear part relates physical lengths, so an input coordinate
   * moves output coordinate o by `matrix[o, i] * input.scales[i] /
   * output.scales[o]` (an identity matrix puts a 1 mm source in 0.5 mm
   * global dimensions at twice its coordinates), while the translation is
   * in output coordinates.  Scales are in the units given.
   */
  layerTransform(layer: string): LayerTransform | undefined;
  /** Sets a layer's transform matrix (same form as `layerTransform`'s), as one undo step. */
  setLayerTransform(layer: string, matrix: Float64Array): void;
  /**
   * Has Neuroglancer read again the chunks it holds from under `url` (an
   * http(s) address): for data a plugin serves and has changed, such as a
   * label volume being drawn.  Chunks on screen are asked for at once and
   * replaced as they come; metadata is kept.
   */
  reloadData(url: string): void;
  /**
   * Label lookup tables, the names and colours of a segmentation's values:
   * those that come with the app, the one a layer has, and giving a layer
   * one as its Display → Colour → Lookup table does.  A table is named by its
   * `lut://` URL.
   */
  lookupTables: LookupTablesApi;
}

export interface LookupTableInfo {
  /** Its `lut://` URL. */
  url: string;
  title: string;
  /** For grouping in menus ("FreeSurfer", "Mouse"). */
  group: string;
  description?: string;
  /** Fetched from its publisher when chosen (its licence does not let the app ship it). */
  fetched: boolean;
}

export interface LookupTablesApi {
  /** The tables that come with the app, or that it fetches from their publishers. */
  catalogue(): LookupTableInfo[];
  /** A table, read once a visit (an Allen structure graph gives each entry its `parent`). */
  load(url: string): Promise<LookupTable>;
  /** A table's title: the catalogue's, or its file's name. */
  title(url: string): string;
  /** The table a segmentation layer has, if any. */
  of(layer: string): string | undefined;
  /** Gives a segmentation layer a table (names and colours), or takes it off with undefined. */
  apply(layer: string, url: string | undefined): Promise<void>;
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
  /**
   * The cross-sections are already drawn (in colour and depth): the drawer
   * asked for `afterSections` and this Neuroglancer honours it.
   */
  sectionsDrawn?: boolean;
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
  /**
   * Draw after Neuroglancer's cross-sections rather than before them, so
   * light can be added over a section, depth-tested against it.  Needs a
   * Neuroglancer whose 3-D panel draws such layers then; elsewhere the
   * drawer draws with the other opaque layers, and `frame.sectionsDrawn`
   * says which happened.
   */
  afterSections?: boolean;
  dispose?(): void;
}

/** What a segmentation layer shows (`ViewerApi.visibleSegments`). */
export interface VisibleSegments {
  /** Every object shows (no segment is chosen, and the layer then shows all). */
  all: boolean;
  /** How many segments are chosen. */
  size: number;
  has(id: bigint): boolean;
  /** The chosen segments' ids. */
  ids(): BigUint64Array;
  /**
   * How strongly Neuroglancer draws the segments not chosen when some are
   * (the layer's `notSelectedAlpha`, "Opacity (off)"), 0 to 1: the layer's
   * own, also while its drawing is hidden.
   */
  notSelectedAlpha: number;
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

// ------------------------------------------------------------------ runner

/** A file a runner job writes. */
export interface RunnerOutput {
  path: string;
  /** "zarr-vectors" (a store folder), "trk", "nifti" or "file". */
  type: string;
}

/** A job on the runner (a Python process on this computer; see docs/guide/local-jobs.md). */
export interface RunnerJob {
  id: string;
  /** "convert", "filter", "density", or "serve" (a file served to the viewer). */
  kind: string;
  title: string;
  args: Record<string, unknown>;
  /** The process id, once started. */
  pid: number | null;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  /** Seconds since 1970. */
  created: number;
  started: number | null;
  finished: number | null;
  /** 0 to 1, when the job reports it. */
  progress: number | null;
  message: string;
  outputs: RunnerOutput[];
  returncode?: number | null;
  serve?: { id: string; url: string };
}

/**
 * The runner: Python jobs on the user's own computer (`python -m
 * ngplatform_runner`), which the app is paired with in Settings › Compute.  Jobs
 * read and write files only under the folders the runner was started with.
 */
export interface RunnerApi {
  /** Whether the app is paired with a runner that answers. */
  available(): boolean;
  onChanged(callback: () => void): Disposer;
  /** The folders the runner may read and write. */
  folders(): string[];
  /** The runner's jobs, newest first (as last fetched). */
  jobs(): RunnerJob[];
  /**
   * Starts a job of a kind the runner knows ("convert", "filter",
   * "density"); resolves with it as started (queued or running).  Fails
   * when the runner refuses the arguments (a path outside its folders, an
   * output that exists).
   */
  start(kind: string, args: Record<string, unknown>): Promise<RunnerJob>;
  /** The job once it has finished (done, failed or cancelled); `onProgress` is called as it runs. */
  wait(id: string, onProgress?: (job: RunnerJob) => void, signal?: AbortSignal): Promise<RunnerJob>;
  cancel(id: string): Promise<void>;
  /** The path on this computer a layer source reads, when the runner serves it (else undefined). */
  pathOf(source: string): Promise<string | undefined>;
  /**
   * Asks the user for a path under the runner's folders: a file or store
   * to read ("open"), or a new file to write ("save", with a suggested
   * name); undefined when cancelled.  `find` looks for a file of that name
   * under the folders first.
   */
  choose(options: { title: string; mode: "open" | "save"; suggested?: string; find?: { name: string; size?: number }; note?: string }): Promise<string | undefined>;
  /** Adds a file or store under the runner's folders to the active scene, served by the runner; resolves with the dataset's id. */
  open(path: string, options?: { name?: string }): Promise<string>;
}

// ------------------------------------------------------------------ hosts

/** A GPU on a host, as nvidia-smi reports it; memory in MiB. */
export interface HostGpu {
  index: number;
  /** As nvidia-smi names it ("NVIDIA RTX A6000"). */
  name: string;
  memoryTotal: number | null;
  memoryUsed: number | null;
  memoryFree: number | null;
  busId: string;
  /** False when the card cannot be used (it needs a reset, it does not answer); `problem` says why. */
  ok: boolean;
  problem?: string;
}

/** A service the host's runner runs beside it (`--service NAME=COMMAND`), reached at `/svc/<name>/`. */
export interface HostServiceState {
  ready: boolean;
  /** Why it is not ready: it ended and is being started again, or the runner gave up on it (with its log's last lines). */
  error: string | null;
  pid: number | null;
}

/** What a host's runner says about its computer. */
export interface HostDetails {
  hostname: string;
  platform: string;
  gpus: HostGpu[];
  services: Record<string, HostServiceState>;
}

/** A computer with a runner the app is paired with: This computer, or another reached through an SSH tunnel. */
export interface HostInfo {
  /** "This computer", or the name it was paired with ("workstation"). */
  name: string;
  /** The runner's address in this browser (`http://localhost:7000` through a tunnel). */
  address: string;
  /** Whether it answered the last check (every 5 s). */
  available: boolean;
  /** As last fetched; undefined before it first answers. */
  info?: HostDetails;
  /** Why it is not available. */
  error?: string;
}

/** One host, for calls to its services. */
export interface Host {
  readonly name: string;
  readonly address: string;
  available(): boolean;
  info(): HostInfo;
  /**
   * A request to one of its services: `path` is relative to `/svc/`
   * (`render/sessions` is the render service's `/sessions`).  The pairing
   * token is added; resolves with the Response as it arrives (its body
   * streams), whatever its status.  Rejects when the host is not paired or
   * does not answer.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** The computers with runners the app is paired with; `ctx.runner` is the first of them, This computer. */
export interface HostsApi {
  /** This computer (when paired) first, then the others, in the order they were paired. */
  list(): HostInfo[];
  /** Called when a host is added or removed, goes up or down, or what it reports changes. */
  onChanged(callback: () => void): Disposer;
  get(name: string): Host | undefined;
  /** The first available host with what is asked for (a usable GPU, a ready service), a GPU host before others. */
  pick(options?: { gpu?: boolean; service?: string }): Host | undefined;
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
    /**
     * A sheet (as the platform's Open is) whose body the plugin draws, with
     * a Close button; Escape or a click outside closes it too.  Returns what
     * closes it.
     */
    sheet(title: string, render: (body: HTMLElement, close: () => void) => Disposer | void, options?: { wide?: boolean }): () => void;
  };
  workspace: WorkspaceApi;
  viewer: ViewerApi;
  /**
   * This plugin's slice of the workspace state: undoable, in the link.
   * State saved by an older version of the plugin (its manifest's
   * `appState.version`) is returned as it was saved, for the plugin to read
   * by its shape; state saved by a newer version is not read (`get` returns
   * undefined) and the user is told.
   */
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
  /** Jobs on this computer, through the runner the app is paired with (see RunnerApi). */
  runner: RunnerApi;
  /** Every computer with a paired runner, This computer and others over SSH, for their services (see HostsApi). */
  hosts: HostsApi;
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
  /** Sign-in: a provider adds its services to Settings › Sign-in. */
  auth: {
    register(provider: AuthProvider): Disposer;
  };
  /** Disposed when the plugin deactivates. */
  readonly subscriptions: Disposer[];
}

// ------------------------------------------------------------------ sign-in

/** Where a service's sign-in stands. */
export interface AuthStatus {
  /** "unconfigured": the sign-in needs setting up before it can be used (Google without a client ID). */
  state: "signed-in" | "signed-out" | "expired" | "unconfigured" | "unknown" | "error";
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
  /** The addresses typed into Settings › Sign-in that led here (removable there). */
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
  /** One line for Settings › Sign-in. */
  description?: string;
  /** Whether this provider takes a server typed into Settings › Sign-in (a URL). */
  accepts?(server: string): boolean;
  /** Its services, from the workspace's data sources and the servers added to it by hand. */
  services(input: { sources: string[]; manual: string[] }): Promise<AuthService[]>;
  /** The ways it lets a layer read its data, offered in the drop-down for each layer (Settings › Sign-in, and the layer's controls). */
  sourceSignIns?(input: { sources: string[]; manual: string[] }): SourceSignIn[];
}

/**
 * A way of reading a layer's data with a sign-in, as Neuroglancer's URL
 * schemes choose one: `gs+google://bucket/path` for `gs://bucket/path`.
 */
export interface SourceSignIn {
  /** Unique among the sign-ins for its storage ("public" reads anonymously). */
  id: string;
  /** Its name in the drop-down. */
  title: string;
  /** What it reads: Google Cloud Storage buckets (`gs://`) or web servers (`https://`). */
  storage: "gs" | "http";
  /** The address that reads a plain one (`gs://bucket/path`, `https://host/path`) with this sign-in. */
  wrap(plain: string): string;
  /** The plain address of one that uses this sign-in, or undefined when it does not. */
  unwrap(address: string): string | undefined;
}

export interface PluginModule {
  activate(context: PlatformContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
