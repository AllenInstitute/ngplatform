/**
 * A 3-D view picks a level per chunk (`refineDense3dChunks`): detail near
 * the camera when zoomed in, the coarsest level for a whole-brain view, and
 * never more than its GPU budget, however close the view.
 */

import { describe, expect, it } from "vitest";
import type { DenseNode, DenseRoot } from "./dense_lod.js";
import { refineDense3dChunks } from "./dense_lod.js";
import { mat4, vec3 } from "neuroglancer/unstable/util/geom.js";

// S-21-46's store: a 140 x 176 x 152 mm brain, one 23 x 21 x 20 mm cell at
// every one of five levels, 420 M vertices at level 0 and a quarter as many
// at each coarser level.
const lower = [-69, -104, -72];
const upper = [70, 72, 80];
const cell = [23, 21, 20];
const levels = 5;
const volume = (upper[0] - lower[0]) * (upper[1] - lower[1]) * (upper[2] - lower[2]);
const densities = Array.from({ length: levels }, (_, l) => 420e6 / 4 ** l / volume);
const BYTES_PER_VERTEX = 16;
const WIDTH = 1600;
const HEIGHT = 950;

/** A perspective view of the brain's centre, `fieldOfView` mm across there. */
function view(fieldOfView: number) {
  const fovy = Math.PI / 4;
  const aspect = WIDTH / HEIGHT;
  const distance = fieldOfView / (2 * Math.tan(fovy / 2) * aspect);
  const projection = mat4.perspective(mat4.create(), fovy, aspect, distance * 0.1, distance + 300);
  const eye = vec3.fromValues(0, -distance, 0);
  const viewMatrix = mat4.lookAt(mat4.create(), eye, vec3.fromValues(0, 0, 0), vec3.fromValues(0, 0, 1));
  return {
    viewProjectionMat: mat4.multiply(mat4.create(), projection, viewMatrix),
    width: WIDTH,
    height: HEIGHT,
    transform: mat4.create(),
    chunkSizes: Array.from({ length: levels }, () => cell),
    lowerClip: lower,
    upperClip: upper,
  };
}

/** Every coarsest-level chunk of the store (those out of view cost nothing more). */
function roots(): DenseNode[] {
  const out: DenseNode[] = [];
  const lo = lower.map((x, i) => Math.floor(x / cell[i]));
  const hi = upper.map((x, i) => Math.floor(x / cell[i]));
  for (let x = lo[0]; x <= hi[0]; ++x) {
    for (let y = lo[1]; y <= hi[1]; ++y) {
      for (let z = lo[2]; z <= hi[2]; ++z) out.push({ level: levels - 1, position: Float32Array.of(x, y, z) });
    }
  }
  return out;
}

function summary(chosen: DenseRoot[]) {
  const byLevel = new Array(levels).fill(0);
  let vertices = 0;
  for (const { leaves } of chosen) {
    for (const leaf of leaves) {
      ++byLevel[leaf.level];
      let v = 1;
      for (let i = 0; i < 3; ++i) {
        const a = Math.max(leaf.position[i] * cell[i], lower[i]);
        const b = Math.min((leaf.position[i] + 1) * cell[i], upper[i]);
        v *= Math.max(b - a, 1);
      }
      vertices += densities[leaf.level] * v;
    }
  }
  return { byLevel, vertices, bytes: vertices * BYTES_PER_VERTEX };
}

const BUDGET = 512 * 1024 * 1024;

describe("a 3-D view's chunks", () => {
  it("stay at the coarsest level for a whole-brain view", () => {
    const chosen = refineDense3dChunks(roots(), view(260), densities, 1, BUDGET, BYTES_PER_VERTEX);
    const { byLevel } = summary(chosen);
    expect(byLevel[0]).toBe(0);
    expect(byLevel[levels - 1]).toBeGreaterThan(0);
  });

  it("are the finest level near the camera when zoomed in, within the budget", () => {
    const chosen = refineDense3dChunks(roots(), view(6), densities, 1, BUDGET, BYTES_PER_VERTEX);
    const after = summary(chosen);
    // Before: the whole view at the coarsest level (0.4% of the vertices).
    const before = summary(roots().map((r) => ({ root: r, leaves: [r] })));
    console.info(
      `6 mm field of view: before, ${before.byLevel[levels - 1]} chunks of level ${levels - 1} ` +
        `(${(before.vertices / 1e6).toFixed(1)} M vertices); after, chunks by level ${JSON.stringify(after.byLevel)} ` +
        `(${(after.vertices / 1e6).toFixed(1)} M vertices, ${(after.bytes / 2 ** 20).toFixed(0)} MiB)`,
    );
    expect(after.byLevel[0]).toBeGreaterThan(0);
    expect(after.bytes).toBeLessThanOrEqual(BUDGET);
    // The finest chunks are those around the centre, nearest the camera.
    for (const leaf of chosen.flatMap((r) => r.leaves)) {
      if (leaf.level !== 0) continue;
      for (let i = 0; i < 3; ++i) expect([-1, 0]).toContain(leaf.position[i]);
    }
  });

  it("never take more than the budget, however small", () => {
    const small = 64 * 1024 * 1024;
    const coarse = summary(refineDense3dChunks(roots(), view(260), densities, 1, Infinity, BYTES_PER_VERTEX));
    for (const fov of [2, 6, 20, 60]) {
      const { bytes } = summary(refineDense3dChunks(roots(), view(fov), densities, 0.1, small, BYTES_PER_VERTEX));
      expect(bytes).toBeLessThanOrEqual(Math.max(small, coarse.bytes));
    }
  });

  it("count a chunk read before at its own size, not the mean", () => {
    // The finest chunks near the centre turn out ten times the mean.
    const big = (level: number) =>
      level === 0 ? BUDGET : level === levels - 1 ? densities[level] * cell[0] * cell[1] * cell[2] * BYTES_PER_VERTEX : undefined;
    const chosen = refineDense3dChunks(roots(), view(6), densities, 1, BUDGET, BYTES_PER_VERTEX, big);
    expect(summary(chosen).byLevel[0]).toBe(0);
    expect(summary(chosen).byLevel[1]).toBeGreaterThan(0);
  });

  it("wait for the coarsest chunk over a region, and scale by how dense it is", () => {
    const rootsInView = roots();
    // Nothing read yet: nothing refined.
    const none = refineDense3dChunks(rootsInView, view(6), densities, 1, BUDGET, BYTES_PER_VERTEX, () => undefined);
    expect(summary(none).byLevel[0]).toBe(0);
    expect(summary(none).byLevel[levels - 2]).toBe(0);
    // The coarse chunks read, each ten times as dense as the mean: fewer
    // finer chunks fit than at the mean.
    const tenfold = (level: number) =>
      level === levels - 1 ? densities[level] * cell[0] * cell[1] * cell[2] * BYTES_PER_VERTEX * 10 : undefined;
    const dense = summary(refineDense3dChunks(rootsInView, view(6), densities, 1, BUDGET, BYTES_PER_VERTEX, tenfold));
    const mean = summary(refineDense3dChunks(rootsInView, view(6), densities, 1, BUDGET, BYTES_PER_VERTEX));
    expect(dense.byLevel[0] + dense.byLevel[1]).toBeLessThan(mean.byLevel[0] + mean.byLevel[1]);
    expect(dense.byLevel[0] + dense.byLevel[1]).toBeGreaterThan(0);
  });
});
