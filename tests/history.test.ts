import { describe, expect, it } from "vitest";
import { StateHistory } from "../src/core/history.js";

describe("StateHistory", () => {
  it("undoes and redoes settled states", () => {
    const h = new StateHistory();
    h.record("a");
    h.record("b");
    h.record("c");
    expect(h.undo()).toBe("b");
    h.record("b"); // restoring b re-serialises it
    expect(h.undo()).toBe("a");
    h.record("a");
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toBe("b");
    h.record("b");
    expect(h.redo()).toBe("c");
  });

  it("adopts a restored state that re-serialises differently, keeping redo", () => {
    const h = new StateHistory();
    h.record("a");
    h.record("b");
    expect(h.undo()).toBe("a");
    h.record("a-normalised");
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe("b");
  });

  it("a new edit clears redo, and identical states are not steps", () => {
    const h = new StateHistory();
    h.record("a");
    expect(h.record("a")).toBe(false);
    h.record("b");
    h.undo();
    h.record("a");
    h.record("c");
    expect(h.canRedo).toBe(false);
  });

  it("keeps at most its limit", () => {
    const h = new StateHistory(3);
    for (const s of ["1", "2", "3", "4", "5"]) h.record(s);
    let steps = 0;
    while (h.undo() !== undefined) {
      steps++;
      h.settle();
    }
    expect(steps).toBe(3);
  });
});

describe("the history menu", () => {
  it("keeps what and when for each change, and moves several steps at once", () => {
    let clock = 1000;
    const h = new StateHistory(200, () => clock);
    h.record("a", "Opened");
    clock = 2000;
    h.record("b", "Layout: 3d");
    clock = 3000;
    h.record("c", "Hid SRB");
    expect(h.rows().map((r) => `${r.label}@${r.time}:${r.state}`)).toEqual(["Opened@1000:done", "Layout: 3d@2000:done", "Hid SRB@3000:current"]);
    expect(h.move(-2)).toBe("a");
    h.record("a"); // the restored state is adopted, not a new step
    expect(h.rows().map((r) => r.state)).toEqual(["current", "undone", "undone"]);
    expect(h.rows()[1].label).toBe("Layout: 3d");
    expect(h.move(1)).toBe("b");
    h.record("b");
    expect(h.rows().map((r) => r.state)).toEqual(["done", "current", "undone"]);
    expect(h.ends()).toEqual({ undo: { label: "Layout: 3d", time: 2000 }, redo: { label: "Hid SRB", time: 3000 } });
    // A new change drops what was undone.
    clock = 4000;
    h.record("d", "Moved");
    expect(h.rows().map((r) => r.label)).toEqual(["Opened", "Layout: 3d", "Moved"]);
    expect(h.ends()).toEqual({ undo: { label: "Moved", time: 4000 }, redo: undefined });
    h.move(-2);
    expect(h.ends()).toEqual({ undo: undefined, redo: { label: "Layout: 3d", time: 2000 } });
  });
});
