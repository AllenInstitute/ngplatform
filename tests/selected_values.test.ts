import { describe, expect, it } from "vitest";
import { guardSelectedValues, type SelectedValues } from "../src/engine/selected_values.js";

type State = { generation?: number };

/** Neuroglancer's LayerSelectedValues, cut down: update stamps every layer in the manager's list; get reads a layer's stamp. */
function values(layers: { layer: { selectionState?: State } | null }[]) {
  const count = 1;
  const v = {
    layerManager: { managedLayers: layers },
    update() {
      for (const l of v.layerManager.managedLayers) l.layer!.selectionState!.generation = count;
    },
    get(layer: { selectionState?: State }) {
      v.update();
      return layer.selectionState!.generation === count ? layer.selectionState : undefined;
    },
  };
  return v;
}

describe("the values under the mouse while a layer is being made", () => {
  it("reads the layers that are made, leaves out the one being made, and does not throw", () => {
    const made = { layer: { selectionState: {} as State } };
    const making: { layer: { selectionState?: State } } = { layer: {} };
    const v = values([made, making]);
    guardSelectedValues(v as unknown as SelectedValues);
    expect(v.get(made.layer)).toEqual({ generation: 1 });
    expect(v.get(making.layer)).toBeUndefined();
    // The manager's own list is put back.
    expect(v.layerManager.managedLayers).toHaveLength(2);
    making.layer.selectionState = {};
    expect(v.get(making.layer)).toEqual({ generation: 1 });
  });
});
