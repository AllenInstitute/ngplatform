/**
 * Mesh files: every format gives the same triangles (as corner coordinates,
 * in order) per object, with STL's repeated corners merged; GIFTI (gzipped,
 * base64, ASCII) and FreeSurfer surfaces where zarr-vectors-tools puts them
 * (anatomical ones in scanner RAS, inflated ones as stored).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMeshFile } from "../../../../src/virtual/vectors/mesh_files.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/meshes");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const surfaces = JSON.parse(fs.readFileSync(path.join(DIR, "expected_surfaces.json"), "utf8"));

describe("mesh files", () => {
  for (const name of Object.keys(expected)) {
    it(`reads ${name}`, async () => {
      const mesh = await parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, name))), name);
      const want = expected[name];
      expect(mesh.objects).toEqual(want.objects);
      expect(mesh.positions.length / 3).toBe(want.vertices);
      want.objects.forEach((_: string, o: number) => {
        const got: number[][][] = [];
        for (let t = 0; t < mesh.triangleObject.length; ++t) {
          if (mesh.triangleObject[t] !== o) continue;
          got.push([0, 1, 2].map((k) => Array.from(mesh.positions.subarray(3 * mesh.triangles[3 * t + k], 3 * mesh.triangles[3 * t + k] + 3))));
        }
        expect(got).toEqual(want.triangles[o]);
      });
    });
  }

  for (const name of Object.keys(surfaces)) {
    it(`reads ${name} where zarr-vectors-tools puts it`, async () => {
      const mesh = await parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, name))), name);
      const got: number[][][] = [];
      for (let t = 0; t < mesh.triangles.length / 3; ++t) {
        got.push([0, 1, 2].map((k) => Array.from(mesh.positions.subarray(3 * mesh.triangles[3 * t + k], 3 * mesh.triangles[3 * t + k] + 3))));
      }
      expect(got.length).toBe(surfaces[name].length);
      got.forEach((tri, t) => tri.forEach((p, k) => p.forEach((v, j) => expect(v).toBeCloseTo(surfaces[name][t][k][j], 4))));
    });
  }

  it("refuses what it does not read", async () => {
    await expect(parseMeshFile(new Uint8Array(10), "x.stl")).rejects.toThrow(/not an STL/);
    await expect(parseMeshFile(new Uint8Array(10), "x.ply")).rejects.toThrow(/not a PLY/);
    await expect(parseMeshFile(new Uint8Array(10), "x.off")).rejects.toThrow(/not a mesh file/);
  });
});
