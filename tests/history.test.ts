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
