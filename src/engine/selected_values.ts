/**
 * Neuroglancer reads the values under the mouse from every visible layer
 * whenever layers change while the mouse is over a view.  A layer still
 * being made has no selection state yet (it is set when its making is
 * done), and reading it threw: a layer added from a key pressed over the
 * views (Track filtering's Alt+Shift+S makes a group's layer) broke the
 * state being restored.  Guarded here: until every layer is made, the
 * values are read later, and a layer not made yet has none.
 */

interface Layer {
  selectionState?: { generation?: number } | undefined;
}

export interface SelectedValues {
  layerManager: { managedLayers: Iterable<{ layer: Layer | null }> };
  update(): void;
  get(layer: Layer): unknown;
}

/** Whether a layer has been made but has no selection state yet. */
const unmade = (managed: { layer: Layer | null }) => managed.layer !== null && managed.layer.selectionState === undefined;

export function guardSelectedValues(values: SelectedValues): void {
  const update = values.update;
  const get = values.get;
  values.update = function (this: SelectedValues) {
    // Left to the next read (the update stays due).
    for (const managed of this.layerManager.managedLayers) if (unmade(managed)) return;
    update.call(this);
  };
  values.get = function (this: SelectedValues, layer: Layer) {
    if (layer.selectionState === undefined) return undefined;
    return get.call(this, layer);
  };
}
