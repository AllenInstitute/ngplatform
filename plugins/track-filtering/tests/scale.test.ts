/**
 * A tractogram of a million streamlines through the fake reader: how long
 * the main thread is busy while a region change settles (a preview,
 * progress ticks, the exact answer, the group's own store), its longest
 * block, how often the panel is set, how many superseded tests are left
 * running, and whether the same answer builds the group's store again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SegmentProperties } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { TrackGroups } from "../plugin.js";
import type { Curves, StoreInfo } from "../roi_client.js";
import { writeTrk } from "../trk.js";
import { INFO, sphereGroup, world } from "./fake_context.js";

const N = 1_000_000;
/** Points per streamline. */
const POINTS = 8;

const BIG: StoreInfo = {
  ...INFO,
  levels: [
    { index: 0, vertexCount: N * POINTS, chunkShape: [32, 32, 32] },
    { index: 1, vertexCount: (N * POINTS) / 10, chunkShape: [64, 64, 64] },
  ],
};

function properties(): SegmentProperties {
  const ids = new BigUint64Array(N);
  const length = new Float32Array(N);
  const fa = new Float32Array(N);
  for (let i = 0; i < N; ++i) {
    ids[i] = BigInt(i);
    length[i] = 10 + (i % 190);
    fa[i] = (i % 97) / 100;
  }
  return {
    ids,
    numeric: [
      { id: "length", description: "", values: length, min: 10, max: 200 },
      { id: "fa", description: "", values: fa, min: 0, max: 0.96 },
    ],
    tags: undefined,
  };
}

/** Every `step`-th streamline, from `from`. */
const every = (step: number, from = 0) => {
  const out = new BigUint64Array(Math.ceil((N - from) / step));
  for (let i = 0; i < out.length; ++i) out[i] = BigInt(from + i * step);
  return out;
};

/** `POINTS` points along x for each id. */
function curves(ids: BigUint64Array, level: number): Curves {
  const offsets = new Uint32Array(ids.length + 1);
  const positions = new Float32Array(3 * POINTS * ids.length);
  for (let i = 0; i < ids.length; ++i) {
    offsets[i + 1] = POINTS * (i + 1);
    for (let p = 0; p < POINTS; ++p) positions.set([p - 4, (i % 100) - 50, 0], 3 * (POINTS * i + p));
  }
  return { ids, offsets, positions, level, ms: 1 };
}

describe("a million streamlines", () => {
  let dom: FakeDom;
  beforeEach(() => {
    // Timers faked, the clock not: the time measured is real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    dom = fakeDocument();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  it("settles a region change with the main thread free", { timeout: 120_000 }, async () => {
    const w = world({ groups: [sphereGroup()], editing: "g1" }, { props: properties(), info: BIG });
    const groups = new TrackGroups(w.ctx, w.engines);
    let busy = 0;
    let longest = 0;
    const timed = async (f: () => unknown) => {
      const t = performance.now();
      await f();
      const ms = performance.now() - t;
      busy += ms;
      longest = Math.max(longest, ms);
    };
    const settle = () => vi.advanceTimersByTimeAsync(0);
    await settle();
    const host = dom.host();
    const dispose = groups.render(host);
    const reader = w.readers[0];
    let answered = 0;
    /** Answers the reads the group's store asked for, the work done in a worker left out of the time. */
    const answerReads = async (time: boolean) => {
      while (answered < reader.reads.length) {
        const read = reader.reads[answered++];
        const c = curves(read.ids, read.level);
        const bytes = read.trk === undefined ? undefined : writeTrk(c, read.trk);
        const go = () => (bytes === undefined ? read.answer(c) : read.answerBytes!(bytes));
        if (time) await timed(async () => (go(), await settle()));
        else go(), await settle();
      }
    };
    // The first answer and its store, not counted.
    reader.evaluations[0].answer(every(4));
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await answerReads(false);
    const builds = () => w.opened.length;
    const builtBefore = builds();

    const panelSets = vi.spyOn(groups as unknown as { updateAll(): void }, "updateAll");
    // Two quick moves: the first's tests are superseded.
    const start = reader.evaluations.length;
    await timed(() => groups["updateRoi"](groups["saved"].groups[0], "g1r", { radius: 9 }));
    await timed(settle);
    const firstMove = reader.evaluations.slice(start);
    await timed(() => groups["updateRoi"](groups["saved"].groups[0], "g1r", { radius: 8 }));
    await timed(settle);
    const preview = reader.evaluations.at(-1)!;
    await timed(async () => (preview.answer(every(40)), await settle()));
    await vi.advanceTimersByTimeAsync(150);
    const exact = reader.evaluations.at(-1)!;
    expect(exact.level).toBe(0);
    for (let i = 1; i <= 200; ++i) await timed(async () => (exact.progress?.(i, 200), await vi.advanceTimersByTimeAsync(5)));
    await timed(async () => (exact.answer(every(3)), await settle()));
    await vi.advanceTimersByTimeAsync(400);
    await answerReads(true);
    const ticks = panelSets.mock.calls.length;
    const stale = firstMove.filter((e) => e.signal === undefined || !e.signal.aborted).length;
    const built = builds() - builtBefore;

    // The region moves but the answer stays: the group's store stays too.
    const same = builds();
    groups["updateRoi"](groups["saved"].groups[0], "g1r", { radius: 8.5 });
    await settle();
    reader.evaluations.at(-1)!.answer(every(3));
    await vi.advanceTimersByTimeAsync(150);
    reader.evaluations.at(-1)!.answer(every(3));
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await answerReads(false);
    const rebuiltForSame = builds() - same;

    console.log(
      `[scale] ${N.toLocaleString()} streamlines: main thread busy ${busy.toFixed(0)} ms while a region change settled, ` +
        `longest block ${longest.toFixed(0)} ms; the panel set ${ticks} times for 200 progress ticks; ` +
        `${stale} of ${firstMove.length} superseded tests left running; group stores built ${built}; rebuilt for the same answer ${rebuiltForSame}`,
    );
    expect(groups.service().list()[0].count).toBe(every(3).length);
    dispose();
    groups.dispose();
  });
});
