/**
 * The Neuroglancer engine, with its views and nothing for managing data.
 *
 * Inside the viewer stays what is about looking: the views, the position in
 * the top left and each panel's own controls (layout buttons, sections,
 * scale) in its top right, as in standard Neuroglancer.  The layer bar,
 * side panels and dialogs are off; what they offered is reached through this
 * class and shown by the platform, which mounts Neuroglancer's own widgets
 * (layer controls, settings, help, statistics) in its docks and dialogs.
 */
import { setSurfaceOverlay } from "./inspector/surface.js";
import type { Drawer3d, VisibleSegments } from "../sdk/types.js";
import { draw3d } from "./draw3d.js";
import {
  addPerspectivePanelToggle,
  changeLayerName,
  deleteLayer,
  EventActionMap,
  getBaseObjectColor,
  getDefaultPerspectivePanelBindings,
  getDefaultSliceViewPanelBindings,
  getStatusMessageContainers,
  ImageUserLayer,
  InputEventBindingHelpDialog,
  initializeLayerFromSpecShowErrorStatus,
  makeMinimalViewer,
  ManagedUserLayer,
  SegmentationUserLayer,
  setScreenshotOverlay,
  type SidePanelManager,
  TrackableBoolean,
  type Viewer,
  setNamedPanelOrientation,
} from "./neuroglancer.js";
import { looksAnatomical, type PanelConvention, panelRotations } from "./anatomical.js";
import { applyLookupTable, layerLookupSource } from "./lookup_tables.js";
import { addMomentum } from "./momentum.js";
import { mountInspector } from "./inspector/index.js";
import { type ChunkSourceStatistics, chunkStatistics, mountViewSettings } from "./view_settings.js";
import { guardSelectedValues, type SelectedValues } from "./selected_values.js";
import { watchOutlines } from "./outlines.js";
import { type CaptureOptions, type CapturePanel, captureDimensions, capturePanels, CaptureSession } from "./capture.js";

export type Json = Record<string, unknown>;

export interface LayerTransformInfo {
  rank: number;
  input: { names: string[]; scales: number[]; units: string[] };
  output: { names: string[]; scales: number[]; units: string[] };
  matrix: Float64Array;
  defaultMatrix: Float64Array;
}

interface WatchableTransformLike {
  value: {
    rank: number;
    inputSpace: { names: readonly string[]; scales: Float64Array; units: readonly string[]; bounds: { lowerBounds: Float64Array; upperBounds: Float64Array } };
    outputSpace: { names: readonly string[]; scales: Float64Array; units: readonly string[] };
    transform: Float64Array;
  };
  defaultTransform: { transform: Float64Array; outputSpace?: { names: readonly string[]; scales: Float64Array } };
  transform: Float64Array;
}

interface ProjectionLike {
  viewProjectionMat: Float32Array;
  displayDimensionRenderInfo: { displayDimensionIndices: Int32Array | number[] };
}

/** A view panel and where a point of the global space is in it. */
export interface ViewPanel {
  kind: "2d" | "3d";
  element: HTMLElement;
  /**
   * Where a global position (all global dimensions) shows: CSS pixels from
   * the panel's top left, and depth (-1..1 within the view; for a 2-D view,
   * within its section's thickness).  Undefined behind the camera.
   */
  project(global: ArrayLike<number>): { x: number; y: number; depth: number } | undefined;
}
export type Disposer = () => void;
export type { ChunkSourceStatistics } from "./view_settings.js";

export interface LayerInfo {
  name: string;
  /** Neuroglancer layer type, or "new" while the source is still resolving. */
  type: string;
  visible: boolean;
  archived: boolean;
  /** Data source URLs, as written in the layer's specification. */
  sources: string[];
  ready: boolean;
  /** One line describing a load error, when there is one. */
  error?: string;
}

export interface CursorInfo {
  active: boolean;
  position: number[];
  names: string[];
  units: string[];
  scales: number[];
  values: Record<string, unknown>;
}

export interface SegmentProperties {
  ids: BigUint64Array;
  numeric: { id: string; description: string | undefined; values: ArrayLike<number>; min: number; max: number }[];
  /** Tags: each segment's `values[i]` lists its tags as character codes indexing `names`. */
  tags: { names: string[]; descriptions: string[]; values: string[] } | undefined;
}

export interface NavigationInfo {
  names: string[];
  units: string[];
  scales: number[];
  position: number[];
  crossSectionScale: number;
  projectionScale: number;
  layout: string;
}

/** Layouts Neuroglancer names; layer-group layouts are kept as "custom". */
export const LAYOUTS: [string, string][] = [
  // The 3-D view bottom right, as Freeview and most viewers place it (see the engine's constructor).
  ["4panel-alt", "4 panels"],
  ["xy-3d", "XY + 3D"],
  ["xz-3d", "XZ + 3D"],
  ["yz-3d", "YZ + 3D"],
  ["3d", "3D"],
  ["xy", "XY"],
  ["xz", "XZ"],
  ["yz", "YZ"],
];

/**
 * Runs `callback` after Neuroglancer's own change handling, at most once per
 * frame, and never lets it throw into Neuroglancer: a listener that throws
 * inside a layer-change dispatch makes Neuroglancer drop the layer.
 */
/** A segment id no store uses: the temporary set that hides a segmentation layer's drawing. */
const HIDDEN_SEGMENTS = new BigUint64Array([0xffffffffffffffffn]);
const segmentColourScratch = new Float32Array(4);

export function deferred(callback: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      try {
        callback();
      } catch (e) {
        console.error("ngplatform listener failed", e);
      }
    });
  };
}

/**
 * Global keys that act on the view only.  Neuroglancer's defaults also bind
 * layer actions (toggle or select a layer by number, add a layer, open its
 * help and statistics panels); those are platform commands instead.
 */
function viewKeyBindings(): EventActionMap {
  const map = new EventActionMap();
  map.set("keys", "toggle-show-slices");
  map.set("keyb", "toggle-scale-bar");
  map.set("keyv", "toggle-default-annotations");
  map.set("keya", "toggle-axis-lines");
  map.set("keyo", "toggle-orthographic-projection");
  map.set("space", "toggle-layout");
  map.set("shift+space", "toggle-layout-alternative");
  // Tools the user bound to letters in a layer's controls.
  for (let i = 0; i < 26; ++i) {
    const lowercase = String.fromCharCode(97 + i);
    const uppercase = String.fromCharCode(65 + i);
    map.set(`alt?+control?+shift+key${lowercase}`, `tool-${uppercase}`);
  }
  return map;
}

/** What Neuroglancer's side panels ask of their manager: only drag hooks. */
const DOCKED_PANEL_MANAGER = {
  startDrag() {},
  endDrag() {},
} as unknown as SidePanelManager;

/** A Neuroglancer side panel shown in a platform dock instead. */
interface DockablePanel {
  element: HTMLElement;
  dispose(): void;
}

