/**
 * Values on a surface's vertices, from the files FreeSurfer, Freeview and
 * GIFTI tools write beside a surface:
 *
 *  - morphometry (`?h.thickness`, `?h.curv`, `?h.sulc`, `?h.area`, `.crv`):
 *    FreeSurfer's "curv" files, the new format (magic FF FF FF, then
 *    big-endian int32 vertex count, face count and values per vertex, then
 *    float32 values) or the old one (3-byte vertex and face counts, int16
 *    hundredths), read as nibabel's `read_morph_data` reads them;
 *  - overlays as `.mgh` / `.mgz` with one value per vertex (width × height ×
 *    depth = the vertex count; the first frame);
 *  - parcellations: `.annot` (each vertex's packed colour, and the colour
 *    table naming them; codes are the table's rows, -1 for none, as
 *    nibabel's `read_annot`) and `.label` (a list of vertex numbers);
 *  - GIFTI data arrays other than the geometry (`.shape.gii`, `.func.gii`,
 *    `.label.gii` with its label table).
 */
import { parseMghHeader, MGH_HEADER } from "../images/mgh.js";
import { giftiArrays } from "./mesh_files.js";

/** A parcellation's entry: its code (the value on the vertices), name and colour (0..1, alpha 1 - T / 255). */
export interface SurfaceLabel {
  code: number;
  name: string;
  rgba: [number, number, number, number];
}

export interface SurfaceValues {
  /** One value per vertex, in the file's vertex order. */
  values: Float32Array;
  /** For a parcellation: what each code means. */
  labels?: SurfaceLabel[];
}

const NEW_CURV = 0xffffff;

const read3 = (bytes: Uint8Array, at: number) => (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];

/** The vertex count a morphometry file declares, from its first 15 bytes; undefined when it is not one. */
export function morphCount(head: Uint8Array): number | undefined {
  if (head.byteLength < 6) return undefined;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (read3(head, 0) === NEW_CURV) return head.byteLength >= 15 ? view.getInt32(3, false) : undefined;
  return read3(head, 0);
}

/** A FreeSurfer morphometry ("curv") file: one value per vertex. */
export function parseMorph(bytes: Uint8Array): SurfaceValues {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (read3(bytes, 0) === NEW_CURV) {
    const n = view.getInt32(3, false);
    const perVertex = view.getInt32(11, false);
    if (n < 0 || 15 + 4 * n * Math.max(1, perVertex) > bytes.byteLength) throw new Error("a morphometry file shorter than its vertex count says");
    const values = new Float32Array(n);
    // Several values per vertex is not something FreeSurfer writes; the first is kept.
    const stride = 4 * Math.max(1, perVertex);
    for (let i = 0; i < n; ++i) values[i] = view.getFloat32(15 + stride * i, false);
    return { values };
  }
  // The old format: 3-byte counts, then int16 hundredths.
  const n = read3(bytes, 0);
  if (6 + 2 * n > bytes.byteLength) throw new Error("not a FreeSurfer morphometry file");
  const values = new Float32Array(n);
  for (let i = 0; i < n; ++i) values[i] = view.getInt16(6 + 2 * i, false) / 100;
  return { values };
}

/** An overlay as MGH (decompressed): the first frame's values, one per vertex. */
export function parseMghValues(bytes: Uint8Array): SurfaceValues {
  const header = parseMghHeader(bytes);
  const n = header.dims[0] * header.dims[1] * header.dims[2];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = { 0: 1, 1: 4, 3: 4, 4: 2 }[header.type as 0 | 1 | 3 | 4];
  if (size === undefined) throw new Error(`MGH voxel type ${header.type} is not read (uchar, short, int and float are)`);
  if (MGH_HEADER + size * n > bytes.byteLength) throw new Error("an MGH file shorter than its header says");
  const values = new Float32Array(n);
  for (let i = 0; i < n; ++i) {
    const at = MGH_HEADER + size * i;
    values[i] = header.type === 0 ? bytes[at] : header.type === 1 ? view.getInt32(at, false) : header.type === 3 ? view.getFloat32(at, false) : view.getInt16(at, false);
  }
  return { values };
}

