/**
 * What track filtering derives from what the user does: a group's answer
 * written into its layer joins the user's undo step (undo takes both away,
 * and they stay away), against the workspace store itself; and the panel's
 * counts over an answer, counted once per answer, so a progress tick does
 * not count every object again.
 */
import { describe, expect, it, vi } from "vitest";
import type { Json, SegmentProperties } from "@ngplatform/sdk";
import { AnswerCounts, histogram, passingIds, tagCounts } from "../filter.js";
import { TrackGroups } from "../plugin.js";
import { wait, workspace } from "./workspace.js";

describe("a group's answer written into its layer", () => {
  it("joins the undo step of the region that changed it, and does not come back after undo", async () => {
    const { engine, store, ctx } = workspace();
    await wait();
    const groups = new TrackGroups(ctx);
    const copies = () => ((engine.layerSpec("Group 1")?.annotations as Json[] | undefined) ?? []).map((a) => a.id).sort();
    // A sphere at the centre: a group, its layer, and the points in it copied there.
    store.noteInput();
    groups.addSphere();
    await wait(20);
    expect(copies()).toEqual(["p0", "p1"]);
    // The view moved, and a second sphere there: no point is in both.
    store.noteInput();
    store.patchState((ng) => void (ng.position = [50, 0, 0]));
    await wait(20);
    const steps = store.historyRows().length;
    store.noteInput();
    groups.addSphere();
    // Seconds pass before the store settles, as when an answer takes them to come: the store no
    // longer takes a plain edit then as its plugin's own echo.
    const now = performance.now.bind(performance);
    const later = vi.spyOn(performance, "now").mockImplementation(() => now() + 5000);
    await wait(20);
    later.mockRestore();
    expect(copies()).toEqual([]);
    // One step: the region and the answer it gives.
    expect(store.historyRows().length).toBe(steps + 1);
    // Undo takes both away, and the answer before stays.
    expect(store.undo()).toBe(true);
    await wait(20);
    expect(copies()).toEqual(["p0", "p1"]);
    expect(store.historyRows().length).toBe(steps + 1);
    expect(store.historyRows().findIndex((r) => r.state === "current")).toBe(steps - 1);
    expect(store.redo()).toBe(true);
    await wait(20);
    expect(copies()).toEqual([]);
    groups.dispose();
  });
});

describe("the panel's counts over an answer", () => {
  /** n objects, `columns` attributes, two tags. */
  function properties(n: number, columns: number): SegmentProperties {
    const ids = new BigUint64Array(n);
    for (let i = 0; i < n; ++i) ids[i] = BigInt(i + 1);
    const numeric = Array.from({ length: columns }, (_, c) => {
      const values = new Float32Array(n);
      for (let i = 0; i < n; ++i) values[i] = (i * (c + 1)) % 1000;
      return { id: `a${c}`, description: undefined, values, min: 0, max: 1000 };
    });
    const values = Array.from({ length: n }, (_, i) => String.fromCharCode(i % 2));
    return { ids, numeric, tags: { names: ["left", "right"], descriptions: ["", ""], values } } as SegmentProperties;
  }

  it("counts each attribute once per answer however many progress ticks come", () => {
    const props = properties(10_000, 10);
    const calls = { histogram: 0, tagCounts: 0, passingIds: 0 };
    const counts = new AnswerCounts({
      histogram: (...a: Parameters<typeof histogram>) => (calls.histogram++, histogram(...a)),
      tagCounts: (...a: Parameters<typeof tagCounts>) => (calls.tagCounts++, tagCounts(...a)),
      passingIds: (...a: Parameters<typeof passingIds>) => (calls.passingIds++, passingIds(...a)),
    });
    const tick = (mask: Uint8Array) => {
      for (const column of props.numeric) counts.histogram(column, 40, mask);
      counts.tagCounts(props, mask);
      counts.passingIds(props, mask);
    };
    const answer = new Uint8Array(10_000).fill(1, 0, 4000);
    // A thousand ticks of "exact: k of N chunks read" while the answer stays.
    for (let k = 0; k < 1000; ++k) tick(answer);
    expect(calls).toEqual({ histogram: 10, tagCounts: 1, passingIds: 1 });
    // The answer is right: the masked histogram as counted directly.
    expect(Array.from(counts.histogram(props.numeric[3], 40, answer))).toEqual(Array.from(histogram(props.numeric[3].values, 0, 1000, 40, answer)));
    // A new answer is counted once more.
    const next = new Uint8Array(10_000).fill(1, 2000);
    for (let k = 0; k < 1000; ++k) tick(next);
    expect(calls).toEqual({ histogram: 20, tagCounts: 2, passingIds: 2 });
  });

  it("makes a tick on two million objects of ten attributes cost far less than counting them", () => {
    const props = properties(2_000_000, 10);
    const counts = new AnswerCounts();
    const answer = new Uint8Array(2_000_000).fill(1, 0, 700_000);
    const tick = () => {
      for (const column of props.numeric) counts.histogram(column, 40, answer);
      counts.tagCounts(props, answer);
    };
    let t = performance.now();
    tick();
    const first = performance.now() - t;
    t = performance.now();
    for (let k = 0; k < 100; ++k) tick();
    const hundred = performance.now() - t;
    // Counting once reads 22 million values; a hundred ticks after it read none.
    expect(hundred).toBeLessThan(first);
  });
});