function dockPanel(host: HTMLElement, panel: DockablePanel): Disposer {
  panel.element.draggable = false;
  panel.element.classList.add("ngp-docked-panel");
  host.append(panel.element);
  return () => {
    panel.element.remove();
    panel.dispose();
  };
}

/** Unpacks a uint32 voxel's bytes as red, green and blue. */
const RGB_SHADER = `void main() {
  uint v = getDataValue().value;
  emitRGB(vec3(float(v & 255u), float((v >> 8u) & 255u), float((v >> 16u) & 255u)) / 255.0);
}
`;

/** Whether a layer's source is an OME-Zarr image whose metadata says its voxels are packed colours. */
async function packedColour(spec: Json): Promise<boolean> {
  const source = Array.isArray(spec.source) ? spec.source[0] : spec.source;
  const url = typeof source === "string" ? source : (source as { url?: string } | undefined)?.url;
  const base = url === undefined ? undefined : /^zarr3?:\/\/(.*?)\/?$/.exec(url)?.[1];
  if (base === undefined) return false;
  try {
    const response = await fetch(`${base}/zarr.json`);
    if (!response.ok) return false;
    const group = (await response.json()) as { attributes?: { ngplatform?: { rendering?: string } } };
    return group.attributes?.ngplatform?.rendering === "rgb";
  } catch {
    return false;
  }
}

function layerSources(managed: ManagedUserLayer): string[] {
  return managed.layer?.dataSources.map((d) => d.spec.url).filter((u) => u.length > 0) ?? [];
}

function layerError(managed: ManagedUserLayer): string | undefined {
  for (const source of managed.layer?.dataSources ?? []) {
    const state = source.loadState;
    if (state !== undefined && "error" in state && state.error !== undefined) {
      return (state.error as Error).message ?? String(state.error);
    }
  }
  return undefined;
}

const PANEL_CONVENTION_KEY = "ngplatform.panelConvention";
const MOMENTUM_KEY = "ngplatform.momentum";

function readMomentum(): boolean {
  try {
    return localStorage.getItem(MOMENTUM_KEY) !== "off";
  } catch {
    return true;
  }
}

function readPanelPreference(): PanelConvention | "auto" {
  try {
    const v = localStorage.getItem(PANEL_CONVENTION_KEY);
    if (v === "radiological" || v === "neurological" || v === "neuroglancer") return v;
  } catch {
    // No storage: the default.
  }
  return "auto";
}

export class Engine {
  readonly viewer: Viewer;
  private readonly disposers: Disposer[] = [];

  constructor(readonly host: HTMLElement) {
    this.viewer = makeMinimalViewer({
      target: host,
      // Position (top left) and each panel's controls (top right) only.
      showUIControls: true,
      showTopBar: true,
      showLocation: true,
      showAnnotationToolStatus: true,
      showPanelControls: true,
      showHelpButton: false,
      showSettingsButton: false,
      showEditStateButton: false,
      showScreenshotButton: false,
      showToolPaletteButton: false,
      showLayerListPanelButton: false,
      showSelectionPanelButton: false,
      showLayerSidePanelButton: false,
      showCopyUrlButton: false,
      showLayerPanel: false,
      showLayerHoverValues: false,
      showLayerDialog: false,
      // An empty scene keeps its layout and position.
      resetStateWhenEmpty: false,
      externalSidePanels: true,
      showPanelBorders: true,
    });
    guardSelectedValues(this.viewer.layerSelectedValues as unknown as SelectedValues);
    this.viewer.coordinateSpace.changed.add(() => {
      this.preferXyz();
      this.applyPanelConvention();
    });
    // Four panels have the 3-D view bottom right here, as in Freeview: Neuroglancer's
    // "4panel" (3-D bottom left), from a link or its own panel buttons, becomes "4panel-alt".
    this.viewer.layout.changed.add(() => {
      if (this.viewer.layout.toJSON() === "4panel") this.viewer.layout.restoreState("4panel-alt");
    });
    addMomentum(host, this.viewer.perspectiveNavigationState.pose.orientation, () => this.momentum);
    const bindings = this.viewer.inputEventBindings;
    bindings.global.addParent(viewKeyBindings(), Number.NEGATIVE_INFINITY);
    bindings.sliceView.addParent(getDefaultSliceViewPanelBindings(), Number.NEGATIVE_INFINITY);
    bindings.perspectiveView.addParent(getDefaultPerspectivePanelBindings(), Number.NEGATIVE_INFINITY);
    // Right-drag and ctrl-wheel belong to the views; the rest of the page
    // keeps its context menu and page zoom.
    const noMenu = (e: Event) => e.preventDefault();
    const noZoom = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    host.addEventListener("contextmenu", noMenu);
    host.addEventListener("wheel", noZoom, { passive: false });
    this.disposers.push(() => {
      host.removeEventListener("contextmenu", noMenu);
      host.removeEventListener("wheel", noZoom);
    });
    // Segmentations drawn as outlines keep their outline layers' colours in step.
    this.disposers.push(watchOutlines(this));
    // Segmentation layers whose drawing a plugin hides stay hidden when made afresh.
    const lm = this.viewer.layerManager;
    for (const signal of [lm.layersChanged, lm.readyStateChanged, lm.specificationChanged]) {
      this.disposers.push(
        signal.add(() => {
          if (this.hiddenSegments.size > 0) this.rehideSegments();
        }),
      );
    }
  }

  // ------------------------------------------------------------- state

  getState(): Json {
    const ng = this.viewer.state.toJSON() as Json;
    // The 2-D views' background a plugin set for a while is saved as it was.
    if (this.background !== undefined) {
      if (this.background.json === undefined) delete ng.crossSectionBackgroundColor;
      else ng.crossSectionBackgroundColor = this.background.json;
    }
    // A layer whose drawing a plugin hides is saved as it was.
    if (this.hiddenDrawing.size > 0 && Array.isArray(ng.layers)) {
      for (const layer of ng.layers as Json[]) {
        const hidden = this.hiddenDrawing.get(String(layer.name));
        if (hidden === undefined) continue;
        if (hidden.json === undefined) delete layer.opacity;
        else layer.opacity = hidden.json;
      }
    }
    // A segmentation layer whose drawing a plugin hides keeps its notSelectedAlpha.
    if (this.hiddenFaint.size > 0 && Array.isArray(ng.layers)) {
      for (const layer of ng.layers as Json[]) {
        const hidden = this.hiddenFaint.get(String(layer.name));
        if (hidden === undefined) continue;
        if (hidden.json === undefined || hidden.json === 0) delete layer.notSelectedAlpha;
        else layer.notSelectedAlpha = hidden.json;
      }
    }
    return ng;
  }

  /** The 2-D views' background as it was while a plugin sets another (its value, and as saved). */
  private background: { value: Float32Array; json: Json[string]; temporary: Float32Array } | undefined;

