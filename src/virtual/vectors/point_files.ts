/**
 * Points and skeletons from text files: SWC neuron morphologies (`n type x
 * y z radius parent` per line) and delimited point tables (.csv, .tsv, .xyz:
 * x, y, z columns by name or the first three, other numeric columns kept as
 * per-point values).  As zarr-vectors-tools reads them, except that a
 * table's x, y and z are found by name, and text columns are left out.
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
    // zarr-vectors-tools skips short lines too.
    if (p.length < 7) continue;
    if (p.slice(0, 7).some((v) => !Number.isFinite(v))) throw new Error(`not an SWC line: ${line}`);
    nodes.push({ id: p[0], type: p[1], position: [p[2], p[3], p[4]], radius: p[5], parent: p[6] });
  }
  if (nodes.length === 0) throw new Error("an SWC file without nodes");
  const ids = new Set<number>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new Error(`node ${n.id} appears twice`);
    ids.add(n.id);
  }
  // A parent not in the file makes a root, as in zarr-vectors-tools.
  for (const n of nodes) if (!ids.has(n.parent)) n.parent = -1;
  return nodes;
}

/**
 * Several SWC files as one (a folder's `@all.swc`): each file's text after a
 * `# @file <name>` line.  Each file's ids are its own, so they are numbered
 * apart; a file that does not parse is left out and named in `skipped`.
 */
export function parseSwcCollection(text: string): { nodes: SwcNode[]; files: string[]; fileOf: Int32Array; skipped: string[] } {
  const parts = text.split(/^# @file (.*)$/m);
  const nodes: SwcNode[] = [];
  const files: string[] = [];
  const skipped: string[] = [];
  const owner: number[] = [];
  let base = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim();
    let mine: SwcNode[];
    try {
      mine = parseSwc(parts[i + 1]);
    } catch {
      skipped.push(name);
      continue;
    }
    const renumber = new Map(mine.map((n, k) => [n.id, base + k + 1]));
    for (const n of mine) {
      nodes.push({ ...n, id: renumber.get(n.id)!, parent: n.parent === -1 ? -1 : renumber.get(n.parent)! });
      owner.push(files.length);
    }
    files.push(name);
    base += mine.length;
  }
  if (nodes.length === 0) throw new Error("no SWC file in the folder could be read");
  return { nodes, files, fileOf: Int32Array.from(owner), skipped };
}

export interface PointTable {
  /** x y z per point. */
  positions: Float64Array;
  /** Other numeric columns, one value per point. */
  columns: { name: string; values: Float32Array }[];
  /** The positions' unit, when the x, y, z columns' names say it (x_um, x_mm, x_nm). */
  unit?: string;
}

/** A delimited table of points: comma, tab or space separated, with or without a header row. */
/** Whether a column's name says it is `axis` (x, y or z) of a point: x, x_position, x_location (10x Xenium), x_um, centroid_x … */
function coordinateName(lower: string, axis: string): boolean {
  return [axis, `${axis}_position`, `position_${axis}`, `${axis}_location`, `${axis}_um`, `${axis}_mm`, `${axis}_nm`, `centroid_${axis}`, `global_${axis}`].includes(lower);
}

/**
 * A Parquet table of points (spatial transcriptomics, cell tables, any
 * table with x, y and z columns): its numeric columns, read column by
 * column (hyparquet, with the usual compressions).  Text columns (gene
 * names, cell types) are left out, as from CSV.
 */
export async function parsePointParquet(file: Blob): Promise<PointTable> {
  const { parquetMetadataAsync, parquetRead, parquetSchema } = await import("hyparquet/src/index.js");
  const { compressors } = await import("hyparquet-compressors");
  const buffer = { byteLength: file.size, slice: (start: number, end?: number) => file.slice(start, end).arrayBuffer() };
  const metadata = await parquetMetadataAsync(buffer);
  const names: string[] = parquetSchema(metadata).children.map((c: { element: { name: string } }) => c.element.name);
  const rows = Number(metadata.num_rows);
  const lower = names.map((n) => n.toLowerCase());
  if (["x", "y"].some((a) => !lower.some((n) => coordinateName(n, a)))) throw new Error("a Parquet table of points needs x and y columns (x, x_location, x_um …)");
  const values = new Map<string, Float64Array>();
  const numeric = new Set<string>();
  await parquetRead({
    file: buffer,
    metadata,
    compressors,
    onChunk: ({ columnName, columnData, rowStart }: { columnName: string; columnData: ArrayLike<unknown>; rowStart: number }) => {
      let column = values.get(columnName);
      if (column === undefined) values.set(columnName, (column = new Float64Array(rows).fill(Number.NaN)));
      for (let i = 0; i < columnData.length; ++i) {
        const v = columnData[i];
        const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : NaN;
        if (Number.isFinite(n)) numeric.add(columnName);
        column[rowStart + i] = n;
      }
    },
  });
  return pointTableOf(names, values, rows, numeric, "Parquet");
}

/**
 * A table read column by column (Parquet, Feather) as points: x, y and z
 * from the columns named so (a table without z lies in z = 0), every other
 * column with numbers a value per point (those with any missing left out).
 */
