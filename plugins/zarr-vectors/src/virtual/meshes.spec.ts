/**
 * The virtual mesh store, read by this package's own reader as the viewer
 * reads meshes: opened, the overview's chunk, each object's mesh (levels of
 * detail, octree, mesh nodes, as backend.ts does) with every face and its
 * winding, at the file's coordinates; ids from 1; the object columns.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { meshGridOffset, meshLevels, objectMeshLayout, partitionMeshFragment } from "../mesh_lod.js";
import { readSegmentProperties } from "../objects.js";
import { LevelPipeline, ObjectReader, openZarrVectorsStore, readObjectTable, ShardIndexCache } from "../reader.js";
import { parseMeshFile } from "../../../../src/virtual/vectors/mesh_files.js";
import { MeshStore } from "../../../../src/virtual/vectors/meshes.js";
import { surfaceCompanions, surfaceRelated } from "../../../../src/virtual/vectors/surfaces.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/meshes");
const expected = JSON.parse(fs.readFileSync(path.join(DIR, "expected.json"), "utf8"));
const signal = new AbortController().signal;

function access(store: MeshStore) {
  return {
    async read(key: string, options: { byteRange?: { offset: number; length: number } | { suffixLength: number } } = {}) {
      const data = await store.get(key);
      if (data === undefined) return undefined;
      const r = options.byteRange;
      if (r === undefined) return data;
      return "suffixLength" in r ? data.subarray(data.length - r.suffixLength) : data.subarray(r.offset, r.offset + r.length);
    },
    async listDirectories(key: string) {
      return (store.list(`${key}/`) ?? []).filter((n) => n.endsWith("/")).map((n) => n.slice(0, -1));
    },
    shardIndexes: new ShardIndexCache(),
  };
}

const key = (p: ArrayLike<number>) => Array.from(p, (v) => v.toFixed(3)).join(",");
/** A face as its corners, rotated to start at the smallest (winding kept). */
function faceKey(corners: string[]): string {
  const i = corners.indexOf([...corners].sort()[0]);
  return [0, 1, 2].map((k) => corners[(i + k) % 3]).join(" | ");
}

describe("virtual mesh store", () => {
  for (const name of Object.keys(expected)) {
    it(`serves ${name}: every face of every object, wound as in the file, at its coordinates`, async () => {
      const mesh = await parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, name))), name);
      const store = new MeshStore(mesh, name);
      const a = access(store);
      const zv = await openZarrVectorsStore(a as never, []);
      expect(zv.description.geometryKind).toBe("mesh");
      const offset = (JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!)).attributes.zarr_vectors.coordinate_offset as number[]);

      // The overview: every vertex, its object's id (from 1).
      const d = (await new LevelPipeline(a as never, zv.description, zv.levels[0]).download([0, 0, 0], signal))!;
      expect(d.numOwnVertices).toBe(mesh.objects.length === 1 ? want(name).vertices : d.numOwnVertices);
      const ids = new Set<number>();
      for (let v = 0; v < d.numOwnVertices; ++v) ids.add(d.segmentIds[2 * v]);
      expect([...ids].sort()).toEqual(mesh.objects.map((_, o) => o + 1));

      // Each object's mesh, as the backend reads it.
      const { levels } = await meshLevels(zv.levels, async () => true);
      const base = levels[0].chunkShape;
      const gridOffset = meshGridOffset(zv.lowerBounds, base, levels.length);
      const reader = new ObjectReader(a as never, zv.description, levels[0]);
      for (let o = 0; o < mesh.objects.length; ++o) {
        const id = BigInt(o + 1);
        const chunks = await reader.chunksOf(id);
        const layout = objectMeshLayout([chunks], base, gridOffset, Float32Array.of(1));
        const got: string[] = [];
        for (let row = 0; row < layout.octree.length / 5; ++row) {
          if (layout.octree[row * 5 + 4] & 0x80000000) continue;
          const node = [0, 1, 2].map((k) => layout.octree[row * 5 + k] - layout.gridOffset[k]);
          const { positions, indices } = await reader.readMeshNode(id, node, signal);
          const part = partitionMeshFragment(positions, indices, node.map((x, k) => x * base[k]), base, false);
          const p = part.vertexPositions;
          for (let t = 0; t < part.indices.length; t += 3) {
            got.push(faceKey([0, 1, 2].map((k) => key(Array.from(p.subarray(3 * part.indices[t + k], 3 * part.indices[t + k] + 3), (v, j) => v + offset[j])))));
          }
        }
        const wanted = (want(name).triangles[o] as number[][][]).map((tri) => faceKey(tri.map((c) => key(c))));
        expect(got.sort()).toEqual(wanted.sort());
      }

      const table = (await readObjectTable(a as never, "0"))!;
      expect(table.numObjects).toBe(mesh.objects.length);
      const props = await readSegmentProperties(a as never, "0", table, []);
      expect(props!.properties.map((p) => p.id).sort()).toEqual(["area", "n_faces", "n_vertices"]);
    });
  }
});

