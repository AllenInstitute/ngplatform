/**
 * CIFTI-2 dense scalars, labels and a time series beside a GIFTI surface:
 * each map on the hemisphere's vertices, as nibabel wrote them; the series
 * also a time point at a time, chosen by a message to the surface's store.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMeshFile } from "../../../../src/virtual/vectors/mesh_files.js";
import { CourseStats } from "../../../../src/virtual/vectors/cifti.js";
import { MeshStore } from "../../../../src/virtual/vectors/meshes.js";
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
    expect(maps.map((m) => m.name)).toEqual(["rest_mean", "rest_sd", "rest_t"]);
    for (const m of maps.filter((m) => m.name !== "rest_t")) {
      const { values } = await m.load();
      (expected[m.name] as (number | null)[]).forEach((v, i) => (v === null ? expect(values[i]).toBeNaN() : expect(values[i]).toBeCloseTo(v, 3)));
    }
  });

  it("serves a time series a time point at a time, the time point chosen by a message to the store", async () => {
    const companions = await surfaceCompanions("sub.L.midthickness.surf.gii", { "sub.rest.dtseries.nii": file("sub.rest.dtseries.nii") }, 12);
    const [series] = companions.series!;
    expect([series.map.name, series.count, series.start, series.step, series.unit, series.time]).toEqual(["rest_t", 7, 0, expect.closeTo(0.72, 6), "second", 0]);
    const mesh = await parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, "sub.L.midthickness.surf.gii"))), "sub.L.midthickness.surf.gii");
    const store = new MeshStore(mesh, "sub.L.midthickness", companions);
    const header = JSON.parse(new TextDecoder().decode(await store.get("headers/surface/zarr.json"))).attributes;
    expect(header.maps).toContain("rest_t");
    expect(header.time_series.rest_t).toEqual({ source: "sub.rest.dtseries.nii", n_time_points: 7, start: 0, step: expect.closeTo(0.72, 6), unit: "second" });
    const spec = JSON.parse(new TextDecoder().decode(await store.get("zarr.json"))).attributes.zarr_vectors.attribute_specs.vertex;
    expect(Object.keys(spec)).toContain("rest_t");
    // The attribute's values, in the file's vertex order (the store keeps the file's order for one object).
    const values = async () => {
      const bytes = (await store.get("0/vertex_attributes/rest_t/c/0/0/0"))!;
      return Array.from(new Float32Array(bytes.slice(8).buffer));
    };
    const rows = expected.rest_t as (number | null)[][];
    const check = (got: number[], row: (number | null)[]) => row.forEach((v, i) => (v === null ? expect(got[i]).toBeNaN() : expect(got[i]).toBeCloseTo(v, 4)));
    check(await values(), rows[0]);
    expect(store.message({ series: "rest_t", time: 5 })).toEqual({ series: "rest_t", time: 5, count: 7 });
    check(await values(), rows[5]);
    // Asking without a time changes nothing; a time outside the series, or another series, is refused.
    expect(store.message({ series: "rest_t" })).toEqual({ series: "rest_t", time: 5, count: 7 });
    expect(() => store.message({ series: "rest_t", time: 7 })).toThrow(/outside/);
    expect(() => store.message({ series: "other", time: 0 })).toThrow(/no time series/);
    expect(store.message({ series: "rest_t", time: 6 })).toEqual({ series: "rest_t", time: 6, count: 7 });
    check(await values(), rows[6]);
  });

  it("finds the vertex nearest a point in the store's coordinates, and answers a vertex's values at every time point", async () => {
    const companions = await surfaceCompanions("sub.L.midthickness.surf.gii", { "sub.rest.dtseries.nii": file("sub.rest.dtseries.nii") }, 12);
    const mesh = await parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, "sub.L.midthickness.surf.gii"))), "sub.L.midthickness.surf.gii");
    const store = new MeshStore(mesh, "sub.L.midthickness", companions);
    // The store holds the file's positions less coordinate_offset (whole millimetres, here not 0).
    const offset = JSON.parse(new TextDecoder().decode(await store.get("zarr.json"))).attributes.zarr_vectors.coordinate_offset as number[];
    expect(offset.some((o) => o !== 0)).toBe(true);
    const stored = (v: number) => [0, 1, 2].map((k) => mesh.positions[3 * v + k] - offset[k]);
    // Half the smallest distance between two vertices: a point that near a vertex has it nearest.
    let gap = Infinity;
    for (let a = 0; a < 12; ++a) for (let b = a + 1; b < 12; ++b) gap = Math.min(gap, Math.hypot(...[0, 1, 2].map((k) => mesh.positions[3 * a + k] - mesh.positions[3 * b + k])));
    for (let v = 0; v < 12; ++v) {
      const near = stored(v).map((x, k) => x + (k === v % 3 ? 0.4 * gap : 0));
      const answer = (await store.message({ series: "rest_t", nearest: near, within: gap })) as { vertex: number; distance: number; position: number[] };
      expect(answer.vertex).toBe(v);
      expect(answer.distance).toBeCloseTo(0.4 * gap, 4);
      answer.position.forEach((x, k) => expect(x).toBeCloseTo(stored(v)[k], 4));
    }
    // Nothing within the distance asked: no vertex.
    expect(await store.message({ series: "rest_t", nearest: stored(0).map((x) => x + 1000), within: 5 })).toEqual({ series: "rest_t", vertex: null });
    expect(() => store.message({ series: "rest_t", nearest: [0, 0] })).toThrow(/point/);
    // Each vertex's values at every time point, as nibabel wrote them; NaN on the medial wall (3 and 4).
    const rows = expected.rest_t as (number | null)[][];
    const checkCourse = async () => {
      for (let v = 0; v < 12; ++v) {
        const answer = (await store.message({ series: "rest_t", vertex: v })) as { series: string; vertex: number; values: Float32Array };
        expect([answer.series, answer.vertex, answer.values.length]).toEqual(["rest_t", v, 7]);
        rows.forEach((row, t) => (row[v] === null ? expect(answer.values[t]).toBeNaN() : expect(answer.values[t]).toBeCloseTo(row[v]!, 4)));
      }
    };
    // Read from the file a column at a time, then from the series read whole for stepping.
    await checkCourse();
    store.message({ series: "rest_t", time: 3 });
    await store.get("0/vertex_attributes/rest_t/c/0/0/0");
    await checkCourse();
    await expect(store.message({ series: "rest_t", vertex: 12 }) as Promise<unknown>).rejects.toThrow(/outside/);
    expect(() => store.message({ series: "rest_t", vertex: 1.5 })).toThrow(/not a vertex/);
  });

  it("answers a parcel's mean and SD at every time point, and its parcellation's labels", async () => {
    const related = { "sub.rest.dtseries.nii": file("sub.rest.dtseries.nii"), "sub.aparc.dlabel.nii": file("sub.aparc.dlabel.nii") };
    const companions = await surfaceCompanions("sub.L.midthickness.surf.gii", related, 12);
    const mesh = await parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, "sub.L.midthickness.surf.gii"))), "sub.L.midthickness.surf.gii");
    const store = new MeshStore(mesh, "sub.L.midthickness", companions);
    const codes = expected.aparc as number[];
    const rows = expected.rest_t as (number | null)[][];
    // The parcellation, its labels counted.
    const listed = (await store.message({ series: "rest_t", parcellations: true })) as { parcellations: { name: string; labels: { code: number; name: string; vertices: number }[]; codes: Float32Array }[] };
    expect(listed.parcellations.map((p) => p.name)).toEqual(["aparc"]);
    const [aparc] = listed.parcellations;
    expect(Array.from(aparc.codes)).toEqual(codes);
    for (const l of aparc.labels) expect(l.vertices, l.name).toBe(codes.filter((c) => c === l.code).length);
    // Each parcel's mean and SD (ddof 1) over its vertices with values, at each time point, by code and by name.
    const check = async (parcel: number | string, code: number) => {
      const answer = (await store.message({ series: "rest_t", parcel })) as { parcellation: string; parcel: number; name: string; vertices: number; mean: Float32Array; sd: Float32Array };
      const members = codes.map((c, v) => (c === code && rows[0][v] !== null ? v : -1)).filter((v) => v >= 0);
      expect([answer.parcellation, answer.parcel, answer.vertices]).toEqual(["aparc", code, members.length]);
      rows.forEach((row, t) => {
        const xs = members.map((v) => row[v]!);
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
        expect(answer.mean[t]).toBeCloseTo(mean, 3);
        expect(answer.sd[t]).toBeCloseTo(sd, 3);
      });
      return answer;
    };
    for (const l of aparc.labels) if (l.vertices > 1) await check(l.code, l.code);
    expect((await check("precentral", 1)).name).toBe("precentral");
    // The same from the series read whole (after stepping through it).
    store.message({ series: "rest_t", time: 2 });
    await store.get("0/vertex_attributes/rest_t/c/0/0/0");
    await check(2, 2);
    await expect(store.message({ series: "rest_t", parcel: "nowhere" }) as Promise<unknown>).rejects.toThrow(/no label/);
    expect(() => store.message({ series: "rest_t", parcellation: "other", parcel: 1 })).toThrow(/no parcellation/);
  });

  it("leaves a file out when its hemisphere has another vertex count", async () => {
    const { maps, skipped } = await surfaceCompanions("sub.L.midthickness.surf.gii", { "sub.thickness.dscalar.nii": file("sub.thickness.dscalar.nii") }, 40);
    expect(maps).toEqual([]);
    expect(skipped[0]).toMatch(/another vertex count/);
  });
});

describe("a parcel's mean and spread over time", () => {
  it("is each time point's mean and SD (n - 1) across the courses, values that are not numbers left out", () => {
    const courses = [
      [1, 2, NaN, 4],
      [3, 2, 5, NaN],
      [5, 2, 7, 8],
    ];
    const stats = new CourseStats(4);
    for (const c of courses) stats.add(c);
    const { mean, sd, count } = stats.result();
    expect(Array.from(count)).toEqual([3, 3, 2, 2]);
    expect(Array.from(mean)).toEqual([3, 2, 6, 6]);
    expect(sd[0]).toBeCloseTo(2, 6);
    expect(sd[1]).toBe(0);
    expect(sd[2]).toBeCloseTo(Math.SQRT2, 6);
    expect(sd[3]).toBeCloseTo(2 * Math.SQRT2, 6);
    // None at all: NaN; one: its value, spread 0.
    const one = new CourseStats(2);
    one.add([7, NaN]);
    const r = one.result();
    expect(r.mean[0]).toBe(7);
    expect(r.sd[0]).toBe(0);
    expect(r.mean[1]).toBeNaN();
    expect(r.sd[1]).toBeNaN();
  });

  it("keeps its precision over a long, offset series (Welford's sums)", () => {
    const stats = new CourseStats(1);
    for (let i = 0; i < 10_000; ++i) stats.add([1e6 + (i % 2)]);
    const { mean, sd } = stats.result();
    expect(mean[0]).toBeCloseTo(1e6 + 0.5, 3);
    expect(sd[0]).toBeCloseTo(Math.sqrt((10_000 * 0.25) / 9_999), 6);
  });
});