  /**
   * Sets the 2-D views' background for a while (Luxar's splats in place of an
   * image need black), or (`undefined`) puts it back: not saved in the link.
   */
  setTemporaryBackground(rgb: [number, number, number] | undefined): void {
    const colour = this.viewer.crossSectionBackgroundColor;
    if (rgb === undefined) {
      if (this.background === undefined) return;
      const before = this.background;
      this.background = undefined;
      colour.value = before.value as typeof colour.value;
      return;
    }
    const temporary = Float32Array.from(rgb);
    this.background = this.background !== undefined ? { ...this.background, temporary } : { value: Float32Array.from(colour.value), json: (this.viewer.state.toJSON() as Json).crossSectionBackgroundColor, temporary };
    colour.value = temporary as typeof colour.value;
  }

  /**
   * Whether an annotation is being drawn: a tool that places it in steps
   * (a polyline, a line, a box, an ellipsoid) has started one.  Restoring the
   * layer's annotations meanwhile would lose it.
   */
  annotationInProgress(): boolean {
    return this.viewer.layerManager.managedLayers.some((managed) => {
      const tool = (managed.layer as unknown as { tool?: { value?: { inProgressAnnotation?: { value?: unknown } } } } | null)?.tool?.value;
      return tool?.inProgressAnnotation?.value !== undefined;
    });
  }

  /** Shows a surface map as a surface layer's overlay (Render → Surface's Overlay); false when the layer is not a surface. */
  setSurfaceOverlay(name: string, map: string): boolean {
    const layer = this.segmentationLayer(name);
    return layer !== undefined && setSurfaceOverlay(layer, map);
  }

  /** Layers whose own drawing a plugin hides: their opacity as it was (its value, and as saved). */
  private readonly hiddenDrawing = new Map<string, { value: number; json: Json[string]; off: () => void; target: object }>();

  /**
   * Hides an image layer's own drawing (its opacity 0), or shows it again,
   * for a plugin that draws the layer itself (Luxar's splats).  Not saved:
   * the state keeps the opacity the layer had, and a change to it while
   * hidden (an undo, the opacity slider) becomes the opacity it returns to.
   * A segmentation layer's segments are shown as a temporary set naming no
   * object instead (see `hiddenSegments`).
   */
  hideDrawing(name: string, hide: boolean): void {
    if (this.segmentationLayer(name) !== undefined || this.hiddenSegments.has(name)) {
      this.hideSegmentDrawing(name, hide);
      return;
    }
    const known = this.hiddenDrawing.get(name);
    if (!hide) {
      if (known === undefined) return;
      known.off();
      this.hiddenDrawing.delete(name);
      const opacity = this.opacityOf(name);
      if (opacity !== undefined) opacity.value = known.value;
      return;
    }
    const opacity = this.opacityOf(name);
    if (opacity === undefined || known?.target === opacity) return;
    // A layer made afresh (its sources changed) is hidden again, keeping the opacity it had.
    known?.off();
    const json = known !== undefined ? known.json : (this.managed(name)?.toJSON() as Json | undefined)?.opacity;
    const entry = { value: known !== undefined && opacity.value === 0 ? known.value : opacity.value, json, off: () => {}, target: opacity as object };
    this.hiddenDrawing.set(name, entry);
    const rezero = () => {
      const now = this.opacityOf(name);
      if (now === undefined || now.value === 0) return;
      entry.value = now.value;
      entry.json = now.value;
      now.value = 0;
    };
    entry.off = opacity.changed.add(rezero);
    opacity.value = 0;
  }

  private opacityOf(name: string): { value: number; changed: { add(f: () => void): () => void } } | undefined {
    const layer = this.managed(name)?.layer as unknown as { opacity?: { value: number; changed: { add(f: () => void): () => void } } } | null | undefined;
    return typeof layer?.opacity?.value === "number" ? layer.opacity : undefined;
  }

  /**
   * Restores a whole Neuroglancer state, changing only what differs.  Keys
   * absent from `ng` return to their defaults; layers are matched by name
   * and kept when unchanged (see the fork's incremental layer restore), so
   * undo, redo and switching scenes do not reload data.
   */
  setState(ng: Json): void {
    const { state } = this.viewer;
    // A segmentation layer whose drawing a plugin hides, restored with the
    // notSelectedAlpha getState saved for it, is restored as it is now (0):
    // the same specification, so the layer is kept, not made afresh (which
    // would drop a plugin's temporary visible set).  Copies: `ng` may be a
    // state kept for undo.
    if (this.hiddenFaint.size > 0 && Array.isArray(ng.layers)) {
      ng = {
        ...ng,
        layers: (ng.layers as Json[]).map((layer) => {
          const faint = this.hiddenFaint.get(String(layer.name));
          if (faint === undefined || layer.notSelectedAlpha === undefined || layer.notSelectedAlpha !== faint.json) return layer;
          const copy = { ...layer };
          delete copy.notSelectedAlpha;
          return copy;
        }),
      };
    }
    for (const [key, child] of state.children) {
      if (Object.prototype.hasOwnProperty.call(ng, key) && ng[key] !== undefined) continue;
      if (key === "layers") child.restoreState([]);
      else child.reset();
    }
    state.restoreState(ng);
    // A background set for a while stays (the state restored has the one saved).
    if (this.background !== undefined) {
      const colour = this.viewer.crossSectionBackgroundColor;
      this.background = { value: Float32Array.from(colour.value), json: (ng as Json).crossSectionBackgroundColor, temporary: this.background.temporary };
      colour.value = this.background.temporary as typeof colour.value;
    }
    // Layers whose drawing a plugin hides stay hidden (their layer objects may be new).
    for (const [name, hidden] of [...this.hiddenDrawing]) {
      const opacity = this.opacityOf(name);
      hidden.off();
      this.hiddenDrawing.delete(name);
      if (opacity !== undefined) this.hideDrawing(name, true);
    }
  }

  onStateChanged(callback: () => void): Disposer {
    this.stateListeners.add(callback);
    const off = this.viewer.state.changed.add(
      deferred(() => {
        if (this.held > 0) this.missedChanges = true;
        else callback();
      }),
    );
    return () => {
      off();
      this.stateListeners.delete(callback);
    };
  }

  private readonly stateListeners = new Set<() => void>();
  private held = 0;
  private missedChanges = false;

