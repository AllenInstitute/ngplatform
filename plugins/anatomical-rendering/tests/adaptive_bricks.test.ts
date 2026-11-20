import { describe, expect, it, vi } from "vitest";

// The bricks' reader: each level's voxels its own value (level index 0: 200, 1: 100), read as asked; or, with `mock.ramp`,
// each voxel its x in its level (a ramp, which trilinear sampling gives back exactly).
const reads: { level: number; lo: number[]; hi: number[] }[] = [];
const mock = { ramp: false };
vi.mock("../../volume-view/volume_client.js", () => ({
  VolumeClient: class {
    open() {
      return Promise.resolve({ levels: [], name: "", window: [0, 255] });
    }
    volume(level: number, _p: unknown, _s: unknown, region: { lo: number[]; hi: number[] }) {
      reads.push({ level, ...region });
      const size = region.hi.map((h, k) => h - region.lo[k]) as [number, number, number];
      const data = new Uint8Array(size[0] * size[1] * size[2]).fill(level === 0 ? 200 : 100);
      if (mock.ramp) for (let i = 0; i < data.length; ++i) data[i] = region.lo[0] + (i % size[0]);
      return Promise.resolve({ data, size });
    }
    dispose() {}
  },
}));

const { Multiscale, POOL_SLOTS, tableSample } = await import("../adaptive_bricks.js");
const { REGION, SLOT } = await import("../adaptive.js");
const { invert } = await import("../local/local.js");

/** A level's voxel to RAS (row-major): `s` mm voxels, voxel 0's centre at s / 2. */
const affine = (s: number) => [s, 0, 0, s / 2, 0, s, 0, s / 2, 0, 0, s, s / 2, 0, 0, 0, 1];

/** The base (s2, 1 mm, 32³) and two finer levels, as readLevel gives them. */
const level = {
  data: new Uint8Array(32 ** 3),
  size: [32, 32, 32] as [number, number, number],
  voxelToRas: affine(1),
  range: [0, 255] as [number, number],
  pct: new Map<number, number>(),
  window: undefined,
  path: "s2",
  levels: [
    { path: "s0", size: [128, 128, 128] as [number, number, number], voxelMm: 0.25, voxelToRas: affine(0.25) },
    { path: "s1", size: [64, 64, 64] as [number, number, number], voxelMm: 0.5, voxelToRas: affine(0.5) },
    { path: "s2", size: [32, 32, 32] as [number, number, number], voxelMm: 1, voxelToRas: affine(1) },
  ],
};

/** Column-major matrices of a camera at `eye` looking along +z (90° across), and its inverse. */
function camera(eye: number[]) {
  const n = 0.1, f = 1000;
  const a = (f + n) / (f - n), b = (-2 * f * n) / (f - n);
  // clip = (x - ex, y - ey, a (z - ez) + b, z - ez)
  const vp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, a, 1, -eye[0], -eye[1], -a * eye[2] + b, -eye[2]];
  // (Its inverse: the transpose's inverse, transposed, is the inverse.)
  const inv = invert(vp);
  return { vp, inv };
}

const U = "https://example.org/image.zarr";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function settle(m: InstanceType<typeof Multiscale>) {
  await vi.waitFor(() => expect(m.busy()).toBe(false), { timeout: 5000, interval: 5 });
}

