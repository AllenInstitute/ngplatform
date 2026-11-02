/** SWC and point-table parsing. */
import { describe, expect, it } from "vitest";
import { parsePointTable, parseSwc } from "./point_files.js";

describe("point and skeleton files", () => {
  it("reads SWC nodes and refuses broken trees", () => {
    const nodes = parseSwc("# a neuron\n1 1 0 0 0 5 -1\n2 3 10 0 0 1 1\n3 3 10 10 0 0.5 2\n");
    expect(nodes.map((n) => [n.id, n.type, n.parent])).toEqual([[1, 1, -1], [2, 3, 1], [3, 3, 2]]);
    expect(nodes[2].position).toEqual([10, 10, 0]);
    // A parent not in the file makes a root; short lines are skipped (as zarr-vectors-tools does).
    expect(parseSwc("1 1 0 0 0 5 7\n2 3\n")[0].parent).toBe(-1);
    expect(() => parseSwc("1 1 0 0 0 5 -1\n1 1 0 0 0 5 -1\n")).toThrow(/twice/);
    expect(() => parseSwc("# nothing\n")).toThrow(/without nodes/);
  });

  it("reads point tables with and without headers, by name or by order", () => {
    const a = parsePointTable("id,Z,y,x,cell_type,score\n1,3,2,1,neuron,0.5\n2,6,5,4,glia,0.25\n");
    expect(Array.from(a.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.columns.map((c) => c.name)).toEqual(["id", "score"]);
    const b = parsePointTable("1.5 2 3\n4 5 6\n");
    expect(Array.from(b.positions)).toEqual([1.5, 2, 3, 4, 5, 6]);
    const c = parsePointTable("x\ty\tz\tintensity\n1\t2\t3\t9\n");
    expect(c.columns).toEqual([{ name: "intensity", values: Float32Array.of(9) }]);
    expect(parsePointTable("x_um,y_um,z_um\n1,2,3\n").unit).toBe("micrometer");
    expect(parsePointTable("1 2 3 4\n").columns[0].name).toBe("col3");
  });
});
