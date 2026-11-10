/**
 * TrackGroups itself, over a fake reader and fake files: a late answer for
 * an old query never wins; each group's own store is made, replaced, let go
 * and put back after undo; a .trk is written with its streamline count in
 * the header last; a density map stops when cancelled; CSV waits for the
 * exact answer; and tags go to the runner's job as the objects they choose.
 * At scale: superseded tests are cancelled, a failed count offers Retry,
 * progress reaches the panel a few times a second, a group's store is made
 * again only when its objects change and let go when switched off, and a
 * download too large to build in memory is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@ngplatform/sdk";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { DOWNLOAD_BYTES, saveTarget, TrackGroups } from "../plugin.js";
import type { ZvfDocument } from "../runner_job.js";
import { curvesOf, INFO, sphereGroup, world } from "./fake_context.js";

/** A store made in the page, as the workspace names it. */
const own = (n: number) => `http://127.0.0.1:4180/local/derived-${n}/Group 1.trk`;

/** Lets every answer already given run its course. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A group's count as the service reports it, and whether it is exact. */
const answer = (groups: TrackGroups, id = "g1") => {
  const g = groups.service().list().find((x) => x.id === id);
  return g && { count: g.count, exact: g.exact };
};

/** Opens the world's tractogram with one group: its first exact answer is being worked out. */
async function opened(options: Parameters<typeof world>[1] = {}) {
  const w = world({ groups: [sphereGroup()], editing: "g1" }, options);
  const groups = new TrackGroups(w.ctx, w.engines);
  await settle();
  const reader = w.readers[0];
  return { w, groups, reader };
}

describe("TrackGroups' answers", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("lets no late answer for an old query win over a newer one", async () => {
    const { w, groups, reader } = await opened();
    // Opening works the answer out exactly, at once.
    expect(reader.evaluations.map((e) => e.level)).toEqual([0]);
    const first = reader.evaluations[0];
    // The region moves: a preview from the sample level, then the exact answer once it stays put.
    groups["updateRoi"](sphereGroup(), "g1r", { center: [5, 0, 0] });
    expect(reader.evaluations.map((e) => e.level)).toEqual([0, 1]);
    const preview = reader.evaluations[1];
    await vi.advanceTimersByTimeAsync(150);
    expect(reader.evaluations.map((e) => e.level)).toEqual([0, 1, 0]);
    const exact = reader.evaluations[2];
    expect(exact.geometry.center).toEqual([5, 0, 0]);

    exact.answer([1n]);
    await settle();
    expect(answer(groups)).toEqual({ count: 1, exact: true });
    // The old query's answer, late: dropped.
    first.answer([0n, 1n, 2n]);
    await settle();
    expect(answer(groups)).toEqual({ count: 1, exact: true });
    // The preview, later than the exact answer (its levels were not cached): dropped too.
    preview.answer([1n, 2n, 3n]);
    await settle();
    expect(answer(groups)).toEqual({ count: 1, exact: true });
    expect(Array.from(w.visible.get("Group 1")!)).toEqual([1n]);
    groups.dispose();
  });

  it("shows a preview until the exact answer, and drops answers for a deleted group", async () => {
    const { groups, reader } = await opened();
    reader.evaluations[0].answer([0n]);
    await settle();
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 9 });
    reader.evaluations[1].answer([0n, 4n]);
    await settle();
    expect(answer(groups)).toEqual({ count: 2, exact: false });
    await vi.advanceTimersByTimeAsync(150);
    groups["deleteGroup"](groups["saved"].groups[0]);
    reader.evaluations[2].answer([0n, 4n, 5n]);
    await settle();
    expect(groups.service().list()).toEqual([]);
    expect(groups["results"].has("g1")).toBe(false);
    groups.dispose();
  });

  it("makes each streamline group a store of its own, replaces it as the answer changes, lets it go, and puts it back after undo", async () => {
    const { w, groups, reader } = await opened({ holdOpens: true });
    reader.evaluations[0].answer([1n]);
    await settle();
    // The store is made once the exact answer has stayed a moment.
    await vi.advanceTimersByTimeAsync(400);
    expect(reader.reads).toHaveLength(1);
    reader.reads[0].answer();
    await settle();
    expect(w.opened.map((f) => f.name)).toEqual(["Group 1.trk"]);
    w.openAnswers[0].resolve([{ source: own(1), name: "Group 1.trk", kind: "segmentation" }]);
    await settle();
    const spec = () => (w.ng.layers as Json[]).find((l) => l.name === "Group 1")!;
    expect(JSON.stringify(spec().source)).toContain(own(1));

    // A new answer: a new store, and the old one let go once the new one shows.
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 8 });
    await vi.advanceTimersByTimeAsync(150);
    reader.evaluations.at(-1)!.answer([1n, 2n]);
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    reader.reads.at(-1)!.answer();
    await settle();
    w.openAnswers[1].resolve([{ source: own(2), name: "Group 1.trk", kind: "segmentation" }]);
    await settle();
    expect(JSON.stringify(spec().source)).toContain(own(2));
    expect(w.closed).toEqual([own(1)]);

    // The answer changes while its store opens: the store made for the old answer is let go at once.
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 7 });
    await vi.advanceTimersByTimeAsync(150);
    reader.evaluations.at(-1)!.answer([2n]);
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    reader.reads.at(-1)!.answer();
    await settle();
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 6 });
    await vi.advanceTimersByTimeAsync(150);
    reader.evaluations.at(-1)!.answer([3n]);
    await settle();
    w.openAnswers[2].resolve([{ source: own(3), name: "Group 1.trk", kind: "segmentation" }]);
    await settle();
    expect(w.closed).toEqual([own(1), own(3)]);
    expect(JSON.stringify(spec().source)).toContain(own(2));
    await vi.advanceTimersByTimeAsync(400);
    reader.reads.at(-1)!.answer();
    await settle();
    w.openAnswers[3].resolve([{ source: own(4), name: "Group 1.trk", kind: "segmentation" }]);
    await settle();
    expect(w.closed).toEqual([own(1), own(3), own(2)]);

    // Undo puts the layer back on the dataset's own source: the group points it at its store again.
    spec().source = { url: "anything", subsources: { objects: false, meshes: false } };
    w.propertiesChanged("Group 1");
    expect(JSON.stringify(spec().source)).toContain(own(4));

    // Deleting the group lets its store go.
    groups["deleteGroup"](groups["saved"].groups[0]);
    expect(w.closed).toEqual([own(1), own(3), own(2), own(4)]);
    groups.dispose();
  });

  it("exports CSV only from the exact answer", async () => {
    const { w, groups, reader } = await opened();
    const download = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const dom = fakeDocument();
    try {
      groups.exportCsv();
      expect(w.toasts.at(-1)?.message).toMatch(/No group with objects/);
      reader.evaluations[0].answer([1n, 2n]);
      await settle();
      groups["updateRoi"](sphereGroup(), "g1r", { radius: 9 });
      reader.evaluations[1].answer([1n]);
      await settle();
      // A preview: a sample, not the group.
      groups.exportCsv();
      expect(w.toasts.at(-1)).toEqual({ message: "Wait for the exact count, then export.", kind: "error" });
      expect(download).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      reader.evaluations[2].answer([1n, 2n, 3n]);
      await settle();
      groups.exportCsv();
      expect(download).toHaveBeenCalledTimes(1);
      const csv = await (download.mock.calls[0][0] as Blob).text();
      expect(csv.split("\n").slice(1, -1).map((row) => row.split(",")[0])).toEqual(["1", "2", "3"]);
    } finally {
      download.mockRestore();
      dom.restore();
      groups.dispose();
    }
  });
});

