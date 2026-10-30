/**
 * The one place the platform touches Neuroglancer.
 *
 * Panels and (later) plugins see this narrow API, never Neuroglancer
 * internals, so a rebase of the fork changes only this file and the embed
 * imports in main.ts.
 */
import type { Viewer } from "neuroglancer/unstable/viewer.js";

export interface LayerInfo {
  name: string;
  type: string;
  visible: boolean;
  sources: string[];
  ready: boolean;
}

export interface CursorInfo {
  active: boolean;
  position: number[];
  names: string[];
  units: string[];
  scales: number[];
  values: Record<string, unknown>;
}

type Disposer = () => void;

/**
 * Runs `callback` after Neuroglancer's own change handling, at most once per
 * frame, and never lets it throw into Neuroglancer: a listener that throws
 * inside a layer-change dispatch makes Neuroglancer drop the layer.
 */
function deferred(callback: () => void): () => void {
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

export class ViewerBridge {
  constructor(readonly viewer: Viewer) {}

  getState(): Record<string, unknown> {
    return this.viewer.state.toJSON() as Record<string, unknown>;
  }

  /** Replaces the whole Neuroglancer state. */
  setState(ng: Record<string, unknown>): void {
    this.viewer.state.reset();
    this.viewer.state.restoreState(ng);
  }

  onStateChanged(callback: () => void): Disposer {
    return this.viewer.state.changed.add(deferred(callback));
  }

  layers(): LayerInfo[] {
    return this.viewer.layerManager.managedLayers.map((managed) => {
      const layer = managed.layer;
      return {
        name: managed.name,
        type: layer?.type ?? "new",
        visible: managed.visible,
        sources: layer?.dataSources.map((d) => d.spec.url).filter((u) => u.length > 0) ?? [],
        ready: managed.isReady() === true,
      };
    });
  }

  onLayersChanged(callback: () => void): Disposer {
    const lm = this.viewer.layerManager;
    const run = deferred(callback);
    const a = lm.layersChanged.add(run);
    const b = lm.readyStateChanged.add(run);
    return () => {
      a();
      b();
    };
  }

  selectedLayer(): string | undefined {
    return this.viewer.selectedLayer.layer?.name;
  }

  onSelectionChanged(callback: () => void): Disposer {
    return this.viewer.selectedLayer.changed.add(deferred(callback));
  }

  /** Opens a layer's side panel, as clicking its name in the layer bar does. */
  selectLayer(name: string): void {
    const managed = this.viewer.layerManager.getLayerByName(name);
    if (managed !== undefined) {
      this.viewer.selectedLayer.layer = managed;
      this.viewer.selectedLayer.visible = true;
    }
  }

  addLayer(spec: { name: string; source: string; type?: string }): void {
    const ng = this.getState();
    const layers = Array.isArray(ng.layers) ? [...(ng.layers as unknown[])] : [];
    const taken = new Set(this.layers().map((l) => l.name));
    let name = spec.name;
    for (let i = 2; taken.has(name); i++) name = `${spec.name} ${i}`;
    layers.push({ type: spec.type ?? "auto", source: spec.source, name });
    this.setState({ ...ng, layers, selectedLayer: { visible: true, layer: name } });
  }

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

  layout(): string {
    const layout = this.getState().layout;
    return typeof layout === "string" ? layout : typeof layout === "object" && layout !== null ? "custom" : "4panel";
  }

  setLayout(layout: string): void {
    this.viewer.layout.restoreState(layout);
  }
}