/** The vertex count an MGH overlay holds (its voxels), from its header. */
export function mghCount(header: Uint8Array): number | undefined {
  try {
    const h = parseMghHeader(header);
    return h.dims[0] * h.dims[1] * h.dims[2];
  } catch {
    return undefined;
  }
}

/** The vertex count an annotation declares, from its first 4 bytes. */
export function annotCount(head: Uint8Array): number | undefined {
  if (head.byteLength < 4) return undefined;
  return new DataView(head.buffer, head.byteOffset, head.byteLength).getInt32(0, false);
}

/**
 * A FreeSurfer annotation: each vertex's code is the colour table's row with
 * its packed colour (r + g·256 + b·65536), -1 where it has none (0) or a
 * colour not in the table.
 */
export function parseAnnot(bytes: Uint8Array): SurfaceValues {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const i32 = () => {
    const v = view.getInt32(at, false);
    at += 4;
    return v;
  };
  const text = (n: number) => {
    const s = new TextDecoder("latin1").decode(bytes.subarray(at, at + n)).replace(/\0.*$/s, "");
    at += n;
    return s;
  };
  const n = i32();
  if (n < 0 || 4 + 8 * n > bytes.byteLength) throw new Error("not a FreeSurfer annotation");
  const packed = new Int32Array(n);
  for (let i = 0; i < n; ++i) {
    const vertex = i32();
    const value = i32();
    packed[vertex >= 0 && vertex < n ? vertex : i] = value;
  }
  if (at + 4 > bytes.byteLength || i32() === 0) throw new Error("an annotation without its colour table");
  const rows: { name: string; rgbt: number[] }[] = [];
  const first = i32();
  if (first > 0) {
    // The old colour table: entries in order.
    text(i32());
    for (let r = 0; r < first; ++r) {
      const name = text(i32());
      rows.push({ name, rgbt: [i32(), i32(), i32(), i32()] });
    }
  } else {
    if (-first !== 2) throw new Error(`an annotation colour table of version ${-first} (2 is read)`);
    const size = i32();
    for (let r = 0; r < size; ++r) rows.push({ name: "", rgbt: [0, 0, 0, 0] });
    text(i32());
    const entries = i32();
    for (let e = 0; e < entries; ++e) {
      const index = i32();
      const name = text(i32());
      const rgbt = [i32(), i32(), i32(), i32()];
      if (index >= 0 && index < size) rows[index] = { name, rgbt };
    }
  }
  const byColour = new Map<number, number>();
  rows.forEach((row, r) => {
    const key = row.rgbt[0] + row.rgbt[1] * 256 + row.rgbt[2] * 65536;
    if (row.name !== "" && !byColour.has(key)) byColour.set(key, r);
  });
  const values = new Float32Array(n);
  for (let i = 0; i < n; ++i) values[i] = packed[i] === 0 ? -1 : (byColour.get(packed[i]) ?? -1);
  const labels: SurfaceLabel[] = rows.flatMap((row, code) =>
    row.name === "" ? [] : [{ code, name: row.name, rgba: [row.rgbt[0] / 255, row.rgbt[1] / 255, row.rgbt[2] / 255, 1 - row.rgbt[3] / 255] as SurfaceLabel["rgba"] }],
  );
  return { values, labels };
}

/** A FreeSurfer `.label` file's vertex numbers (its first column), in order. */
export function parseLabelVertices(text: string): Int32Array {
  const lines = text.split("\n");
  // A comment line, the count, then "vertex x y z value" per line.
  const count = Number.parseInt(lines[1] ?? "", 10);
  if (!Number.isFinite(count) || count < 0) throw new Error("not a FreeSurfer label file");
  const out = new Int32Array(count);
  for (let i = 0; i < count; ++i) {
    const v = Number.parseInt((lines[2 + i] ?? "").trim().split(/\s+/)[0], 10);
    if (!Number.isFinite(v)) throw new Error(`a label file with ${i} of its ${count} vertices`);
    out[i] = v;
  }
  return out;
}

