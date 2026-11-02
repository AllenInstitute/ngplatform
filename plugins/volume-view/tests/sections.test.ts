import { describe, expect, it } from "vitest";
import { fineSections, layoutType, MAX_SECTION } from "../sections.js";

// SRB 2026a: 0.1 mm voxels, about 200 mm across, in a view of millimetres.
const srb = { finestMm: 0.1, extentMm: 200, canonicalMetres: 0.001, panelPixels: 800 };

describe("fine sections on the cut", () => {
  it("are three sections through the position, xy, xz and yz, at a zoom of their own", () => {
    const sections = fineSections({ ...srb, projectionScale: 260 }) as Record<string, any>;
    expect(Object.keys(sections)).toEqual(["volume-xy", "volume-xz", "volume-yz"]);
    expect(sections["volume-xy"].orientation).toEqual({ link: "linked" });
    expect(sections["volume-xz"].orientation.link).toBe("relative");
    expect(sections["volume-xz"].orientation.value[0]).toBeCloseTo(Math.SQRT1_2);
    expect(sections["volume-yz"].orientation.value[1]).toBeCloseTo(Math.SQRT1_2);
    for (const s of Object.values(sections)) {
      expect(s.position).toEqual({ link: "linked" });
      expect(s.scale.link).toBe("unlinked");
    }
  });

  it("follow the 3-D zoom down to the finest voxel, in steps of √2", () => {
    const zoomedOut = (fineSections({ ...srb, projectionScale: 260 }) as any)["volume-xy"];
    // 260 mm over 800 pixels: 0.325 mm a pixel, stepped up to 0.1 × 2^(4/2) = 0.4.
    expect(zoomedOut.scale.value).toBeCloseTo(0.4);
    expect(zoomedOut.width).toBe(Math.ceil((300 / 0.4) / 64) * 64);
    const zoomedIn = (fineSections({ ...srb, projectionScale: 20 }) as any)["volume-xy"];
    // 0.025 mm a pixel is finer than the data: the finest voxel, and the budget caps the size.
    expect(zoomedIn.scale.value).toBeCloseTo(0.1);
    expect(zoomedIn.width).toBe(MAX_SECTION);
    expect(zoomedIn.height).toBe(MAX_SECTION);
    // A small change of zoom keeps the same sections (nothing reloads).
    const a = (fineSections({ ...srb, projectionScale: 250 }) as any)["volume-xy"];
    const b = (fineSections({ ...srb, projectionScale: 255 }) as any)["volume-xy"];
    expect(a).toEqual(b);
  });

  it("read the layout's type from a name or a layout with cross-sections", () => {
    expect(layoutType("4panel")).toBe("4panel");
    expect(layoutType({ type: "3d", crossSections: {} })).toBe("3d");
    expect(layoutType(undefined)).toBe("xy-3d");
  });
});
