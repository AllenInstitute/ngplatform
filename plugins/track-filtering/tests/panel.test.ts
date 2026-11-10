/**
 * The Filtering panel, drawn into the SDK's stand-in document: its cards
 * and shared controls, its empty state, choosing a group without an undo
 * step, + Sphere with no group as one change, updating in place, tags kept
 * or left out, and letting go when disposed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import { TrackGroups } from "../plugin.js";
import { sphereGroup, world } from "./fake_context.js";

const settle = () => vi.advanceTimersByTimeAsync(0);

/** The elements under `root` matching `selector`, as an array. */
const all = <E extends HTMLElement = HTMLElement>(root: Element, selector: string) => [...root.querySelectorAll(selector)] as E[];

describe("the Filtering panel", () => {
  let dom: FakeDom;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = fakeDocument();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  async function shown(...args: Parameters<typeof world>) {
    const w = world(...args);
    const groups = new TrackGroups(w.ctx, w.engines);
    await settle();
    const host = dom.host();
    const dispose = groups.render(host);
    const card = (title: string) => all<HTMLDetailsElement>(host, "details.card").find((c) => dom.text(c.querySelector(".card-title")!) === title)!;
    return { w, groups, host, dispose, card };
  }

  it("offers to open data when the scene has nothing to filter", async () => {
    const { w, host, groups } = await shown({}, { data: false });
    expect(dom.text(host)).toBe("Nothing to filter in this scene. Open data…");
    dom.find(host, "button", "Open data…").click();
    expect(w.ctx.commands.invoke).toHaveBeenCalledWith("dataset.add");
    groups.dispose();
  });

  it("is cards of the shared controls, with every on/off control the SDK's", async () => {
    const { host, card, groups } = await shown({ groups: [sphereGroup()], editing: "g1" });
    const visible = all(host, "details.card").filter((c) => !c.hidden);
    expect(visible.map((c) => dom.text(c.querySelector(".card-title")!))).toEqual(["Dataset", "Groups", "Regions", "Attributes", "Output", "Statistics"]);
    // No tags in this store: no Stored groups card.
    expect(card("Stored groups").hidden).toBe(true);
    const boxes = all(host, "input[type=checkbox]");
    expect(boxes.length).toBe(2);
    for (const box of boxes) expect((box.parentNode as Element).className).toBe("choice");
    expect(all(host, "[style]")).toEqual([]);
    // A region: its values as the shared slider, no Apply (a typed value applies on Enter or leaving it).
    const region = host.querySelector(".tf-roi")!;
    expect(region.querySelectorAll(".slider").length).toBe(4);
    expect(() => dom.find(region, "button", "Apply")).toThrow();
    groups.dispose();
  });

  it("chooses a group by its row without writing the state", async () => {
    const { w, host, groups } = await shown({ groups: [sphereGroup("g1", "Group 1"), sphereGroup("g2", "Group 2")], editing: "g1" });
    const rows = () => all(host, ".ds-row");
    expect(rows().map((r) => r.className)).toEqual(["ds-row selected", "ds-row"]);
    const writes = w.writes.length;
    rows()[1].click();
    expect(w.writes.length).toBe(writes);
    expect(rows().map((r) => r.className)).toEqual(["ds-row", "ds-row selected"]);
    // Its regions are the ones shown.
    expect(dom.text(host.querySelector(".tf-roi")!)).toContain("Sphere 1");
    // Ticking a group's Show does not choose it.
    dom.check(rows()[0].querySelector<HTMLInputElement>("input[type=checkbox]")!, false);
    expect(rows().map((r) => r.className)).toEqual(["ds-row", "ds-row selected"]);
    expect((w.ng.layers as { name: string; visible?: boolean }[]).find((l) => l.name === "Group 1")?.visible).toBe(false);
    groups.dispose();
  });

  it("makes a group with its sphere in one change when there is none", async () => {
    const { w, host, card, groups } = await shown();
    expect(dom.text(card("Groups").querySelector(".empty-state")!)).toBe("No groups yet. New group");
    dom.find(host, "button", "+ Sphere").click();
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0].groups).toHaveLength(1);
    expect(w.writes[0].groups[0]).toMatchObject({ name: "Group 1", layer: "Group 1" });
    expect(w.writes[0].groups[0].rois.map((r) => r.shape)).toEqual(["sphere"]);
    expect(w.addLayer).toHaveBeenCalledTimes(1);
    expect(w.addLayer.mock.calls[0][2]).toEqual({ quiet: true });
    groups.dispose();
  });

  it("updates in place: an answer redraws nothing, and a value being typed is kept", async () => {
    const { w, host, groups } = await shown({ groups: [sphereGroup()], editing: "g1" });
    const x = host.querySelector(".tf-roi")!.querySelector<HTMLInputElement>("input[type=number]")!;
    const status = host.querySelector<HTMLElement>(".status-line")!;
    expect(dom.text(status)).toBe("Counting…");
    w.readers[0].evaluations[0].answer([1n, 2n]);
    await settle();
    expect(status.hidden).toBe(true);
    expect(dom.text(host.querySelector(".ds-row")!)).toContain("2");
    expect(host.querySelector(".tf-roi")!.querySelector("input[type=number]")).toBe(x);
    // Typing 12 while an undo puts the region back: the box keeps what is typed until it is left.
    x.focus();
    x.value = "12";
    w.setState({ groups: [{ ...sphereGroup(), rois: [{ ...sphereGroup().rois[0], center: [3, 0, 0] }] }], editing: "g1" });
    expect(x.value).toBe("12");
    dom.fire(x, "change");
    x.blur();
    expect(groups["saved"].groups[0].rois[0].center).toEqual([12, 0, 0]);
    expect(host.querySelector(".tf-roi")!.querySelector("input[type=number]")).toBe(x);
    groups.dispose();
  });

  it("keeps or leaves out a stored group's objects", async () => {
    const { w, card, groups } = await shown({ groups: [sphereGroup()], editing: "g1" }, { tags: true });
    const tags = card("Stored groups");
    expect(tags.hidden).toBe(false);
    tags.open = true;
    dom.fire(tags, "toggle");
    const rows = all(tags, ".tf-tag");
    expect(rows.map((r) => dom.text(r.querySelector(".tf-name")!))).toEqual(["left", "short"]);
    // Counts over every object until the group has an answer.
    expect(rows.map((r) => dom.text(r.querySelector(".readout")!))).toEqual(["3", "1"]);
    const short = rows[1].querySelector<HTMLSelectElement>("select")!;
    short.value = "out";
    dom.fire(short, "change");
    expect(w.writes.at(-1)!.groups[0].filter).toMatchObject({ includeTags: [], excludeTags: ["short"] });
    const left = rows[0].querySelector<HTMLSelectElement>("select")!;
    left.value = "keep";
    dom.fire(left, "change");
    expect(w.writes.at(-1)!.groups[0].filter).toMatchObject({ includeTags: ["left"], excludeTags: ["short"] });
    expect(dom.text(tags.querySelector(".card-badge")!)).toBe("2 set");
    // Back to either.
    short.value = "";
    dom.fire(short, "change");
    expect(w.writes.at(-1)!.groups[0].filter).toMatchObject({ includeTags: ["left"], excludeTags: [] });
    groups.dispose();
  });

  it("offers CSV only once the answer is exact", async () => {
    const { w, host, groups } = await shown({ groups: [sphereGroup()], editing: "g1" });
    const csv = dom.find<HTMLButtonElement>(host, "button", "Export CSV");
    expect(csv.disabled).toBe(true);
    w.readers[0].evaluations[0].answer([1n]);
    await settle();
    expect(csv.disabled).toBe(false);
    groups.dispose();
  });

  it("lets go of the panel when it is disposed: later answers draw nothing", async () => {
    const { w, host, dispose, groups } = await shown({ groups: [sphereGroup()], editing: "g1" });
    const before = dom.text(host);
    dispose();
    expect(groups["parts"].size).toBe(0);
    w.readers[0].evaluations[0].answer([1n]);
    await settle();
    expect(dom.text(host)).toBe(before);
    groups.dispose();
  });
});
