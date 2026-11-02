/**
 * Points and skeletons from text files: SWC neuron morphologies (`n type x
 * y z radius parent` per line) and delimited point tables (.csv, .tsv, .xyz:
 * x, y, z columns by name or the first three, other numeric columns kept as
 * per-point values).
 */

export interface SwcNode {
  id: number;
  type: number;
  position: [number, number, number];
  radius: number;
  /** The parent's id, -1 for a root. */
  parent: number;
}

export function parseSwc(text: string): SwcNode[] {
  const nodes: SwcNode[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length < 7 || p.slice(0, 7).some((v) => !Number.isFinite(v))) throw new Error(`not an SWC line: ${line}`);
    nodes.push({ id: p[0], type: p[1], position: [p[2], p[3], p[4]], radius: p[5], parent: p[6] });
  }
  if (nodes.length === 0) throw new Error("an SWC file without nodes");
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parent !== -1 && !ids.has(n.parent)) throw new Error(`node ${n.id}'s parent ${n.parent} is not in the file`);
  return nodes;
}

export interface PointTable {
  /** x y z per point. */
  positions: Float32Array;
  /** Other numeric columns, one value per point. */
  columns: { name: string; values: Float32Array }[];
}

/** A delimited table of points: comma, tab or space separated, with or without a header row. */
export function parsePointTable(text: string): PointTable {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("a point table without rows");
  const delimiter = lines[0].includes(",") ? "," : lines[0].includes("\t") ? "\t" : /\s+/;
  const split = (l: string) => l.split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  const first = split(lines[0]);
  const header = first.some((c) => c !== "" && !Number.isFinite(Number(c)));
  const names = header ? first : first.map((_, i) => `column${i}`);
  const rows = (header ? lines.slice(1) : lines).map(split);
  const lower = names.map((n) => n.toLowerCase());
  const find = (axis: string) => lower.findIndex((n) => n === axis || n === `${axis}_position` || n === `position_${axis}` || n === `${axis}_um` || n === `${axis}_mm` || n === `centroid_${axis}`);
  let axes = ["x", "y", "z"].map(find);
  if (axes.some((i) => i === -1)) axes = [0, 1, 2];
  if (names.length < 3) throw new Error("a point table needs three columns (x, y, z)");
  const positions = new Float32Array(3 * rows.length);
  rows.forEach((r, i) => axes.forEach((a, k) => (positions[3 * i + k] = Number(r[a]))));
  if (positions.some((v) => !Number.isFinite(v))) throw new Error("a point table with x, y or z values that are not numbers");
  const columns: PointTable["columns"] = [];
  names.forEach((name, c) => {
    if (axes.includes(c)) return;
    const values = Float32Array.from(rows, (r) => Number(r[c]));
    // Text columns (cell types, labels) are left out.
    if (values.some((v) => !Number.isFinite(v))) return;
    columns.push({ name: name.replace(/[^A-Za-z0-9_]/g, "_") || `column${c}`, values });
  });
  return { positions, columns };
}
