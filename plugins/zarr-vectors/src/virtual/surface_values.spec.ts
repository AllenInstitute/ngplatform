/**
 * Values on surface vertices: every file of the small FreeSurfer subject in
 * testdata/meshes/subject reads as nibabel reads it (morphometry in both
 * formats, MGH and MGZ overlays, GIFTI shape and label arrays, annotations
 * with either colour table, labels); the files beside a surface are found
 * by name, and checked by their vertex count.
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  combineLabels,
  parseAnnot,
  parseGiftiValues,
  parseLabelVertices,
  parseMghValues,
  parseMorph,
} from "../../../../src/virtual/vectors/surface_values.js";
import { surfaceCompanions, surfaceRelated } from "../../../../src/virtual/vectors/surfaces.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/meshes/subject");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const bytes = (name: string) => new Uint8Array(fs.readFileSync(path.join(DIR, name)));
const gunzip = (b: Uint8Array) => new Uint8Array(gunzipSync(b));

function close(got: ArrayLike<number>, want: number[]) {
  expect(got.length).toBe(want.length);
  want.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 5));
}

function sameLabels(got: { code: number; name: string; rgba: number[] }[] | undefined, want: { code: number; name: string; rgba: number[] }[]) {
  expect(got?.map((l) => [l.code, l.name])).toEqual(want.map((l) => [l.code, l.name]));
  got!.forEach((l, i) => close(l.rgba, want[i].rgba));
}

describe("surface values", () => {
  it("reads morphometry in FreeSurfer's new and old formats", () => {
    for (const name of ["surf/lh.thickness", "surf/lh.sulc", "surf/lh.avg_curv"]) close(parseMorph(bytes(name)).values, expected[name].values);
  });

  it("reads MGH and MGZ overlays with a value per vertex", () => {
    close(parseMghValues(bytes("surf/lh.w-g.pct.mgh")).values, expected["surf/lh.w-g.pct.mgh"].values);
    close(parseMghValues(gunzip(bytes("surf/lh.overlay.mgz"))).values, expected["surf/lh.overlay.mgz"].values);
  });

  it("reads GIFTI shape and label arrays, with the label table", async () => {
    const shape = await parseGiftiValues(fs.readFileSync(path.join(DIR, "surf/lh.thickness.shape.gii"), "utf8"), "x");
    expect(shape.map((a) => a.name)).toEqual(["thickness"]);
    close(shape[0].data.values, expected["surf/lh.thickness.shape.gii"].thickness.values);
    const labels = await parseGiftiValues(fs.readFileSync(path.join(DIR, "surf/lh.aparc.label.gii"), "utf8"), "x");
    const want = expected["surf/lh.aparc.label.gii"].lobes;
    expect(labels.map((a) => a.name)).toEqual(["lobes"]);
    close(labels[0].data.values, want.values);
    sameLabels(labels[0].data.labels, want.labels);
  });

  it("reads annotations with the new and old colour tables, as nibabel's codes", () => {
    for (const name of ["label/lh.aparc.annot", "label/lh.old.annot"]) {
      const got = parseAnnot(bytes(name));
      close(got.values, expected[name].values);
      sameLabels(got.labels, expected[name].labels);
    }
  });

  it("reads labels, and puts several together, the smallest on top", () => {
    const cortex = parseLabelVertices(fs.readFileSync(path.join(DIR, "label/lh.cortex.label"), "utf8"));
    const v1 = parseLabelVertices(fs.readFileSync(path.join(DIR, "label/lh.V1.label"), "utf8"));
    expect(Array.from(cortex)).toEqual(expected["label/lh.cortex.label"].vertices);
    expect(Array.from(v1)).toEqual(expected["label/lh.V1.label"].vertices);
    const both = combineLabels(12, [{ name: "cortex", vertices: cortex }, { name: "V1", vertices: v1 }]);
    expect(Array.from(both.values)).toEqual([0, 1, 0, 1, 1, 0, 0, 0, 0, 0, -1, -1]);
    expect(both.labels!.map((l) => l.name)).toEqual(["cortex", "V1"]);
  });

  it("finds a FreeSurfer surface's companions by name, and keeps those of its vertex count", async () => {
    const list = async (folder: string) => fs.readdirSync(path.join(DIR, folder.replace(/^subject\/?/, ""))).sort();
    const related = await surfaceRelated("subject/surf/lh.white", list);
    expect(related.sort()).toEqual(
      [
        "lh.avg_curv", "lh.inflated", "lh.overlay.mgz", "lh.pial", "lh.sulc", "lh.thickness", "lh.w-g.pct.mgh",
        "../label/lh.V1.label", "../label/lh.aparc.annot", "../label/lh.cortex.label", "../label/lh.old.annot",
      ].sort(),
    );
    const files = Object.fromEntries(related.map((p) => [p, new File([bytes(path.posix.join("surf", p))], p.split("/").pop()!)]));
    const { maps, surfaces, skipped } = await surfaceCompanions("lh.white", files, 12);
    expect(skipped).toEqual([]);
    expect(maps.map((m) => m.name)).toEqual(["sulc", "thickness", "aparc", "labels", "avg_curv", "old", "overlay", "w_g_pct"]);
    expect(surfaces).toEqual({ white: "lh.white", pial: "lh.pial", inflated: "lh.inflated" });
    close((await maps[1].load()).values, expected["surf/lh.thickness"].values);
    close((await maps.find((m) => m.name === "overlay")!.load()).values, expected["surf/lh.overlay.mgz"].values);
    // A GIFTI surface: the same hemisphere's shape and label files beside it.
    const gifti = await surfaceRelated("subject/surf/lh.white.surf.gii", list);
    expect(gifti.sort()).toEqual(["lh.aparc.label.gii", "lh.thickness.shape.gii"]);
    const giftiFiles = Object.fromEntries(gifti.map((p) => [p, new File([bytes(path.posix.join("surf", p))], p)]));
    const fromGifti = await surfaceCompanions("lh.white.surf.gii", giftiFiles, 12);
    expect(fromGifti.skipped).toEqual([]);
    expect(fromGifti.maps.map((m) => [m.name, m.parcellation])).toEqual([["thickness", false], ["lobes", true]]);
    close((await fromGifti.maps[0].load()).values, expected["surf/lh.thickness"].values);

    const wrong = await surfaceCompanions("lh.white", files, 13);
    expect(wrong.maps.map((m) => m.name)).toEqual(["labels"]);
    expect(wrong.skipped.length).toBe(7);
  });
});
