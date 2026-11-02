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
import { parseMeshFile } from "./mesh_files.js";
import { MeshStore } from "./meshes.js";

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
      const mesh = parseMeshFile(new Uint8Array(fs.readFileSync(path.join(DIR, name))), name);
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
