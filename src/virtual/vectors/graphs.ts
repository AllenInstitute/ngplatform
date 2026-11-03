/**
 * Graphs with node positions, as zarr-vectors-tools ingests them: GraphML
 * (node positions in `x`, `y`, `z` data) and edge lists (a table of
 * `source, target` beside a node table of `node_id, x, y, z`).  Served as a
 * zarr-vectors graph store: one object per connected component, its nodes
 * in order, every edge an explicit link; each node's other numeric values
 * and its degree as values per node.
 */
import type { PointTable } from "./point_files.js";
import { CellStore } from "./points.js";

export interface Graph {
  /** x y z per node. */
  positions: Float64Array;
  /** Node index pairs, one per edge. */
  edges: Int32Array;
  /** Other numeric values per node. */
  columns: PointTable["columns"];
  unit?: string;
}

const AXES = ["x", "y", "z"];

const unescape = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (_, name: string, dec?: string, hex?: string) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()],
  );

const attributes = (tag: string): Map<string, string> => new Map([...tag.matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map((m) => [m[1], unescape(m[3] ?? m[4])]));

/**
 * A GraphML file's first graph: its nodes (positions from the node keys
 * named x, y and z), edges, and the other numeric node values.  Read with
 * patterns rather than an XML parser (workers have none); nested graphs and
 * hyperedges are not read.
 */
export function parseGraphml(text: string): Graph {
  const keys = new Map<string, { name: string; for: string }>();
  for (const m of text.matchAll(/<key\b([^>]*?)\/?>/g)) {
    const a = attributes(m[1]);
    const id = a.get("id");
    if (id !== undefined) keys.set(id, { name: a.get("attr.name") ?? id, for: a.get("for") ?? "all" });
  }
  const nodeIndex = new Map<string, number>();
  const values: Map<string, string>[] = [];
  for (const m of text.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const id = attributes(m[1]).get("id");
    if (id === undefined || nodeIndex.has(id)) continue;
    nodeIndex.set(id, values.length);
    const data = new Map<string, string>();
    for (const d of (m[3] ?? "").matchAll(/<data\b([^>]*?)>([\s\S]*?)<\/data>/g)) {
      const key = attributes(d[1]).get("key");
      if (key !== undefined) data.set(keys.get(key)?.name ?? key, unescape(d[2].trim()));
    }
    values.push(data);
  }
  if (values.length === 0) throw new Error("a GraphML file without nodes");
  const edges: number[] = [];
  for (const m of text.matchAll(/<edge\b([^>]*?)(\/>|>)/g)) {
    const a = attributes(m[1]);
    const s = nodeIndex.get(a.get("source") ?? "");
    const t = nodeIndex.get(a.get("target") ?? "");
    if (s !== undefined && t !== undefined) edges.push(s, t);
  }
  const names = [...new Set(values.flatMap((v) => [...v.keys()]))];
  const axis = (k: string) => names.find((n) => n.toLowerCase() === k) ?? names.find((n) => n.toLowerCase() === `pos_${k}` || n.toLowerCase() === `${k}_position`);
  const axes = AXES.map(axis);
  if (axes.some((a) => a === undefined)) throw new Error("GraphML nodes need x, y and z values for their positions");
  const positions = new Float64Array(3 * values.length);
  values.forEach((v, i) => axes.forEach((a, k) => (positions[3 * i + k] = Number(v.get(a!) ?? 0))));
  const columns = names
    .filter((n) => !axes.includes(n))
    .map((name) => ({ name: name.replace(/[^A-Za-z0-9_]/g, "_"), values: Float32Array.from(values, (v) => Number(v.get(name) ?? 0)) }))
    .filter((c) => c.values.every(Number.isFinite));
  return { positions, edges: Int32Array.from(edges), columns };
}

/** A delimited table with a header row: its column names and rows of text. */
function table(text: string, what: string): { names: string[]; rows: string[][] } {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length < 2) throw new Error(`${what} needs a header row and at least one row`);
  const delimiter = lines[0].includes(",") ? "," : lines[0].includes("\t") ? "\t" : /\s+/;
  const split = (l: string) => l.split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  return { names: split(lines[0]), rows: lines.slice(1).map(split) };
}

