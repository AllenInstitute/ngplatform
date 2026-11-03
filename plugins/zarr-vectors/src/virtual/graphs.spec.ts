/**
 * Virtual graph stores (GraphML, edge lists), read by this package's own
 * reader as the viewer reads them: every node with its component's id,
 * every edge once (cycles included), the per-node values and the
 * component table.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSegmentProperties } from "../objects.js";
import { LevelPipeline, openZarrVectorsStore, readObjectTable, ShardIndexCache } from "../reader.js";
import { graphStore, parseEdgeList, parseGraphml, splitEdgeList } from "../../../../src/virtual/vectors/graphs.js";
import type { CellStore } from "../../../../src/virtual/vectors/points.js";

const DIR = path.resolve(import.meta.dirname, "../../../../tests/testdata/graphs");
const text = (name: string) => fs.readFileSync(path.join(DIR, name), "utf8");
const signal = new AbortController().signal;

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

const key = (p: ArrayLike<number>, v: number, off: number[]) => [0, 1, 2].map((k) => (p[3 * v + k] + off[k]).toFixed(2)).join(",");
const undirected = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const idOf = (ids: Uint32Array, v: number) => Number(BigInt(ids[2 * v]) | (BigInt(ids[2 * v + 1]) << 32n));

async function serve(store: CellStore) {
  const a = access(store);
  const zv = await openZarrVectorsStore(a as never, undefined);
  const data = (await new LevelPipeline(a as never, zv.description, zv.levels[0]).download([0, 0, 0], signal, { bridges: true }))!;
  return { a, zv, data, off: zv.coordinateOffset ?? [0, 0, 0] };
}

describe("virtual graph store", () => {
  it("reads GraphML as networkx wrote it: positions, every edge of a cycle, values per node", async () => {
    const graph = parseGraphml(text("cycle.graphml"));
    expect(graph.positions.length).toBe(18);
    expect(graph.edges.length).toBe(12);
    expect(graph.columns.map((c) => c.name)).toEqual(["radius"]);
    const { a, zv, data, off } = await serve(graphStore(graph, "cycle"));
    expect(zv.description.geometryKind).toBe("graph");
    expect(data.numOwnVertices).toBe(6);
    const edges: string[] = [];
    for (let i = 0; i < data.edges.length; i += 2) edges.push(undirected(key(data.positions, data.edges[i], off), key(data.positions, data.edges[i + 1], off)));
    const p = (x: number, y: number, z: number) => [x, y, z].map((v) => v.toFixed(2)).join(",");
    const want = [
      [p(0, 0, 0), p(10, 0, 0)],
      [p(10, 0, 0), p(10, 10, 0)],
      [p(10, 10, 0), p(0, 10, 5)],
      [p(0, 10, 5), p(0, 0, 0)],
      [p(0, 0, 0), p(10, 10, 0)],
      [p(50, 50, 50), p(60, 50, 50)],
    ].map(([u, v]) => undirected(u, v));
    expect(edges.sort()).toEqual(want.sort());
    // Two components: the square with its diagonal, and the pair.
    for (let v = 0; v < data.numOwnVertices; ++v) expect(idOf(data.segmentIds, v)).toBe(data.positions[3 * v] + off[0] >= 50 ? 2 : 1);
    const degree = zv.description.attributes.findIndex((x) => x.name === "degree");
    const first = Array.from({ length: 6 }, (_, v) => v).find((v) => key(data.positions, v, off) === p(0, 0, 0))!;
    expect(data.attributes[degree][first]).toBe(3);
    const table = (await readObjectTable(a as never, "0"))!;
    const props = (await readSegmentProperties(a as never, "0", table, []))!;
    const edgesOf = props.properties.find((x) => x.id === "edges") as unknown as { values: ArrayLike<number> };
    expect(Array.from(edgesOf.values)).toEqual([5, 1]);
  });

  it("reads an edge list with its node table, leaving out edges to nodes it does not have", async () => {
    const both = `${text("net_edges.csv")}\n# @file net_nodes.csv\n${text("net_nodes.csv")}`;
    const { edges, nodes } = splitEdgeList(both);
    const graph = parseEdgeList(edges, nodes);
    expect(graph.unit).toBe("micrometer");
    expect(Array.from(graph.edges)).toEqual([0, 1, 1, 2, 2, 0]);
    expect(graph.columns.map((c) => c.name)).toEqual(["score"]);
    const { zv, data } = await serve(graphStore(graph, "net"));
    expect(zv.description.geometryKind).toBe("graph");
    expect(data.numOwnVertices).toBe(4);
    expect(data.edges.length).toBe(6);
    expect(() => splitEdgeList(text("net_edges.csv"))).toThrow(/node table/);
  });
});

describe("graph export", () => {
  it("writes GraphML that reads back to the same graph", async () => {
    const { graphmlFile } = await import("../../../../src/virtual/out/vectors.js");
    const graph = parseGraphml(text("cycle.graphml"));
    const back = parseGraphml(new TextDecoder().decode(graphmlFile(graph.positions, graph.edges, graph.columns)));
    expect(Array.from(back.positions)).toEqual(Array.from(graph.positions));
    expect(Array.from(back.edges)).toEqual(Array.from(graph.edges));
    expect(back.columns).toEqual(graph.columns);
  });
});