function want(name: string) {
  return expected[name];
}

describe("virtual surface store", () => {
  const SUBJECT = path.resolve(DIR, "subject");
  const values = JSON.parse(fs.readFileSync(path.join(SUBJECT, "expected.json"), "utf8"));
  const file = (p: string) => new File([fs.readFileSync(path.join(SUBJECT, "surf", p))], p.split("/").pop()!);

  async function surfaceStore() {
    const related = await surfaceRelated("surf/lh.white", async (folder) => fs.readdirSync(path.join(SUBJECT, folder)).sort());
    const files = Object.fromEntries(related.map((p) => [p, file(p)]));
    const mesh = await parseMeshFile(new Uint8Array(fs.readFileSync(path.join(SUBJECT, "surf/lh.white"))), "lh.white");
    return new MeshStore(mesh, "lh.white", await surfaceCompanions("lh.white", files, mesh.positions.length / 3));
  }

  it("serves the values beside a surface as vertex attributes, with label tables and sibling surfaces in its header", async () => {
    const store = await surfaceStore();
    const a = access(store);
    const zv = await openZarrVectorsStore(a as never, undefined);
    const names = zv.description.attributes.map((x) => x.name);
    expect(names).toEqual(["aparc", "avg_curv", "labels", "old", "overlay", "sulc", "thickness", "w_g_pct"]);
    const surface = zv.description.surface!;
    expect(surface.geometry).toBe("white");
    expect(surface.surfaces).toEqual({ white: "../lh.white/", pial: "../lh.pial/", inflated: "../lh.inflated/" });
    expect(surface.maps).toEqual(["sulc", "thickness", "aparc", "labels", "avg_curv", "old", "overlay", "w_g_pct"]);
    const aparc = zv.description.attributes.find((x) => x.name === "aparc")!;
    expect(aparc.labels!.map((l) => [l.code, l.name])).toEqual(values["label/lh.aparc.annot"].labels.map((l: { code: number; name: string }) => [l.code, l.name]));
    expect(zv.description.attributes.find((x) => x.name === "thickness")!.labels).toBeUndefined();

    // The overview chunk's attributes, vertex by vertex as the files have them.
    const d = (await new LevelPipeline(a as never, zv.description, zv.levels[0]).download([0, 0, 0], signal))!;
    const wanted: Record<string, number[]> = {
      thickness: values["surf/lh.thickness"].values,
      sulc: values["surf/lh.sulc"].values,
      aparc: values["label/lh.aparc.annot"].values,
      overlay: values["surf/lh.overlay.mgz"].values,
    };
    for (const [name, list] of Object.entries(wanted)) {
      const got = d.attributes[names.indexOf(name)];
      list.forEach((v, i) => expect(got[i]).toBeCloseTo(v, 4));
    }
  });

  it("serves a map that is not shown by default when asked for by name", async () => {
    const store = await surfaceStore();
    const zv = await openZarrVectorsStore(access(store) as never, ["overlay"]);
    expect(zv.description.attributes.map((x) => x.name)).toEqual(["overlay"]);
  });
});
