/**
 * The Colour by controls' shader: the choices read back from it; groups by
 * their stored colours or a palette, those not chosen hidden in as few tests
 * as their runs allow; an attribute through a colour map between a low and a
 * high control, outside that window hidden when asked; and the stores'
 * taxonomies read as groups.
 */
import { describe, expect, it } from "vitest";
import { groupColourShader } from "../plugins/zarr-vectors/src/geometry_kind.js";
import { taxonomyGroups } from "../plugins/zarr-vectors/src/store.js";
import { attributeRange, colourLookOf, colourShader, MAX_RUNS, runs } from "../src/engine/colour_shader.js";

describe("colour by shader", () => {
  it("draws segments in the layer's own colours", () => {
    const text = colourShader({ by: "segment" });
    expect(text).toMatch(/emitDefault\(\);/);
    expect(colourLookOf(text)).toEqual({ by: "segment" });
    expect(colourLookOf("void main() { emitDefault(); }")).toBeUndefined();
  });

  it("colours by group, in the store's colours or a palette, hiding the groups not chosen", () => {
    const look = { by: "group" as const, group: { tier: "class", attribute: "class_index", colorAttribute: "class_color", colours: "stored" as const, shown: [3, 1, 2, 7] } };
    const text = colourShader(look);
    expect(colourLookOf(text)).toEqual(look);
    expect(text).toMatch(/float group = prop_class_index\(\);/);
    expect(text).toMatch(/if \(k >= 1 && k <= 3\) return true;/);
    expect(text).toMatch(/if \(k == 7\) return true;/);
    expect(text).toMatch(/if \(!zvShown\(group\)\) discard;/);
    expect(text).toMatch(/emitRGB\(zvPacked\(prop_class_color\(\)\)\);/);
    const palette = colourShader({ by: "group", group: { ...look.group, colours: "palette", shown: undefined } });
    expect(palette).toMatch(/emitRGB\(zvPalette\(group\)\);/);
    expect(palette).not.toMatch(/discard/);
    // Too many runs to test: every group shows.
    const scattered = Array.from({ length: MAX_RUNS + 1 }, (_, i) => 2 * i);
    expect(colourShader({ by: "group", group: { ...look.group, shown: scattered } })).not.toMatch(/discard/);
  });

  it("is what a store with a taxonomy starts with: its coarsest group in the store's colours", () => {
    const look = { by: "group" as const, group: { tier: "class", attribute: "class_index", colorAttribute: "class_color", colours: "stored" as const } };
    expect(groupColourShader("class", "class_index", "class_color")).toBe(colourShader(look));
    expect(colourLookOf(groupColourShader("class", "class_index", "class_color"))).toEqual(look);
  });

  it("merges chosen groups into runs", () => {
    expect(runs([5, 1, 2, 3, 9, 10, 2])).toEqual([[1, 3], [5, 5], [9, 10]]);
    expect(runs([])).toEqual([]);
  });

  it("colours by an attribute through a colour map between a low and a high control", () => {
    const look = { by: "attribute" as const, attribute: "gene_Slc17a7", colormap: "magma", range: [0, 8] as [number, number], low: 0.5, high: 6, hideOutside: true };
    const text = colourShader(look);
    expect(colourLookOf(text)).toEqual(look);
    expect(text).toMatch(/#uicontrol float low slider\(min=0\.0, max=8\.0, step=0\.008, default=0\.5\)/);
    expect(text).toMatch(/#uicontrol float high slider\(min=0\.0, max=8\.0, step=0\.008, default=6\.0\)/);
    expect(text).toMatch(/vec3 colormap\(float x\)/);
    expect(text).toMatch(/if \(!\(value >= low && value <= high\)\) discard;/);
    expect(colourShader({ ...look, hideOutside: false })).not.toMatch(/discard/);
  });

  it("starts an attribute's window at its 2nd and 98th percentiles", () => {
    const values = Float32Array.from({ length: 101 }, (_, i) => i);
    expect(attributeRange(values)).toEqual({ range: [0, 100], low: 2, high: 98 });
    expect(attributeRange([NaN, 4, 4])).toEqual({ range: [4, 5], low: 4, high: 4 });
    expect(attributeRange([])).toEqual({ range: [0, 1], low: 0, high: 1 });
  });
});

describe("a store's taxonomy as groups", () => {
  it("lists its tiers coarsest first, with their names, colours and parents", () => {
    const taxonomy = {
      tiers: [
        { name: "neurotransmitter", attribute: "neurotransmitter_index", color_attribute: "neurotransmitter_color", count: 2 },
        { name: "class", attribute: "class_index", color_attribute: "class_color", count: 2 },
        { name: "subclass", attribute: "subclass_index", count: 3, parent_tier: "class", parent_index: [0, 0, 1] },
      ],
      depth_order: ["class", "subclass"],
    };
    const groups = taxonomyGroups(taxonomy, { class: ["01 IT-ET Glut", "02 NP-CT-L6b Glut"], neurotransmitter: ["Glut", "GABA"] });
    expect(groups.map((g) => g.name)).toEqual(["class", "subclass", "neurotransmitter"]);
    expect(groups[0]).toEqual({ name: "class", attribute: "class_index", colorAttribute: "class_color", count: 2, names: ["01 IT-ET Glut", "02 NP-CT-L6b Glut"] });
    expect(groups[1]).toEqual({ name: "subclass", attribute: "subclass_index", count: 3, parent: "class", parentIndex: [0, 0, 1] });
    expect(taxonomyGroups(undefined, undefined)).toEqual([]);
  });
});
