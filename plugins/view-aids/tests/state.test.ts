import { describe, expect, it } from "vitest";
import { cameraBetween, readCamera, writeCamera } from "../camera.js";
import { angleBetween, type Quat } from "../geometry.js";
import { graphicsNow, nextName, readSaved } from "../state.js";

describe("the saved state", () => {
  it("starts with the cube and labels on, graphics shown, no bookmarks", () => {
    expect(readSaved(undefined)).toEqual({ cube: true, labels: true, bookmarks: [] });
  });

  it("reads bookmarks, dropping what is broken", () => {
    const saved = readSaved({
      cube: false,
      hidden: { showAxisLines: true, showDefaultAnnotations: false },
      bookmarks: [
        { id: "a", name: "Front", thumbnail: "data:image/webp;base64,xx", camera: { position: [1, 2, 3], projectionOrientation: [0, 0, 0, 2], projectionScale: 50, layout: "3d" } },
        { name: "no id" },
        { id: "b", thumbnail: "javascript:alert(1)", camera: { projectionOrientation: "bad" } },
      ],
    });
    expect(saved.cube).toBe(false);
    expect(saved.hidden).toEqual({ showAxisLines: true, showDefaultAnnotations: false, showScaleBar: true });
    expect(saved.bookmarks).toHaveLength(2);
    expect(saved.bookmarks[0]).toMatchObject({ id: "a", name: "Front", camera: { position: [1, 2, 3], projectionOrientation: [0, 0, 0, 1], projectionScale: 50, layout: "3d" } });
    expect(saved.bookmarks[1].thumbnail).toBeUndefined();
    expect(saved.bookmarks[1].name).toBe("View");
  });

  it("names new bookmarks by the first free number", () => {
    expect(nextName([])).toBe("View 1");
    expect(nextName([{ name: "View 2" }])).toBe("View 3");
    expect(nextName([{ name: "View 2" }, { name: "View 3" }])).toBe("View 4");
  });

  it("reads Neuroglancer's switches, on unless written off", () => {
    const state: Record<string, unknown> = { showAxisLines: false };
    expect(graphicsNow((k) => state[k])).toEqual({ showAxisLines: false, showDefaultAnnotations: true, showScaleBar: true });
  });
});

describe("cameras", () => {
  const a = readCamera({ position: [0, 0, 0], projectionOrientation: [0, 0, 0, 1], projectionScale: 10, crossSectionScale: 1, projectionDepth: 5 });
  const turn: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const b = readCamera({ position: [10, 20, 30], projectionOrientation: turn, projectionScale: 1000, crossSectionScale: 4, projectionDepth: 9, layout: "3d" });

  it("is the start at 0 and the end at 1", () => {
    expect(cameraBetween(a, b, 0)).toMatchObject({ position: [0, 0, 0], projectionScale: 10, crossSectionScale: 1 });
    const end = cameraBetween(a, b, 1);
    expect(end).toMatchObject({ position: [10, 20, 30], projectionScale: 1000, crossSectionScale: 4, projectionDepth: 9 });
    expect(angleBetween(end.projectionOrientation, turn)).toBeLessThan(1e-6);
  });

  it("zooms by the same factor each moment, and turns evenly", () => {
    const mid = cameraBetween(a, b, 0.5);
    expect(mid.projectionScale).toBeCloseTo(100);
    expect(mid.crossSectionScale).toBeCloseTo(2);
    expect(mid.position).toEqual([5, 10, 15]);
    expect(angleBetween(mid.projectionOrientation, [0, 0, 0, 1])).toBeCloseTo(Math.PI / 4);
    // Depths change at the end, not along the way.
    expect(mid.projectionDepth).toBeUndefined();
  });

  it("writes a camera into the state, the layout only when asked", () => {
    const ng: Record<string, unknown> = { layout: "4panel-alt" };
    writeCamera(ng, b, false);
    expect(ng.layout).toBe("4panel-alt");
    expect(ng.projectionScale).toBe(1000);
    writeCamera(ng, b, true);
    expect(ng.layout).toBe("3d");
  });
});
