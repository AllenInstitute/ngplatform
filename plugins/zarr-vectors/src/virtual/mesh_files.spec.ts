/**
 * Mesh files: every format gives the same triangles (as corner coordinates,
 * in order) per object, with STL's repeated corners merged.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMeshFile } from "./mesh_files.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/meshes");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));

describe("mesh files", () => {
  for (const name of Object.keys(expected)) {
    it(`reads ${name}`, () => {
      const mesh = parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, name))), name);
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

  it("refuses what it does not read", () => {
    expect(() => parseMeshFile(new Uint8Array(10), "x.stl")).toThrow(/not an STL/);
    expect(() => parseMeshFile(new Uint8Array(10), "x.ply")).toThrow(/not a PLY/);
    expect(() => parseMeshFile(new Uint8Array(10), "x.off")).toThrow(/not a mesh file/);
  });
});
