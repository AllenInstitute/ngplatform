/**
 * The region worker's client over a stand-in worker: answers kept within a
 * bound in bytes, a test nobody waits for any more cancelled in the worker,
 * a worker that dies started again with its work run once more (and failed
 * with why if it dies again); and the worker's chunk loop, which stops
 * between chunks once its work is stale.
 */
import { describe, expect, it } from "vitest";
import { type RoiGeometry, scanChunks } from "../roi.js";
import { RoiEngine } from "../roi_client.js";
import { INFO } from "./fake_context.js";

/** A worker that records what it is sent; the test answers. */
class FakeWorker {
  readonly sent: any[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage(msg: any): void {
    this.sent.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(msg: object): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
  crash(message = "out of memory"): void {
    this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
  }
  /** The requests of a type sent to it. */
  of(type: string): any[] {
    return this.sent.filter((m) => m.type === type);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function engine(cacheBytes?: number) {
  const workers: FakeWorker[] = [];
  const e = new RoiEngine("http://store/", {
    cacheBytes,
    start: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    },
  });
  const open = async (w = workers.at(-1)!) => {
    w.reply({ type: "opened", info: INFO });
    await settle();
  };
  return { e, workers, open };
}

const sphere = (x: number): RoiGeometry => ({ shape: "sphere", center: [x, 0, 0], radius: 5, size: [10, 10, 10] });
const ids = (n: number) => BigUint64Array.from({ length: n }, (_, i) => BigInt(i));

describe("the region worker's client", () => {
  it("keeps answers within its bound in bytes, the least recently used let go", async () => {
    // Room for three answers of 100 ids (800 bytes each, and a little more).
    const { e, workers, open } = engine(3 * 900);
    await open();
    const w = workers[0];
    for (let x = 0; x < 10; ++x) {
      const answer = e.evaluate(sphere(x), 0);
      await settle();
      w.reply({ type: "result", id: w.of("evaluate").at(-1).id, ids: ids(100), chunks: 1, bytes: 0, ms: 1 });
      await answer;
      expect(e.cachedBytes).toBeLessThanOrEqual(3 * 900);
    }
    expect(w.of("evaluate")).toHaveLength(10);
    // The latest three are kept: asked again, nothing is sent.
    await e.evaluate(sphere(9), 0);
    await e.evaluate(sphere(7), 0);
    expect(w.of("evaluate")).toHaveLength(10);
    // An old one is asked of the worker again.
    e.evaluate(sphere(0), 0).catch(() => {});
    await settle();
    expect(w.of("evaluate")).toHaveLength(11);
    // One larger than the whole bound is not kept at all.
    const big = e.evaluate(sphere(20), 0);
    await settle();
    w.reply({ type: "result", id: w.of("evaluate").at(-1).id, ids: ids(1000), chunks: 1, bytes: 0, ms: 1 });
    expect((await big).ids.length).toBe(1000);
    expect(e.cachedBytes).toBeLessThanOrEqual(3 * 900);
    e.dispose();
  });

  it("cancels a test in the worker once nobody waits for it, and shares one still wanted", async () => {
    const { e, workers, open } = engine();
    await open();
    const w = workers[0];
    const first = new AbortController();
    const second = new AbortController();
    const a = e.evaluate(sphere(1), 0, undefined, first.signal);
    const b = e.evaluate(sphere(1), 0, undefined, second.signal);
    await settle();
    // One test for both.
    expect(w.of("evaluate")).toHaveLength(1);
    const id = w.of("evaluate")[0].id;
    first.abort();
    await expect(a).rejects.toThrow(/Aborted/);
    expect(w.of("cancel")).toEqual([]);
    second.abort();
    await expect(b).rejects.toThrow(/Aborted/);
    expect(w.of("cancel")).toEqual([{ type: "cancel", id }]);
    // Its late answer is not kept: asked again, it is tested again.
    w.reply({ type: "result", id, ids: ids(3), chunks: 1, bytes: 0, ms: 1 });
    e.evaluate(sphere(1), 0).catch(() => {});
    await settle();
    expect(w.of("evaluate")).toHaveLength(2);
    e.dispose();
  });

  it("starts a worker that died again and runs its test once more; a second death fails, with why", async () => {
    const { e, workers, open } = engine();
    await open();
    const answer = e.evaluate(sphere(1), 0);
    await settle();
    workers[0].crash();
    expect(workers[0].terminated).toBe(true);
    // A new worker opens the store, then is given the same test.
    expect(workers).toHaveLength(2);
    expect(workers[1].of("open")).toHaveLength(1);
    expect(workers[1].of("evaluate")).toEqual([]);
    await open(workers[1]);
    expect(workers[1].of("evaluate")).toHaveLength(1);
    workers[1].reply({ type: "result", id: workers[1].of("evaluate")[0].id, ids: ids(2), chunks: 1, bytes: 0, ms: 1 });
    expect((await answer).ids.length).toBe(2);

    // It dies again: run once more, then given up.
    const failing = e.evaluate(sphere(2), 0);
    await settle();
    workers[1].crash();
    await open(workers[2]);
    expect(workers[2].of("evaluate")).toHaveLength(1);
    workers[2].crash("out of memory");
    await expect(failing).rejects.toThrow("the region reader stopped: out of memory");
    // And the next request has a worker of its own.
    e.evaluate(sphere(3), 0).catch(() => {});
    await settle();
    expect(workers).toHaveLength(4);
    e.dispose();
  });
});

describe("the region worker's chunk loop", () => {
  it("reads no further chunk once its work is stale", async () => {
    const coords = Array.from({ length: 20 }, (_, i) => [i, 0, 0]);
    const read: number[] = [];
    let stale = false;
    const finished = await scanChunks(
      coords,
      2,
      async (c) => {
        read.push(c[0]);
        if (read.length === 4) stale = true;
        await settle();
        return c[0];
      },
      () => {},
      () => stale,
    );
    expect(finished).toBe(false);
    // The two in hand when it went stale finish; none after.
    expect(read.length).toBe(4);
    const all: number[] = [];
    expect(await scanChunks(coords, 3, async (c) => c[0], (v) => all.push(v), () => false)).toBe(true);
    expect(all.sort((x, y) => x - y)).toEqual(coords.map((c) => c[0]));
  });
});
