import { describe, expect, it } from "vitest";
import { blur, distance2, halo, type MorphOp, morphTile, readMask, tiles } from "../morphology.js";
import { LabelVolume } from "../label_volume.js";
import type { Vec3 } from "../kernels.js";

const idx = (n: Vec3, x: number, y: number, z: number) => x + n[0] * (y + n[1] * z);
const count = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + (v ? 1 : 0), 0);

/** A seeded random blob mask. */
function blob(n: Vec3, seed = 1): Uint8Array {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const m = new Uint8Array(n[0] * n[1] * n[2]);
  const centres = Array.from({ length: 6 }, () => [rand() * n[0], rand() * n[1], rand() * n[2], 2 + rand() * 4]);
  for (let z = 0; z < n[2]; ++z)
    for (let y = 0; y < n[1]; ++y)
      for (let x = 0; x < n[0]; ++x) if (centres.some(([a, b, c, r]) => (x - a) ** 2 + (y - b) ** 2 + (z - c) ** 2 < r * r) || rand() < 0.01) m[idx(n, x, y, z)] = 1;
  return m;
}

/** The whole operation on a volume, tile by tile as the editor does (changes worked out first, then written). */
function run(volume: LabelVolume, value: number, op: MorphOp, amount: number, spacing: Vec3, tile: number, axis?: number, index?: number): void {
  const painted = volume.paintedBox(value)!;
  const box = { lo: [...painted.lo] as Vec3, hi: [...painted.hi] as Vec3 };
  if (axis !== undefined) {
    box.lo[axis] = index!;
    box.hi[axis] = index! + 1;
  }
  const reach = halo(op, amount, spacing, axis);
  const writes: [Vec3, number][] = [];
  for (const t of tiles(op, box, reach, volume.size as Vec3, axis, tile)) {
    const mask = readMask(volume, value, t.read.lo, t.read.hi);
    const n = t.read.hi.map((v, k) => v - t.read.lo[k]) as Vec3;
    const after = morphTile(op, mask, n, t.read.lo, t.core, amount, spacing, axis);
    const cn = t.core.hi.map((v, k) => v - t.core.lo[k]);
    let o = 0;
    for (let z = 0; z < cn[2]; ++z)
      for (let y = 0; y < cn[1]; ++y)
        for (let x = 0; x < cn[0]; ++x, ++o) {
          const p: Vec3 = [t.core.lo[0] + x, t.core.lo[1] + y, t.core.lo[2] + z];
          const was = volume.get(...p) === value;
          if (after[o] && !was) writes.push([p, value]);
          if (!after[o] && was) writes.push([p, 0]);
        }
  }
  for (const [p, v] of writes) volume.chunk(volume.key(p[0] >> 6, p[1] >> 6, p[2] >> 6), true)![(p[0] & 63) + 64 * ((p[1] & 63) + 64 * (p[2] & 63))] = v;
}

