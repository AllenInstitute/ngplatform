/**
 * The bricks' CPU side: the page table's layout, which bricks a view
 * wants, and how slots are given and taken back.
 */
import { describe, expect, it } from "vitest";
import { ABSENT, BRICK, type BrickLevel, brickLevels, brickRegion, BrickSet, type BrickView, CONSTANT, eyeOf, fillSlot, packPages, RESIDENT, SLOT, type Vec3 } from "../bricks.js";
import { identity, invert, type Mat4, multiply } from "../ome.js";

// A 256 mm image: levels of 0.5, 1 and 2 mm voxels, and a whole level of 4 mm.
const scaled = (voxel: number, size: number): Mat4 => {
  const m = identity();
  for (let k = 0; k < 3; ++k) {
    m[5 * k] = voxel;
    m[4 * k + 3] = -128 + voxel / 2;
  }
  return m;
};
const levels: BrickLevel[] = [0.5, 1, 2].map((v, index) => ({ index, size: [256 / v, 256 / v, 256 / v] as Vec3, voxelToRas: scaled(v, 256 / v) }));

/** The whole level: a ball of tissue 90 mm across (radius), on a dark background. */
function ball(): { data: Uint8Array; size: Vec3; voxelToRas: Mat4; darkBackground: boolean } {
  const n = 64;
  const data = new Uint8Array(n * n * n);
  const m = scaled(4, n);
  for (let z = 0; z < n; ++z) {
    for (let y = 0; y < n; ++y) {
      for (let x = 0; x < n; ++x) {
        const p = [x, y, z].map((v, k) => m[5 * k] * v + m[4 * k + 3]);
        if (Math.hypot(...p) < 90) data[(z * n + y) * n + x] = 200;
      }
    }
  }
  return { data, size: [n, n, n], voxelToRas: m, darkBackground: true };
}

/** A camera at `eye` looking at `target`: display (= RAS mm) to clip, column-major, and back. */
function camera(eye: number[], fovy = Math.PI / 4, target = [0, 0, 0]): { viewProjection: Float64Array; invViewProjection: Float64Array } {
  const norm = (v: number[]) => v.map((x) => x / Math.hypot(...v));
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(eye.map((v, k) => v - target[k]));
  const x = norm(cross(Math.abs(z[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1], z));
  const y = cross(z, x);
  const view = Float64Array.from([...x, -dot(x, eye), ...y, -dot(y, eye), ...z, -dot(z, eye), 0, 0, 0, 1]);
  const f = 1 / Math.tan(fovy / 2);
  const [near, far] = [1, 2000];
  const projection = Float64Array.from([f, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), (2 * far * near) / (near - far), 0, 0, -1, 0]);
  const vp = multiply(projection, view);
  const columns = (m: Mat4) => Float64Array.from({ length: 16 }, (_, i) => m[4 * (i % 4) + Math.floor(i / 4)]);
  return { viewProjection: columns(vp), invViewProjection: columns(invert(vp)) };
}

const at = (eye: number[], height: number, more: Partial<BrickView> = {}): BrickView => ({ ...camera(eye), height, toDisplay: identity(), threshold: 0.2, finest: 0, ...more });

/** A brick's box (RAS mm) and its centre's distance from `eye`. */
function boxOf(set: BrickSet, id: number) {
  const { level, b } = set.brick(id);
  const v = 0.5 * 2 ** level;
  const lo = b.map((x) => -128 + x * BRICK * v);
  const hi = lo.map((x) => x + BRICK * v);
  return { level, lo, hi, centre: lo.map((x, k) => (x + hi[k]) / 2) };
}

const never = () => new Promise<Uint8Array>(() => {});
const layout = () => brickLevels(levels, 2048)!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("page tables", () => {
  it("are stacked along z, and in a new column when z is full", () => {
    const p = packPages([[10, 12, 30], [5, 6, 20], [3, 3, 15]], 50)!;
    expect(p.offsets).toEqual([[0, 0, 0], [0, 0, 30], [10, 0, 0]]);
    expect(p.size).toEqual([13, 12, 50]);
  });

  it("do not overlap", () => {
    const grids: Vec3[] = [[40, 30, 25], [20, 15, 13], [10, 8, 7], [5, 4, 4], [3, 2, 2]];
    const p = packPages(grids, 64)!;
    const used = new Set<string>();
    p.offsets.forEach((o, i) => {
      for (let z = 0; z < grids[i][2]; ++z) for (let y = 0; y < grids[i][1]; ++y) for (let x = 0; x < grids[i][0]; ++x) {
        const key = `${o[0] + x},${o[1] + y},${o[2] + z}`;
        expect(used.has(key)).toBe(false);
        used.add(key);
        expect([o[0] + x, o[1] + y, o[2] + z].every((v, k) => v < p.size[k])).toBe(true);
      }
    });
  });

  it("leave the finest levels out when they do not fit", () => {
    expect(packPages([[60, 1, 1]], 50)).toBeUndefined();
    expect(layout().levels.map((l) => l.index)).toEqual([0, 1, 2]);
    // 16 bricks a side at 0.5 mm: too many for a texture 12 a side.
    const small = brickLevels(levels, 12)!;
    expect(small.levels.map((l) => l.index)).toEqual([1, 2]);
    expect(brickLevels(levels, 2)).toBeUndefined();
  });
});

