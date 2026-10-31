/**
 * The Neuroglancer engine, mounted with none of its own interface.
 *
 * The viewer element holds the data panels only: no top bar, layer bar, side
 * panels or dialogs.  Everything those offered is reached through this class
 * and shown by the platform, which mounts Neuroglancer's own widgets (layer
 * controls, selection details, settings, help, statistics, position) into its
 * docks where they exist.
 */
import {
  changeLayerName,
  deleteLayer,
  EventActionMap,
  getDefaultPerspectivePanelBindings,
  getDefaultSliceViewPanelBindings,
  getStatusMessageContainers,
  InputEventBindingHelpDialog,
  initializeLayerFromSpecShowErrorStatus,
  makeMinimalViewer,
  ManagedUserLayer,
  MousePositionWidget,
  PositionWidget,
  SelectionDetailsPanel,
  type SidePanelManager,
  StatisticsPanel,
  TabView,
  type Viewer,
  ViewerSettingsPanel,
  WatchableValue,
} from "./neuroglancer.js";

export type Json = Record<string, unknown>;
export type Disposer = () => void;

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
  ["4panel", "4 panels"],
  ["4panel-alt", "4 panels (alt)"],
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

export class Engine {
  readonly viewer: Viewer;
  private readonly disposers: Disposer[] = [];
  /** How many docked copies of each location-driven panel are mounted. */
  private readonly docked = { selection: 0, statistics: 0 };

  constructor(readonly host: HTMLElement) {
    this.viewer = makeMinimalViewer({
      target: host,
      showUIControls: false,
      showTopBar: false,
      showLayerPanel: false,
      showLayerHoverValues: false,
      showLayerDialog: false,
      // An empty scene keeps its layout and position.
      resetStateWhenEmpty: false,
      externalSidePanels: true,
      showPanelBorders: true,
    });
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
  }

  // ------------------------------------------------------------- state

  getState(): Json {
    return this.viewer.state.toJSON() as Json;
  }

  /**
   * Restores a whole Neuroglancer state, changing only what differs.  Keys
   * absent from `ng` return to their defaults; layers are matched by name
   * and kept when unchanged (see the fork's incremental layer restore), so
   * undo, redo and switching scenes do not reload data.
   */
  setState(ng: Json): void {
    const { state } = this.viewer;
    for (const [key, child] of state.children) {
      if (Object.prototype.hasOwnProperty.call(ng, key) && ng[key] !== undefined) continue;
      if (key === "layers") child.restoreState([]);
      else child.reset();
    }
    state.restoreState(ng);
    // Docked panels draw only while their location is visible; a restored
    // state without them would hide them.
    if (this.docked.selection > 0) this.viewer.selectionDetailsState.location.visible = true;
    if (this.docked.statistics > 0) this.viewer.statisticsDisplayState.location.visible = true;
  }

  onStateChanged(callback: () => void): Disposer {
    return this.viewer.state.changed.add(deferred(callback));
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

  resetOrientation(): void {
    this.viewer.navigationState.pose.orientation.reset();
    this.viewer.perspectiveNavigationState.pose.orientation.reset();
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
   * Mounts a layer's own controls (Source, Rendering, Segments, Annotations…,
   * whatever its type offers) into `host`.
   */
  mountLayerControls(host: HTMLElement, name: string): Disposer {
    const managed = this.managed(name);
    const userLayer = managed?.layer;
    if (managed === undefined || userLayer == null) return () => {};
    const tabsOf = () =>
      [...userLayer.tabs.options]
        .map(([id, option]) => ({ id, label: option.label, hidden: option.hidden?.value ?? false, order: option.order ?? 0 }))
        .sort((a, b) => a.order - b.order)
        .map(({ id, label, hidden }) => ({ id, label, hidden }));
    const tabs = new WatchableValue(tabsOf());
    const panelState = userLayer.panels.panels[0];
    const selectedTab = panelState.selectedTab;
    const view = new TabView({
      makeTab: (id: string) => userLayer.tabs.options.get(id)!.getter(),
      selectedTab,
      tabs,
    });
    const refresh = () => {
      tabs.value = tabsOf();
    };
    const offs = [
      userLayer.tabs.changed.add(refresh),
      ...[...userLayer.tabs.options.values()].map((o) => o.hidden?.changed.add(refresh) ?? (() => {})),
    ];
    if (selectedTab.value === undefined) {
      const first = tabs.value.find((t) => !t.hidden);
      if (first !== undefined) selectedTab.value = first.id;
    }
    view.element.classList.add("ngp-layer-controls");
    host.append(view.element);
    return () => {
      offs.forEach((off) => off());
      view.element.remove();
      view.dispose();
    };
  }

  /** Neuroglancer's selection details (pinned picks, with back and forward). */
  mountSelection(host: HTMLElement): Disposer {
    const v = this.viewer;
    const location = v.selectionDetailsState.location;
    location.visible = true;
    this.docked.selection++;
    const undock = dockPanel(
      host,
      new SelectionDetailsPanel(DOCKED_PANEL_MANAGER, v.selectionDetailsState, v.layerSpecification, v.selectedLayer),
    );
    return () => {
      undock();
      if (--this.docked.selection === 0) location.visible = false;
    };
  }

  mountSettings(host: HTMLElement): Disposer {
    return dockPanel(host, new ViewerSettingsPanel(DOCKED_PANEL_MANAGER, this.viewer.settingsPanelState, this.viewer));
  }

  mountStatistics(host: HTMLElement): Disposer {
    const v = this.viewer;
    const location = v.statisticsDisplayState.location;
    location.visible = true;
    this.docked.statistics++;
    const undock = dockPanel(host, new StatisticsPanel(DOCKED_PANEL_MANAGER, v.chunkQueueManager, v.statisticsDisplayState));
    return () => {
      undock();
      if (--this.docked.statistics === 0) location.visible = false;
    };
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

  /** Neuroglancer's position widget: per-dimension coordinates, editable. */
  mountPosition(host: HTMLElement): Disposer {
    const v = this.viewer;
    const widget = new PositionWidget(v.position, v.layerSpecification.coordinateSpaceCombiner, {
      velocity: v.velocity,
      getToolBinder: () => v.toolBinder,
      allowFocus: true,
    });
    const mouse = new MousePositionWidget(document.createElement("div"), v.mouseState, v.coordinateSpace);
    widget.element.classList.add("ngp-position");
    mouse.element.classList.add("ngp-mouse-position");
    host.append(widget.element, mouse.element);
    return () => {
      widget.element.remove();
      mouse.element.remove();
      widget.dispose();
      mouse.dispose();
    };
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