/** Distinct colours for labels that bring none (`.label` files): hues a golden angle apart. */
export function labelColour(i: number): [number, number, number, number] {
  const h = (i * 0.618033988749895) % 1;
  const k = (n: number) => (n + h * 6) % 6;
  // HSV (h, 0.65, 0.9) to RGB.
  const f = (n: number) => 0.9 - 0.585 * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1), 1];
}

/**
 * Several `.label` files as one parcellation: each vertex takes the smallest
 * label it is in, so a label inside another (V1 in cortex) still shows;
 * codes are the files' order, -1 outside them all.
 */
export function combineLabels(vertexCount: number, labels: { name: string; vertices: Int32Array }[]): SurfaceValues {
  const values = new Float32Array(vertexCount).fill(-1);
  const order = labels.map((l, code) => ({ ...l, code })).sort((a, b) => b.vertices.length - a.vertices.length);
  for (const { vertices, code } of order) for (const v of vertices) if (v >= 0 && v < vertexCount) values[v] = code;
  return { values, labels: labels.map((l, code) => ({ code, name: l.name, rgba: labelColour(code) })) };
}

/** Intents of GIFTI arrays that are geometry, not values. */
const GEOMETRY = new Set(["NIFTI_INTENT_POINTSET", "NIFTI_INTENT_TRIANGLE", "NIFTI_INTENT_VECTOR", "NIFTI_INTENT_GENMATRIX"]);

/**
 * A GIFTI file's per-vertex data arrays (shape, functional, label), each
 * with its name (its `Name` metadata, else `name` and its number); a label
 * array brings the file's label table.
 */
export async function parseGiftiValues(text: string, name: string): Promise<{ name: string; data: SurfaceValues }[]> {
  const arrays = (await giftiArrays(text)).filter((a) => !GEOMETRY.has(a.intent));
  let labels: SurfaceLabel[] | undefined;
  const table = /<LabelTable>([\s\S]*?)<\/LabelTable>/.exec(text)?.[1];
  if (table !== undefined) {
    labels = [];
    for (const m of table.matchAll(/<Label\b([^>]*)>([\s\S]*?)<\/Label>/g)) {
      const attr = (key: string, fallback: number) => Number(new RegExp(`${key}\\s*=\\s*"([^"]*)"`).exec(m[1])?.[1] ?? fallback);
      const labelName = m[2].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
      labels.push({ code: attr("Key", attr("Index", labels.length)), name: labelName, rgba: [attr("Red", 0), attr("Green", 0), attr("Blue", 0), attr("Alpha", 1)] });
    }
  }
  const out: { name: string; data: SurfaceValues }[] = [];
  arrays.forEach((a, i) => {
    // A 2-D array (vertices × maps) gives one map per column.
    const columns = a.dims[1] > 1 ? a.dims[1] : 1;
    for (let c = 0; c < columns; ++c) {
      const values = new Float32Array(a.dims[0]);
      for (let v = 0; v < a.dims[0]; ++v) values[v] = a.values[v * columns + c];
      const base = a.name || (arrays.length > 1 ? `${name}_${i + 1}` : name);
      out.push({ name: columns > 1 ? `${base}_${c + 1}` : base, data: a.intent === "NIFTI_INTENT_LABEL" ? { values, labels } : { values } });
    }
  });
  return out;
}

/** The vertex count of a GIFTI file's first per-vertex array, from the start of the file (its tags come before the data). */
export function giftiCount(head: string): number | undefined {
  for (const m of head.matchAll(/<DataArray\b([^>]*)>/g)) {
    const intent = /Intent\s*=\s*"([^"]*)"/.exec(m[1])?.[1] ?? "";
    if (GEOMETRY.has(intent) && intent !== "NIFTI_INTENT_POINTSET") continue;
    const dim = /Dim0\s*=\s*"(\d+)"/.exec(m[1]);
    if (dim !== null) return Number(dim[1]);
  }
  return undefined;
}