describe("a brick's slot", () => {
  it("is the brick and a voxel around it, the edge repeated past the level", () => {
    const size: Vec3 = [40, 40, 40];
    const region = brickRegion(size, [0, 0, 0]);
    expect(region).toEqual({ lo: [0, 0, 0], hi: [33, 33, 33] });
    const n = region.hi.map((v, k) => v - region.lo[k]);
    const data = new Uint8Array(n[0] * n[1] * n[2]);
    for (let z = 0; z < n[2]; ++z) for (let y = 0; y < n[1]; ++y) for (let x = 0; x < n[0]; ++x) data[(z * n[1] + y) * n[0] + x] = x + 2 * y + 3 * z;
    const slot = fillSlot(data, region, size, [0, 0, 0]);
    expect(slot.data.length).toBe(SLOT ** 3);
    expect(slot.constant).toBeUndefined();
    const s = (x: number, y: number, z: number) => slot.data[(z * SLOT + y) * SLOT + x];
    // Slot voxel 0 is level voxel -1: the edge (0) repeated.
    expect(s(0, 0, 0)).toBe(0);
    expect(s(1, 1, 1)).toBe(0);
    expect(s(2, 1, 1)).toBe(1);
    expect(s(5, 3, 2)).toBe(4 + 2 * 2 + 3 * 1);
    expect(s(33, 1, 1)).toBe(32);
  });

  it("at the level's far edge, repeats its last voxel", () => {
    const size: Vec3 = [40, 40, 40];
    const region = brickRegion(size, [1, 0, 0]);
    expect(region).toEqual({ lo: [31, 0, 0], hi: [40, 33, 33] });
    const n = region.hi.map((v, k) => v - region.lo[k]);
    const data = new Uint8Array(n[0] * n[1] * n[2]);
    for (let i = 0; i < data.length; ++i) data[i] = region.lo[0] + (i % n[0]);
    const slot = fillSlot(data, region, size, [1, 0, 0]);
    expect(slot.data[0]).toBe(31);
    expect(slot.data[7]).toBe(38);
    expect(slot.data[8]).toBe(39);
    expect(slot.data[9]).toBe(39);
    expect(slot.data[20]).toBe(39);
  });

  it("knows a brick of one value", () => {
    const size: Vec3 = [64, 64, 64];
    const region = brickRegion(size, [1, 1, 1]);
    const data = new Uint8Array(34 * 34 * 34).fill(7);
    expect(fillSlot(data, region, size, [1, 1, 1]).constant).toBe(7);
  });
});