describe("multiscale bricks", () => {
  it("the camera's inverse undoes it", () => {
    const { vp, inv } = camera([16, 16, -20]);
    const p = [3, 4, 30, 1];
    const c = [0, 1, 2, 3].map((r) => vp[r] * p[0] + vp[4 + r] * p[1] + vp[8 + r] * p[2] + vp[12 + r] * p[3]);
    const ndc = c.map((x) => x / c[3]);
    const w = [0, 1, 2, 3].map((r) => inv[r] * ndc[0] + inv[4 + r] * ndc[1] + inv[8 + r] * ndc[2] + inv[12 + r]);
    expect(w.slice(0, 3).map((x) => +(x / w[3]).toFixed(6))).toEqual([3, 4, 30]);
  });

  it("refines what the camera is near, coarse levels first, and tables it", async () => {
    reads.length = 0;
    const m = new Multiscale();
    expect(m.attach(U, level)).toBe(true);
    const { vp, inv } = camera([16, 16, -20]);
    const view = { invViewProjection: inv, viewProjection: vp, height: 1000, worldFromVox: identity, cropLo: [-1e9, -1e9, -1e9], cropHi: [1e9, 1e9, 1e9], key: "k" };
    m.plan(U, view, POOL_SLOTS);
    await settle(m);
    // s1 (index 1) read before s0 (index 0).
    expect(reads[0].level).toBe(1);
    expect(reads.some((r) => r.level === 0)).toBe(true);
    const shares = m.shares(U, "s2")!;
    expect(shares.map((s) => s.path)).toEqual(["s2", "s1", "s0"]);
    expect(shares[2].share).toBeGreaterThan(0);
    // The table: each region drawn finer points at slots holding that level's bricks.
    const t = m.table([U]);
    expect(t.ms[0]).toBe(1);
    expect(Array.from(t.grid)).toEqual([32 / REGION, 32 / REGION, 32 / REGION]);
    const regions = (32 / REGION) ** 3;
    let fine = 0;
    for (let r = 0; r < regions; ++r) {
      const e = t.data[4 * r];
      const lvl = e & 255;
      if (lvl === 0) continue;
      ++fine;
      const n = ((e >> 8) & 255) * ((e >> 16) & 255) * (e >>> 24);
      for (let i = 0; i < n; ++i) {
        const slot = t.data[4 * (t.data[4 * r + 1] + i)];
        const bytes = m.slotBytes(slot)!;
        expect(bytes.length).toBe(SLOT ** 3);
        expect(bytes[0]).toBe(lvl === 2 ? 200 : 100);
      }
    }
    expect(fine).toBeGreaterThan(0);
    // Every slot written is given once to a renderer that has none.
    const w = m.written(0);
    expect(w.slots.length).toBeGreaterThan(0);
    expect(m.written(w.stamp).slots).toEqual([]);
    // The majorant's cells under a finer region take its bricks' values.
    const cells = m.cellBounds(U, 4, [8, 8, 8])!;
    expect(cells.size).toBeGreaterThan(0);
    for (const [lo, hi] of cells.values()) {
      expect([100, 200]).toContain(Math.round(hi * 255));
      expect(lo).toBeLessThanOrEqual(hi);
    }
  });

  it("asks for nothing again when the camera has not moved, and lets an image go", async () => {
    const m = new Multiscale();
    m.attach(U, level);
    const { vp, inv } = camera([16, 16, -20]);
    const view = { invViewProjection: inv, viewProjection: vp, height: 1000, worldFromVox: identity, cropLo: [-1e9, -1e9, -1e9], cropHi: [1e9, 1e9, 1e9], key: "k" };
    m.plan(U, view, POOL_SLOTS);
    await settle(m);
    const version = m.version;
    reads.length = 0;
    m.plan(U, view, POOL_SLOTS);
    expect(reads).toEqual([]);
    expect(m.version).toBe(version);
    m.detach(U);
    expect(m.has(U)).toBe(false);
    expect(m.table([U]).ms[0]).toBe(0);
  });

  it("keeps a far, small image at its base", async () => {
    const m = new Multiscale();
    m.attach(U, level);
    const { vp, inv } = camera([16, 16, -1e5]);
    m.plan(U, { invViewProjection: inv, viewProjection: vp, height: 100, worldFromVox: identity, cropLo: [-1e9, -1e9, -1e9], cropHi: [1e9, 1e9, 1e9], key: "k" }, POOL_SLOTS);
    await settle(m);
    expect(m.shares(U, "s2")![0].share).toBe(1);
  });

  it("looks a point up as the shaders do: each refined region gives its level's value there", async () => {
    mock.ramp = true;
    try {
      const m = new Multiscale();
      m.attach(U, level);
      const { vp, inv } = camera([16, 16, -20]);
      m.plan(U, { invViewProjection: inv, viewProjection: vp, height: 1000, worldFromVox: identity, cropLo: [-1e9, -1e9, -1e9], cropHi: [1e9, 1e9, 1e9], key: "k" }, POOL_SLOTS);
      await settle(m);
      const t = m.table([U]);
      const scales = [[2, 0.5], [4, 1.5]];
      let checked = 0;
      for (let i = 0; i < 4000; ++i) {
        // A point well inside the image (the ramp's ends are clamped).
        const v = [1 + ((i * 7.31) % 29), 1 + ((i * 3.17) % 29), (i * 5.71) % 31] as [number, number, number];
        const got = tableSample(t, 0, v, (slot) => m.slotBytes(slot));
        if (got === undefined) continue;
        const r = [0, 1, 2].map((k) => Math.floor((v[k] + 0.5) / REGION));
        const e = t.data[4 * (r[0] + 4 * (r[1] + 4 * r[2]))] & 255;
        const [sc, off] = scales[e - 1];
        expect(got * 255).toBeCloseTo(v[0] * sc + off, 3);
        ++checked;
      }
      expect(checked).toBeGreaterThan(100);
    } finally {
      mock.ramp = false;
    }
  });

  it("keeps the slots a renderer draws with until it lets them go", async () => {
    const m = new Multiscale(48);
    m.attach(U, level);
    const near = camera([16, 16, -20]);
    const view = (c: ReturnType<typeof camera>, key: string) => ({ invViewProjection: c.inv, viewProjection: c.vp, height: 1000, worldFromVox: identity, cropLo: [-1e9, -1e9, -1e9], cropHi: [1e9, 1e9, 1e9], key });
    // A small pool share: the next plan must reuse slots.
    m.plan(U, view(near, "a"), 40);
    await settle(m);
    const t = m.table([U]);
    const owner = {};
    m.pin(owner, t.slots);
    const before = new Map([...t.slots].map((s) => [s, m.slotBytes(s)]));
    expect(t.slots.size).toBeGreaterThan(0);
    // Near another corner, the whole pool asked for: slots are reused, but not the pinned ones.
    const stamp = m.written(0).stamp;
    m.plan(U, view(camera([2, 2, -3]), "b"), 48);
    await settle(m);
    const rewritten = m.written(stamp).slots;
    expect(rewritten.length).toBeGreaterThan(0);
    for (const s of t.slots) {
      expect(rewritten).not.toContain(s);
      expect(m.slotBytes(s)).toBe(before.get(s));
    }
    // Let go: they may be reused.
    m.pin(owner, undefined);
  });

  it("reaches the levels chosen with a small pool", async () => {
    const m = new Multiscale(24);
    m.attach(U, level);
    // Near, and a tall view: every region in view wants s0, the budget all of the pool.
    const { vp, inv } = camera([16, 16, -2]);
    m.plan(U, { invViewProjection: inv, viewProjection: vp, height: 8000, worldFromVox: identity, cropLo: [-1e9, -1e9, -1e9], cropHi: [1e9, 1e9, 1e9], key: "k" }, 24);
    await settle(m);
    expect(m.shares(U, "s2")![2].share).toBeGreaterThan(0);
    expect(m.unreached(U)).toBe(0);
  });
});
