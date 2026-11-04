import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StateHistory } from "../src/core/history.js";

/** The default workspace (the SRB example) as the store serialises it. */
const DEFAULT = readFileSync(new URL("./testdata/history/default_workspace.json", import.meta.url), "utf8");

const labels = (h: StateHistory) => h.rows().map((r) => r.label);

/** Records `snapshot` as a step labelled by itself. */
const step = (h: StateHistory, snapshot: string) => h.record(snapshot, snapshot);

/** Restores like the store: the snapshot handed back is recorded (adopted). */
const restore = (h: StateHistory, snapshot: string | undefined) => {
  if (snapshot !== undefined) h.record(snapshot);
  return snapshot;
};

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

  it("does not make identical states steps", () => {
    const h = new StateHistory();
    h.record("a");
    expect(h.record("a")).toBe(false);
    expect(h.tree()).toHaveLength(1);
  });

  it("keeps at most its limit of states", () => {
    const h = new StateHistory(4);
    for (const s of ["1", "2", "3", "4", "5"]) h.record(s);
    let steps = 0;
    while (h.undo() !== undefined) {
      steps++;
      h.settle();
    }
    expect(steps).toBe(3);
    expect(h.tree()).toHaveLength(4);
  });
});

describe("the history tree", () => {
  it("starts a branch for a change made after going back, keeping the old future", () => {
    const h = new StateHistory();
    for (const s of ["a", "b", "c"]) step(h, s);
    restore(h, h.move(-2)); // back to a
    expect(step(h, "x")).toBe(true);
    expect(labels(h)).toEqual(["a", "x"]);
    const tree = h.tree();
    expect(tree.map((n) => `${n.label}:${n.state}`)).toEqual(["a:done", "b:branch", "c:branch", "x:current"]);
    expect(tree[0].children).toHaveLength(2);
    // Nothing to redo from the new change; undo goes to its parent.
    expect(h.canRedo).toBe(false);
    expect(restore(h, h.undo())).toBe("a");
    // Redo follows the branch last visited: the new one.
    expect(restore(h, h.redo())).toBe("x");
  });

  it("redoes along the branch last visited, as Vim's undo tree", () => {
    const h = new StateHistory();
    for (const s of ["a", "b", "c"]) step(h, s);
    restore(h, h.move(-2));
    step(h, "x");
    // Jump to c on the old branch, then go back to a: redo now leads to b, then c.
    expect(restore(h, h.jump(h.tree().find((n) => n.label === "c")!.id))).toBe("c");
    expect(labels(h)).toEqual(["a", "b", "c"]);
    restore(h, h.move(-2));
    expect(restore(h, h.redo())).toBe("b");
    expect(restore(h, h.redo())).toBe("c");
    expect(h.ends()).toEqual({ undo: { label: "c", time: expect.any(Number) }, redo: undefined });
  });

  it("jumps to any node, restoring its state", () => {
    const h = new StateHistory();
    for (const s of ["a", "b"]) step(h, s);
    restore(h, h.undo());
    step(h, "x");
    step(h, "y");
    restore(h, h.move(-2));
    step(h, "z");
    // a → b ; a → x → y ; a → z (current)
    const id = (label: string) => h.tree().find((n) => n.label === label)!.id;
    expect(h.jump(id("z"))).toBeUndefined(); // already there
    expect(restore(h, h.jump(id("y")))).toBe("y");
    expect(h.tree().find((n) => n.label === "y")!.state).toBe("current");
    expect(h.tree().find((n) => n.label === "z")!.state).toBe("branch");
    expect(labels(h)).toEqual(["a", "x", "y"]);
    expect(restore(h, h.jump(id("b")))).toBe("b");
    expect(h.snapshot(id("y"))).toBe("y");
  });

  it("moves between sibling branches at the nearest fork", () => {
    const h = new StateHistory();
    step(h, "a");
    step(h, "b");
    step(h, "b2");
    restore(h, h.move(-2));
    step(h, "x");
    restore(h, h.undo());
    step(h, "z");
    // a has three branches, in the order made: b, x, z.  From z:
    expect(h.canSwitchBranch(1)).toBe(false);
    expect(restore(h, h.switchBranch(-1))).toBe("x");
    expect(restore(h, h.switchBranch(-1))).toBe("b");
    expect(h.switchBranch(-1)).toBeUndefined();
    // From deeper in a branch, the nearest fork above is used.
    restore(h, h.redo());
    expect(h.rows().at(-1)!.label).toBe("b2");
    expect(restore(h, h.switchBranch(1))).toBe("x");
  });

  it("keeps the old rows API as the current path", () => {
    let clock = 1000;
    const h = new StateHistory(400, () => clock);
    h.record("a", "Opened");
    clock = 2000;
    h.record("b", "Layout: 3d");
    clock = 3000;
    h.record("c", "Hid SRB");
    expect(h.rows().map((r) => `${r.label}@${r.time}:${r.state}`)).toEqual(["Opened@1000:done", "Layout: 3d@2000:done", "Hid SRB@3000:current"]);
    expect(h.move(-2)).toBe("a");
    h.record("a");
    expect(h.rows().map((r) => r.state)).toEqual(["current", "undone", "undone"]);
    expect(h.move(1)).toBe("b");
    h.record("b");
    expect(h.ends()).toEqual({ undo: { label: "Layout: 3d", time: 2000 }, redo: { label: "Hid SRB", time: 3000 } });
    clock = 4000;
    h.record("d", "Moved");
    expect(h.rows().map((r) => r.label)).toEqual(["Opened", "Layout: 3d", "Moved"]);
    expect(h.ends()).toEqual({ undo: { label: "Moved", time: 4000 }, redo: undefined });
    h.move(-2);
    expect(h.ends()).toEqual({ undo: undefined, redo: { label: "Layout: 3d", time: 2000 } });
  });

  it("keeps the scene and datasets of each step", () => {
    const h = new StateHistory();
    h.record("a", "Opened");
    h.record("b", { label: "SRB 2026a: colour map viridis", scene: "Scene 2", datasets: ["SRB 2026a"] });
    expect(h.tree()[1]).toMatchObject({ label: "SRB 2026a: colour map viridis", scene: "Scene 2", datasets: ["SRB 2026a"] });
  });
});