export function pointTableOf(names: string[], values: Map<string, Float64Array>, rows: number, numeric: Set<string>, format: string): PointTable {
  const lower = names.map((n) => n.toLowerCase());
  const axes = ["x", "y", "z"].map((a) => lower.findIndex((n) => coordinateName(n, a)));
  if (axes[0] === -1 || axes[1] === -1) throw new Error(`a ${format} table of points needs x and y columns (x, x_location, x_um …)`);
  const positions = new Float64Array(3 * rows);
  axes.forEach((a, k) => {
    // A flat table (no z) lies in the plane z = 0.
    const column = a === -1 ? undefined : values.get(names[a]);
    for (let i = 0; i < rows; ++i) positions[3 * i + k] = column?.[i] ?? 0;
  });
  if (positions.some((v) => !Number.isFinite(v))) throw new Error(`a ${format} table with x, y or z values that are not numbers`);
  const columns: PointTable["columns"] = [];
  names.forEach((name, c) => {
    if (axes.includes(c) || !numeric.has(name)) return;
    const column = values.get(name)!;
    if (column.some((v) => !Number.isFinite(v))) return;
    columns.push({ name: name.replace(/[^A-Za-z0-9_]/g, "_") || `col${c}`, values: Float32Array.from(column) });
  });
  const suffix = /_(um|mm|nm)$/.exec(lower[axes[0]])?.[1] ?? (/_location$/.test(lower[axes[0]]) ? "um" : undefined);
  const unit = suffix === undefined ? undefined : { um: "micrometer", mm: "millimeter", nm: "nanometer" }[suffix];
  return { positions, columns, unit };
}

export function parsePointTable(text: string): PointTable {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("a point table without rows");
  const delimiter = lines[0].includes(",") ? "," : lines[0].includes("\t") ? "\t" : /\s+/;
  const split = (l: string) => l.split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  const first = split(lines[0]);
  const header = first.some((c) => c !== "" && !Number.isFinite(Number(c)));
  const names = header ? first : first.map((_, i) => `col${i}`);
  const rows = (header ? lines.slice(1) : lines).map(split);
  const lower = names.map((n) => n.toLowerCase());
  const find = (axis: string) => lower.findIndex((n) => coordinateName(n, axis));
  let axes = ["x", "y", "z"].map(find);
  if (axes.some((i) => i === -1)) axes = [0, 1, 2];
  if (names.length < 3) throw new Error("a point table needs three columns (x, y, z)");
  const positions = new Float64Array(3 * rows.length);
  rows.forEach((r, i) => axes.forEach((a, k) => (positions[3 * i + k] = Number(r[a]))));
  if (positions.some((v) => !Number.isFinite(v))) throw new Error("a point table with x, y or z values that are not numbers");
  const columns: PointTable["columns"] = [];
  names.forEach((name, c) => {
    if (axes.includes(c)) return;
    const values = Float32Array.from(rows, (r) => Number(r[c]));
    // Text columns (cell types, labels) are left out.
    if (values.some((v) => !Number.isFinite(v))) return;
    columns.push({ name: name.replace(/[^A-Za-z0-9_]/g, "_") || `col${c}`, values });
  });
  const suffix = /_(um|mm|nm)$/.exec(lower[axes[0]] ?? "")?.[1];
  const unit = suffix === undefined ? undefined : { um: "micrometer", mm: "millimeter", nm: "nanometer" }[suffix];
  return { positions, columns, unit };
}

/**
 * An ASPRS LAS point cloud (versions 1.0 to 1.4, point formats 0 to 10):
 * the points' scaled and offset coordinates, with intensity and
 * classification as columns.  LAZ (compressed LAS) is decompressed to
 * LAS first (laz.ts).
 */
export function parseLas(bytes: Uint8Array): PointTable {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "LASF") throw new Error("not a LAS file (no LASF mark)");
  const headerSize = view.getUint16(94, true);
  const offset = view.getUint32(96, true);
  const rawFormat = view.getUint8(104);
  if (rawFormat & 0xc0) throw new Error("this LAS file is compressed (LAZ); name it .laz to have it decompressed");
  const format = rawFormat & 0x3f;
  const length = view.getUint16(105, true);
  let count = view.getUint32(107, true);
  // LAS 1.4 keeps a 64-bit count, and leaves the old one 0 when it does not fit.
  if (headerSize >= 375) count = Number(view.getBigUint64(247, true)) || count;
  count = Math.min(count, Math.floor((bytes.byteLength - offset) / length));
  const scale = [0, 1, 2].map((k) => view.getFloat64(131 + 8 * k, true));
  const shift = [0, 1, 2].map((k) => view.getFloat64(155 + 8 * k, true));
  const positions = new Float64Array(3 * count);
  const intensity = new Float32Array(count);
  const classification = new Float32Array(count);
  // Formats 6 to 10 keep the classification in its own byte; 0 to 5 in the low five bits of byte 15.
  const modern = format >= 6;
  for (let i = 0, at = offset; i < count; ++i, at += length) {
    for (let k = 0; k < 3; ++k) positions[3 * i + k] = view.getInt32(at + 4 * k, true) * scale[k] + shift[k];
    intensity[i] = view.getUint16(at + 12, true);
    classification[i] = modern ? view.getUint8(at + 16) : view.getUint8(at + 15) & 0x1f;
  }
  return {
    positions,
    columns: [
      { name: "intensity", values: intensity },
      { name: "classification", values: classification },
    ],
  };
}
