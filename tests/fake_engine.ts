/** A viewer for the workspace store's tests: the state as plain JSON, layers from it. */
import type { Json } from "../src/core/workspace.js";
import type { EngineLike } from "../src/platform/workspace_store.js";

export class FakeEngine implements EngineLike {
  ng: Json = {};
  selected: string | undefined;
  setStateCalls = 0;
  private listeners = new Set<() => void>();

  private layerList(): Json[] {
    return (this.ng.layers as Json[] | undefined) ?? [];
  }
  private changed() {
    for (const l of this.listeners) l();
  }
  getState(): Json {
    return structuredClone(this.ng);
  }
  setState(ng: Json): void {
    this.setStateCalls++;
    this.ng = structuredClone(ng);
    this.changed();
  }
  onStateChanged(callback: () => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  onLayersChanged() {
    return () => {};
  }
  layers() {
    return this.layerList().map((l) => ({
      name: String(l.name),
      type: l.type === "auto" ? "image" : String(l.type ?? "image"),
      visible: l.visible !== false,
      ready: true,
    }));
  }
  layerSpec(name: string) {
    return this.layerList().find((l) => l.name === name);
  }
  addLayer(spec: Json, options: { index?: number; select?: boolean } = {}) {
    const layers = this.layerList();
    layers.splice(options.index ?? layers.length, 0, spec);
    this.ng = { ...this.ng, layers };
    if (options.select) this.selected = String(spec.name);
    this.changed();
    return String(spec.name);
  }
  removeLayer(name: string) {
    this.ng = { ...this.ng, layers: this.layerList().filter((l) => l.name !== name) };
    this.changed();
  }
  renameLayer(name: string, newName: string) {
    this.ng = { ...this.ng, layers: this.layerList().map((l) => (l.name === name ? { ...l, name: newName } : l)) };
    this.changed();
    return newName;
  }
  setLayerVisible(name: string, visible: boolean) {
    this.ng = { ...this.ng, layers: this.layerList().map((l) => (l.name === name ? { ...l, visible } : l)) };
    this.changed();
  }
  moveLayer(name: string, index: number) {
    const layers = this.layerList();
    const from = layers.findIndex((l) => l.name === name);
    const [layer] = layers.splice(from, 1);
    layers.splice(index, 0, layer);
    this.ng = { ...this.ng, layers };
    this.changed();
  }
  selectedLayer() {
    return this.selected;
  }
  selectLayer(name: string | undefined) {
    this.selected = name;
  }
}