describe("pruning", () => {
  it("drops the oldest leaves off the current path first, never the path", () => {
    let clock = 0;
    const h = new StateHistory(6, () => ++clock);
    for (const s of ["a", "b", "c"]) step(h, s);
    restore(h, h.move(-2)); // a
    for (const s of ["x", "y", "z"]) step(h, s); // 6 nodes: a, b, c, x, y, z
    expect(h.tree()).toHaveLength(6);
    step(h, "w"); // 7: the oldest removable is c (a leaf off the path)
    expect(h.tree().map((n) => n.label)).toEqual(["a", "b", "x", "y", "z", "w"]);
    step(h, "v"); // then b
    expect(h.tree().map((n) => n.label)).toEqual(["a", "x", "y", "z", "w", "v"]);
    step(h, "u"); // then the root, now with one child
    expect(h.tree().map((n) => n.label)).toEqual(["x", "y", "z", "w", "v", "u"]);
    expect(h.rows().map((r) => r.label)).toEqual(["x", "y", "z", "w", "v", "u"]);
  });

  it("turns the old future into a branch, which goes oldest first like any other", () => {
    let clock = 0;
    const h = new StateHistory(4, () => ++clock);
    for (const s of ["a", "b", "c", "d"]) step(h, s);
    restore(h, h.move(-2)); // at b, with c and d undone
    h.replaceCurrent("b2");
    expect(h.tree().map((n) => n.label)).toEqual(["a", "b", "c", "d"]);
    step(h, "x"); // the old future becomes a branch; the oldest removable, a (the root), goes first
    expect(h.tree().map((n) => n.label)).toEqual(["b", "c", "d", "x"]);
    expect(h.snapshot(h.tree()[0].id)).toBe("b2");
  });

  it("drops states past the size limit", () => {
    const h = new StateHistory(400, Date.now, 2000);
    for (let i = 0; i < 50; i++) h.record(JSON.stringify({ i, text: "x".repeat(100) + i }));
    expect(h.stats().stored).toBeLessThanOrEqual(2000);
    expect(h.tree().length).toBeLessThan(50);
    expect(h.canUndo).toBe(true);
  });
});

describe("storage", () => {
  /** n changes of the default workspace, as a user makes them: moves, layer settings, visibility, layout. */
  function changes(n: number): string[] {
    const base = JSON.parse(DEFAULT);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const ws = structuredClone(base);
      const layer = ws.ng.layers[i % ws.ng.layers.length];
      switch (i % 4) {
        case 0:
          base.ng.position = [i, -15, 10];
          break;
        case 1:
          layer.opacity = (i % 10) / 10;
          base.ng.layers[i % ws.ng.layers.length] = layer;
          break;
        case 2:
          layer.visible = i % 8 !== 2;
          base.ng.layers[i % ws.ng.layers.length] = layer;
          break;
        default:
          base.ng.layout = ["xy", "3d", "4panel"][i % 3];
      }
      out.push(JSON.stringify(base));
    }
    return out;
  }

  it("restores every state exactly", () => {
    const h = new StateHistory();
    const states = changes(60);
    for (const s of states) h.record(s);
    const tree = h.tree();
    expect(tree.map((n) => h.snapshot(n.id))).toEqual(states);
  });

  it("stores 400 states of the default workspace in a small part of their size", () => {
    const h = new StateHistory();
    const states = changes(400);
    for (const s of states) h.record(s);
    const raw = states.reduce((sum, s) => sum + s.length, 0);
    const { stored, nodes } = h.stats();
    expect(nodes).toBe(400);
    // Measured: about 2.3 MB raw, about 0.1 MB stored (each state about 5.7 KB, a change a few hundred bytes).
    expect(raw).toBeGreaterThan(2_000_000);
    expect(stored).toBeLessThan(raw / 10);
  });

  it("frees the pieces of pruned states", () => {
    const h = new StateHistory(20);
    for (const s of changes(300)) h.record(s);
    const fresh = new StateHistory(20);
    for (const s of changes(300).slice(-20)) fresh.record(s);
    expect(h.stats().pieces).toBe(fresh.stats().pieces);
  });

  it("exports and imports the tree", () => {
    const h = new StateHistory();
    const states = changes(12);
    for (const s of states.slice(0, 8)) h.record(s, { label: "step", scene: "Scene 1", datasets: ["SRB 2026a"] });
    restore(h, h.move(-3));
    for (const s of states.slice(8)) h.record(s);
    const data = JSON.parse(JSON.stringify(h.export()));
    const back = StateHistory.import(data)!;
    expect(back.tree()).toEqual(h.tree());
    expect(back.stats()).toEqual(h.stats());
    for (const n of h.tree()) expect(back.snapshot(n.id)).toBe(h.snapshot(n.id));
    // It goes on as before: undo, and a new step gets a fresh id.
    expect(back.undo()).toBe(h.undo());
    back.record(states[0]);
    back.record("{}");
    expect(new Set(back.tree().map((n) => n.id)).size).toBe(back.tree().length);
    expect(StateHistory.import({ version: 2 } as never)).toBeUndefined();
  });
});
