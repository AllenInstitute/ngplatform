import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { graph, members, readCollection, resolvePath, transformMatrix } from "../collection.js";

const example = JSON.parse(readFileSync(new URL("../examples/srb_gallery.json", import.meta.url), "utf8"));

describe("OME-Zarr collections (RFC-8 draft)", () => {
  it("reads the tree, its members and where the collection places them", () => {
    const root = readCollection(example, "https://example.org/data/srb_gallery.json");
    expect(root.name).toBe("srb_gallery");
    expect(root.systems[0]).toEqual({ id: "gallery", name: "Gallery", axes: ["z", "y", "x"], units: ["micrometer", "micrometer", "micrometer"] });
    const m = members(root);
    expect(m.map((x) => x.node.name)).toEqual(["SRB 2026a", "SRB 2026a, moved right", "SRB 2026a, mirrored left to right"]);
    expect(m[0].placement).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // The scene system's axes are z, y, x: a translation [0, 0, 170000] is 170 000 along x.
    expect(m[1].placement).toEqual([1, 0, 0, 170000, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // Scale, then translate: x mirrored and moved.
    expect(m[2].placement).toEqual([-1, 0, 0, 340000, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(graph(root).transforms.map((t) => `${t.input}→${t.output} ${t.type}`)).toEqual(["srb-left→gallery identity", "srb-middle→gallery translation", "srb-right→gallery sequence"]);
  });

  it("resolves relative paths against the document, and composes affines on x, y, z", () => {
    expect(resolvePath("./image.ome.zarr", "https://example.org/data/c.json")).toBe("https://example.org/data/image.ome.zarr");
    expect(resolvePath("../gallery.json", "https://example.org/data/c.json")).toBe("https://example.org/gallery.json");
    const a = transformMatrix({ type: "affine", affine: [[2, 0, 0, 1], [0, 3, 0, 2], [0, 0, 4, 3]] }, ["z", "y", "x"]);
    // Rows and columns in z, y, x order, as x, y, z.
    expect(a).toEqual([4, 0, 0, 3, 0, 3, 0, 2, 0, 0, 2, 1, 0, 0, 0, 1]);
    expect(transformMatrix({ type: "displacements" })).toBeUndefined();
    expect(() => readCollection({ hello: 1 }, "https://x/")).toThrow(/not an OME collection/);
  });
});