const column = (names: string[], candidates: string[]) => {
  const lower = names.map((n) => n.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
};

/**
 * An edge list (`source, target`, as zarr-vectors-tools reads it; also
 * src/dst, from/to, u/v) with its node table (`node_id, x, y, z`; also id,
 * node, name), matched by id.  Edges naming nodes not in the table are left
 * out.
 */
export function parseEdgeList(edgesText: string, nodesText: string): Graph {
  const nodes = table(nodesText, "the node table");
  const idAt = column(nodes.names, ["node_id", "id", "node", "name", "vertex", "vertex_id"]);
  const axes = AXES.map((k) => column(nodes.names, [k, `${k}_position`, `pos_${k}`, `${k}_um`, `${k}_mm`, `${k}_nm`]));
  if (axes.some((a) => a === -1)) throw new Error("the node table needs x, y and z columns");
  const index = new Map<string, number>();
  nodes.rows.forEach((r, i) => index.set(idAt === -1 ? String(i) : r[idAt], i));
  const positions = new Float64Array(3 * nodes.rows.length);
  nodes.rows.forEach((r, i) => axes.forEach((a, k) => (positions[3 * i + k] = Number(r[a]))));
  if (positions.some((v) => !Number.isFinite(v))) throw new Error("the node table has x, y or z values that are not numbers");
  const columns = nodes.names
    .map((name, c) => ({ c, name }))
    .filter(({ c }) => c !== idAt && !axes.includes(c))
    .map(({ c, name }) => ({ name: name.replace(/[^A-Za-z0-9_]/g, "_") || `col${c}`, values: Float32Array.from(nodes.rows, (r) => Number(r[c])) }))
    .filter((col) => col.values.every(Number.isFinite));
  const list = table(edgesText, "the edge list");
  let s = column(list.names, ["source", "src", "from", "u", "node1", "start"]);
  let t = column(list.names, ["target", "dst", "to", "v", "node2", "end"]);
  if (s === -1 || t === -1) [s, t] = [0, 1];
  const edges: number[] = [];
  for (const r of list.rows) {
    const a = index.get(r[s]);
    const b = index.get(r[t]);
    if (a !== undefined && b !== undefined) edges.push(a, b);
  }
  const suffix = /_(um|mm|nm)$/.exec(nodes.names[axes[0]].toLowerCase())?.[1];
  return { positions, edges: Int32Array.from(edges), columns, unit: suffix === undefined ? undefined : { um: "micrometer", mm: "millimeter", nm: "nanometer" }[suffix] };
}

/** The edge list and node table as the worker gets them: the edges, then `# @file <name>` and the nodes. */
export function splitEdgeList(text: string): { edges: string; nodes: string } {
  const at = /^# @file .*$/m.exec(text);
  if (at === null) throw new Error("an edge list needs its node table (node_id, x, y, z) beside it, named as it is with nodes for edges (graph_edges.csv and graph_nodes.csv)");
  return { edges: text.slice(0, at.index), nodes: text.slice(at.index + at[0].length) };
}

/** A graph as a zarr-vectors graph store: one object per connected component. */
export function graphStore(graph: Graph, name: string): CellStore {
  const n = graph.positions.length / 3;
  const { edges } = graph;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const degree = new Float32Array(n);
  for (let e = 0; e < edges.length; e += 2) {
    degree[edges[e]] += 1;
    degree[edges[e + 1]] += 1;
    parent[find(edges[e])] = find(edges[e + 1]);
  }
  // Components in order of their first node; each one's nodes in file order.
  const componentOf = new Map<number, number>();
  const members: number[][] = [];
  for (let i = 0; i < n; ++i) {
    const root = find(i);
    let c = componentOf.get(root);
    if (c === undefined) {
      componentOf.set(root, (c = members.length));
      members.push([]);
    }
    members[c].push(i);
  }
  const order = members.flat();
  const rowOf = new Int32Array(n);
  order.forEach((i, row) => (rowOf[i] = row));
  const positions = new Float64Array(3 * n);
  order.forEach((i, row) => positions.set(graph.positions.subarray(3 * i, 3 * i + 3), 3 * row));
  const reorder = (values: Float32Array) => Float32Array.from(order, (i) => values[i]);
  const edgeCount = new Float32Array(members.length);
  const links = new Int32Array(edges.length);
  for (let e = 0; e < edges.length; e += 2) {
    links[e] = rowOf[edges[e]];
    links[e + 1] = rowOf[edges[e + 1]];
    edgeCount[componentOf.get(find(edges[e]))!] += 1;
  }
  return new CellStore(
    {
      kind: "graph",
      positions,
      objectRows: members.map((m) => m.length),
      vertexAttributes: [{ name: "degree", values: reorder(degree) }, ...graph.columns.filter((c) => c.name !== "degree").map((c) => ({ name: c.name, values: reorder(c.values) }))],
      objectColumns: [
        { name: "nodes", values: Float32Array.from(members, (m) => m.length) },
        { name: "edges", values: edgeCount },
      ],
      links,
      unit: graph.unit,
    },
    name,
  );
}
