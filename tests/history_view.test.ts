import { describe, expect, it } from "vitest";
import { StateHistory } from "../src/core/history.js";
import { nodeText, type ViewRow, viewRows } from "../src/ui/history_view.js";

const show = (rows: ViewRow[]) => rows.map((r) => "  ".repeat(r.depth) + (r.kind === "fold" ? `↳ ${r.count} (${r.open ? "open" : "shut"})` : `${r.node.label}${r.node.state === "current" ? " ●" : r.node.state === "branch" ? " ·" : ""}`));

/** a → b → c ; a → x → y (current) ; x → z. */
function tree(): StateHistory {
  let clock = 0;
  const h = new StateHistory(400, () => ++clock);
  const go = (s: string | undefined) => s !== undefined && h.record(s);
  for (const s of ["a", "b", "c"]) h.record(s, { label: s, scene: "Scene 1", datasets: s === "b" ? ["SRB 2026a"] : [] });
  go(h.move(-2));
  h.record("x", { label: "x", scene: "Scene 2" });
  h.record("z", "z");
  go(h.undo());
  h.record("y", { label: "y", scene: "Scene 2", datasets: ["SRB 2026a"] });
  return h;
}

describe("the history view", () => {
  it("shows the current path, newest first, with other branches folded above where they start", () => {
    const h = tree();
    const nodes = h.tree();
    expect(show(viewRows(nodes, new Set()))).toEqual(["y ●", "↳ 1 (shut)", "x", "↳ 2 (shut)", "a"]);
    const a = nodes.find((n) => n.label === "a")!.id;
    const x = nodes.find((n) => n.label === "x")!.id;
    expect(show(viewRows(nodes, new Set([a, x])))).toEqual(["y ●", "↳ 1 (open)", "  z ·", "x", "↳ 2 (open)", "  c ·", "  b ·", "a"]);
  });

  it("filters by scene or dataset across every branch", () => {
    const nodes = tree().tree();
    expect(show(viewRows(nodes, new Set(), { scene: "Scene 2" }))).toEqual(["y ●", "x"]);
    expect(show(viewRows(nodes, new Set(), { dataset: "SRB 2026a" }))).toEqual(["y ●", "b ·"]);
  });

  it("names a change by scene, and by the datasets its words do not name", () => {
    const node = { id: 1, parent: undefined, children: [], next: undefined, time: 0, state: "current" as const };
    expect(nodeText({ ...node, label: "SRB 2026a: colour map viridis", scene: "Scene 2", datasets: ["SRB 2026a"] }, true)).toEqual({ text: "Scene 2 · SRB 2026a: colour map viridis", datasets: [] });
    expect(nodeText({ ...node, label: "SRB (view): opacity", scene: "Scene 2", datasets: ["SRB 2026a"] }, false)).toEqual({ text: "SRB (view): opacity", datasets: ["SRB 2026a"] });
  });
});
