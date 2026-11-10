/**
 * The precomputed-mesh store's cells (precomputed_meshes.ts): the decoded
 * cells it keeps stay within their byte limit however reads overlap and
 * finish (a cell still being read is shared, never evicted, and counted
 * once it is read), and a level of more cells than a call takes arguments
 * is planned; a cell's reads are cancelled once nothing wants it, a failed
 * fragment is tried again and, failing still, left out with a warning;
 * segment ids past 2^63 are kept; and several stores share one budget.
 */
import { describe, expect, it } from "vitest";
import { type FragmentMesh, MESH_CELL_BUDGET, type MeshStorePlan, PrecomputedMeshStore } from "./precomputed_meshes.js";

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

/** A plan of one cell holding `n` segments' fragments, each read by `read(i, signal)`. */
function cellOf(n: number, read: (i: number, signal?: AbortSignal) => Promise<FragmentMesh>, ids?: bigint[]): MeshStorePlan {
  return {
    name: "test",
    ids: ids ?? Array.from({ length: n }, (_, i) => BigInt(i + 1)),
    lo: [0, 0, 0],
    hi: [10, 10, 10],
    scales: [1, 1, 1],
    unit: "nanometer",
    levels: [{ chunk: 10, vertices: 3 * n, fragments: Array.from({ length: n }, (_, i) => ({ object: i, centre: [5, 5, 5], read: (signal?: AbortSignal) => read(i, signal) })) }],
  };
}

/** A read that waits until its signal aborts (then rejects), counting the aborts. */
function hanging() {
  let started = 0;
  let aborted = 0;
  const read = (_: number, signal?: AbortSignal) =>
    new Promise<FragmentMesh>((_, reject) => {
      started++;
      signal?.addEventListener("abort", () => {
        aborted++;
        reject(signal.reason);
      });
    });
  return { read, started: () => started, aborted: () => aborted };
}

describe("cancelling and retrying a cell's reads", () => {
  it("stops a cell's fragment reads once every request for it is cancelled, a few read at a time", async () => {
    const h = hanging();
    const store = new PrecomputedMeshStore(cellOf(20, h.read), undefined, { concurrency: 4 });
    const one = new AbortController();
    const two = new AbortController();
    const a = store.get("0/vertices/c/0/0/0", one.signal);
    const b = store.get("0/vertex_fragments/c/0/0/0", two.signal);
    await new Promise((r) => setTimeout(r, 0));
    // Shared: one read of the cell, four fragments at a time.
    expect(h.started()).toBe(4);
    one.abort();
    await expect(a).rejects.toThrow(/abort/i);
    // The other request still wants it.
    expect(h.aborted()).toBe(0);
    two.abort();
    await expect(b).rejects.toThrow(/abort/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.aborted()).toBe(4);
    expect(h.started()).toBe(4);
    // Asked for again: read afresh, not the aborted read.
    const again = new AbortController();
    const c = store.get("0/vertices/c/0/0/0", again.signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.started()).toBe(8);
    again.abort();
    await expect(c).rejects.toThrow(/abort/i);
  });

  it("tries a failed fragment again after a pause, and gets it", async () => {
    let tries = 0;
    const store = new PrecomputedMeshStore(
      cellOf(1, async () => {
        if (++tries < 3) throw new Error("503 Service Unavailable");
        return TRIANGLE;
      }),
      undefined,
      { backoffMs: 1 },
    );
    const vertices = await store.get("0/vertices/c/0/0/0");
    expect(tries).toBe(3);
    expect(vertices!.byteLength).toBe(8 + 36);
    expect(store.warnings).toEqual([]);
  });

  it("keeps a cell's other fragments when one still fails, and says so", async () => {
    const seen: string[] = [];
    let tries = 0;
    const store = new PrecomputedMeshStore(
      cellOf(5, async (i) => {
        if (i === 2) {
          tries++;
          throw new Error("fragment 2: 500 Server Error");
        }
        return TRIANGLE;
      }),
      undefined,
      { backoffMs: 1, retries: 2 },
    );
    store.onWarning((w) => seen.push(w));
    const vertices = await store.get("0/vertices/c/0/0/0");
    // Tried three times in all; four triangles of five kept.
    expect(tries).toBe(3);
    expect(vertices!.byteLength).toBe(8 + 4 * 36);
    const index = await store.get("0/vertex_fragments/c/0/0/0");
    expect(index).toBeDefined();
    expect(store.failedFragments).toBe(1);
    expect(seen).toEqual(["Some mesh fragments could not be read and are left out (1 of 5 in a cell of level 0: fragment 2: 500 Server Error)"]);
    expect(store.warnings).toEqual(seen);
  });

  it("fails a cell none of whose fragments can be read, and reads it again next time", async () => {
    let fail = true;
    const store = new PrecomputedMeshStore(
      cellOf(2, async () => {
        if (fail) throw new Error("offline");
        return TRIANGLE;
      }),
      undefined,
      { backoffMs: 1, retries: 0 },
    );
    await expect(store.get("0/vertices/c/0/0/0")).rejects.toThrow("offline");
    fail = false;
    expect((await store.get("0/vertices/c/0/0/0"))!.byteLength).toBe(8 + 2 * 36);
  });
});

describe("segment ids and many segments", () => {
  it("serves ids at and past 2^63 as uint64, unchanged", async () => {
    const ids = [1n, 2n ** 63n - 1n, 2n ** 63n, 2n ** 64n - 1n];
    const store = new PrecomputedMeshStore(cellOf(4, async () => TRIANGLE, ids));
    const array = JSON.parse(new TextDecoder().decode((await store.get("0/object_index/object_ids/zarr.json"))!));
    expect(array.data_type).toBe("uint64");
    const bytes = (await store.get("0/object_index/object_ids/c/0"))!;
    expect(Array.from(new BigUint64Array(bytes.buffer, bytes.byteOffset, 4))).toEqual(ids);
  });

  it("plans a cell of 100,000 segments in linear time", () => {
    const n = 100_000;
    const t0 = performance.now();
    const store = new PrecomputedMeshStore(cellOf(n, async () => TRIANGLE));
    const ms = performance.now() - t0;
    expect(store.fragmentCounts).toEqual([n]);
    // A search per fragment (the old indexOf) took about 3.6 s for the owners alone; a map, 12 ms.
    expect(ms).toBeLessThan(2000);
  });

  it("keeps the decoded cells of several stores within one budget", async () => {
    const before = MESH_CELL_BUDGET.limit;
    MESH_CELL_BUDGET.setMaxBytes(5 * CELL_BYTES);
    try {
      const stores = [0, 1, 2].map(() => new PrecomputedMeshStore(plan(4).plan));
      // Their reads finish at once.
      for (const s of stores) (s.plan.levels[0].fragments as { read: unknown }[]).forEach((f) => (f.read = async () => TRIANGLE));
      for (const s of stores) for (let i = 0; i < 4; ++i) await s.get(`0/vertices/c/${i}/0/0`);
      // 12 cells read over three stores, 5 kept: the last store's four, and the second's last.
      expect(MESH_CELL_BUDGET.size).toBe(5 * CELL_BYTES);
      expect(stores.map((s) => s.cachedBytes)).toEqual([0, CELL_BYTES, 4 * CELL_BYTES]);
    } finally {
      MESH_CELL_BUDGET.setMaxBytes(before);
    }
  });
});
