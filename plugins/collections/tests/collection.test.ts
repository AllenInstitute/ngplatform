import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainInto, collectionFromScene, displayRangeOf, editCollection, fieldWarp, firstLevel, freshId, graph, invert, isCollection, members, parentGroups, placeInto, placementOf, readCollection, resolvePath, sceneSystems, transformJson, transformMatrix, transformSteps, zarrGroupUrl } from "../collection.js";

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

describe("placing members in a chosen coordinate system", () => {
  const doc = {
    ome: {
      type: "collection",
      name: "two spaces",
      attributes: {
        scene: {
          coordinateSystems: [
            { id: "physical", axes: [{ name: "z", unit: "micrometer" }, { name: "y", unit: "micrometer" }, { name: "x", unit: "micrometer" }] },
            { id: "atlas", axes: [{ name: "z", unit: "micrometer" }, { name: "y", unit: "micrometer" }, { name: "x", unit: "micrometer" }] },
          ],
          coordinateTransformations: [
            { type: "translation", translation: [0, 0, 10], input: { id: "a" }, output: { id: "physical" } },
            { type: "scale", scale: [2, 2, 2], input: { id: "atlas" }, output: { id: "physical" } },
          ],
        },
      },
      nodes: [{ type: "multiscale", name: "A", id: "a", path: { type: "zarr", path: "a.ome.zarr" } }],
    },
  };

  it("composes the chain of transforms, walking one backwards as its inverse", () => {
    const root = readCollection(doc, "https://example.org/c/zarr.json");
    const a = root.nodes[0];
    expect(placeInto(root, a, "physical")).toEqual([1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // a → physical (x + 10), then physical → atlas (the inverse of × 2): (x + 10) / 2.
    expect(placeInto(root, a, "atlas")).toEqual([0.5, 0, 0, 5, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]);
    expect(placeInto(root, a, "nowhere")).toBeUndefined();
    expect(sceneSystems(root).map((s) => s.id)).toEqual(["physical", "atlas"]);
    expect(invert([2, 0, 0, 1, 0, 4, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1])).toEqual([0.5, 0, 0, -0.5, 0, 0.25, 0, -0.5, 0, 0, 1, -3, 0, 0, 0, 1]);
  });

  it("looks for a collection in the groups above an image", () => {
    expect(parentGroups("zarr://gs://bucket/study/collection.zarr/images/a.ome.zarr/|zarr2:")).toEqual([
      "https://storage.googleapis.com/bucket/study/collection.zarr/images",
      "https://storage.googleapis.com/bucket/study/collection.zarr",
      "https://storage.googleapis.com/bucket/study",
    ]);
    expect(parentGroups("https://host/a/b.zarr/")).toEqual(["https://host/a"]);
    expect(parentGroups("local://annotations")).toEqual([]);
    expect(isCollection({ zarr_format: 3, attributes: { ome: { type: "collection", nodes: [] } } })).toBe(true);
    expect(isCollection({ zarr_format: 3, attributes: { ome: { multiscales: [] } } })).toBe(false);
  });
});

describe("members warped by a displacement field (RFC-5 displacements)", () => {
  const axes = [{ name: "z", unit: "micrometer" }, { name: "y", unit: "micrometer" }, { name: "x", unit: "micrometer" }];
  const doc = {
    ome: {
      type: "collection",
      name: "warped",
      attributes: {
        scene: {
          coordinateSystems: [
            { id: "physical", axes },
            { id: "atlas", axes },
            { id: "other", axes },
          ],
          coordinateTransformations: [
            { type: "translation", translation: [0, 0, 10], input: { id: "a" }, output: { id: "physical" } },
            // As registration writes it: from the fixed space (atlas) to the moving image's.
            {
              type: "sequence",
              input: { id: "atlas" },
              output: { id: "a" },
              transformations: [{ type: "displacements", path: "coordinateTransformations/swirl" }, { type: "translation", translation: [0, 0, -10] }],
            },
            { type: "displacements", path: "coordinateTransformations/second", input: { id: "atlas" }, output: { id: "other" } },
          ],
        },
      },
      nodes: [{ type: "multiscale", name: "A", id: "a", path: { type: "zarr", path: "a.ome.zarr" } }],
    },
  };
  const root = readCollection(doc, "https://example.org/c.zarr/zarr.json");
  const a = root.nodes[0];

  it("reads a sequence holding a field as steps, its path resolved against the document", () => {
    const t = graph(root).transforms[1];
    expect(transformSteps(t.raw, ["z", "y", "x"], t.document)).toEqual([
      { kind: "field", url: "https://example.org/c.zarr/coordinateTransformations/swirl", inverse: false, components: ["z", "y", "x"] },
      { kind: "affine", m: [1, 0, 0, -10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ]);
    expect(transformSteps({ type: "coordinates", path: "c" }, undefined, t.document)).toEqual([{ kind: "field", url: "https://example.org/c.zarr/c", inverse: false, absolute: true }]);
  });

  it("finds the chain through a field (one at most), which affine placement does not", () => {
    expect(placeInto(root, a, "atlas")).toBeUndefined();
    // a → atlas walks atlas → a backwards: the translation undone, then the field's inverse.
    const steps = chainInto(root, a, "atlas")!;
    expect(steps.map((s) => (s.kind === "field" ? `field${s.inverse ? " inverted" : ""}` : "affine"))).toEqual(["affine", "field inverted"]);
    expect(chainInto(root, a, "physical")).toEqual([{ kind: "affine", m: [1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]);
    // Into "other": through two fields.
    const other = chainInto(root, a, "other")!;
    expect(other.filter((s) => s.kind === "field").length).toBe(2);
  });

  it("shows such a member placed by the chain's affines and resampled back through the chain", () => {
    const shown = fieldWarp(chainInto(root, a, "atlas")!, 1e-3)!;
    expect(shown.placement).toEqual([1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // Back from the atlas to a: q → q + D(q) (the field as written), then x − 10 µm.
    expect(shown.warp).toEqual({
      kind: "field",
      url: "https://example.org/c.zarr/coordinateTransformations/swirl",
      before: [[1, 0, 0, 0.01, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
      after: [[1, 0, 0, -0.01, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
      invert: false,
      components: ["z", "y", "x"],
    });
    // A field walked as written (member to system) is undone by its inverse.
    expect((fieldWarp([{ kind: "field", url: "f", inverse: false }], 1)?.warp as { invert?: boolean }).invert).toBe(true);
    // Two fields: two parts, back from the system, each with the affines before it.
    const two = fieldWarp(
      [
        { kind: "field", url: "f1", inverse: false },
        { kind: "affine", m: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { kind: "field", url: "f2", inverse: true },
      ],
      1,
    )!.warp as { kind: string; parts: { url: string; invert: boolean; before: number[][]; after: number[][] }[] };
    expect(two.kind).toBe("fields");
    expect(two.parts.map((p) => [p.url, p.invert, p.before.length, p.after.length])).toEqual([
      ["f2", false, 1, 0],
      ["f1", true, 1, 0],
    ]);
    expect(two.parts[1].before[0][3]).toBe(-2);
    expect(fieldWarp(chainInto(root, a, "physical")!, 1)).toBeUndefined();
  });

  it("shows a warped copy (float32) with the image's own contrast", () => {
    const group = { attributes: { ome: { multiscales: [{ datasets: [{ path: "0" }] }] } } };
    expect(firstLevel(group)).toBe("0");
    expect(displayRangeOf(group, { data_type: "uint16" })).toEqual([0, 65535]);
    expect(displayRangeOf({ multiscales: [], omero: { channels: [{ window: { start: 10, end: 900 } }] } }, { dtype: "<u2" })).toEqual([10, 900]);
    expect(displayRangeOf(group, { dtype: "|u1" })).toEqual([0, 255]);
    expect(displayRangeOf(group, { data_type: "float32" })).toBeUndefined();
  });
});

describe("coordinate maps", () => {
  it("are applied as written, and not inverted", async () => {
    const { fieldWarp, transformSteps, inverseOf } = await import("../collection.js");
    const doc = "https://example.org/c/zarr.json";
    const coords = { type: "coordinates", path: "map.zarr" };
    const steps = transformSteps(coords, ["z", "y", "x"], doc)!;
    expect(steps).toEqual([{ kind: "field", url: "https://example.org/c/map.zarr", inverse: false, absolute: true, components: ["z", "y", "x"] }]);
    // Written system → member, walked member → system (backwards): shown through the map as written.
    const back = transformSteps(inverseOf(coords), ["z", "y", "x"], doc)!;
    const shown = fieldWarp(back, 1)!.warp as { absolute?: boolean; invert: boolean };
    expect([shown.absolute, shown.invert]).toEqual([true, false]);
    // Written member → system: showing would need its inverse, which is not computed.
    expect(fieldWarp(steps, 1)).toBeUndefined();
  });
});

describe("transforms walked backwards", () => {
  it("use a bijection's stated inverse, alone or inside a sequence", async () => {
    const { inverseOf, transformSteps } = await import("../collection.js");
    const doc = "https://example.org/c/zarr.json";
    const field = (p: string) => ({ type: "displacements", path: p });
    const shift = { type: "translation", translation: [0, 0, 5] };
    const seq = { type: "sequence", transformations: [shift, { type: "bijection", forward: field("fwd.zarr"), inverse: field("inv.zarr") }] };
    const forward = transformSteps(seq, ["z", "y", "x"], doc)!;
    expect(forward.map((s) => (s.kind === "field" ? `field ${s.url.split("/").pop()} ${s.inverse}` : "affine"))).toEqual(["affine", "field fwd.zarr false"]);
    const back = transformSteps(inverseOf(seq), ["z", "y", "x"], doc)!;
    // Backwards: the bijection's own inverse (not the forward field inverted), then the shift undone.
    expect(back.map((s) => (s.kind === "field" ? `field ${s.url.split("/").pop()} ${s.inverse}` : "affine"))).toEqual(["field inv.zarr false", "affine"]);
    expect(back[1].kind === "affine" && back[1].m[3]).toBe(-5);
    // A field with no stated inverse, backwards, is inverted.
    const plain = transformSteps(inverseOf(field("only.zarr")), ["z", "y", "x"], doc)!;
    expect(plain[0].kind === "field" && plain[0].inverse).toBe(true);
    expect(inverseOf(inverseOf(seq))).toEqual(seq);
  });
});

describe("building a collection", () => {
  it("reads the Zarr group a layer's source is", () => {
    expect(zarrGroupUrl("zarr://gs://bucket/a/b.ome.zarr/|zarr3:")).toBe("https://storage.googleapis.com/bucket/a/b.ome.zarr");
    expect(zarrGroupUrl({ url: "zarr://https://host/x.zarr/" })).toBe("https://host/x.zarr");
    expect(zarrGroupUrl("https://host/y.ome.zarr")).toBe("https://host/y.ome.zarr");
    expect(zarrGroupUrl("precomputed://gs://bucket/seg")).toBeUndefined();
    expect(zarrGroupUrl("local://annotations")).toBeUndefined();
    const taken = new Set<string>();
    expect([freshId("SRB 2026a", taken), freshId("SRB 2026a", taken), freshId("!!", taken)]).toEqual(["srb-2026a", "srb-2026a-2", "item"]);
  });

  it("writes a 4 × 4 as the simplest transform, in the system's axis order, and reads it back", () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(transformJson(I)).toEqual({ type: "identity" });
    expect(transformJson([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, -2, 0, 0, 0, 1])).toEqual({ type: "translation", translation: [-2, 0, 5] });
    expect(transformJson([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1])).toEqual({ type: "scale", scale: [4, 3, 2] });
    const rotated = [0, -1, 0, 1, 1, 0, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1];
    const t = transformJson(rotated);
    expect(t.type).toBe("affine");
    expect(transformMatrix(t, ["z", "y", "x"])).toEqual(rotated);
    const s = transformJson([-1, 0, 0, 7, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(transformMatrix(s, ["z", "y", "x"])).toEqual([-1, 0, 0, 7, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("finds where a layer is placed relative to its own placement", () => {
    // Output order z, y, x; the image's own: 0.1 mm voxels; shown moved 5 mm along x.
    const own = [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1];
    const now = [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 5, 0, 0, 0, 1];
    expect(placementOf(now, own, ["z", "y", "x"])).toEqual([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(placementOf(now, own, ["c", "y", "x"])).toBeUndefined();
  });

  it("makes a collection of a scene's images, placed as the scene shows them", () => {
    const doc = collectionFromScene("My scene", { name: "Scene", unit: "micrometer" }, [
      { name: "A", url: "https://host/a.zarr" },
      { name: "B", url: "https://host/b.zarr", placement: [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ]);
    const root = readCollection(doc, "https://example.org/");
    expect(root.name).toBe("My scene");
    expect(sceneSystems(root).map((s) => s.id)).toEqual(["scene"]);
    const m = members(root);
    expect(m.map((x) => x.node.location?.url)).toEqual(["https://host/a.zarr", "https://host/b.zarr"]);
    // 5 mm along x is 5000 µm.
    expect(placeInto(root, m[1].node, "scene")).toEqual([1, 0, 0, 5000, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(placeInto(root, m[0].node, "scene")).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("edits members, systems and transforms, leaving the document given as it was", () => {
    const doc = collectionFromScene("c", { name: "Scene", unit: "micrometer" }, [{ name: "A", url: "https://host/a.zarr" }]);
    let next = editCollection(doc, { op: "addSystem", name: "Atlas", unit: "millimeter" });
    next = editCollection(next, { op: "addMember", name: "A", url: "https://host/a2.zarr" });
    next = editCollection(next, { op: "addTransform", transform: { type: "scale", scale: [1000, 1000, 1000], input: { id: "atlas" }, output: { id: "scene" } } });
    next = editCollection(next, { op: "rename", name: "renamed" });
    let root = readCollection(next, "https://example.org/");
    expect(root.name).toBe("renamed");
    expect(root.nodes.map((n) => n.id)).toEqual(["a", "a-2"]);
    expect(sceneSystems(root).map((s) => `${s.id} ${s.units[0]}`)).toEqual(["scene micrometer", "atlas millimeter"]);
    // A placed in the atlas through the scene: × 1/1000.
    expect(placeInto(root, root.nodes[0], "atlas")?.[0]).toBeCloseTo(0.001);
    expect(readCollection(doc, "https://example.org/").nodes).toHaveLength(1);
    next = editCollection(next, { op: "removeMember", id: "a" });
    root = readCollection(next, "https://example.org/");
    expect(root.nodes.map((n) => n.id)).toEqual(["a-2"]);
    expect(root.transforms.map((t) => `${t.input}→${t.output}`)).toEqual(["atlas→scene"]);
    next = editCollection(next, { op: "removeSystem", id: "atlas" });
    expect(readCollection(next, "https://example.org/").transforms).toEqual([]);
    next = editCollection(next, { op: "addTransform", transform: { type: "identity", input: { id: "a-2" }, output: { id: "scene" } } });
    next = editCollection(next, { op: "setTransform", index: 0, transform: { type: "translation", translation: [0, 0, 1], input: { id: "a-2" }, output: { id: "scene" } } });
    expect(readCollection(next, "https://example.org/").transforms[0].type).toBe("translation");
    next = editCollection(next, { op: "removeTransform", index: 0 });
    expect(readCollection(next, "https://example.org/").transforms).toEqual([]);
  });

  it("edits the example where it keeps its transforms", () => {
    const next = editCollection(example, { op: "removeTransform", index: 1 });
    expect(readCollection(next, "https://example.org/").transforms.map((t) => t.input)).toEqual(["srb-left", "srb-right"]);
    expect(example.ome.attributes.scene.coordinateTransformations).toHaveLength(3);
  });
});
