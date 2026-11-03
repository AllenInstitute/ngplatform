/** CIFTI-2 dense scalars and labels beside a GIFTI surface: each map on the hemisphere's vertices, as nibabel wrote them. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { surfaceCompanions, surfaceRelated } from "../../../../src/virtual/vectors/surfaces.js";

const DIR = path.resolve(import.meta.dirname, "../../../../tests/testdata/cifti");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const file = (name: string) => new File([fs.readFileSync(path.join(DIR, name))], name);

describe("CIFTI on a surface", () => {
  it("is found beside a GIFTI surface of a known hemisphere", async () => {
    const related = await surfaceRelated("sub.L.midthickness.surf.gii", async () => fs.readdirSync(DIR));
    expect(related.sort()).toEqual(["sub.aparc.dlabel.nii", "sub.rest.dtseries.nii", "sub.thickness.dscalar.nii"]);
  });

  it("gives each map's values on the left cortex's vertices, the medial wall empty, and a parcellation's table", async () => {
    const related = { "sub.aparc.dlabel.nii": file("sub.aparc.dlabel.nii"), "sub.thickness.dscalar.nii": file("sub.thickness.dscalar.nii") };
    const { maps, skipped } = await surfaceCompanions("sub.L.midthickness.surf.gii", related, 12);
    expect(skipped).toEqual([]);
    expect(maps.map((m) => m.name).sort()).toEqual(["aparc", "myelin", "thickness"]);
    for (const name of ["thickness", "myelin"]) {
      const { values } = await maps.find((m) => m.name === name)!.load();
      (expected[name] as (number | null)[]).forEach((v, i) => (v === null ? expect(values[i]).toBeNaN() : expect(values[i]).toBeCloseTo(v, 6)));
    }
    const aparc = maps.find((m) => m.name === "aparc")!;
    expect(aparc.parcellation).toBe(true);
    const { values, labels } = await aparc.load();
    expect(Array.from(values)).toEqual(expected.aparc);
    expect(labels!.map((l) => [l.code, l.name])).toEqual(Object.entries(expected.aparc_labels).map(([k, v]) => [Number(k), (v as [string])[0]]));
    labels!.forEach((l) => expect(l.rgba.map((c) => Math.round(c * 100) / 100)).toEqual(expected.aparc_labels[String(l.code)][1]));
  });

  it("gives a time series' mean and standard deviation over time on each vertex", async () => {
    const { maps } = await surfaceCompanions("sub.L.midthickness.surf.gii", { "sub.rest.dtseries.nii": file("sub.rest.dtseries.nii") }, 12);
    expect(maps.map((m) => m.name)).toEqual(["rest_mean", "rest_sd"]);
    for (const m of maps) {
      const { values } = await m.load();
      (expected[m.name] as (number | null)[]).forEach((v, i) => (v === null ? expect(values[i]).toBeNaN() : expect(values[i]).toBeCloseTo(v, 3)));
    }
  });

  it("leaves a file out when its hemisphere has another vertex count", async () => {
    const { maps, skipped } = await surfaceCompanions("sub.L.midthickness.surf.gii", { "sub.thickness.dscalar.nii": file("sub.thickness.dscalar.nii") }, 40);
    expect(maps).toEqual([]);
    expect(skipped[0]).toMatch(/another vertex count/);
  });
});
