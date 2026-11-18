/**
 * Volume meshes (format 0.10's `element`): cells drawn as their boundary.
 * The stores in testdata/ (volume_tets1, one chunk; volume_tets2, 2 × 2 × 2
 * chunks, most cells crossing) were written by zarr-vectors-py with volume
 * elements (generate_volume.py): a cube of 162 tetrahedra; volume_tets.json
 * has the cells and the boundary zarr-vectors-py's `boundary_faces` gives.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LevelPipeline } from "./chunk_pipeline.js";
import { boundaryTriangles, ELEMENT_FACES, ELEMENT_WIDTH, type VolumeElement, volumeElement } from "./elements.js";
import { asFormat09 } from "./format010.js";
import { openZarrVectorsStore } from "./store.js";
import { ShardIndexCache } from "./zarr_array.js";
import { FIXTURE_DIR, fixtureListDirectories, fixtureRead } from "./test_fixtures.js";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Each element's corners as VTK numbers them (a unit cell of each kind). */
const UNIT: Record<VolumeElement, V3[]> = {
  tetra: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
  pyramid: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0.5, 0.5, 1]],
  wedge: [[0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1]],
  hexahedron: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
};

/** The volume a closed set of triangles encloses (positive when wound outward). */
function volumeOf(triangles: readonly number[], at: (v: number) => V3): number {
  let v = 0;
  for (let t = 0; t + 3 <= triangles.length; t += 3) v += dot(at(triangles[t]), cross(at(triangles[t + 1]), at(triangles[t + 2])));
  return v / 6;
}

describe("a volume element's boundary", () => {
  for (const element of Object.keys(ELEMENT_WIDTH) as VolumeElement[]) {
    it(`is its faces, wound outward: ${element}`, () => {
      const corners = UNIT[element];
      const cell = corners.map((_, i) => i);
      const tris = boundaryTriangles(cell, element);
      const faces = ELEMENT_FACES[element];
      expect(tris.length / 3).toBe(faces.reduce((n, f) => n + f.length - 2, 0));
      // Every triangle faces away from the cell's centre, and together they enclose it.
      const c = corners.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]] as V3, [0, 0, 0] as V3).map((x) => x / corners.length) as V3;
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b, d] = [0, 1, 2].map((k) => corners[tris[t + k]]);
        expect(dot(cross(sub(b, a), sub(d, a)), sub(a, c))).toBeGreaterThan(0);
      }
      expect(volumeOf(tris, (v) => corners[v])).toBeGreaterThan(0);
    });
  }

  it("leaves out the faces two cells share", () => {
    // Two tetrahedra on one triangle (0, 1, 2), apexes on either side.
    const cells = [0, 1, 2, 3, 0, 2, 1, 4];
    const tris = boundaryTriangles(cells, "tetra");
    expect(tris.length / 3).toBe(6);
    const names = new Set<string>();
    for (let t = 0; t < tris.length; t += 3) names.add([tris[t], tris[t + 1], tris[t + 2]].sort().join(","));
    expect(names.has("0,1,2")).toBe(false);
  });

  it("is taken only as the element its width says", () => {
    expect(volumeElement("tetra", 4)).toBe("tetra");
    expect(volumeElement("tetra", 3)).toBeUndefined();
    expect(volumeElement("polyhedron", 4)).toBeUndefined();
    expect(volumeElement(undefined, 4)).toBeUndefined();
  });
});

describe("format 0.10 metadata, read as 0.9's", () => {
  it("moves each kind of node back", () => {
    expect(asFormat09({ attributes: { zarr_vectors: { kind: "root", zv_version: "0.10.0", axes: [{ name: "x" }] }, multiscales: { layout: [{ asset: "0" }, { asset: "1" }] } } }).attributes).toEqual({
      zarr_vectors: { zv_version: "0.10.0", axes: [{ name: "x" }] },
      multiscales: [{ axes: [{ name: "x" }], datasets: [{ path: "0" }, { path: "1" }] }],
    });
    expect(asFormat09({ attributes: { zarr_vectors: { kind: "level", vertex_count: 5, presence: { x: 1 } } } }).attributes).toEqual({ zarr_vectors_level: { vertex_count: 5 }, zarr_vectors_presence: { x: 1 } });
    expect(asFormat09({ node_type: "array", attributes: { zarr_vectors: { kind: "links", dtype: "int64", has_perm: true } } })).toEqual({ node_type: "array", attributes: { zv_array: "links", dtype: "int64", has_perm: true } });
    expect(asFormat09({ attributes: { zarr_vectors: { kind: "vertex_attribute", dtype: "float32" } } }).attributes.zv_array).toBe("attribute");
    // 0.9 as it is.
    const old = { attributes: { zv_array: "links", link_width: 3 } };
    expect(asFormat09(old)).toBe(old);
  });
});

// ------------------------------------------------------------------ the stores

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "volume_tets.json"), "utf8")) as { vertices: V3[]; cells: number[][]; boundary: number[][][] };
/** A triangle as the positions of its corners, starting at the least (so the winding is kept). */
const nameOf = (corners: V3[]) => {
  const s = corners.map((p) => p.map((x) => x.toFixed(4)).join(" "));
  let at = 0;
  for (let i = 1; i < 3; ++i) if (s[i] < s[at]) at = i;
  return [0, 1, 2].map((k) => s[(at + k) % 3]).join(" | ");
};
/** zarr-vectors-py's boundary, as triangles by position. */
const pythonBoundary = new Set(expected.boundary.flat().map((f) => nameOf(f.map((v) => expected.vertices[v]))));

async function drawn(store: string, bridges = true): Promise<{ triangles: string[]; element: string | undefined }> {
  const access = { read: fixtureRead(store), listDirectories: fixtureListDirectories(store), shardIndexes: new ShardIndexCache() };
  const opened = await openZarrVectorsStore(access, undefined);
  const level = opened.levels[0];
  const pipeline = new LevelPipeline(access, opened.description, level);
  const triangles: string[] = [];
  const grid = level.chunkShape.map((s, d) => Math.ceil((opened.upperBounds[d] - opened.lowerBounds[d]) / s));
  for (let x = 0; x < grid[0]; ++x)
    for (let y = 0; y < grid[1]; ++y)
      for (let z = 0; z < grid[2]; ++z) {
        const data = await pipeline.download([x, y, z], new AbortController().signal, { bridges });
        if (data === undefined) continue;
        const at = (v: number): V3 => [data.positions[3 * v], data.positions[3 * v + 1], data.positions[3 * v + 2]];
        for (let t = 0; t + 3 <= data.faces.length; t += 3) triangles.push(nameOf([at(data.faces[t]), at(data.faces[t + 1]), at(data.faces[t + 2])]));
      }
  return { triangles, element: opened.description.element };
}

describe("a volume mesh store (format 0.10, element: tetra)", () => {
  it("in one chunk: drawn as the boundary zarr-vectors-py gives, wound as it is", async () => {
    const { triangles, element } = await drawn("volume_tets1");
    expect(element).toBe("tetra");
    expect(triangles.length).toBe(pythonBoundary.size);
    expect(new Set(triangles)).toEqual(pythonBoundary);
  });

  it("in 2 × 2 × 2 chunks, most cells crossing: the same surface, each face once, none inside", async () => {
    const { triangles } = await drawn("volume_tets2");
    expect(triangles.length).toBe(pythonBoundary.size);
    expect(new Set(triangles)).toEqual(pythonBoundary);
    // (Without the cells that cross chunks, which this store depends on, it is not.)
    const own = await drawn("volume_tets2", false);
    expect(new Set(own.triangles)).not.toEqual(pythonBoundary);
  });
});
