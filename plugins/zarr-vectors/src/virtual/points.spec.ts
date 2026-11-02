/**
 * The virtual skeleton and point stores, read by this package's own reader
 * as the viewer and Track filtering read them: opened, the overview's
 * chunk (with and without bridges) holding every node with its tree's id
 * and every edge once, each tree's skeleton, the object table and its
 * columns; points with their values, as objects or not.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSegmentProperties } from "../objects.js";
import { LevelPipeline, ObjectReader, openZarrVectorsStore, readObjectTable, ShardIndexCache } from "../reader.js";
import { parsePointTable, parseSwc, type SwcNode } from "./point_files.js";
import { type CellStore, MAX_POINT_OBJECTS, pointStore, skeletonStore } from "./points.js";

const DIR = path.resolve(import.meta.dirname, "../../testdata/points");
const signal = new AbortController().signal;
const text = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8");

function access(store: CellStore) {
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

const pkey = (p: ArrayLike<number>) => Array.from(p, (x) => Math.fround(x).toFixed(3)).join(",");
/** A stored position at the file's coordinates (the reader's positions are the cell's; the viewer adds the offset). */
const at = (p: Float32Array, v: number, offset: number[]) => [0, 1, 2].map((k) => p[3 * v + k] + offset[k]);
const undirected = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const idOf = (ids: Uint32Array, v: number) => Number(BigInt(ids[2 * v]) | (BigInt(ids[2 * v + 1]) << 32n));

/** Each node's tree (numbered from 1 in root order) and the edges, at the file's coordinates. */
function truth(nodes: SwcNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rootOf = (n: SwcNode): SwcNode => (n.parent === -1 ? n : rootOf(byId.get(n.parent)!));
  const roots = nodes.filter((n) => n.parent === -1);
  const tree = new Map<string, number>();
  const edges = new Map<number, string[]>();
  for (const n of nodes) {
    const id = roots.indexOf(rootOf(n)) + 1;
    tree.set(pkey(n.position), id);
    if (n.parent === -1) continue;
    if (!edges.has(id)) edges.set(id, []);
    edges.get(id)!.push(undirected(pkey(n.position), pkey(byId.get(n.parent)!.position)));
  }
  return { roots, tree, edges };
}

describe("virtual skeleton store", () => {
  for (const name of ["neuron_a.swc", "neuron_b.swc", "two_trees.swc", "forest.swc"]) {
    it(`serves ${name}: every node and edge, each tree an object`, async () => {
      const nodes = parseSwc(text(name));
      const t = truth(nodes);
      const store = skeletonStore(parseSwc(text(name)), name);
      const a = access(store);
      const zv = await openZarrVectorsStore(a as never, undefined);
      const d = zv.description;
      const off = zv.coordinateOffset ?? [0, 0, 0];
      expect(d.geometryKind).toBe("skeleton");
      expect(d.skeletonLayout).toBe("linked");
      expect(d.hasObjects).toBe(true);
      expect(d.attributes.map((x) => x.name).sort()).toEqual(["compartment", "radius"]);
      const radiusSlot = d.attributes.findIndex((x) => x.name === "radius");
      const radiusOf = new Map(nodes.map((n) => [pkey(n.position), n.radius]));
      const all = [...t.edges.values()].flat().sort();

      for (const bridges of [true, false]) {
        const data = (await new LevelPipeline(a as never, d, zv.levels[0]).download([0, 0, 0], signal, { bridges }))!;
        expect(data.numOwnVertices).toBe(nodes.length);
        const got: string[] = [];
        for (let v = 0; v < data.numOwnVertices; ++v) {
          const k = pkey(at(data.positions, v, off));
          expect(idOf(data.segmentIds, v), k).toBe(t.tree.get(k));
          expect(data.attributes[radiusSlot][v]).toBe(Math.fround(radiusOf.get(k)!));
        }
        for (let i = 0; i < data.edges.length; i += 2) got.push(undirected(pkey(at(data.positions, data.edges[i], off)), pkey(at(data.positions, data.edges[i + 1], off))));
        expect(got.sort()).toEqual(all);
      }

      const reader = new ObjectReader(a as never, d, zv.levels[0]);
      for (let id = 1; id <= t.roots.length; ++id) {
        const sk = await reader.readSkeleton(BigInt(id), signal);
        const got: string[] = [];
        for (let i = 0; i < sk.edges.length; i += 2) got.push(undirected(pkey(at(sk.positions, sk.edges[i], off)), pkey(at(sk.positions, sk.edges[i + 1], off))));
        expect(got.sort(), `tree ${id}`).toEqual([...(t.edges.get(id) ?? [])].sort());
        const mine = Array.from({ length: sk.positions.length / 3 }, (_, v) => pkey(at(sk.positions, v, off))).sort();
        expect(mine).toEqual(nodes.filter((n) => t.tree.get(pkey(n.position)) === id).map((n) => pkey(n.position)).sort());
      }

      const table = (await readObjectTable(a as never, "0"))!;
      expect([...table.segmentIds].map(Number)).toEqual(t.roots.map((_, i) => i + 1));
      const props = (await readSegmentProperties(a as never, "0", table, []))!;
      expect(props.properties.map((p) => p.id).sort()).toEqual(["branch_points", "cable_length", "nodes"]);
      const count = props.properties.find((p) => p.id === "nodes") as unknown as { values: ArrayLike<number> };
      expect(Array.from(count.values)).toEqual(t.roots.map((_, i) => nodes.filter((n) => t.tree.get(pkey(n.position)) === i + 1).length));
    });
  }

  it("puts SWC in micrometres and moves it into one cell", async () => {
    const store = skeletonStore(parseSwc(text("forest.swc")), "forest");
    const root = JSON.parse(new TextDecoder().decode((await store.get("zarr.json"))!)).attributes;
    expect(root.multiscales[0].axes[0].unit).toBe("micrometer");
    expect(root.zarr_vectors.coordinate_offset).toEqual([10, 10, 10]);
    expect(root.zarr_vectors.chunk_shape).toEqual([64, 64, 64]);
    expect(await store.get("0/groups/zarr.json")).toBeUndefined();
    expect(await store.get("0/fragment_attributes/segment_id/zarr.json")).toBeUndefined();
  });

  it("refuses parents in a cycle", () => {
    expect(() => skeletonStore(parseSwc("1 1 0 0 0 1 2\n2 1 1 0 0 1 1\n"), "loop")).toThrow(/cycle/);
  });
});

