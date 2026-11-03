/**
 * The Surface controls' shader: the choices read back from it, the default
 * a Zarr Vectors surface layer starts with is the controls' own, and the
 * overlay's controls start where its values are.
 */
import { describe, expect, it } from "vitest";
import { curvatureShader } from "../plugins/zarr-vectors/src/geometry_kind.js";
import { overlayRange, SURFACE_COLORMAPS, surfaceLookOf, surfaceShader } from "../src/engine/surface_shader.js";

describe("surface shader", () => {
  it("is what a surface layer starts with, for curvature alone", () => {
    expect(surfaceShader({ curvature: "curv" })).toBe(curvatureShader("curv"));
    expect(surfaceLookOf(curvatureShader("sulc"))).toEqual({ curvature: "sulc" });
  });

  it("keeps its choices, and writes an overlay, its colour map and a parcellation", () => {
    const look = { curvature: "curv", overlay: "thickness", colormap: "heat", range: [0, 5] as [number, number], threshold: 1.5, max: 3.5, parcellation: "aparc" };
    const text = surfaceShader(look);
    expect(surfaceLookOf(text)).toEqual(look);
    expect(text).toMatch(/#uicontrol float threshold slider\(min=0\.0, max=5\.0, step=0\.005, default=1\.5\)/);
    expect(text).toMatch(/prop_thickness\(\)/);
    expect(text).toMatch(/lut_aparc\(prop_aparc\(\)\)/);
    expect(text).toMatch(/#ifdef ZV_SECTION/);
    const viridis = surfaceShader({ ...look, colormap: "viridis", outlines: true });
    expect(viridis).toMatch(/vec3 colormap\(float x\)/);
    expect(viridis).not.toMatch(/ZV_SECTION/);
    // Another surface of the same vertices, named for the layer's vertex shader.
    const inflated = surfaceShader({ curvature: "curv", position: "coords_inflated" });
    expect(inflated.split("\n")[1]).toBe("#define ZV_POSITION coords_inflated");
    expect(surfaceLookOf(inflated)).toEqual({ curvature: "curv", position: "coords_inflated" });
    expect(SURFACE_COLORMAPS[0].id).toBe("heat");
    expect(SURFACE_COLORMAPS.some((m) => m.id === "jet")).toBe(true);
  });

  it("reads no look from another shader", () => {
    expect(surfaceLookOf("void main() { emitDefault(); }\n")).toBeUndefined();
    expect(surfaceLookOf("// Surface: {broken\nvoid main() {}")).toBeUndefined();
  });

  it("starts an overlay's controls from its values", () => {
    const values = Array.from({ length: 101 }, (_, i) => i / 20); // 0 to 5
    const heat = overlayRange(values);
    expect(heat.range).toEqual([0, 5]);
    expect(heat.threshold).toBeCloseTo(1.25, 5);
    expect(heat.max).toBeCloseTo(4.9, 5);
    const signed = overlayRange([-4, -2, 0, Number.NaN, 2, 4], "jet");
    expect(signed.range).toEqual([-4, 4]);
    expect(signed.threshold).toBe(-4);
  });
});
