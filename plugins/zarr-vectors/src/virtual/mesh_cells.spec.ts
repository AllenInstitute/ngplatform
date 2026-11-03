/**
 * Large meshes in cells with coarser levels (src/virtual/vectors/
 * mesh_levels.ts, mesh_cells.ts): level 0 holds every face once, in the
 * cell of its centroid, border vertices copied into each cell that uses
 * them; each coarser level has fewer faces in cells twice as large; every
 * level's cells meet without cracks; the plugin's reader reads every level
 * as the viewer does; zarr-vectors-py's validator passes a written copy.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { meshGridOffset, meshLevels, objectMeshLayout } from "../mesh_lod.js";
import { LevelPipeline, ObjectReader, openZarrVectorsStore, readObjectTable, ShardIndexCache } from "../reader.js";
import { parsePly, type MeshData } from "../../../../src/virtual/vectors/mesh_files.js";
import { buildMeshLevels, chooseBin, KeyIndex, splitCells, type MeshLevels } from "../../../../src/virtual/vectors/mesh_levels.js";
import { CellMeshStore, openMeshStore } from "../../../../src/virtual/vectors/mesh_cells.js";
import { MeshStore } from "../../../../src/virtual/vectors/meshes.js";
import { writeStore } from "./write_store.js";

const signal = new AbortController().signal;

/** A closed, wrinkled torus of 2·n·m triangles, moved by `shift`. */
function torus(n: number, m: number, shift = [100, 90, 40], R = 60, r = 25): { positions: Float32Array; triangles: Uint32Array } {
  const positions = new Float32Array(3 * n * m);
  for (let i = 0; i < n; ++i) {
    for (let j = 0; j < m; ++j) {
      const u = (2 * Math.PI * i) / n;
      const v = (2 * Math.PI * j) / m;
      const rr = r + 2 * Math.sin(9 * u) * Math.sin(13 * v);
      const at = 3 * (i * m + j);
      positions[at] = (R + rr * Math.cos(v)) * Math.cos(u) + shift[0];
      positions[at + 1] = (R + rr * Math.cos(v)) * Math.sin(u) + shift[1];
      positions[at + 2] = rr * Math.sin(v) + shift[2];
    }
  }
  const triangles = new Uint32Array(6 * n * m);
  let t = 0;
  for (let i = 0; i < n; ++i) {
    for (let j = 0; j < m; ++j) {
      const a = i * m + j;
      const b = ((i + 1) % n) * m + j;
      const c = ((i + 1) % n) * m + ((j + 1) % m);
      const d = i * m + ((j + 1) % m);
      triangles.set([a, b, c, a, c, d], t);
      t += 6;
    }
  }
  return { positions, triangles };
}

function single(n: number, m: number): MeshData {
  const { positions, triangles } = torus(n, m);
  return { positions, triangles, triangleObject: new Uint32Array(triangles.length / 3), objects: ["torus"] };
}

/** Two tori, as two objects, side by side (they share no vertices). */
function two(n: number, m: number): MeshData {
  const a = torus(n, m);
  const b = torus(n, m, [100, 90, 140], 40, 15);
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const triangles = new Uint32Array(a.triangles.length + b.triangles.length);
  triangles.set(a.triangles);
  triangles.set(b.triangles.map((v) => v + a.positions.length / 3), a.triangles.length);
  const triangleObject = new Uint32Array(triangles.length / 3);
  triangleObject.fill(1, a.triangles.length / 3);
  return { positions, triangles, triangleObject, objects: ["outer", "inner"] };
}

const corner = (p: ArrayLike<number>, at: number) => `${p[at]},${p[at + 1]},${p[at + 2]}`;
/** A face as its corners' exact positions, rotated to start at the smallest (winding kept). */
function faceKey(c: string[]): string {
  const i = c.indexOf([...c].sort()[0]);
  return [0, 1, 2].map((k) => c[(i + k) % 3]).join(" ");
}

