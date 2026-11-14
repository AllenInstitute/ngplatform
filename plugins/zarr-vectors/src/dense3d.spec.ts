/**
 * A 3-D view picks a level per chunk (`refineDense3dChunks`): detail near
 * the camera when zoomed in, the coarsest level for a whole-brain view, and
 * never more than its GPU budget, however close the view.
 */

import { describe, expect, it } from "vitest";
import type { DenseNode, DenseRoot } from "./dense_lod.js";
import { nodeKey, refineDense3dChunks, regionDrawn, regionReads } from "./dense_lod.js";
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

describe("a sparse coarsest level (a cell atlas)", () => {
  // The ABC atlas's store: 3.74 M cells in a 12.6 x 8 x 10.5 mm mouse brain,
  // in 0.5 mm cells at every one of five levels, each an eighth of the one
  // below: the coarsest holds 913 cells, so most of its cells are empty.
  const alower = [0, 0, 0];
  const aupper = [12.6, 8, 10.5];
  const acell = [0.5, 0.5, 0.5];
  const alevels = 5;
  const avolume = aupper[0] * aupper[1] * aupper[2];
  const adensities = Array.from({ length: alevels }, (_, l) => 3.74e6 / 8 ** l / avolume);
  const cellVolume = acell[0] * acell[1] * acell[2];
  const aview = (fieldOfView: number) => {
    const v = view(fieldOfView);
    const centre = vec3.fromValues(6.3, 4, 5.25);
    const fovy = Math.PI / 4;
    const distance = fieldOfView / (2 * Math.tan(fovy / 2) * (WIDTH / HEIGHT));
    const projection = mat4.perspective(mat4.create(), fovy, WIDTH / HEIGHT, distance * 0.1, distance + 30);
    const eye = vec3.fromValues(6.3, 4 - distance, 5.25);
    const viewMatrix = mat4.lookAt(mat4.create(), eye, centre, vec3.fromValues(0, 0, 1));
    return { ...v, viewProjectionMat: mat4.multiply(mat4.create(), projection, viewMatrix), chunkSizes: Array.from({ length: alevels }, () => acell), lowerClip: alower, upperClip: aupper };
  };
  const aroots = (): DenseNode[] => {
    const out: DenseNode[] = [];
    for (let x = 0; x < Math.ceil(aupper[0] / acell[0]); ++x) {
      for (let y = 0; y < Math.ceil(aupper[1] / acell[1]); ++y) {
        for (let z = 0; z < Math.ceil(aupper[2] / acell[2]); ++z) out.push({ level: alevels - 1, position: Float32Array.of(x, y, z) });
      }
    }
    return out;
  };
  /** The coarsest level as read: each cell's vertices drawn at random about its mean (0.1), most none. */
  const standIns = (seed: number) => {
    let s = seed;
    const random = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const mean = adensities[alevels - 1] * cellVolume;
    const sizes = new Map<string, number>();
    return (level: number, position: Float32Array) => {
      if (level !== alevels - 1) return undefined;
      const key = position.join();
      if (!sizes.has(key)) {
        // Poisson by inversion.
        let k = 0;
        let p = Math.exp(-mean);
        let f = p;
        const u = random();
        while (u > f) p *= mean / ++k, (f += p);
        sizes.set(key, k * BYTES_PER_VERTEX);
      }
      return sizes.get(key);
    };
  };
  /** Each region's finest level drawn (regions wholly out of view, none drawn, left out). */
  const levelsOf = (chosen: DenseRoot[]) => chosen.filter(({ leaves }) => leaves.length > 0).map(({ leaves }) => Math.min(...leaves.map((l) => l.level)));

  it("refine under an empty stand-in as under any other, so no region is left at the coarsest level", () => {
    const read = standIns(1);
    const chosen = refineDense3dChunks(aroots(), aview(16), adensities, 1, BUDGET, BYTES_PER_VERTEX, read);
    const finest = levelsOf(chosen);
    // Every region of the brain at the same, finer level: no patches of the 913-cell stand-in.
    expect(new Set(finest).size).toBe(1);
    expect(finest[0]).toBeLessThan(alevels - 1);
    // As before empty cells counted as read: the regions under them never refined, a patchwork.
    const unread = (level: number, position: Float32Array) => (read(level, position) || undefined);
    const before = levelsOf(refineDense3dChunks(aroots(), aview(16), adensities, 1, BUDGET, BYTES_PER_VERTEX, unread));
    expect(before.filter((l) => l === alevels - 1).length).toBeGreaterThan(before.length / 2);
  });

  it("count a region under a sparse stand-in at its level's density, so the budget holds", () => {
    // A budget for about half the brain at the finest level. The finer chunks hold
    // their level's mean, whatever the stand-in over them happened to hold.
    const budget = 0.5 * 3.74e6 * BYTES_PER_VERTEX;
    const chosen = refineDense3dChunks(aroots(), aview(16), adensities, 1, budget, BYTES_PER_VERTEX, standIns(2));
    let bytes = 0;
    for (const { leaves } of chosen) for (const l of leaves) bytes += adensities[l.level] * cellVolume * BYTES_PER_VERTEX;
    expect(bytes).toBeLessThanOrEqual(budget * 1.1);
  });

  it("choose among thousands of the coarsest level's chunks quickly", () => {
    const roots = aroots();
    expect(roots.length).toBeGreaterThan(8000);
    const t = performance.now();
    refineDense3dChunks(roots, aview(16), adensities, 1, BUDGET, BYTES_PER_VERTEX, standIns(3));
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("a region's chunks while they load", () => {
  const node = (level: number, x: number, y: number, z: number, pixel = 0) => ({ level, position: Float32Array.of(x, y, z), pixel });
  const keys = (nodes: { level: number; position: Float32Array }[]) => nodes.map(nodeKey).sort();

  it("show the finest level loaded over a chain of one chunk a level (a cell atlas), never a gap under a loaded one", () => {
    const sizes = Array.from({ length: 5 }, () => [0.5, 0.5, 0.5]);
    const region = { root: node(4, 3, 4, 5), leaves: [node(0, 3, 4, 5)] };
    const drawn = (loaded: number[]) => regionDrawn(region, sizes, (n) => loaded.includes(n.level));
    expect(drawn([4, 3, 2]).nodes.map((n) => n.level)).toEqual([2]);
    expect(drawn([4, 3, 2]).complete).toBe(false);
    expect(drawn([4]).nodes.map((n) => n.level)).toEqual([4]);
    expect(drawn([4, 0]).nodes.map((n) => n.level)).toEqual([0]);
    expect(drawn([4, 0]).complete).toBe(true);
    // Nothing over it loaded: nothing drawn (a gap only then).
    expect(drawn([]).nodes).toEqual([]);
  });

  it("draw a coarser chunk over its finer ones until all of them are loaded, never both over one place", () => {
    // Level 1 chunks twice level 0's: the region's chunk covers eight finer ones, four chosen.
    const sizes = [[1, 1, 1], [2, 2, 2]];
    const leaves = [node(0, 0, 0, 0), node(0, 1, 0, 0), node(0, 0, 1, 0), node(0, 1, 1, 0)];
    const region = { root: node(1, 0, 0, 0), leaves };
    const some = new Set([nodeKey(leaves[0]), nodeKey(leaves[1])]);
    // Coarse loaded, finer partly: the coarse alone.
    expect(keys(regionDrawn(region, sizes, (n) => n.level === 1 || some.has(nodeKey(n))).nodes)).toEqual([nodeKey(region.root)]);
    // Coarse not loaded: what of the finer is there.
    expect(keys(regionDrawn(region, sizes, (n) => some.has(nodeKey(n))).nodes)).toEqual(keys(leaves.slice(0, 2)));
    // All finer loaded: the finer alone.
    expect(keys(regionDrawn(region, sizes, () => true).nodes)).toEqual(keys(leaves));
  });

  it("are read coarsest level first and, within a level, nearest first", () => {
    const sizes = Array.from({ length: 3 }, () => [1, 1, 1]);
    const near = { root: node(2, 0, 0, 0, 0.1), leaves: [node(0, 0, 0, 0, 0.1)] };
    const reads = regionReads(near, sizes);
    expect(reads.map((n) => n.level)).toEqual([2, 1, 0]);
    const far = { root: node(2, 5, 0, 0, 9), leaves: [node(1, 5, 0, 0, 9)] };
    const both = [...regionReads(far, sizes), ...reads].sort((a, b) => b.level - a.level || (a.pixel ?? 0) - (b.pixel ?? 0));
    expect(both.map((n) => `${n.level}/${n.pixel}`)).toEqual(["2/0.1", "2/9", "1/0.1", "1/9", "0/0.1"]);
  });
});

describe("a cell atlas within a laptop's GPU", () => {
  // The ABC atlas whole in view with Neuroglancer's GPU memory limit at 256 MiB, 128 MiB and 32 MiB
  // (the budget a 3-D view takes is half): the view stays within it, every region drawn at some level.
  const lower = [0, 0, 0];
  const upper = [12.6, 8, 10.5];
  const size = [0.5, 0.5, 0.5];
  const nlevels = 5;
  const densities = Array.from({ length: nlevels }, (_, l) => 3.74e6 / 8 ** l / (12.6 * 8 * 10.5));
  const chunkVolume = size[0] * size[1] * size[2];
  const allRoots = () => {
    const out: DenseNode[] = [];
    for (let x = 0; x < 26; ++x) for (let y = 0; y < 16; ++y) for (let z = 0; z < 21; ++z) out.push({ level: nlevels - 1, position: Float32Array.of(x, y, z) });
    return out;
  };
  const atlasView = () => {
    const v = view(16);
    const fovy = Math.PI / 4;
    const distance = 16 / (2 * Math.tan(fovy / 2) * (WIDTH / HEIGHT));
    const projection = mat4.perspective(mat4.create(), fovy, WIDTH / HEIGHT, distance * 0.1, distance + 30);
    const look = mat4.lookAt(mat4.create(), vec3.fromValues(6.3, 4 - distance, 5.25), vec3.fromValues(6.3, 4, 5.25), vec3.fromValues(0, 0, 1));
    return { ...v, viewProjectionMat: mat4.multiply(mat4.create(), projection, look), chunkSizes: Array.from({ length: nlevels }, () => size), lowerClip: lower, upperClip: upper };
  };
  for (const limit of [256, 128, 32]) {
    it(`stays within ${limit} MiB, coarsest first where it must`, () => {
      const budget = (limit * 2 ** 20) / 2;
      const known = (level: number) => (level === nlevels - 1 ? 0 : undefined);
      const chosen = refineDense3dChunks(allRoots(), atlasView(), densities, 1, budget, BYTES_PER_VERTEX, known);
      let bytes = 0;
      const byLevel = new Array(nlevels).fill(0);
      for (const { leaves } of chosen) {
        for (const l of leaves) {
          bytes += densities[l.level] * chunkVolume * BYTES_PER_VERTEX;
          ++byLevel[l.level];
        }
      }
      console.info(`${limit} MiB: chunks by level ${JSON.stringify(byLevel)}, ${(bytes / 2 ** 20).toFixed(1)} MiB`);
      expect(bytes).toBeLessThanOrEqual(budget * 1.05);
      // The whole store's regions are drawn, and none at the near-empty coarsest level: an even
      // level across the view, not the nearest at the finest and the rest as gaps.
      expect(chosen.filter((r) => r.leaves.length > 0).length).toBeGreaterThan(7000);
      expect(byLevel[nlevels - 1]).toBe(0);
    });
  }
});