/** A writable file as the browser's save dialog gives one: parts appended, `{type: "write", position}` writes over. */
function picked() {
  let bytes = new Uint8Array(0);
  const put = (at: number, part: ArrayBuffer) => {
    const data = new Uint8Array(part);
    if (at + data.length > bytes.length) {
      const grown = new Uint8Array(at + data.length);
      grown.set(bytes);
      bytes = grown;
    }
    bytes.set(data, at);
  };
  const file = { closed: false, aborted: false, bytes: () => bytes };
  const picker = vi.fn(async () => ({
    name: "Group 1.trk",
    createWritable: async () => ({
      write: async (data: ArrayBuffer | { type: "write"; position: number; data: ArrayBuffer }) => (data instanceof ArrayBuffer ? put(bytes.length, data) : put(data.position, data.data)),
      close: async () => void (file.closed = true),
      abort: async () => void (file.aborted = true),
    }),
  }));
  return { file, picker };
}

describe("saving a group's streamlines", () => {
  let dom: FakeDom;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = fakeDocument();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  /** A group whose exact answer is streamlines 1, 2 and 4. */
  async function exact() {
    const o = await opened();
    o.reader.evaluations[0].answer([1n, 2n, 4n]);
    await settle();
    return o;
  }

  it("writes a .trk to the chosen file, its streamline count put into the header last", async () => {
    const { groups, reader } = await exact();
    const { file, picker } = picked();
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = picker;
    const saving = groups.saveTrk();
    await settle();
    expect(reader.reads.at(-1)!.ids).toEqual(BigUint64Array.from([1n, 2n, 4n]));
    // While the streamlines are read, the header holds no count yet.
    expect(new DataView(file.bytes().buffer).getInt32(988, true)).toBe(0);
    reader.reads.at(-1)!.answer();
    await saving;
    const bytes = file.bytes();
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe("TRACK");
    expect(view.getInt32(988, true)).toBe(3);
    expect(bytes.length).toBe(1000 + 3 * (4 + 2 * 12));
    expect(file.closed).toBe(true);
    expect(groups["saved_"].get("g1")).toMatch(/^Saved 3 streamlines \(6 points/);
    groups.dispose();
  });

  it("rewrites the header held in memory when it has to download instead", async () => {
    const { groups, reader } = await exact();
    const download = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    try {
      const saving = groups.saveTrk();
      await settle();
      reader.reads.at(-1)!.answer();
      await saving;
      const blob = download.mock.calls[0][0] as Blob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      expect(new DataView(bytes.buffer).getInt32(988, true)).toBe(3);
      expect(bytes.length).toBe(1000 + 3 * (4 + 2 * 12));
    } finally {
      download.mockRestore();
      groups.dispose();
    }
  });

  it("stops a density map when it is cancelled, and stops reading", async () => {
    const { w, groups, reader } = await exact();
    const host = dom.host();
    const dispose = groups.render(host);
    const mapping = groups.densityMap(undefined, 0, 2);
    await settle();
    const read = reader.reads.at(-1)!;
    const cancel = dom.find<HTMLButtonElement>(host, "button", "Cancel");
    expect(cancel.hidden).toBe(false);
    expect(dom.text(host)).toContain("Counting streamlines: 0 of 3…");
    cancel.click();
    await mapping;
    expect(read.signal?.aborted).toBe(true);
    expect(w.datasets).toEqual([]);
    expect(w.toasts).toEqual([]);
    expect(groups["saving"]).toBeUndefined();
    expect(cancel.hidden).toBe(true);
    expect(dom.text(host)).toContain("Density map cancelled.");
    // Another can start: nothing is left running.
    const again = groups.densityMap(undefined, 0, 2);
    await settle();
    reader.reads.at(-1)!.answer(curvesOf(BigUint64Array.from([1n, 2n, 4n])));
    await again;
    expect(w.datasets).toHaveLength(1);
    expect(dom.text(host)).toMatch(/Density map of 3 streamlines on a \d+ × \d+ × \d+ grid of 2 mm voxels/);
    dispose();
    groups.dispose();
  });

  it("refuses a density grid too fine to count, saying what fits", async () => {
    const { w, groups } = await exact();
    await groups.densityMap(undefined, 0, 0.1);
    expect(w.toasts.at(-1)?.message).toMatch(/too many to count in the page: use [\d.]+ mm or more/);
    expect(groups["saving"]).toBeUndefined();
    groups.dispose();
  });
});

describe("a group run on this computer", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("sends its tags as the objects they choose, and the density map's voxel size", async () => {
    const w = world({ groups: [{ ...sphereGroup(), filter: { ranges: {}, includeTags: ["left"], excludeTags: ["short"] } }], editing: "g1" }, { tags: true, runner: true });
    const groups = new TrackGroups(w.ctx, w.engines);
    await settle();
    groups["densityVoxel"] = 2;
    w.ctx.ui.form = (async (_t: string, _s: unknown, initial: Record<string, unknown>) => ({ ...initial, density: true })) as typeof w.ctx.ui.form;
    // It follows the job until it ends, which this one never does.
    void groups.runOnComputer();
    await settle();
    expect(w.toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(w.jobs).toHaveLength(1);
    const { args } = w.jobs[0];
    const filter = args.filter as ZvfDocument;
    expect(filter.tree).toMatchObject({ op: "and", args: [{ op: "passes" }, { op: "group", ids: [0] }] });
    // "left" is 0, 2 and 4: bits 0, 2, 4 of 5.
    expect(filter.groups).toEqual([{ size: 5, bits: btoa(String.fromCharCode(0b10101000)) }]);
    expect(args).toMatchObject({ density: "/data/Group_1_density.nii.gz", voxel: 2 });
    groups.dispose();
  });
});

describe("TrackGroups at scale", () => {
  let dom: FakeDom;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = fakeDocument();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  it("cancels the tests a newer query supersedes", async () => {
    const { groups, reader } = await opened();
    const first = reader.evaluations[0];
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 8 });
    // The first exact test is no longer wanted: the worker is told to stop it.
    expect(first.signal?.aborted).toBe(true);
    const preview = reader.evaluations[1];
    expect(preview.signal?.aborted).toBe(false);
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 7 });
    expect(preview.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    const exact = reader.evaluations.at(-1)!;
    expect(exact.signal?.aborted).toBe(false);
    // Deleting the group stops its tests too.
    groups["deleteGroup"](groups["saved"].groups[0]);
    expect(exact.signal?.aborted).toBe(true);
    groups.dispose();
  });

  it("shows a count that failed with Retry, which counts again", async () => {
    const { groups, reader } = await opened();
    const host = dom.host();
    const dispose = groups.render(host);
    reader.evaluations[0].fail(new Error("the region reader stopped: out of memory"));
    await settle();
    const status = host.querySelector(".status-line.error")!;
    expect(dom.text(status)).toBe("the region reader stopped: out of memory Retry");
    dom.find<HTMLButtonElement>(host, "button", "Retry").click();
    await settle();
    expect(reader.evaluations).toHaveLength(2);
    expect(reader.evaluations[1].level).toBe(0);
    reader.evaluations[1].answer([1n, 2n]);
    await settle();
    expect(host.querySelector(".status-line.error")).toBeNull();
    expect(answer(groups)).toEqual({ count: 2, exact: true });
    dispose();
    groups.dispose();
  });

  it("sets the panel a few times a second as a count progresses, not on every tick", async () => {
    const { groups, reader } = await opened();
    const host = dom.host();
    const dispose = groups.render(host);
    const sets = vi.spyOn(groups as unknown as { updateAll(): void }, "updateAll");
    const exact = reader.evaluations[0];
    for (let i = 1; i <= 100; ++i) exact.progress!(i, 100);
    expect(sets).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(sets).toHaveBeenCalledTimes(1);
    expect(dom.text(host)).toContain("Counting exactly: 100 of 100 chunks read…");
    dispose();
    groups.dispose();
  });

  it("makes a group's store again only when its objects change", async () => {
    const { w, groups, reader } = await opened();
    reader.evaluations[0].answer([1n, 2n]);
    await vi.advanceTimersByTimeAsync(400);
    reader.reads[0].answer();
    await settle();
    expect(w.opened).toHaveLength(1);
    // The region moves, but the same streamlines pass: the store stays.
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 6 });
    reader.evaluations.at(-1)!.answer([1n, 2n]);
    await vi.advanceTimersByTimeAsync(150);
    reader.evaluations.at(-1)!.answer([1n, 2n]);
    await vi.advanceTimersByTimeAsync(400);
    expect(reader.reads).toHaveLength(1);
    expect(w.opened).toHaveLength(1);
    // Another streamline passes: a new store.
    groups["updateRoi"](sphereGroup(), "g1r", { radius: 7 });
    await vi.advanceTimersByTimeAsync(150);
    reader.evaluations.at(-1)!.answer([1n, 2n, 3n]);
    await vi.advanceTimersByTimeAsync(400);
    expect(reader.reads).toHaveLength(2);
    expect(reader.reads[1].trk).toBeDefined();
    groups.dispose();
  });

  it("lets the groups' own stores go when switched off, their layers back on the dataset", async () => {
    const { w, groups, reader } = await opened();
    reader.evaluations[0].answer([1n, 2n]);
    await vi.advanceTimersByTimeAsync(400);
    reader.reads[0].answer();
    await settle();
    const spec = () => (w.ng.layers as Json[]).find((l) => l.name === "Group 1")!;
    expect(JSON.stringify(spec().source)).toContain(own(1));
    groups.dispose();
    expect(w.closed).toEqual([own(1)]);
    expect(JSON.stringify(spec().source)).not.toContain("derived-");
    expect(Array.from(w.visible.get("Group 1")!)).toEqual([1n, 2n]);
  });

  it("refuses a download too large to build in memory, before reading, and says what to do", async () => {
    // Ten thousand million points: far past what a download is built from.
    const w = world({ groups: [sphereGroup()], editing: "g1" }, { info: { ...INFO, levels: [{ index: 0, vertexCount: 1e10, chunkShape: [32, 32, 32] }] } });
    const groups = new TrackGroups(w.ctx, w.engines);
    await settle();
    const reader = w.readers[0];
    reader.evaluations[0].answer([1n, 2n, 3n]);
    await settle();
    const reads = reader.reads.length;
    await groups.saveTrk();
    expect(reader.reads).toHaveLength(reads);
    expect(w.toasts.at(-1)?.message).toMatch(/^Could not save Group 1: it would be about [\d.]+ GB, and this browser builds a download in memory \(up to 1\.0 GB\)\. Save it in Chrome or Edge, or use Run on this computer\.$/);
    groups.dispose();
  });

  it("stops building a download past its cap, holding parts as blobs", async () => {
    const target = (await saveTarget("x.trk", "TrackVis tracks", ".trk", 3000))!;
    expect(target.streams).toBe(false);
    const stream = await target.open();
    await stream.write(new ArrayBuffer(1000));
    await stream.write(new ArrayBuffer(1500));
    await expect(stream.write(new ArrayBuffer(1000))).rejects.toThrow(/builds a download in memory/);
    expect(DOWNLOAD_BYTES).toBe(2 ** 30);
  });
});
