import { describe, expect, it } from "vitest";
import { colormapOf, colormapShader, COLORMAPS, DEFAULT_INVLERP, invlerpOf } from "../src/engine/colormaps.js";

/** Neuroglancer's default image shader. */
const DEFAULT = `#uicontrol invlerp normalized
void main() {
  emitGrayscale(normalized());
}
`;

describe("colour maps", () => {
  it("offers every map the menu promises", () => {
    expect(COLORMAPS.map((m) => m.id)).toEqual([
      "grayscale",
      "heat",
      "jet",
      "ge",
      "nih",
      "pet",
      "binary",
      "hot",
      "cool",
      "viridis",
      "magma",
      "inferno",
      "plasma",
      "cividis",
      "turbo",
      "cubehelix",
      "redblue",
    ]);
  });

  it("knows Neuroglancer's default shader as grayscale", () => {
    expect(colormapOf(DEFAULT)).toBe("grayscale");
    expect(colormapShader("grayscale", DEFAULT)).toBe(DEFAULT);
  });

  it("keeps the contrast directive when the map changes, and recognises each map it writes", () => {
    const start = DEFAULT.replace(DEFAULT_INVLERP, "#uicontrol invlerp normalized(range=[10, 250], window=[0, 300])");
    for (const map of COLORMAPS) {
      for (const signed of [false, true]) {
        const shader = colormapShader(map.id, start, { signed })!;
        expect(shader).toContain("#uicontrol invlerp normalized(range=[10, 250], window=[0, 300]");
        expect(colormapOf(shader, { signed })).toBe(map.id);
        // And back to grayscale gives the start again.
        expect(colormapShader("grayscale", shader)).toBe(start);
      }
    }
  });

  it("calls an edited shader Custom", () => {
    const viridis = colormapShader("viridis", DEFAULT)!;
    expect(colormapOf(viridis.replace("emitRGB(colormap(normalized()))", "emitRGB(colormap(1.0 - normalized()))"))).toBeUndefined();
    expect(colormapOf("void main() { emitRGB(vec3(1.0)); }")).toBeUndefined();
  });

  it("writes heat with an unclamped contrast, a mid point, and blue for negative values of signed data", () => {
    const unsigned = colormapShader("heat", DEFAULT)!;
    expect(invlerpOf(unsigned)).toBe("#uicontrol invlerp normalized(clamp=false)");
    expect(unsigned).toContain("#uicontrol float mid slider(");
    expect(unsigned).toContain("emitTransparent()");
    expect(unsigned).not.toContain("abs(");
    const signed = colormapShader("heat", DEFAULT, { signed: true })!;
    expect(signed).toContain("normalized(abs(toRaw(getDataValue())))");
    expect(colormapOf(signed, { signed: false })).toBeUndefined();
    const ranged = colormapShader("heat", "#uicontrol invlerp normalized(range=[2, 5], clamp=true)\nvoid main() {}")!;
    expect(invlerpOf(ranged)).toBe("#uicontrol invlerp normalized(range=[2, 5], clamp=false)");
  });

  it("writes sampled maps as small piecewise-linear functions", () => {
    const viridis = colormapShader("viridis", DEFAULT)!;
    expect(viridis).toMatch(/const vec3 nodes\[33\] = vec3\[33\]\(/);
    // Viridis starts dark purple and ends yellow.
    expect(viridis).toContain("vec3(0.267, 0.005, 0.329)");
    expect(viridis).toContain("vec3(0.993, 0.906, 0.144)");
    expect(colormapShader("binary", DEFAULT)).toContain('#uicontrol vec3 colour color(default="#ff3030")');
    expect(colormapShader("nope", DEFAULT)).toBeUndefined();
  });
});
