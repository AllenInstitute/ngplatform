import { describe, expect, it } from "vitest";
import { guardSelectedValues, type SelectedValues } from "../src/engine/selected_values.js";

/** Neuroglancer's LayerSelectedValues, cut down: update stamps every made layer; get reads a layer's stamp. */
function values(layers: { layer: { selectionState?: { generation?: number } } | null }[]) {
  let count = 1;
  const v = {
    layerManager: { managedLayers: layers },
    updates: 0,
    update() {
      for (const l of layers) l.layer!.selectionState!.generation = count;
      v.updates++;
    },
    get(layer: { selectionState?: { generation?: number } }) {
      v.update();
      return layer.selectionState!.generation === count ? layer.selectionState : undefined;
    },
  };
  return v;
}

describe("the values under the mouse while a layer is being made", () => {
  it("waits for the layer instead of throwing, then reads as before", () => {
    const made = { layer: { selectionState: {} as { generation?: number } } };
    const making: { layer: { selectionState?: { generation?: number } } } = { layer: {} };
    const v = values([made, making]);
    guardSelectedValues(v as unknown as SelectedValues);
    expect(() => v.get(made.layer)).not.toThrow();
    expect(v.get(made.layer)).toBeUndefined();
    expect(v.get(making.layer)).toBeUndefined();
    expect(v.updates).toBe(0);
    making.layer.selectionState = {};
    expect(v.get(made.layer)).toEqual({ generation: 1 });
    expect(v.updates).toBe(1);
  });
});
