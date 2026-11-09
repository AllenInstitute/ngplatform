/**
 * The precomputed-mesh store's cells (precomputed_meshes.ts): the decoded
 * cells it keeps stay within their byte limit however reads overlap and
 * finish (a cell still being read is shared, never evicted, and counted
 * once it is read), and a level of more cells than a call takes arguments
 * is planned.
 */
import { describe, expect, it } from "vitest";
import { type FragmentMesh, type MeshStorePlan, PrecomputedMeshStore } from "./precomputed_meshes.js";

/** One triangle's fragment: 3 vertices and 3 corners, 36 + 12 bytes decoded. */
const TRIANGLE: FragmentMesh = { positions: new Float32Array(9), triangles: Uint32Array.from([0, 1, 2]) };
const CELL_BYTES = 48;

/** A plan of one level of `n` cells along x, one segment's fragment in each, whose reads finish when the test says. */
function plan(n: number) {
  const reads = new Array<number>(n).fill(0);
  const waiting = new Map<number, (() => void)[]>();
  const p: MeshStorePlan = {
    name: "test",
    ids: Array.from({ length: n }, (_, i) => BigInt(i + 1)),
    lo: [0, 0, 0],
    hi: [10 * n, 10, 10],
    scales: [1, 1, 1],
    unit: "nanometer",
    levels: [
      {
        chunk: 10,
        vertices: 3 * n,
        fragments: Array.from({ length: n }, (_, i) => ({
          object: i,
          centre: [10 * i + 5, 5, 5],
          read: () => {
            reads[i]++;
            return new Promise<FragmentMesh>((resolve) => {
              const list = waiting.get(i) ?? [];
              list.push(() => resolve(TRIANGLE));
              waiting.set(i, list);
            });
          },
        })),
      },
    ],
  };
  /** Lets cell i's reads finish, and waits for what follows. */
  const finish = async (i: number) => {
    for (const r of waiting.get(i) ?? []) r();
    waiting.delete(i);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { plan: p, reads, finish };
}

describe("the precomputed-mesh store's decoded cells", () => {
  it("keeps its byte count exact while cells are evicted as others are still being read", async () => {
    const { plan: p, reads, finish } = plan(8);
    // Room for two cells.
    const store = new PrecomputedMeshStore(p, 2 * CELL_BYTES);
    const ask = (i: number) => store.get(`0/vertices/c/${i}/0/0`);
    // Cell 0 read; then 1 to 5 asked for at once, and finished out of order.
    const first = ask(0);
    await finish(0);
    await first;
    const asked = [1, 2, 3, 4, 5].map(ask);
    // Asked for again while being read: shared, not read twice.
    const again = ask(3);
    for (const i of [4, 2, 5, 1, 3]) await finish(i);
    await Promise.all([...asked, again]);
    expect(reads.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(store.cachedBytes).toBe(2 * CELL_BYTES);
    // The two asked for last (5, then 3 again) are kept; the others were let go.
    await ask(5);
    await ask(3);
    expect(reads[5]).toBe(1);
    expect(reads[3]).toBe(1);
    const back = ask(4);
    await finish(4);
    await back;
    expect(reads[4]).toBe(2);
    expect(store.cachedBytes).toBe(2 * CELL_BYTES);
  });

  it("never lets its byte count fall below 0 or rise past its limit over many overlapping reads", async () => {
    const n = 40;
    const { plan: p, finish } = plan(n);
    const store = new PrecomputedMeshStore(p, 3 * CELL_BYTES);
    const ask = (i: number) => store.get(`0/vertices/c/${i}/0/0`);
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let round = 0; round < 20; ++round) {
      const cells = Array.from({ length: 6 }, () => Math.floor(random() * n));
      const pending = cells.map(ask);
      for (const i of [...new Set(cells)].sort(() => random() - 0.5)) {
        await finish(i);
        expect(store.cachedBytes).toBeGreaterThanOrEqual(0);
        expect(store.cachedBytes).toBeLessThanOrEqual(3 * CELL_BYTES);
      }
      await Promise.all(pending);
      expect(store.cachedBytes % CELL_BYTES).toBe(0);
    }
    expect(store.cachedBytes).toBe(3 * CELL_BYTES);
  });

  it("plans a level of 200,000 cells (no Math.min over a spread)", async () => {
    const n = 200_000;
    const { plan: p } = plan(n);
    const store = new PrecomputedMeshStore(p);
    const array = JSON.parse(new TextDecoder().decode((await store.get("0/vertices/zarr.json"))!));
    expect(array.shape).toEqual([n, 1, 1]);
    expect(array.attributes.chunk_grid_origin).toEqual([0, 0, 0]);
  });
});