function volumeOf(n: Vec3, mask: Uint8Array, value = 3): LabelVolume {
  const v = new LabelVolume(n, "uint8", Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  for (let z = 0; z < n[2]; ++z)
    for (let y = 0; y < n[1]; ++y)
      for (let x = 0; x < n[0]; ++x) if (mask[idx(n, x, y, z)]) v.chunk(v.key(x >> 6, y >> 6, z >> 6), true)![(x & 63) + 64 * ((y & 63) + 64 * (z & 63))] = value;
  return v;
}

function snapshot(v: LabelVolume, value: number): Uint8Array {
  return readMask(v, value, [0, 0, 0], v.size as Vec3);
}

describe("the distance transform", () => {
  it("is the exact squared distance to the nearest target voxel, on an anisotropic grid", () => {
    const n: Vec3 = [9, 7, 5];
    const sp = [0.5, 1, 2.5];
    const target = new Uint8Array(n[0] * n[1] * n[2]);
    for (const [x, y, z] of [[1, 1, 1], [7, 5, 3], [4, 0, 4]]) target[idx(n, x, y, z)] = 1;
    const d = distance2(target, n, sp);
    for (let z = 0; z < n[2]; ++z)
      for (let y = 0; y < n[1]; ++y)
        for (let x = 0; x < n[0]; ++x) {
          let best = Infinity;
          for (const [a, b, c] of [[1, 1, 1], [7, 5, 3], [4, 0, 4]]) best = Math.min(best, ((x - a) * sp[0]) ** 2 + ((y - b) * sp[1]) ** 2 + ((z - c) * sp[2]) ** 2);
          expect(d[idx(n, x, y, z)]).toBeCloseTo(best, 9);
        }
  });
});

describe("Grow, Shrink and Smooth", () => {
  it("grow one voxel into the ball of the radius in millimetres", () => {
    const n: Vec3 = [21, 21, 21];
    const m = new Uint8Array(21 ** 3);
    m[idx(n, 10, 10, 10)] = 1;
    const sp: Vec3 = [1, 1, 2];
    const out = morphTile("grow", m, n, [0, 0, 0], { lo: [0, 0, 0], hi: n }, 4, sp);
    let want = 0;
    for (let z = 0; z < 21; ++z) for (let y = 0; y < 21; ++y) for (let x = 0; x < 21; ++x) if ((x - 10) ** 2 + (y - 10) ** 2 + ((z - 10) * 2) ** 2 <= 16) ++want;
    expect(count(out)).toBe(want);
  });

  it("shrink a box by its outer layer, but not where it meets the volume's edge", () => {
    const n: Vec3 = [12, 12, 12];
    const m = new Uint8Array(12 ** 3);
    // A box from the edge (x 0) to 7 along each axis.
    for (let z = 2; z < 8; ++z) for (let y = 2; y < 8; ++y) for (let x = 0; x < 8; ++x) m[idx(n, x, y, z)] = 1;
    const out = morphTile("shrink", m, n, [0, 0, 0], { lo: [0, 0, 0], hi: n }, 1, [1, 1, 1]);
    // y and z lose a layer each side (6 → 4); x keeps its edge at 0 and loses 7 (8 → 7).
    expect(count(out)).toBe(7 * 4 * 4);
    expect(out[idx(n, 0, 4, 4)]).toBe(1);
    expect(out[idx(n, 7, 4, 4)]).toBe(0);
  });

  it("smooth away a speck and a pinhole, keeping a block about its size", () => {
    const n: Vec3 = [24, 24, 24];
    const m = new Uint8Array(24 ** 3);
    for (let z = 6; z < 18; ++z) for (let y = 6; y < 18; ++y) for (let x = 6; x < 18; ++x) m[idx(n, x, y, z)] = 1;
    m[idx(n, 12, 12, 12)] = 0; // a pinhole
    m[idx(n, 2, 2, 2)] = 1; // a speck
    const out = morphTile("smooth", m, n, [0, 0, 0], { lo: [0, 0, 0], hi: n }, 1, [1, 1, 1]);
    expect(out[idx(n, 12, 12, 12)]).toBe(1);
    expect(out[idx(n, 2, 2, 2)]).toBe(0);
    expect(Math.abs(count(out) - 12 ** 3) / 12 ** 3).toBeLessThan(0.1);
    // The corners are rounded off.
    expect(out[idx(n, 6, 6, 6)]).toBe(0);
  });

  it("blur keeps the total (edges extended, a mask well inside)", () => {
    const n: Vec3 = [20, 20, 20];
    const m = new Uint8Array(8000);
    m[idx(n, 10, 10, 10)] = 1;
    const b = blur(m, n, [1.5, 1, 0]);
    expect(Array.from(b).reduce((a, v) => a + v, 0)).toBeCloseTo(1, 4);
    expect(b[idx(n, 10, 10, 11)]).toBe(0);
  });

  for (const op of ["grow", "shrink", "smooth"] as const) {
    it(`${op}s the same tile by tile as in one piece, across chunks`, () => {
      const n: Vec3 = [70, 40, 30];
      const m = blob(n, op.length);
      const sp: Vec3 = [1, 1, 1.5];
      const whole = volumeOf(n, m);
      run(whole, 3, op, 2, sp, 1000);
      const tiled = volumeOf(n, m);
      run(tiled, 3, op, 2, sp, 9);
      const a = snapshot(whole, 3);
      expect(count(a)).not.toBe(count(m));
      expect(snapshot(tiled, 3)).toEqual(a);
    });
  }

  it("in one section, changes that section only", () => {
    const n: Vec3 = [30, 30, 10];
    const m = blob(n, 7);
    const v = volumeOf(n, m);
    run(v, 3, "grow", 2, [1, 1, 1], 1000, 2, 5);
    const after = snapshot(v, 3);
    for (let z = 0; z < 10; ++z) {
      let differs = 0;
      for (let y = 0; y < 30; ++y) for (let x = 0; x < 30; ++x) if (after[idx(n, x, y, z)] !== m[idx(n, x, y, z)]) ++differs;
      if (z === 5) expect(differs).toBeGreaterThan(0);
      else expect(differs).toBe(0);
    }
  });
});
