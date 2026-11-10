/**
 * Undo steps, against the workspace store itself: a region that makes its
 * group is one step, and choosing which group to edit is none.
 */
import { describe, expect, it } from "vitest";
import { readSaved, TrackGroups } from "../plugin.js";
import { wait, workspace } from "./workspace.js";

describe("track groups' undo steps", () => {
  it("makes a group, its region and its layer in one step when + Sphere has no group to go in", async () => {
    const { engine, store, ctx } = workspace();
    await wait();
    const groups = new TrackGroups(ctx);
    const steps = store.historyRows().length;
    store.noteInput();
    groups.addSphere();
    await wait(20);
    expect(store.historyRows().length).toBe(steps + 1);
    const saved = readSaved(ctx.state.get());
    expect(saved.groups).toHaveLength(1);
    expect(saved.groups[0]).toMatchObject({ name: "Group 1", layer: "Group 1" });
    expect(saved.groups[0].rois.map((r) => r.shape)).toEqual(["sphere"]);
    expect(engine.layerSpec("Group 1")).toBeDefined();
    // One undo takes all of it away.
    expect(store.undo()).toBe(true);
    await wait(20);
    expect(readSaved(ctx.state.get()).groups).toEqual([]);
    expect(engine.layerSpec("Group 1")).toBeUndefined();
    groups.dispose();
  });

  it("does not make choosing a group to edit a step: the choice goes with the next change", async () => {
    const { store, ctx } = workspace();
    await wait();
    const groups = new TrackGroups(ctx);
    store.noteInput();
    groups.addSphere();
    await wait(20);
    store.noteInput();
    groups.newGroup();
    await wait(20);
    const [first, second] = readSaved(ctx.state.get()).groups;
    expect(readSaved(ctx.state.get()).editing).toBe(second.id);
    const steps = store.historyRows().length;
    store.noteInput();
    groups.selectGroup(first.id);
    await wait(20);
    expect(store.historyRows().length).toBe(steps);
    expect(readSaved(ctx.state.get()).editing).toBe(second.id);
    // The next change is to the group chosen, and records the choice with it.
    store.noteInput();
    groups.addBox();
    await wait(20);
    expect(store.historyRows().length).toBe(steps + 1);
    const saved = readSaved(ctx.state.get());
    expect(saved.editing).toBe(first.id);
    expect(saved.groups[0].rois.map((r) => r.shape)).toEqual(["sphere", "box"]);
    expect(saved.groups[1].rois).toEqual([]);
    // Undoing something else keeps the group chosen here.
    store.noteInput();
    groups.selectGroup(second.id);
    expect(store.undo()).toBe(true);
    await wait(20);
    expect(groups["editing"]()?.id).toBe(second.id);
    groups.dispose();
  });
});
