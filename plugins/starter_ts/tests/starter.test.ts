import { describe, expect, it } from "vitest";
import { describeLayers, readSaved } from "../plugin.js";

describe("the starter plugin", () => {
  it("reads its state, whatever was saved", () => {
    expect(readSaved(undefined)).toEqual({ count: 0 });
    expect(readSaved({ count: 3 })).toEqual({ count: 3 });
    expect(readSaved({ count: "three" })).toEqual({ count: 0 });
  });

  it("describes the scene's layers", () => {
    expect(describeLayers([])).toBe("This scene has no layers.");
    expect(describeLayers([{ name: "a", type: "image", visible: true }, { name: "b", type: "segmentation", visible: false }])).toBe("2 layers, 1 shown");
  });
});