  /**
   * Keeps state changes from the workspace's listeners (each would be an
   * undo step and a new address) until the returned function is called,
   * which tells them once if anything changed: a capture moves the view
   * frame by frame and puts it back.
   */
  holdStateChanges(): () => void {
    this.held++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.held > 0 || !this.missedChanges) return;
      this.missedChanges = false;
      for (const listener of this.stateListeners) {
        try {
          listener();
        } catch (e) {
          console.error("ngplatform listener failed", e);
        }
      }
    };
  }

  // ------------------------------------------------------------ layers

  private managed(name: string): ManagedUserLayer | undefined {
    return this.viewer.layerManager.getLayerByName(name);
  }

  layers(): LayerInfo[] {
    return this.viewer.layerManager.managedLayers.map((managed) => ({
      name: managed.name,
      type: managed.layer?.type ?? "new",
      visible: managed.visible,
      archived: managed.archived,
      sources: layerSources(managed),
      ready: managed.isReady() === true,
      error: layerError(managed),
    }));
  }

  /**
   * An object that changes whenever the layer named `name` is replaced or
   * changes type, so mounted controls know to mount again.
   */
  layerToken(name: string): object | undefined {
    return this.managed(name)?.layer ?? undefined;
  }

  /** A layer's specification, as it would appear in the state's layer list. */
  layerSpec(name: string): Json | undefined {
    return this.managed(name)?.toJSON() as Json | undefined;
  }

  onLayersChanged(callback: () => void): Disposer {
    const lm = this.viewer.layerManager;
    const run = deferred(callback);
    const a = lm.layersChanged.add(run);
    const b = lm.readyStateChanged.add(run);
    const c = lm.specificationChanged.add(run);
    return () => {
      a();
      b();
      c();
    };
  }

  /** Adds one layer, leaving every other layer untouched. */
  addLayer(spec: Json, options: { index?: number; select?: boolean } = {}): string {
    const lm = this.viewer.layerManager;
    const requested = typeof spec.name === "string" && spec.name !== "" ? spec.name : "layer";
    const name = lm.getUniqueLayerName(requested);
    const managed = new ManagedUserLayer(name, this.viewer.layerSpecification);
    this.viewer.layerSpecification.add(managed, options.index);
    initializeLayerFromSpecShowErrorStatus(managed, { ...spec, name });
    if (options.select) this.selectLayer(name);
    return name;
  }

  removeLayer(name: string): void {
    const managed = this.managed(name);
    if (managed !== undefined) deleteLayer(managed);
  }

  renameLayer(name: string, newName: string): string | undefined {
    const managed = this.managed(name);
    if (managed === undefined) return undefined;
    changeLayerName(managed, newName);
    return managed.name;
  }

  setLayerVisible(name: string, visible: boolean): void {
    this.managed(name)?.setVisible(visible);
  }

  /** Moves a layer to `index` in the layer list (draw order). */
  moveLayer(name: string, index: number): void {
    const lm = this.viewer.layerManager;
    const managed = this.managed(name);
    if (managed === undefined) return;
    lm.reorderManagedLayer(lm.managedLayers.indexOf(managed), Math.max(0, Math.min(index, lm.managedLayers.length - 1)));
  }

  selectedLayer(): string | undefined {
    return this.viewer.selectedLayer.layer?.name;
  }

  /**
   * Makes `name` the selected layer: the one tools and annotation act on.
   * Its controls show in the platform's inspector, never inside the viewer.
   */
  selectLayer(name: string | undefined): void {
    const selected = this.viewer.selectedLayer;
    if (name === undefined) {
      selected.layer = undefined;
      return;
    }
    const managed = this.managed(name);
    if (managed !== undefined && selected.layer !== managed) selected.layer = managed;
  }

  onSelectionChanged(callback: () => void): Disposer {
    return this.viewer.selectedLayer.changed.add(deferred(callback));
  }

  // ---------------------------------------------------------- pointer

  cursor(): CursorInfo {
    const { mouseState, coordinateSpace } = this.viewer;
    const space = coordinateSpace.value;
    let values: Record<string, unknown> = {};
    try {
      values = this.viewer.layerSelectedValues.toJSON();
    } catch {
      values = {};
    }
    return {
      active: mouseState.active,
      position: Array.from(mouseState.position),
      names: [...space.names],
      units: [...space.units],
      scales: Array.from(space.scales),
      values,
    };
  }

  onCursorChanged(callback: () => void): Disposer {
    return this.viewer.mouseState.changed.add(deferred(callback));
  }

  // -------------------------------------------------------- navigation

  navigation(): NavigationInfo {
    const v = this.viewer;
    const space = v.coordinateSpace.value;
    return {
      names: [...space.names],
      units: [...space.units],
      scales: Array.from(space.scales),
      position: Array.from(v.position.value),
      crossSectionScale: v.crossSectionScale.value,
      projectionScale: v.projectionScale.value,
      layout: this.layout(),
    };
  }

  onNavigationChanged(callback: () => void): Disposer {
    const v = this.viewer;
    const run = deferred(callback);
    const offs = [
      v.navigationState.changed.add(run),
      v.perspectiveNavigationState.changed.add(run),
      v.coordinateSpace.changed.add(run),
      v.layout.changed.add(run),
    ];
    return () => offs.forEach((off) => off());
  }

  setPosition(position: number[]): void {
    const { position: pos } = this.viewer;
    const value = new Float32Array(pos.value);
    position.forEach((x, i) => {
      if (i < value.length && Number.isFinite(x)) value[i] = x;
    });
    pos.value = value;
  }

  /**
   * A layer's local dimensions (those its sources name `t'`, out of the
   * global ones) and its position along them, in their coordinates;
   * undefined until the layer has loaded.
   */
  localPosition(name: string): { names: string[]; scales: number[]; units: string[]; position: number[] } | undefined {
    const layer = this.managed(name)?.layer;
    if (layer === null || layer === undefined) return undefined;
    const space = layer.localCoordinateSpace.value;
    if (!space.valid) return undefined;
    return { names: [...space.names], scales: Array.from(space.scales), units: [...space.units], position: Array.from(layer.localPosition.value) };
  }

  /** Moves a layer's local position (NaN leaves a dimension where it is). */
  setLocalPosition(name: string, position: number[]): void {
    const layer = this.managed(name)?.layer;
    if (layer === null || layer === undefined) return;
    const pos = layer.localPosition;
    const value = new Float32Array(pos.value);
    position.forEach((x, i) => {
      if (i < value.length && Number.isFinite(x)) value[i] = x;
    });
    pos.value = value;
  }

  /** Multiplies the 2D and 3D zoom (a scale is the size of one screen pixel). */
  zoom(factor: number): void {
    const v = this.viewer;
    v.crossSectionScale.value *= factor;
    v.projectionScale.value *= factor;
  }

  setScales(crossSection?: number, projection?: number): void {
    const v = this.viewer;
    if (crossSection !== undefined && crossSection > 0) v.crossSectionScale.value = crossSection;
    if (projection !== undefined && projection > 0) v.projectionScale.value = projection;
  }

  /**
   * Centres the view on the data and zooms the sections and the 3D view to
   * show all of it.
   */
  fitToData(): void {
    const v = this.viewer;
    const space = v.coordinateSpace.value;
    if (!space.valid || space.rank === 0) return;
    v.position.reset();
    v.position.snapToVoxel();
    v.projectionScale.reset();
    v.projectionScale.handleCoordinateSpaceChanged();
    // The largest extent across the displayed axes, in canonical voxels (the zoom's unit).
    const { canonicalVoxelFactors, displayDimensionIndices } = v.navigationState.displayDimensionRenderInfo.value;
    const { lowerBounds, upperBounds } = space.bounds;
    let extent = 0;
    canonicalVoxelFactors.forEach((factor, i) => {
      const dim = displayDimensionIndices[i];
      if (dim !== -1) extent = Math.max(extent, (upperBounds[dim] - lowerBounds[dim]) * factor);
    });
    const panel = this.host.parentElement?.querySelector<HTMLElement>(".neuroglancer-rendered-data-panel");
    const pixels = Math.max(160, Math.min(panel?.clientWidth ?? 400, panel?.clientHeight ?? 400));
    const scale = (extent * 1.1) / pixels;
    if (Number.isFinite(scale) && scale > 0) v.crossSectionScale.value = scale;
  }

  /** Fits the view to the data (fitToData) once layer `name` has loaded. */
  fitWhenLoaded(name: string): void {
    this.whenLoaded(name, () => this.viewer.coordinateSpace.value.valid, () => this.fitToData());
  }

  /**
   * Sets an image layer's contrast from its source's channel metadata (OME's
   * omero window) once it has loaded, unless its shader or contrast is set.
   */
  contrastWhenLoaded(name: string): void {
    this.whenLoaded(name, () => true, async () => {
      const layer = this.managed(name)?.layer;
      if (!(layer instanceof ImageUserLayer)) return;
      const spec = layer.toJSON() as Json;
      const controls = (spec.shaderControls ?? {}) as Json;
      if (spec.shader !== undefined || controls.normalized !== undefined) return;
      // A colour image packed one uint32 a voxel (this app's TIFF and NIfTI stores say so): unpacked to RGB.
      if (await packedColour(spec)) {
        // The shader is still the default: the spec has none.
        layer.fragmentMain.value = RGB_SHADER;
        return;
      }
      const load = layer.dataSources[0]?.loadState;
      const channel = load !== undefined && load.error === undefined ? load.dataSource.channelMetadata?.channels?.[0] : undefined;
      if (channel?.range === undefined) return;
      layer.shaderControlState.restoreState({ ...controls, normalized: { range: Array.from(channel.range), ...(channel.window ? { window: Array.from(channel.window) } : {}) } });
    });
  }

  /** Runs `run` once layer `name` is ready and `also` holds, if within `timeout` ms. */
  private whenLoaded(name: string, also: () => boolean, run: () => void | Promise<void>, timeout = 120_000): void {
    const v = this.viewer;
    const offs: Disposer[] = [];
    let done = false;
    const finish = () => {
      done = true;
      offs.forEach((off) => off());
    };
    const check = () => {
      if (done) return;
      const managed = this.managed(name);
      if (managed === undefined) return finish();
      if (managed.isReady() !== true || !also()) return;
      finish();
      void run();
    };
    const timer = setTimeout(finish, timeout);
    offs.push(v.layerManager.readyStateChanged.add(check), v.layerManager.layersChanged.add(check), v.coordinateSpace.changed.add(check), () => clearTimeout(timer));
    check();
  }

  resetOrientation(): void {
    this.viewer.navigationState.pose.orientation.reset();
    this.viewer.perspectiveNavigationState.pose.orientation.reset();
  }

  /**
   * Which way up the cross-section panels show the data (see anatomical.ts):
   * a choice remembered in this browser, or "auto": as Freeview does
   * (radiological) for anatomy in RAS, as Neuroglancer does otherwise.
   */
  panelConvention(): { preference: PanelConvention | "auto"; applied: PanelConvention } {
    return { preference: this.panelPreference, applied: this.appliedConvention };
  }

  setPanelConvention(preference: PanelConvention | "auto"): void {
    this.panelPreference = preference;
    try {
      localStorage.setItem(PANEL_CONVENTION_KEY, preference);
    } catch {
      // Not remembered; it still applies now.
    }
    this.applyPanelConvention();
  }

  private panelPreference: PanelConvention | "auto" = readPanelPreference();

  /** Whether the 3-D view keeps turning after a drag (see momentum.ts); remembered in the browser. */
  get momentum(): boolean {
    return this.momentumOn;
  }

  set momentum(on: boolean) {
    this.momentumOn = on;
    try {
      localStorage.setItem(MOMENTUM_KEY, on ? "on" : "off");
    } catch {
      // Not remembered; it still applies now.
    }
  }

  private momentumOn = readMomentum();
  private appliedConvention: PanelConvention = "neuroglancer";

  /**
   * Shows x, y and z, in that order, when the space has them: OME-Zarr
   * images list their axes z, y, x (slowest first), and a scene whose first
   * data is one would otherwise show the z-y plane in the panel named xy,
   * and the anatomical orientation (applyPanelConvention) would not apply.
   * Left alone when the scene chose its display dimensions itself.
   */
  private preferXyz(): void {
    const space = this.viewer.coordinateSpace.value;
    const display = this.viewer.displayDimensions;
    if (!space.valid || display.toJSON() !== undefined) return;
    if (!["x", "y", "z"].every((n) => space.names.includes(n))) return;
    const { displayRank, displayDimensionIndices } = display.value;
    const shown = Array.from(displayDimensionIndices.slice(0, displayRank)).map((i) => space.names[i]);
    if (shown.join(",") === "x,y,z") return;
    display.restoreState(["x", "y", "z"]);
  }

  private applyPanelConvention(): void {
    const space = this.viewer.coordinateSpace.value;
    const want: PanelConvention =
      this.panelPreference !== "auto"
        ? this.panelPreference
        : space.valid && looksAnatomical(space.names, Array.from(space.scales), space.units)
          ? "radiological"
          : "neuroglancer";
    if (want === this.appliedConvention) return;
    this.appliedConvention = want;
    const rotations = panelRotations(want);
    for (const axes of ["xy", "xz", "yz"] as const) {
      const q = rotations[axes];
      setNamedPanelOrientation(axes, q === undefined ? undefined : (Float32Array.from(q) as unknown as Parameters<typeof setNamedPanelOrientation>[1]));
    }
    // Panels take their rotation when made: make the layout again.
    const layout = this.viewer.layout.toJSON();
    this.viewer.layout.restoreState(layout === "3d" ? "xy" : "3d");
    this.viewer.layout.restoreState(layout);
  }

  layout(): string {
    const layout = this.viewer.layout.toJSON();
    return typeof layout === "string" ? layout : "custom";
  }

  setLayout(layout: string): void {
    this.viewer.layout.restoreState(layout);
  }

  /** Display switches the platform shows as checkboxes. */
  private viewOptionTrackables() {
    const v = this.viewer;
    return {
      showAxisLines: v.showAxisLines,
      showScaleBar: v.showScaleBar,
      showSlices: v.showPerspectiveSliceViews,
      showDefaultAnnotations: v.showDefaultAnnotations,
      wireFrame: v.wireFrame,
      enableAdaptiveDownsampling: v.enableAdaptiveDownsampling,
    };
  }

  viewOptions(): Record<string, boolean> {
    return Object.fromEntries(Object.entries(this.viewOptionTrackables()).map(([k, t]) => [k, t.value]));
  }

  setViewOption(key: string, value: boolean): void {
    const trackable = (this.viewOptionTrackables() as Record<string, { value: boolean }>)[key];
    if (trackable !== undefined) trackable.value = value;
  }

  /** Runs one of Neuroglancer's named viewer actions, e.g. "toggle-axis-lines". */
  action(name: string): void {
    this.viewer.element.dispatchEvent(new CustomEvent(`action:${name}`, { bubbles: true, cancelable: true }));
  }

  // ----------------------------------------- Neuroglancer widgets, docked

  /**
   * Mounts a layer's settings (Source, Render, Segments, Annotations…,
   * whatever its type offers) into `host`, as the platform's own inspector.
   */
  mountLayerControls(host: HTMLElement, name: string): Disposer {
    const userLayer = this.managed(name)?.layer;
    if (userLayer == null) return () => {};
    return mountInspector(host, userLayer);
  }

  // ----------------------------------------------------- segment state

  private segmentationLayer(name: string): SegmentationUserLayer | undefined {
    const layer = this.managed(name)?.layer;
    return layer instanceof SegmentationUserLayer ? layer : undefined;
  }

  /**
   * A segmentation layer's segment properties (numeric columns and tags), as
   * plain arrays, once its source has supplied them.
   */
  segmentProperties(name: string): SegmentProperties | undefined {
    const map = this.segmentationLayer(name)?.displayState.segmentPropertyMap.value;
    const inline = map?.segmentPropertyMap.inlineProperties;
    if (map === undefined || inline === undefined) return undefined;
    return {
      ids: inline.ids,
      numeric: map.numericalProperties.map((p) => ({
        id: p.id,
        description: p.description,
        values: p.values,
        min: Number(p.bounds[0]),
        max: Number(p.bounds[1]),
      })),
      tags:
        map.tags === undefined
          ? undefined
          : { names: map.tags.tags, descriptions: map.tags.tagDescriptions, values: map.tags.values },
    };
  }

  /** Calls back when a layer's segment properties arrive or change. */
  onSegmentPropertiesChanged(name: string, callback: () => void): Disposer {
    let current: Disposer | undefined;
    let layer: SegmentationUserLayer | undefined;
    const run = deferred(callback);
    const bind = () => {
      const next = this.segmentationLayer(name);
      if (next === layer) return;
      current?.();
      layer = next;
      current = next?.displayState.segmentPropertyMap.changed.add(run);
      run();
    };
    const off = this.viewer.layerManager.layersChanged.add(bind);
    bind();
    return () => {
      off();
      current?.();
    };
  }

  /** The `lut://` source naming a segmentation layer's lookup table, if it has one. */
  lookupTable(name: string): string | undefined {
    const layer = this.segmentationLayer(name);
    return layer && layerLookupSource(layer);
  }

  /** Gives a segmentation layer a lookup table, as its Render tab does (see lookup_tables.ts). */
  async setLookupTable(name: string, url: string | undefined): Promise<void> {
    const layer = this.segmentationLayer(name);
    if (layer === undefined) throw new Error(`${name} is not a segmentation layer`);
    await applyLookupTable(layer, url);
  }

  /**
   * Temporary visible sets plugins asked for (`setTemporaryVisibleSegments`),
   * with the layer state each was set on: a layer made afresh forgets its
   * set, as Neuroglancer's own does.
   */
  private readonly temporarySegments = new Map<string, { group: object; ids: BigUint64Array; set?: Set<bigint> }>();
  /**
   * Segmentation layers whose own drawing a plugin hides (Luxar draws them),
   * with the layer state it was hidden on: their segments are shown as a
   * temporary set naming no object, which Neuroglancer neither draws nor
   * reads chunks for, while `visibleSegments` still says what they show.
   */
  private readonly hiddenSegments = new Map<string, object | undefined>();
  /** Called when a layer's claimed temporary set changes (listeners of `onSegmentsChanged`). */
  private readonly segmentListeners = new Map<string, Set<() => void>>();

  /**
   * Shows only `ids` in a segmentation layer, through its temporary visible
   * set: not saved in the state, so a filter result never bloats the link.
   * `undefined` returns the layer to its ordinary visible segments.  While
   * the layer's drawing is hidden (`hideDrawing`) the set is kept and
   * reported by `visibleSegments`, and shown when the drawing is.
   */
  setTemporaryVisibleSegments(name: string, ids: BigUint64Array | undefined): void {
    const group = this.segmentationLayer(name)?.displayState.segmentationGroupState.value;
    if (group === undefined) return;
    if (ids === undefined) this.temporarySegments.delete(name);
    else this.temporarySegments.set(name, { group, ids: BigUint64Array.from(ids) });
    this.applySegments(name);
    for (const listener of this.segmentListeners.get(name) ?? []) listener();
  }

  /** Puts a layer's temporary visible set as it should be: none, a plugin's set, or (hidden) no object. */
  private applySegments(name: string): void {
    const group = this.segmentationLayer(name)?.displayState.segmentationGroupState.value;
    if (group === undefined) return;
    const claim = this.temporarySegments.get(name);
    const hidden = this.hiddenSegments.has(name);
    if (hidden) this.hiddenSegments.set(name, group);
    const ids = hidden ? HIDDEN_SEGMENTS : claim?.group === group ? claim.ids : undefined;
    group.temporaryVisibleSegments.clear();
    if (ids === undefined) {
      group.useTemporaryVisibleSegments.value = false;
      return;
    }
    // Sized once for the whole set (here and in the workers' copies): adding
    // hundreds of thousands of ids to a table that grows as it fills
    // rehashes it again and again.
    const set = group.temporaryVisibleSegments;
    set.reserve(Math.ceil(ids.length / set.hashTable.loadFactor));
    set.add(ids);
    group.useTemporaryVisibleSegments.value = true;
  }

  /** Hides a segmentation layer's drawing or shows it again (see `hiddenSegments`). */
  private hideSegmentDrawing(name: string, hide: boolean): void {
    if (hide === this.hiddenSegments.has(name)) {
      // Hidden already: again only on a layer made afresh.
      const group = this.segmentationLayer(name)?.displayState.segmentationGroupState.value;
      if (!hide || group === undefined || this.hiddenSegments.get(name) === group) return;
    }
    if (hide) this.hiddenSegments.set(name, undefined);
    else this.hiddenSegments.delete(name);
    this.applySegments(name);
    this.zeroNotSelected(name, hide);
  }

  /** Hides again the segmentation layers made afresh (an undo, a source changed) while hidden. */
  private rehideSegments(): void {
    for (const [name, group] of this.hiddenSegments) {
      const now = this.segmentationLayer(name)?.displayState.segmentationGroupState.value;
      if (now !== undefined && now !== group) this.applySegments(name);
      this.zeroNotSelected(name, true);
    }
  }

  /**
   * Segmentation layers whose drawing a plugin hides, with their
   * notSelectedAlpha as it was (its value, and as saved): Neuroglancer would
   * draw every object not chosen at that strength, the hidden temporary set
   * included, so it is kept at 0 meanwhile.  A change to it while hidden
   * (the "Opacity (off)" slider, an undo) becomes the value reported and
   * put back.
   */
  private readonly hiddenFaint = new Map<string, { value: number; json: Json[string]; off: () => void; target: object }>();

  private zeroNotSelected(name: string, hide: boolean): void {
    const known = this.hiddenFaint.get(name);
    const alpha = this.segmentationLayer(name)?.displayState.notSelectedAlpha;
    if (!hide) {
      if (known === undefined) return;
      known.off();
      this.hiddenFaint.delete(name);
      if (alpha !== undefined) alpha.value = known.value;
      return;
    }
    if (alpha === undefined || known?.target === alpha) return;
    // A layer made afresh: hidden again, keeping the value it had unless the new one says otherwise.
    known?.off();
    const keep = known !== undefined && alpha.value === 0;
    const json = keep ? known.json : (this.managed(name)?.toJSON() as Json | undefined)?.notSelectedAlpha;
    const entry = { value: keep ? known.value : alpha.value, json, off: () => {}, target: alpha as object };
    this.hiddenFaint.set(name, entry);
    let zeroing = false;
    const rezero = () => {
      if (zeroing) return;
      entry.value = alpha.value;
      entry.json = alpha.value;
      if (alpha.value === 0) return;
      zeroing = true;
      alpha.value = 0;
      zeroing = false;
    };
    entry.off = alpha.changed.add(rezero);
    zeroing = true;
    alpha.value = 0;
    zeroing = false;
  }

  /**
   * What a segmentation layer shows, as Neuroglancer would draw it (were its
   * drawing not hidden): every object (`all`: no segment chosen and
   * `ignoreNullVisibleSet`), or those `has` says.  The segments are a
   * plugin's temporary set when one is set, else the layer's own.
   */
  visibleSegments(name: string): VisibleSegments | undefined {
    const layer = this.segmentationLayer(name);
    if (layer === undefined) return undefined;
    const { displayState } = layer;
    const group = displayState.segmentationGroupState.value;
    const claim = this.temporarySegments.get(name);
    const ignoreNull = displayState.ignoreNullVisibleSet.value;
    // The layer's own, also while its drawing is hidden (and it is kept at 0).
    const notSelectedAlpha = this.hiddenFaint.get(name)?.value ?? displayState.notSelectedAlpha.value;
    if (claim !== undefined && claim.group === group) {
      const set = (claim.set ??= new Set(claim.ids));
      return { all: set.size === 0 && ignoreNull, size: set.size, has: (id) => set.has(id), ids: () => BigUint64Array.from(set), notSelectedAlpha };
    }
    // A temporary set Neuroglancer itself made (not ours to hide behind).
    const own = (!this.hiddenSegments.has(name) && group.useTemporaryVisibleSegments.value ? group.temporaryVisibleSegments : group.visibleSegments) as typeof group.visibleSegments & Iterable<bigint>;
    return { all: own.size === 0 && ignoreNull, size: own.size, has: (id) => own.has(id), ids: () => BigUint64Array.from(own), notSelectedAlpha };
  }

  /**
   * A segment's colour in a segmentation layer, as Neuroglancer colours it
   * (a colour stated for it, the layer's default colour, or the hash of its
   * id with the layer's seed), with the layer's saturation.  RGB, 0 to 1.
   */
  segmentColour(name: string, id: bigint): [number, number, number] | undefined {
    const layer = this.segmentationLayer(name);
    if (layer === undefined) return undefined;
    const ds = layer.displayState;
    const c = getBaseObjectColor(ds as unknown as Parameters<typeof getBaseObjectColor>[0], id, segmentColourScratch);
    const s = ds.saturation.value;
    return [c[0] * s + 1 - s, c[1] * s + 1 - s, c[2] * s + 1 - s];
  }

  /**
   * Calls back when what a segmentation layer shows or how its segments are
   * coloured changes: its segments, a plugin's temporary set, the colours,
   * or the layer made afresh.
   */
  onSegmentsChanged(name: string, callback: () => void): Disposer {
    const run = deferred(callback);
    let bound: object | undefined;
    let offs: (() => void)[] = [];
    const unbind = () => {
      offs.forEach((off) => off());
      offs = [];
    };
    const bind = () => {
      const layer = this.segmentationLayer(name);
      const groupState = layer?.displayState.segmentationGroupState.value;
      const colours = layer?.displayState.segmentationColorGroupState.value;
      const token = layer === undefined ? undefined : [layer, groupState, colours];
      if (token !== undefined && bound !== undefined && (bound as unknown[]).every((v, i) => v === token[i])) return;
      unbind();
      bound = token;
      run();
      if (layer === undefined) return;
      const ds = layer.displayState;
      for (const signal of [
        groupState!.visibleSegments.changed,
        groupState!.temporaryVisibleSegments.changed,
        groupState!.useTemporaryVisibleSegments.changed,
        ds.ignoreNullVisibleSet.changed,
        ds.notSelectedAlpha.changed,
        ds.saturation.changed,
        colours!.segmentColorHash.changed,
        colours!.segmentStatedColors.changed,
        colours!.segmentDefaultColor.changed,
      ]) {
        offs.push(signal.add(run));
      }
      // The layer's group (a link to another layer's) changing.
      offs.push(ds.segmentationGroupState.changed.add(bind), ds.segmentationColorGroupState.changed.add(bind));
    };
    const lm = this.viewer.layerManager;
    const offLayers = [lm.layersChanged.add(bind), lm.readyStateChanged.add(bind), lm.specificationChanged.add(bind)];
    let listeners = this.segmentListeners.get(name);
    if (listeners === undefined) this.segmentListeners.set(name, (listeners = new Set()));
    listeners.add(run);
    bind();
    return () => {
      offLayers.forEach((off) => off());
      unbind();
      const set = this.segmentListeners.get(name);
      set?.delete(run);
      if (set?.size === 0) this.segmentListeners.delete(name);
    };
  }

  /** A layer's first source's transform (see the SDK's ViewerApi.layerTransform). */
  layerTransform(name: string): LayerTransformInfo | undefined {
    const t = this.transformOf(name);
    if (t === undefined) return undefined;
    const { rank, inputSpace, outputSpace, transform } = t.value;
    const space = (s: { names: readonly string[]; scales: Float64Array; units: readonly string[] }) => ({ names: [...s.names], scales: Array.from(s.scales), units: [...s.units] });
    const { lowerBounds, upperBounds } = inputSpace.bounds;
    const bounds = Array.from(lowerBounds).every(Number.isFinite) && Array.from(upperBounds).every(Number.isFinite) ? { lower: Array.from(lowerBounds), upper: Array.from(upperBounds) } : undefined;
    // The source's own transform, in the output space's scales as the current one is: Neuroglancer
    // keeps it in the source's (a 2 mm image's translation in 2 mm steps), and rescales only the
    // translation between them (coordinate_transform.ts, convertTransformOutputScales).
    const defaultMatrix = Float64Array.from(t.defaultTransform.transform);
    const own = t.defaultTransform.outputSpace;
    for (let r = 0; r < rank && own !== undefined; ++r) {
      if (own.names[r] === outputSpace.names[r] && own.scales[r] > 0 && outputSpace.scales[r] > 0) defaultMatrix[rank * (rank + 1) + r] *= own.scales[r] / outputSpace.scales[r];
    }
    return {
      rank,
      input: { ...space(inputSpace), ...(bounds ? { bounds } : {}) },
      output: space(outputSpace),
      matrix: Float64Array.from(transform),
      defaultMatrix,
    };
  }

  setLayerTransform(name: string, matrix: Float64Array): void {
    const t = this.transformOf(name);
    if (t !== undefined) t.transform = Float64Array.from(matrix);
  }

  private transformOf(name: string) {
    const loaded = this.viewer.layerManager.getLayerByName(name)?.layer?.dataSources[0]?.loadState;
    // A source that failed to load has no transform.
    return (loaded as unknown as { transform?: WatchableTransformLike } | undefined)?.transform;
  }

  /** The view panels shown now, 2-D and 3-D. */
  panels(): ViewPanel[] {
    const out: ViewPanel[] = [];
    for (const panel of this.viewer.display.panels) {
      const any = panel as unknown as {
        element?: HTMLElement;
        sliceView?: { projectionParameters: { value: ProjectionLike } };
        projectionParameters?: { value: ProjectionLike };
      };
      const projection = any.sliceView?.projectionParameters.value ?? any.projectionParameters?.value;
      const element = any.element;
      if (projection?.viewProjectionMat === undefined || element === undefined || !element.isConnected) continue;
      out.push({
        kind: any.sliceView !== undefined ? "2d" : "3d",
        element,
        project: (global) => {
          const p = any.sliceView?.projectionParameters.value ?? any.projectionParameters!.value;
          const { displayDimensionIndices } = p.displayDimensionRenderInfo;
          const d = [0, 1, 2].map((i) => (displayDimensionIndices[i] === -1 ? 0 : (global[displayDimensionIndices[i]] ?? 0)));
          const m = p.viewProjectionMat;
          const c = [0, 1, 2, 3].map((r) => m[r] * d[0] + m[4 + r] * d[1] + m[8 + r] * d[2] + m[12 + r]);
          if (c[3] <= 0) return undefined;
          const rect = element.getBoundingClientRect();
          return { x: ((c[0] / c[3] + 1) / 2) * rect.width, y: ((1 - c[1] / c[3]) / 2) * rect.height, depth: c[2] / c[3] };
        },
      });
    }
    return out;
  }

  /** Calls back after each frame Neuroglancer draws. */
  onRendered(callback: () => void): Disposer {
    return this.viewer.display.updateFinished.add(callback);
  }

  private readonly screenshotPainters = new Set<(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void>();

  /** Paints on top of Neuroglancer's screenshots (see the fork's screenshot_manager), until disposed. */
  addScreenshotOverlay(paint: (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void): Disposer {
    this.screenshotPainters.add(paint);
    setScreenshotOverlay((context, canvas) => {
      for (const painter of this.screenshotPainters) painter(context, canvas);
    });
    return () => this.screenshotPainters.delete(paint);
  }

  /** Paints the overlays plugins add to screenshots (labels) onto a capture. */
  paintOverlays(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    for (const painter of this.screenshotPainters) painter(context, canvas);
  }

  /** Starts capturing frames (see ./capture.ts); end the session to put the view back. */
  beginCapture(options: CaptureOptions): CaptureSession {
    return new CaptureSession(this, options);
  }

  /** The views a capture can be cropped to. */
  capturePanels(): CapturePanel[] {
    return capturePanels(this.viewer);
  }

  /** The dimensions a capture can sweep. */
  captureDimensions(): ReturnType<typeof captureDimensions> {
    return captureDimensions(this.viewer);
  }

  /** An element over the views, for drawing beside them in HTML (labels, say). */
  addOverlay(): { element: HTMLElement; dispose(): void } {
    const element = document.createElement("div");
    element.className = "view-overlay";
    this.host.parentElement!.append(element);
    return { element, dispose: () => element.remove() };
  }

  /** A plugin's drawing in the 3-D view, with the layer `name` (see ./draw3d.ts). */
  draw3d(name: string, drawer: Drawer3d): { redraw(): void; dispose(): void } {
    return draw3d(this.viewer, name, drawer);
  }

  /** A switch beside "Sections" in the 3-D panels. */
  viewToggle(spec: { label: string; title?: string; value: boolean; onChange(value: boolean): void }): { set(value: boolean): void; dispose(): void } {
    const value = new TrackableBoolean(spec.value, spec.value);
    const off = value.changed.add(() => spec.onChange(value.value));
    const remove = addPerspectivePanelToggle({ label: spec.label, title: spec.title, value });
    return {
      set: (v) => {
        value.value = v;
      },
      dispose: () => {
        off();
        remove();
      },
    };
  }

  /** Settings › View: the viewer's settings, as the app's fields. */
  mountSettings(host: HTMLElement): Disposer {
    return mountViewSettings(host, this.viewer);
  }

  /** What each chunk source has loaded for the views (Settings › Developer). */
  chunkStatistics(): Promise<ChunkSourceStatistics[]> {
    return chunkStatistics(this.viewer);
  }

  /** Neuroglancer's key and mouse binding reference, for the views. */
  mountBindingsHelp(host: HTMLElement): Disposer {
    const v = this.viewer;
    const { inputEventBindings } = v;
    return dockPanel(
      host,
      new InputEventBindingHelpDialog(
        DOCKED_PANEL_MANAGER,
        v.helpPanelState,
        [
          ["Views", inputEventBindings.global],
          ["Cross section view", inputEventBindings.sliceView],
          ["3-D projection view", inputEventBindings.perspectiveView],
        ],
        v.layerManager,
        v.globalToolBinder,
      ),
    );
  }

  /** Opens Neuroglancer's screenshot dialog (scale, crop, statistics). */
  showScreenshotDialog(): void {
    this.viewer.showScreenshotDialog();
  }

  /**
   * Moves Neuroglancer's status messages (loading, errors) into `host`, out
   * of the viewer, and reports each new one to `onMessage`.
   */
  routeStatusMessages(host: HTMLElement, onMessage: (text: string, error: boolean) => void): Disposer {
    const containers = getStatusMessageContainers();
    host.append(...containers);
    const seen = new WeakSet<Node>();
    const observer = new MutationObserver(() => {
      for (const container of containers) {
        for (const item of container.querySelectorAll("li")) {
          if (seen.has(item)) continue;
          const text = item.textContent?.replace(/\s*Dismiss\s*$/, "").trim() ?? "";
          if (text === "") continue;
          seen.add(item);
          onMessage(text, item.querySelector("button") !== null);
        }
      }
    });
    for (const container of containers) observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }

  dispose(): void {
    this.disposers.splice(0).forEach((d) => d());
    this.viewer.dispose();
  }
}
