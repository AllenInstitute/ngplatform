/**
 * Regions in the views (the in-view tools): each shown region is a shape
 * with handles; dragging one writes what its sliders write (quietly while
 * moving, one change when let go); a new region starts where the user is
 * looking and is selected; its floating card sets AND/OR/NOT, exact
 * numbers and deletes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeDom, fakeDocument } from "@ngplatform/sdk/testing";
import type { ViewShape } from "@ngplatform/sdk";
import { type Saved, TrackGroups } from "../plugin.js";
import { sphereGroup, world } from "./fake_context.js";

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("regions in the views", () => {
  let dom: FakeDom;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = fakeDocument();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  async function shown(saved: Partial<Saved>) {
    const w = world(saved);
    const groups = new TrackGroups(w.ctx, w.engines);
    await settle();
    return { w, groups };
  }

  it("draws each region of the group being edited as a shape in its colour", async () => {
    const box = { id: "b1", shape: "box" as const, center: [1, 2, 3] as [number, number, number], radius: 5, size: [2, 4, 6] as [number, number, number], op: "not" as const };
    const group = { ...sphereGroup(), rois: [...sphereGroup().rois, box] };
    const { w, groups } = await shown({ groups: [group], editing: "g1" });
    const sphere = w.views.shapes.get("g1r") as Extract<ViewShape, { kind: "sphere" }>;
    expect(sphere).toMatchObject({ kind: "sphere", centre: [0, 0, 0], radii: [5, 5, 5], uniform: true, colour: "#e4572e", label: "Sphere 1 · Group 1" });
    expect(w.views.shapes.get("b1")).toMatchObject({ kind: "box", lower: [0, 0, 0], upper: [2, 4, 6], label: "Box 2 · Group 1" });
    groups.dispose();
    expect(w.views.shapes.size).toBe(0);
  });

  it("writes a drag as the sliders do: quietly while moving, one change when let go", async () => {
    const { w, groups } = await shown({ groups: [sphereGroup()], editing: "g1" });
    const writes = w.writes.length;
    w.views.drag("g1r", { centre: [3, 4, 5], radii: [7, 7, 7] }, false);
    expect(w.writes.length).toBe(writes);
    w.views.drag("g1r", { centre: [3, 4, 6], radii: [8, 8, 8] }, true);
    expect(w.writes.length).toBe(writes + 1);
    expect(w.writes.at(-1)!.groups[0].rois[0]).toMatchObject({ center: [3, 4, 6], radius: 8 });
    groups.dispose();
  });

  it("starts a new region where the user is looking, selected", async () => {
    const { w, groups } = await shown({ groups: [sphereGroup()], editing: "g1" });
    w.views.looking = [10, 20, 30];
    groups.addBox();
    const roi = w.writes.at(-1)!.groups[0].rois.at(-1)!;
    expect(roi.center).toEqual([10, 20, 30]);
    expect(w.views.selected()).toBe(roi.id);
    expect(w.views.shapes.get(roi.id)?.kind).toBe("box");
    groups.dispose();
  });

  it("has a card with the region's operator, exact values and Delete", async () => {
    const { w, groups } = await shown({ groups: [sphereGroup()], editing: "g1" });
    const host = dom.host();
    const shape = w.views.shapes.get("g1r")!;
    const dispose = shape.card!(host) as () => void;
    dom.type(host.querySelector("select") as unknown as HTMLInputElement, "not");
    expect(w.writes.at(-1)!.groups[0].rois[0].op).toBe("not");
    const radius = host.querySelector<HTMLInputElement>('input[aria-label="Radius"]')!;
    dom.type(radius, "9");
    expect(w.writes.at(-1)!.groups[0].rois[0].radius).toBe(9);
    // The card follows a drag.
    w.views.drag("g1r", { centre: [1, 1, 1], radii: [4, 4, 4] }, true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="x"]')!.value).toBe("1");
    dom.find(host, "button", "Delete").click();
    expect(w.writes.at(-1)!.groups[0].rois).toEqual([]);
    expect(w.views.shapes.has("g1r")).toBe(false);
    dispose();
    groups.dispose();
  });
});
