/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from "vitest";
import { mat4 } from "neuroglancer/unstable/util/geom.js";
import {
  denseLayerDraws,
  NO_OBJECT,
  selectionOf,
  levelDensities,
  selectDenseLevel,
} from "./dense_lod.js";
import {
  rangeSpans,
  rowSpans,
} from "./level_cells.js";
import { levelChain } from "./store.js";

const level = (vertexCount: number | undefined, chunk: number) => ({
  vertexCount,
  chunkShape: [chunk, chunk, chunk],
});
const box = { lower: [0, 0, 0], upper: [100, 100, 100] };

describe("levelDensities", () => {
  it("never makes a finer level look sparser than a coarser one", () => {
    // A writer's placeholder count of 0 at level 0.
    const d = levelDensities(
      [level(0, 16), level(5e6, 32), level(1e6, 64)],
      box.lower,
      box.upper,
    );
    expect(d[0]).toBeGreaterThanOrEqual(d[1]);
    expect(d[1]).toBeGreaterThanOrEqual(d[2]);
    expect(d[0]).toBeCloseTo(8 * d[1]);
  });

  it("estimates an uncounted coarse level from the one below", () => {
    const d = levelDensities(
      [level(1e6, 16), level(undefined, 32), level(0, 32)],
      box.lower,
      box.upper,
    );
    expect(d[1]).toBeCloseTo(d[0] / 8);
    expect(d[2]).toBeCloseTo(d[1] / 2);
    expect(d.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
  });

  it("gives a flat store a finite density", () => {
    const d = levelDensities(
      [level(4000, 16), level(1000, 32)],
      [0, 0, 0],
      [100, 100, 0],
    );
    expect(d.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
    expect(d[0]).toBeCloseTo(4 * d[1]);
  });
});

describe("additive levels", () => {
  const add = (vertexCount: number, chunk: number) => ({
    ...level(vertexCount, chunk),
    refinement: "add" as const,
  });

  it("chain each additive level to the coarser ones it adds to", () => {
    const replace = (vertexCount: number, chunk: number) => ({
      ...level(vertexCount, chunk),
      refinement: "replace" as const,
    });
    const levels = [
      add(1, 16),
      add(1, 32),
      replace(1, 64),
      add(1, 128),
      replace(1, 256),
    ];
    expect(levels.map((_, i) => levelChain(levels, i))).toEqual([
      [0, 1, 2],
      [1, 2],
      [2],
      [3, 4],
      [4],
    ]);
  });

  it("count a level's view as its own vertices and the coarser ones'", () => {
    // Each level holds what the coarser ones do not: 6000 = 1000 + 2000 + 3000.
    const d = levelDensities(
      [add(3000, 16), add(2000, 32), level(1000, 64)],
      box.lower,
      box.upper,
    );
    const v = 1e6;
    expect(d.map((x) => Math.round(x * v))).toEqual([6000, 3000, 1000]);
  });
});

describe("denseLayerDraws", () => {
  const base = {
    visibleAlpha: 1,
    notSelectedAlpha: 0,
    numVisibleSegments: 7,
    ignoreNullVisibleSet: true,
    objectsDrawnElsewhere: true,
  };
  it("is false when the selection is drawn elsewhere and the rest is hidden", () => {
    expect(denseLayerDraws(base)).toBe(false);
  });
  it("is true when the rest shows, or the selection is its to draw", () => {
    expect(denseLayerDraws({ ...base, notSelectedAlpha: 0.1 })).toBe(true);
    expect(denseLayerDraws({ ...base, objectsDrawnElsewhere: false })).toBe(
      true,
    );
  });
  it("shows everything for an empty selection, unless that is hidden too", () => {
    expect(denseLayerDraws({ ...base, numVisibleSegments: 0 })).toBe(true);
    expect(
      denseLayerDraws({ ...base, numVisibleSegments: 0, visibleAlpha: 0 }),
    ).toBe(false);
    expect(
      denseLayerDraws({
        ...base,
        numVisibleSegments: 0,
        ignoreNullVisibleSet: false,
      }),
    ).toBe(false);
  });
  it("is false at alpha 0 everywhere", () => {
    expect(
      denseLayerDraws({
        ...base,
        visibleAlpha: 0,
        objectsDrawnElsewhere: false,
      }),
    ).toBe(false);
  });
});

describe("rowSpans", () => {
  it("joins the closest spans until few enough remain", () => {
    const rows = Array.from({ length: 41 }, (_, i) => i * 10_000 + (i % 3));
    const spans = rowSpans(rows, 4096, 16);
    expect(spans.length).toBe(16);
    for (let i = 1; i < spans.length; ++i) {
      expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1]);
    }
    for (const r of rows) {
      expect(spans.some(([a, b]) => r >= a && r <= b)).toBe(true);
    }
  });

  it("keeps nearby rows in one span", () => {
    expect(rowSpans([1, 5, 9000, 9001], 4096, 16)).toEqual([
      [1, 5],
      [9000, 9001],
    ]);
  });

  it("merges whole ranges the same way", () => {
    expect(
      rangeSpans(
        [
          [0, 9],
          [12, 20],
          [9000, 9000],
        ],
        4096,
        16,
      ),
    ).toEqual([
      [0, 20],
      [9000, 9000],
    ]);
    expect(
      rangeSpans(
        [
          [0, 0],
          [10000, 10010],
          [20000, 20000],
        ],
        100,
        2,
      ),
    ).toEqual([
      [0, 0],
      [10000, 20000],
    ]);
  });
});