describe("choosing bricks", () => {
  const eye = [0, -400, 0];

  it("are finer near the camera and coarser further away", () => {
    const { levels: kept, layout: pages } = layout();
    const set = new BrickSet(kept, pages, 16, ball(), never);
    const wanted = set.choose(at(eye, 300));
    expect(wanted.length).toBeGreaterThan(10);
    const boxes = wanted.map((id) => boxOf(set, id));
    const distance = (b: ReturnType<typeof boxOf>) => Math.hypot(...b.centre.map((v, k) => v - eye[k]));
    const near = boxes.filter((b) => b.level === 0);
    const far = boxes.filter((b) => b.level > 0);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    expect(Math.min(...near.map(distance))).toBeLessThan(Math.min(...far.map(distance)));
    expect(Math.max(...near.map(distance))).toBeLessThan(Math.max(...far.map(distance)));
    // Nearest first.
    expect(distance(boxes[0])).toBeLessThan(distance(boxes[boxes.length - 1]));
    // A brick each place: no two overlap.
    for (let i = 0; i < boxes.length; ++i) {
      for (let j = i + 1; j < boxes.length; ++j) {
        const a = boxes[i];
        const b = boxes[j];
        expect(a.lo.every((v, k) => v < b.hi[k] && b.lo[k] < a.hi[k])).toBe(false);
      }
    }
  });

  it("leave out bricks behind the tissue's near surface, unless the cut opens them to the camera", () => {
    const { levels: kept, layout: pages } = layout();
    const set = new BrickSet(kept, pages, 16, ball(), never);
    const wanted = set.choose(at(eye, 300));
    // The camera is at y = -400: bricks beyond the ball's centre and well inside its outline are behind its near half
    // (near the outline a brick's corners can be seen past the ball).
    const behind = (id: number) => {
      const { centre } = boxOf(set, id);
      return centre[1] > 30 && Math.hypot(centre[0], centre[2]) < 50;
    };
    expect(wanted.some(behind)).toBe(false);
    expect(wanted.length).toBeGreaterThan(10);
    // The octant towards the camera cut away: bricks at the ball's middle can be seen.
    const cut = new BrickSet(kept, pages, 16, ball(), never);
    const opened = cut.choose(at(eye, 300, { cut: { point: [0, 0, 0], side: [1, -1, 1] } }));
    expect(opened.some((id) => boxOf(cut, id).centre[1] > 0 && Math.hypot(boxOf(cut, id).centre[0], boxOf(cut, id).centre[2]) < 50)).toBe(true);
    // With the camera inside the tissue nothing is taken as hidden.
    const inside = new BrickSet(kept, pages, 16, ball(), never);
    expect(inside.choose(at([0, -10, 0], 300)).some((id) => boxOf(inside, id).centre[1] > 30)).toBe(true);
    expect(eyeOf(camera([3, -400, 7]).viewProjection)!.map((v) => +v.toFixed(6))).toEqual([3, -400, 7]);
  });

  it("all coarse when the view is small, all finest when it is large", () => {
    const { levels: kept, layout: pages } = layout();
    const small = new BrickSet(kept, pages, 16, ball(), never);
    expect(small.choose(at(eye, 10)).every((id) => small.brick(id).level === 2)).toBe(true);
    const large = new BrickSet(kept, pages, 16, ball(), never);
    expect(large.choose(at(eye, 4000)).every((id) => large.brick(id).level === 0)).toBe(true);
  });

  it("keep to the atlas's slots, the most needed first", () => {
    const { levels: kept, layout: pages } = layout();
    const set = new BrickSet(kept, pages, 3, ball(), never);
    const wanted = set.choose(at(eye, 4000));
    expect(wanted.length).toBeLessThanOrEqual(27);
    expect(wanted.length).toBeGreaterThan(10);
    // The near side of the ball, not the far one.
    expect(wanted.every((id) => boxOf(set, id).centre[1] < 0)).toBe(true);
  });

  it("stop at the finest level asked for", () => {
    const { levels: kept, layout: pages } = layout();
    const set = new BrickSet(kept, pages, 16, ball(), never);
    const wanted = set.choose(at(eye, 4000, { finest: 1 }));
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.every((id) => set.brick(id).level === 1)).toBe(true);
  });

  it("leave out the cut-away octant, the inside of the tissue, and what the camera does not see", () => {
    const { levels: kept, layout: pages } = layout();
    const set = new BrickSet(kept, pages, 16, ball(), never);
    const side = [1, -1, 1];
    const wanted = set.choose(at(eye, 4000, { cut: { point: [0, 0, 0], side } }));
    const boxes = wanted.map((id) => boxOf(set, id));
    const removed = (b: ReturnType<typeof boxOf>) => [0, 1, 2].every((k) => (side[k] > 0 ? b.lo[k] >= 0 : b.hi[k] <= 0));
    expect(boxes.some(removed)).toBe(false);
    // On the cut's faces, bricks inside the ball; elsewhere only near its surface.
    const onCut = (b: ReturnType<typeof boxOf>) => [0, 1, 2].every((k) => (side[k] > 0 ? b.hi[k] >= 0 : b.lo[k] <= 0));
    const inside = (b: ReturnType<typeof boxOf>) => Math.hypot(...b.lo.map((v, k) => Math.max(Math.abs(v), Math.abs(b.hi[k])))) < 80;
    expect(boxes.some((b) => onCut(b) && inside(b))).toBe(true);
    expect(boxes.some((b) => !onCut(b) && inside(b))).toBe(false);
    // Nothing outside the ball (with a margin of a brick).
    expect(boxes.every((b) => Math.hypot(...b.centre) < 90 + 32 * 2 ** b.level)).toBe(true);
    // A camera looking at the ball's right edge sees only that side.
    const aside = new BrickSet(kept, pages, 16, ball(), never);
    const seen = aside.choose(at(eye, 4000, camera([120, -400, 0], 0.3, [120, 0, 0])));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => boxOf(aside, id).hi[0] > 40)).toBe(true);
  });
});

