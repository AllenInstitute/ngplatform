/**
 * Neuroglancer reads the values under the mouse from every visible layer
 * whenever layers change while the mouse is over a view.  A layer still
 * being made has no selection state yet (it is set when its making is
 * done), and reading it threw: a layer added from a key pressed over the
 * views (Track filtering's Alt+Shift+S makes a group's layer) broke the
 * state being restored.  Guarded here: the values are read from the layers
 * that are made (the others are left out of that pass), and a layer not
 * made yet has none.
 */

interface Layer {
  selectionState?: { generation?: number } | undefined;
}

type Managed = { layer: Layer | null };

export interface SelectedValues {
  layerManager: { managedLayers: Managed[] };
  update(): void;
  get(layer: Layer): unknown;
}

/** Whether a layer has been made but has no selection state yet. */
const unmade = (managed: Managed) => managed.layer !== null && managed.layer.selectionState === undefined;

export function guardSelectedValues(values: SelectedValues): void {
  const update = values.update;
  const get = values.get;
  values.update = function (this: SelectedValues) {
    const manager = this.layerManager;
    const all = manager.managedLayers;
    if (!all.some(unmade)) return update.call(this);
    // Neuroglancer's own pass, over the layers that are made only (the list is put back at once).
    manager.managedLayers = all.filter((m) => !unmade(m));
    try {
      update.call(this);
    } finally {
      manager.managedLayers = all;
    }
  };
  values.get = function (this: SelectedValues, layer: Layer) {
    if (layer.selectionState === undefined) return undefined;
    return get.call(this, layer);
  };
}