describe("a cross-section's level", () => {
  // The ABC atlas: 3.74 M points in 12.6 x 8 x 10.5 mm, 0.5 mm chunks at five levels.
  const densities = Array.from({ length: 5 }, (_, l) => 3.74e6 / 8 ** l / (12.6 * 8 * 10.5));
  const sources = Array.from({ length: 5 }, () => ({
    chunkLayout: { detTransform: 1, size: [0.5, 0.5, 0.5] },
    lowerClipDisplayBound: [0, 0, 0],
    upperClipDisplayBound: [12.6, 8, 10.5],
    source: { spec: { chunkDataSize: [0.5, 0.5, 0.5] } },
  })) as any;
  /** A 600 x 600 pixel cross-section `mmPerPixel` across, showing `depthPixels` either side of the plane. */
  const section = (mmPerPixel: number, depthPixels: number) => {
    const projectionMat = mat4.ortho(mat4.create(), -300, 300, 300, -300, -depthPixels, depthPixels);
    const viewMatrix = mat4.fromScaling(mat4.create(), [1 / mmPerPixel, 1 / mmPerPixel, 1 / mmPerPixel]);
    return { projectionMat, viewMatrix, width: 600, height: 600 } as any;
  };

  it("is coarser for a deep slab than for a thin one, as it loads and draws that depth", () => {
    // The whole brain in view, 10 pixels either side (Neuroglancer's default): 0.4 mm each side.
    const whole = selectDenseLevel(section(0.04, 10), sources, densities, 1, true);
    // As deep as the brain is: coarser still, rather than all of it at a fine level.
    const deep = selectDenseLevel(section(0.04, 300), sources, densities, 1, true);
    expect(deep).toBeGreaterThan(whole);
    // Zoomed in to cells (5 um a pixel), a thin slab: the finest.
    expect(selectDenseLevel(section(0.005, 10), sources, densities, 1, true)).toBe(0);
  });
});

describe("a layer hidden while a plugin draws it", () => {
  it("reads its one no-object id as nothing chosen, so nothing is read", () => {
    const hidden = selectionOf(1, true, true);
    expect(hidden).toEqual({ numVisibleSegments: 0, ignoreNullVisibleSet: false });
    expect(
      denseLayerDraws({ visibleAlpha: 1, notSelectedAlpha: 0, objectsDrawnElsewhere: false, ...hidden }),
    ).toBe(false);
    // Its faint objects shown would still be drawn.
    expect(
      denseLayerDraws({ visibleAlpha: 1, notSelectedAlpha: 0.2, objectsDrawnElsewhere: false, ...hidden }),
    ).toBe(true);
  });
  it("keeps any other selection as it is", () => {
    expect(selectionOf(0, false, true)).toEqual({ numVisibleSegments: 0, ignoreNullVisibleSet: true });
    expect(selectionOf(2, true, true)).toEqual({ numVisibleSegments: 2, ignoreNullVisibleSet: true });
    expect(selectionOf(1, false, true)).toEqual({ numVisibleSegments: 1, ignoreNullVisibleSet: true });
    expect(NO_OBJECT).toBe(2n ** 64n - 1n);
  });
});