describe("slots", () => {
  const eye = [0, -400, 0];
  /** A brick's voxels: not one value, unless its level is 2 (then all 0). */
  const loader = async (level: number, region: { lo: Vec3; hi: Vec3 }) => {
    const n = region.hi.map((v, k) => v - region.lo[k]);
    const data = new Uint8Array(n[0] * n[1] * n[2]);
    if (level !== 2) for (let i = 0; i < data.length; ++i) data[i] = i % 251;
    return data;
  };

  it("hold bricks as they arrive, and the page table says where", async () => {
    const { levels: kept, layout: pages } = layout();
    const set = new BrickSet(kept, pages, 16, ball(), loader);
    let changes = 0;
    set.onChange = () => ++changes;
    const wanted = set.choose(at([0, -400, 0], 100));
    for (let i = 0; i < 100 && set.pending > 0; ++i) await flush();
    expect(changes).toBe(wanted.length);
    const entry = (id: number) => Array.from(set.pages.subarray(4 * set.page(id), 4 * set.page(id) + 4));
    for (const id of wanted) {
      const e = entry(id);
      if (set.brick(id).level === 2) {
        expect(e).toEqual([0, 0, 0, CONSTANT]);
      } else {
        expect(e[3]).toBe(RESIDENT);
        expect(e.slice(0, 3).every((v) => v < 16)).toBe(true);
      }
    }
    const resident = wanted.filter((id) => set.brick(id).level !== 2);
    expect(set.held).toBe(resident.length);
    // Each in a slot of its own, uploaded once.
    expect(new Set(resident.map((id) => entry(id).slice(0, 3).join())).size).toBe(resident.length);
    expect(set.uploads.length).toBe(resident.length);
    expect(set.uploads.every((u) => u.data.length === SLOT ** 3)).toBe(true);
    expect(set.takeDirty().length).toBe(wanted.length);
    expect(set.takeDirty().length).toBe(0);
  });

  it("go to new bricks from those least recently wanted", async () => {
    const { levels: kept, layout: pages } = layout();
    const set = new BrickSet(kept, pages, 3, ball(), loader);
    const settle = async () => {
      for (let i = 0; i < 200 && set.pending > 0; ++i) await flush();
    };
    const first = set.choose(at([0, -400, 0], 4000)).filter((id) => set.brick(id).level !== 2);
    await settle();
    expect(set.held).toBe(first.length);
    const entry = (id: number) => set.pages[4 * set.page(id) + 3];
    // From the other side: the first view's bricks give their slots up.
    const second = set.choose(at([0, 400, 0], 4000)).filter((id) => set.brick(id).level !== 2);
    await settle();
    expect(set.held).toBeLessThanOrEqual(27);
    expect(second.every((id) => entry(id) === RESIDENT)).toBe(true);
    const gone = first.filter((id) => entry(id) === ABSENT);
    expect(gone.length).toBeGreaterThanOrEqual(first.length + second.length - 27);
    // Back again: the second view's bricks are now least recently wanted.
    const third = set.choose(at([0, -400, 0], 4000)).filter((id) => set.brick(id).level !== 2);
    await settle();
    expect(third.every((id) => entry(id) === RESIDENT)).toBe(true);
  });

  it("stop reading bricks no longer wanted", async () => {
    const { levels: kept, layout: pages } = layout();
    const aborted: number[] = [];
    let started = 0;
    const set = new BrickSet(kept, pages, 16, ball(), (level, region, signal) => {
      started++;
      return new Promise((_, reject) => signal.addEventListener("abort", () => (aborted.push(level), reject(new Error("aborted")))));
    });
    set.choose(at(eye, 4000, camera([120, -400, 0], 0.3, [120, 0, 0])));
    expect(set.pending).toBe(6);
    set.choose(at(eye, 4000, camera([-120, -400, 0], 0.3, [-120, 0, 0])));
    expect(aborted.length).toBe(6);
    expect(set.pending).toBe(6);
    expect(started).toBe(12);
  });
});