describe("virtual point store", () => {
  for (const name of ["points.csv", "points.xyz"]) {
    it(`serves ${name}: every point, its values, each point an object`, async () => {
      const table = parsePointTable(text(name));
      const store = pointStore(parsePointTable(text(name)), name);
      const a = access(store);
      const zv = await openZarrVectorsStore(a as never, undefined);
      const d = zv.description;
      const off = zv.coordinateOffset ?? [0, 0, 0];
      expect(d.geometryKind).toBe("point_cloud");
      expect(d.attributes.map((x) => x.name)).toEqual(table.columns.map((c) => c.name));
      const data = (await new LevelPipeline(a as never, d, zv.levels[0]).download([0, 0, 0], signal, { bridges: false }))!;
      const n = table.positions.length / 3;
      expect(data.numOwnVertices).toBe(n);
      for (let v = 0; v < n; ++v) {
        expect(pkey(at(data.positions, v, off))).toBe(pkey(table.positions.subarray(3 * v, 3 * v + 3)));
        expect(idOf(data.segmentIds, v)).toBe(v + 1);
        table.columns.forEach((c, slot) => expect(data.attributes[slot][v]).toBe(c.values[v]));
      }
      const table_ = (await readObjectTable(a as never, "0"))!;
      expect([...table_.segmentIds].map(Number)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      if (table.columns.length > 0) {
        const props = (await readSegmentProperties(a as never, "0", table_, []))!;
        expect(props.properties.map((p) => p.id).filter((id) => !id.startsWith("label"))).toEqual(table.columns.map((c) => c.name).filter((c) => c !== "label"));
      }
    });
  }

  it("draws a large table's points without making each an object", async () => {
    const n = MAX_POINT_OBJECTS + 1;
    const positions = new Float64Array(3 * n);
    for (let i = 0; i < positions.length; ++i) positions[i] = (i * 7919) % 1000;
    const store = pointStore({ positions, columns: [] }, "big");
    const a = access(store);
    const zv = await openZarrVectorsStore(a as never, undefined);
    expect(zv.description.hasObjects).toBe(false);
    const data = (await new LevelPipeline(a as never, zv.description, zv.levels[0]).download([0, 0, 0], signal, { bridges: false }))!;
    expect(data.numOwnVertices).toBe(n);
  });
});