/** A level's faces, from its cells, as position triples: per object. */
function levelFaces(levels: MeshLevels, k: number): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const cell of levels.levels[k].cells) {
    let row = 0;
    let face = 0;
    for (let f = 0; f < cell.owners.length; ++f) {
      const list = out.get(cell.owners[f]) ?? [];
      out.set(cell.owners[f], list);
      for (let t = 0; t < cell.faceCounts[f]; ++t, ++face) {
        const rows = [0, 1, 2].map((j) => cell.faces[3 * face + j]);
        // Rows stay inside the face group's own fragment.
        for (const r of rows) expect(r >= row && r < row + cell.vertexCounts[f]).toBe(true);
        list.push(faceKey(rows.map((r) => corner(cell.vertices, 3 * r))));
      }
      row += cell.vertexCounts[f];
    }
  }
  return out;
}

/** How many faces use each edge, in the union of a level's cells welded by exact position. */
function edgeUses(faces: string[]): Map<string, number> {
  const uses = new Map<string, number>();
  for (const f of faces) {
    const c = f.split(" ");
    for (let k = 0; k < 3; ++k) {
      const e = [c[k], c[(k + 1) % 3]].sort().join("|");
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  return uses;
}

function access(store: { get(key: string): Promise<Uint8Array | undefined>; list(prefix: string): string[] | undefined }) {
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

const OPTIONS = { cellFaces: 2000, lastLevelFaces: 1000 };

describe("a large mesh in cells", () => {
  const mesh = single(120, 80);
  const levels = buildMeshLevels(mesh, OPTIONS);
  const offset = levels.offset;

  it("holds every face once at level 0, in the cell of its centroid, wound as in the file", () => {
    const level = levels.levels[0];
    expect(level.cells.length).toBeGreaterThan(8);
    expect(level.faceCount).toBe(mesh.triangles.length / 3);
    const got = levelFaces(levels, 0).get(0)!;
    const want: string[] = [];
    const moved = mesh.positions.map((v, i) => Math.fround(v - offset[i % 3]));
    for (let f = 0; f < mesh.triangles.length / 3; ++f) {
      want.push(faceKey([0, 1, 2].map((k) => corner(moved, 3 * mesh.triangles[3 * f + k]))));
    }
    expect(got.sort()).toEqual(want.sort());
    for (const cell of level.cells) {
      for (let t = 0; t < cell.faces.length; t += 3) {
        for (let k = 0; k < 3; ++k) {
          const centroid = [0, 1, 2].reduce((s, j) => s + cell.vertices[3 * cell.faces[t + j] + k], 0) / 3;
          expect(Math.floor(centroid / level.chunk)).toBe(cell.at[k]);
        }
      }
    }
  });

  it("copies a border vertex into each cell whose faces use it, and no other vertex", () => {
    const level = levels.levels[0];
    // Independently: the cells each vertex's faces fall in.
    const cellsOf = new Map<number, Set<string>>();
    const p = mesh.positions.map((v, i) => Math.fround(v - offset[i % 3]));
    for (let f = 0; f < mesh.triangles.length / 3; ++f) {
      const cell = [0, 1, 2].map((k) => Math.floor((p[3 * mesh.triangles[3 * f] + k] + p[3 * mesh.triangles[3 * f + 1] + k] + p[3 * mesh.triangles[3 * f + 2] + k]) / 3 / level.chunk)).join();
      for (let k = 0; k < 3; ++k) {
        const v = mesh.triangles[3 * f + k];
        cellsOf.set(v, (cellsOf.get(v) ?? new Set()).add(cell));
      }
    }
    const expected = [...cellsOf.values()].reduce((n, s) => n + s.size, 0);
    expect(level.vertexCount).toBe(expected);
    expect(level.vertexCount).toBeGreaterThan(mesh.positions.length / 3);
    // Every stored vertex is used by a face of its fragment.
    for (const cell of level.cells) {
      const used = new Uint8Array(cell.vertices.length / 3);
      for (const r of cell.faces) used[r] = 1;
      expect(used.every((u) => u === 1)).toBe(true);
    }
  });

  it("makes coarser levels with fewer faces in cells twice as large, every vertex used and in bounds", () => {
    expect(levels.levels.length).toBeGreaterThanOrEqual(3);
    for (let k = 1; k < levels.levels.length; ++k) {
      const [before, level] = [levels.levels[k - 1], levels.levels[k]];
      expect(level.chunk).toBe(2 * before.chunk);
      expect(level.faceCount).toBeLessThan(0.75 * before.faceCount);
      expect(level.faceCount).toBeGreaterThan(0.1 * before.faceCount);
      expect(level.cells.reduce((n, c) => n + c.faces.length / 3, 0)).toBe(level.faceCount);
      for (const cell of level.cells) {
        const used = new Uint8Array(cell.vertices.length / 3);
        for (const r of cell.faces) used[r] = 1;
        expect(used.every((u) => u === 1)).toBe(true);
        for (let i = 0; i < cell.vertices.length; ++i) {
          expect(cell.vertices[i]).toBeGreaterThanOrEqual(levels.lo[i % 3]);
          expect(cell.vertices[i]).toBeLessThanOrEqual(levels.hi[i % 3]);
        }
      }
    }
    expect(levels.levels.at(-1)!.faceCount).toBeLessThanOrEqual(OPTIONS.lastLevelFaces);
  });

  it("leaves no crack between cells at any level: every edge of a closed mesh is shared", () => {
    for (let k = 0; k < levels.levels.length; ++k) {
      const uses = edgeUses(levelFaces(levels, k).get(0)!);
      const open = [...uses.values()].filter((n) => n < 2).length;
      expect({ level: k, open }).toEqual({ level: k, open: 0 });
      // Level 0 is the file's closed manifold: each edge exactly twice.
      if (k === 0) expect([...uses.values()].every((n) => n === 2)).toBe(true);
    }
  });

  it("keeps objects apart: clusters never join two objects", () => {
    const pair = buildMeshLevels(two(100, 60), OPTIONS);
    expect(pair.levels.length).toBeGreaterThanOrEqual(2);
    for (let k = 0; k < pair.levels.length; ++k) {
      const faces = levelFaces(pair, k);
      expect([...faces.keys()].sort()).toEqual([0, 1]);
      const corners = (o: number) => new Set(faces.get(o)!.flatMap((f) => f.split(" ")));
      const outer = corners(0);
      expect([...corners(1)].some((c) => outer.has(c))).toBe(false);
      for (const o of [0, 1]) expect([...edgeUses(faces.get(o)!).values()].filter((n) => n < 2)).toEqual([]);
    }
    expect(Array.from(pair.columns.find((c) => c.name === "n_faces")!.values)).toEqual([12000, 12000]);
  });

  it("chooses a bin putting about four vertices in each", () => {
    // A 64 × 64 grid of points 1 apart on a plane: bins of 2 hold four.
    const grid = new Float32Array(3 * 64 * 64);
    for (let i = 0; i < 64 * 64; ++i) grid.set([(i % 64) + 0.5, Math.floor(i / 64) + 0.5, 3], 3 * i);
    expect(chooseBin(grid, 256)).toBe(2);
    const index = new KeyIndex(2);
    expect([index.id(2 ** 40 + 1), index.id(7), index.id(2 ** 40 + 1), index.id(2 ** 52 - 1)]).toEqual([0, 1, 0, 2]);
    for (let i = 0; i < 5000; ++i) index.id(i * 1009);
    expect(index.id(7)).toBe(1);
  });

  it("splits by object within a cell: one fragment and face group per object, in object order", () => {
    const m = two(30, 20);
    const cells = splitCells(m.positions.map((v, i) => v - [60, 30, 0][i % 3]), m.triangles, m.triangleObject, 2, 512);
    expect(cells.length).toBe(1);
    expect(Array.from(cells[0].owners)).toEqual([0, 1]);
    expect(Array.from(cells[0].faceCounts)).toEqual([1200, 1200]);
    expect(Array.from(cells[0].vertexCounts)).toEqual([600, 600]);
  });

  it("is read by the plugin's reader as the viewer reads it: every level, its cells and each object's mesh", async () => {
    const store = new CellMeshStore(levels, "torus");
    const a = access(store);
    const zv = await openZarrVectorsStore(a as never, []);
    expect(zv.description.geometryKind).toBe("mesh");
    expect(zv.levels.length).toBe(levels.levels.length);
    const lod = await meshLevels(zv.levels, async () => true);
    expect(lod.unused).toBe(0);
    for (let k = 0; k < zv.levels.length; ++k) {
      const level = levels.levels[k];
      expect(zv.levels[k].chunkShape).toEqual([level.chunk, level.chunk, level.chunk]);
      // The overview: each cell's vertices and faces, and its object (id 1).
      const pipeline = new LevelPipeline(a as never, zv.description, zv.levels[k]);
      let vertices = 0;
      for (const cell of level.cells) {
        const d = (await pipeline.download(cell.at, signal))!;
        vertices += d.numOwnVertices;
        expect(d.segmentIds[0]).toBe(1);
      }
      expect(vertices).toBe(level.vertexCount);
      // The object's mesh at this level, node by node, as the backend reads it.
      const reader = new ObjectReader(a as never, zv.description, zv.levels[k]);
      const chunks = await reader.chunksOf(1n);
      expect(chunks.length).toBe(level.cells.length);
      let faces = 0;
      for (const c of chunks) {
        const { indices } = await reader.readMeshNode(1n, c, signal);
        faces += indices.length / 3;
      }
      expect(faces).toBe(level.faceCount);
    }
    const base = zv.levels[0].chunkShape;
    const layout = objectMeshLayout(
      await Promise.all(lod.levels.map((l) => new ObjectReader(a as never, zv.description, l).chunksOf(1n))),
      base,
      meshGridOffset(zv.lowerBounds, base, lod.levels.length),
      Float32Array.from(lod.levels.map((_, i) => 2 ** i)),
    );
    expect(layout.octree.length / 5).toBeGreaterThan(levels.levels[0].cells.length);
    const table = (await readObjectTable(a as never, "0"))!;
    expect(table.numObjects).toBe(1);
  });

  it("opens small meshes and surfaces as one cell, large ones in cells", async () => {
    expect(await openMeshStore(single(20, 10), "small")).toBeInstanceOf(MeshStore);
    expect(await openMeshStore(single(120, 80), "large", undefined, 1000)).toBeInstanceOf(CellMeshStore);
  });

  it("reads a binary PLY with quads and other properties", () => {
    const header = "ply\nformat binary_little_endian 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nelement face 1\nproperty uchar flags\nproperty list uchar uint vertex_indices\nproperty list uchar int other\nend_header\n";
    const body = new DataView(new ArrayBuffer(4 * 13 + 1 + 1 + 16 + 1 + 4));
    let at = 0;
    for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]) {
      for (const v of [x, y, z]) (body.setFloat32(at, v, true), (at += 4));
      body.setUint8(at++, 200);
    }
    body.setUint8(at++, 7);
    body.setUint8(at++, 4);
    for (const v of [0, 1, 2, 3]) (body.setUint32(at, v, true), (at += 4));
    body.setUint8(at++, 1);
    body.setInt32(at, 9, true);
    const bytes = new Uint8Array([...new TextEncoder().encode(header), ...new Uint8Array(body.buffer)]);
    const m = parsePly(bytes, "quad");
    expect(Array.from(m.triangles)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(Array.from(m.positions.subarray(6, 9))).toEqual([1, 1, 0]);
  });
});

// ---------------------------------------------------------------- zarr-vectors-py

const PYTHON = path.join(os.homedir(), ".conda/envs/zarr-vectors/bin/python");
const hasValidator = fs.existsSync(PYTHON) && spawnSync(PYTHON, ["-c", "import zarr_vectors.validate"]).status === 0;

describe("zarr-vectors-py", () => {
  it.skipIf(!hasValidator)("validates a written copy of a store in cells, every level (conformance level 5)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zv-mesh-cells-"));
    try {
      const store = new CellMeshStore(buildMeshLevels(two(60, 40), { cellFaces: 1500, lastLevelFaces: 1000 }), "two");
      expect(await writeStore(store, dir)).toBeGreaterThan(20);
      const script = "import sys\nfrom zarr_vectors.validate import validate\nr = validate(sys.argv[1], level=5)\nprint(r.summary())\nsys.exit(0 if r.ok else 1)\n";
      const run = spawnSync(PYTHON, ["-c", script, dir], { encoding: "utf8" });
      expect(run.stdout + run.stderr).toContain("PASS");
      expect(run.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
