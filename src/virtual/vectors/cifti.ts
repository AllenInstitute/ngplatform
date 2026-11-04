/**
 * CIFTI-2 values on a surface (HCP's `.dscalar.nii` and `.dlabel.nii`): a
 * NIfTI-2 file whose XML extension says which vertices of which surface
 * each column is (brain models), and what each row is (a named map, with a
 * label table for a parcellation).  A hemisphere's surface takes the
 * columns of its cortex: each map becomes values on its vertices, the
 * vertices not in it (the medial wall) NaN, or 0 for labels.  Rows vary
 * fastest in the file (NIfTI order), so a map is read in one pass.  A
 * time series (`.dtseries.nii`) gives each vertex's mean and standard
 * deviation over time, read a few thousand columns at a time: each
 * structure's columns are contiguous, so only its part of the file is read;
 * and its values at one time point (`CiftiSeries`), for stepping through
 * time, or at one vertex at every time point (its column), for plotting.
 */
import type { SurfaceLabel, SurfaceValues } from "./surface_values.js";

/** A CIFTI file's names: dense scalars, labels and time series. */
export const CIFTI_FILE = /\.d(scalar|label|tseries)\.nii$/i;

export interface CiftiModel {
  structure: string;
  offset: number;
  count: number;
  /** For surfaces: the surface's vertex count and which of its vertices the columns are. */
  surfaceVertices?: number;
  vertices?: Int32Array;
}

export interface CiftiHeader {
  /** Where the values start, their NIfTI data type, and the matrix's rows (maps) and columns. */
  offset: number;
  datatype: number;
  littleEndian: boolean;
  rows: number;
  columns: number;
  /** Each row's name, and for labels, its table (none for a time series). */
  maps: { name: string; labels?: SurfaceLabel[] }[];
  /** The rows are time points (a series), not maps. */
  series: boolean;
  /** A series' time points: the first's time and the step, with their unit ("second"; the file's SeriesExponent applied). */
  seriesAxis?: { start: number; step: number; unit: string };
  models: CiftiModel[];
}

/** The hemisphere's cortex, as CIFTI names it. */
export const CORTEX: Record<string, string> = { L: "CIFTI_STRUCTURE_CORTEX_LEFT", R: "CIFTI_STRUCTURE_CORTEX_RIGHT" };

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The header and XML of a CIFTI-2 file, from its bytes up to the values (`vox_offset`). */
export function parseCiftiHeader(bytes: Uint8Array): CiftiHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getInt32(0, true) === 540;
  if (!little && view.getInt32(0, false) !== 540) throw new Error("not a CIFTI-2 file (CIFTI-2 is NIfTI-2)");
  const dim = Array.from({ length: 8 }, (_, k) => Number(view.getBigInt64(16 + 8 * k, little)));
  const datatype = view.getInt16(12, little);
  const offset = Number(view.getBigInt64(168, little));
  // Extensions after the 540-byte header and its 4 flag bytes: code 32 holds the XML.
  let xml: string | undefined;
  for (let at = 544; at + 8 <= Math.min(offset, bytes.byteLength); ) {
    const size = view.getInt32(at, little);
    const code = view.getInt32(at + 4, little);
    if (size < 8) break;
    if (code === 32) xml = new TextDecoder().decode(bytes.subarray(at + 8, Math.min(at + size, bytes.byteLength))).replace(/\0+$/, "");
    at += size;
  }
  if (xml === undefined) throw new Error("no CIFTI XML extension");
  const maps: CiftiHeader["maps"] = [];
  const models: CiftiModel[] = [];
  let series = false;
  let seriesAxis: CiftiHeader["seriesAxis"];
  // A map with nothing inside (a series) is written self-closed.
  for (const m of xml.matchAll(/<MatrixIndicesMap\b([^>]*?)(?:\/>|>([\s\S]*?)<\/MatrixIndicesMap>)/g)) {
    const body = m[2] ?? "";
    const applies = (attr(m[1], "AppliesToMatrixDimension") ?? "").split(",").map((s) => Number(s.trim()));
    const type = attr(m[1], "IndicesMapToDataType") ?? "";
    if (applies.includes(0) && /SERIES/.test(type)) {
      series = true;
      const scale = 10 ** Number(attr(m[1], "SeriesExponent") ?? 0);
      seriesAxis = {
        start: Number(attr(m[1], "SeriesStart") ?? 0) * scale,
        step: Number(attr(m[1], "SeriesStep") ?? 1) * scale,
        unit: (attr(m[1], "SeriesUnit") ?? "SECOND").toLowerCase(),
      };
    }
    if (applies.includes(0) && /SCALARS|LABELS/.test(type)) {
      for (const named of body.matchAll(/<NamedMap\b[^>]*>([\s\S]*?)<\/NamedMap>/g)) {
        const name = unescape(/<MapName>([\s\S]*?)<\/MapName>/.exec(named[1])?.[1]?.trim() ?? `map ${maps.length + 1}`);
        const table = /<LabelTable>([\s\S]*?)<\/LabelTable>/.exec(named[1]);
        const labels = table === null ? undefined : [...table[1].matchAll(/<Label\b([^>]*)>([\s\S]*?)<\/Label>/g)].map((l): SurfaceLabel => ({
          code: Number(attr(l[1], "Key") ?? 0),
          name: unescape(l[2].trim()),
          rgba: ["Red", "Green", "Blue", "Alpha"].map((c) => Number(attr(l[1], c) ?? (c === "Alpha" ? 1 : 0))) as SurfaceLabel["rgba"],
        }));
        maps.push({ name, ...(labels === undefined ? {} : { labels }) });
      }
    }
    if (applies.includes(1) && /BRAIN_MODELS/.test(type)) {
      for (const b of body.matchAll(/<BrainModel\b([^>]*)>([\s\S]*?)<\/BrainModel>/g)) {
        const surface = /SURFACE/.test(attr(b[1], "ModelType") ?? "");
        const indices = /<VertexIndices>([\s\S]*?)<\/VertexIndices>/.exec(b[2]);
        models.push({
          structure: attr(b[1], "BrainStructure") ?? "",
          offset: Number(attr(b[1], "IndexOffset") ?? 0),
          count: Number(attr(b[1], "IndexCount") ?? 0),
          ...(surface ? { surfaceVertices: Number(attr(b[1], "SurfaceNumberOfVertices") ?? 0), vertices: Int32Array.from(indices?.[1].trim().split(/\s+/).filter(Boolean).map(Number) ?? []) } : {}),
        });
      }
    }
  }
  return { offset, datatype, littleEndian: little, rows: dim[5], columns: dim[6], maps, models, series, ...(seriesAxis ? { seriesAxis } : {}) };
}

const SIZES: Record<number, number> = { 2: 1, 4: 2, 8: 4, 16: 4, 64: 8, 256: 1, 512: 2, 768: 4 };

/** A value of a CIFTI data type at `at`. */
function reader(view: DataView, datatype: number, little: boolean): (at: number) => number {
  switch (datatype) {
    case 2: return (at) => view.getUint8(at);
    case 256: return (at) => view.getInt8(at);
    case 4: return (at) => view.getInt16(at, little);
    case 512: return (at) => view.getUint16(at, little);
    case 8: return (at) => view.getInt32(at, little);
    case 768: return (at) => view.getUint32(at, little);
    case 16: return (at) => view.getFloat32(at, little);
    case 64: return (at) => view.getFloat64(at, little);
    default: throw new Error(`CIFTI data type ${datatype} is not read`);
  }
}

/**
 * A time series' mean and standard deviation over time on the vertices of
 * `structure`'s surface, read from `file` a few thousand columns at a time
 * (the medial wall NaN).
 */
export async function ciftiSeriesStats(file: Blob, header: CiftiHeader, structure: string, vertexCount: number): Promise<{ mean: Float32Array; sd: Float32Array }> {
  const model = header.models.find((m) => m.structure === structure && m.vertices !== undefined);
  if (model === undefined) throw new Error(`no ${structure} in the file`);
  const size = SIZES[header.datatype];
  if (size === undefined) throw new Error(`CIFTI data type ${header.datatype} is not read`);
  const mean = new Float32Array(vertexCount).fill(NaN);
  const sd = new Float32Array(vertexCount).fill(NaN);
  const rows = header.rows;
  const step = Math.max(1, Math.floor((32 << 20) / (rows * size)));
  for (let k0 = 0; k0 < model.count; k0 += step) {
    const k1 = Math.min(model.count, k0 + step);
    const start = header.offset + size * rows * (model.offset + k0);
    const bytes = new Uint8Array(await file.slice(start, start + size * rows * (k1 - k0)).arrayBuffer());
    const read = reader(new DataView(bytes.buffer), header.datatype, header.littleEndian);
    for (let k = k0; k < k1; ++k) {
      const vertex = model.vertices![k];
      if (vertex < 0 || vertex >= vertexCount) continue;
      // Welford's running mean and variance over the column's time points.
      let m = 0;
      let s = 0;
      for (let t = 0; t < rows; ++t) {
        const x = read(size * ((k - k0) * rows + t));
        const d = x - m;
        m += d / (t + 1);
        s += d * (x - m);
      }
      mean[vertex] = m;
      sd[vertex] = rows > 1 ? Math.sqrt(s / (rows - 1)) : 0;
    }
  }
  return { mean, sd };
}

/** Map `row` of the file on the vertices of `structure`'s surface (`vertexCount` of them). */
export function ciftiMap(bytes: Uint8Array, header: CiftiHeader, row: number, structure: string, vertexCount: number): SurfaceValues {
  const model = header.models.find((m) => m.structure === structure && m.vertices !== undefined);
  if (model === undefined) throw new Error(`no ${structure} in the file`);
  const size = SIZES[header.datatype];
  if (size === undefined) throw new Error(`CIFTI data type ${header.datatype} is not read`);
  const read = reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), header.datatype, header.littleEndian);
  const map = header.maps[row];
  const values = new Float32Array(vertexCount).fill(map?.labels !== undefined ? 0 : NaN);
  for (let k = 0; k < model.count; ++k) {
    const vertex = model.vertices![k];
    // Element (row, column) at row + rows × column: rows vary fastest.
    if (vertex >= 0 && vertex < vertexCount) values[vertex] = read(header.offset + size * (row + header.rows * (model.offset + k)));
  }
  return { values, ...(map?.labels !== undefined ? { labels: map.labels } : {}) };
}

/** Each of a surface's vertices' column in a structure's part of the file (-1 for none: the medial wall). */
function columnsOf(model: CiftiModel, vertexCount: number): Int32Array {
  const columns = new Int32Array(vertexCount).fill(-1);
  model.vertices!.forEach((vertex, k) => {
    if (vertex >= 0 && vertex < vertexCount) columns[vertex] = k;
  });
  return columns;
}

/**
 * The mean and standard deviation (n - 1) across time courses added one at
 * a time (a parcel's vertices), at each time point: Welford's running sums,
 * values that are not numbers left out at their time point.
 */
export class CourseStats {
  private readonly n: Int32Array;
  private readonly mean: Float64Array;
  private readonly m2: Float64Array;

  constructor(readonly rows: number) {
    this.n = new Int32Array(rows);
    this.mean = new Float64Array(rows);
    this.m2 = new Float64Array(rows);
  }

  add(values: ArrayLike<number>): void {
    const { n, mean, m2 } = this;
    for (let t = 0; t < this.rows; ++t) {
      const x = values[t];
      if (!Number.isFinite(x)) continue;
      const k = ++n[t];
      const d = x - mean[t];
      mean[t] += d / k;
      m2[t] += d * (x - mean[t]);
    }
  }

  /** NaN at a time point with no values (and the SD where there is one). */
  result(): { mean: Float32Array; sd: Float32Array; count: Int32Array } {
    const mean = new Float32Array(this.rows);
    const sd = new Float32Array(this.rows);
    for (let t = 0; t < this.rows; ++t) {
      const k = this.n[t];
      mean[t] = k > 0 ? this.mean[t] : NaN;
      sd[t] = k > 1 ? Math.sqrt(this.m2[t] / (k - 1)) : k === 1 ? 0 : NaN;
    }
    return { mean, sd, count: Int32Array.from(this.n) };
  }
}

/** The most a series' values on one structure may take in memory to be stepped through (float32). */
const SERIES_BYTES = 1 << 30;

/**
 * A time series' values on `structure`'s surface, a time point at a time
 * (the medial wall NaN).  The structure's columns are read once, when a
 * time point is first asked for, a few thousand at a time, and kept as
 * float32 by time point (a row of the file each), so each later time point
 * is one copy.
 */
export class CiftiSeries {
  private matrix: Promise<Float32Array> | undefined;
  private readonly model: CiftiModel;
  /** Each vertex's column in the structure (-1 for none), made when first asked for. */
  private columns: Int32Array | undefined;

  constructor(
    private readonly file: Blob,
    private readonly header: CiftiHeader,
    structure: string,
    private readonly vertexCount: number,
  ) {
    const model = header.models.find((m) => m.structure === structure && m.vertices !== undefined);
    if (model === undefined) throw new Error(`no ${structure} in the file`);
    this.model = model;
  }

  /** Time points. */
  get count(): number {
    return this.header.rows;
  }

  /** The values at time point `t` on the surface's vertices. */
  async at(t: number): Promise<Float32Array> {
    if (!(t >= 0 && t < this.header.rows)) throw new Error(`time point ${t} is outside 0–${this.header.rows - 1}`);
    const matrix = await (this.matrix ??= this.read());
    const { count, vertices } = this.model;
    const out = new Float32Array(this.vertexCount).fill(NaN);
    const row = matrix.subarray(t * count, (t + 1) * count);
    for (let k = 0; k < count; ++k) {
      const vertex = vertices![k];
      if (vertex >= 0 && vertex < this.vertexCount) out[vertex] = row[k];
    }
    return out;
  }

  /**
   * Vertex `vertex`'s values at every time point: from the series read
   * already, else its column of the file alone (contiguous, rows varying
   * fastest).  NaN at every time point for a vertex the file has no
   * column for (the medial wall).
   */
  async course(vertex: number): Promise<Float32Array> {
    if (!(Number.isInteger(vertex) && vertex >= 0 && vertex < this.vertexCount)) throw new Error(`vertex ${vertex} is outside 0–${this.vertexCount - 1}`);
    const { header, model } = this;
    const rows = header.rows;
    const out = new Float32Array(rows).fill(NaN);
    const k = (this.columns ??= columnsOf(model, this.vertexCount))[vertex];
    if (k === -1) return out;
    if (this.matrix !== undefined) {
      const matrix = await this.matrix;
      for (let t = 0; t < rows; ++t) out[t] = matrix[t * model.count + k];
      return out;
    }
    const size = SIZES[header.datatype];
    if (size === undefined) throw new Error(`CIFTI data type ${header.datatype} is not read`);
    const start = header.offset + size * rows * (model.offset + k);
    const bytes = new Uint8Array(await this.file.slice(start, start + size * rows).arrayBuffer());
    const value = reader(new DataView(bytes.buffer), header.datatype, header.littleEndian);
    for (let t = 0; t < rows; ++t) out[t] = value(size * t);
    return out;
  }

  /**
   * The mean and standard deviation over `vertices` (a parcel) at every
   * time point: from the series read already, else from the file, the
   * parcel's columns read in runs (columns a few apart read together,
   * at most 32 MB at a time).  Vertices the file has no column for (the
   * medial wall) are left out.
   */
  async parcel(vertices: ArrayLike<number>): Promise<{ mean: Float32Array; sd: Float32Array; count: Int32Array }> {
    const { header, model } = this;
    const rows = header.rows;
    const columnOf = (this.columns ??= columnsOf(model, this.vertexCount));
    const columns: number[] = [];
    for (let i = 0; i < vertices.length; ++i) {
      const v = vertices[i];
      if (!(Number.isInteger(v) && v >= 0 && v < this.vertexCount)) throw new Error(`vertex ${v} is outside 0–${this.vertexCount - 1}`);
      if (columnOf[v] !== -1) columns.push(columnOf[v]);
    }
    columns.sort((a, b) => a - b);
    const stats = new CourseStats(rows);
    const column = new Float32Array(rows);
    if (this.matrix !== undefined) {
      const matrix = await this.matrix;
      for (const k of columns) {
        for (let t = 0; t < rows; ++t) column[t] = matrix[t * model.count + k];
        stats.add(column);
      }
      return stats.result();
    }
    const size = SIZES[header.datatype];
    if (size === undefined) throw new Error(`CIFTI data type ${header.datatype} is not read`);
    const most = Math.max(1, Math.floor((32 << 20) / (rows * size)));
    for (let i = 0; i < columns.length; ) {
      // A run: the next columns while the gaps are small and the read stays within its size.
      let j = i + 1;
      while (j < columns.length && columns[j] - columns[j - 1] <= 32 && columns[j] - columns[i] < most) ++j;
      const k0 = columns[i];
      const k1 = columns[j - 1] + 1;
      const start = header.offset + size * rows * (model.offset + k0);
      const bytes = new Uint8Array(await this.file.slice(start, start + size * rows * (k1 - k0)).arrayBuffer());
      const value = reader(new DataView(bytes.buffer), header.datatype, header.littleEndian);
      for (let c = i; c < j; ++c) {
        const at = size * rows * (columns[c] - k0);
        for (let t = 0; t < rows; ++t) column[t] = value(at + size * t);
        stats.add(column);
      }
      i = j;
    }
    return stats.result();
  }

  /** The structure's part of the file, by time point then column. */
  private async read(): Promise<Float32Array> {
    const { header, model } = this;
    const size = SIZES[header.datatype];
    if (size === undefined) throw new Error(`CIFTI data type ${header.datatype} is not read`);
    const rows = header.rows;
    if (rows * model.count * 4 > SERIES_BYTES) throw new Error(`the series is too large to step through (${rows} time points of ${model.count} vertices)`);
    const matrix = new Float32Array(rows * model.count);
    const step = Math.max(1, Math.floor((32 << 20) / (rows * size)));
    for (let k0 = 0; k0 < model.count; k0 += step) {
      const k1 = Math.min(model.count, k0 + step);
      const start = header.offset + size * rows * (model.offset + k0);
      const bytes = new Uint8Array(await this.file.slice(start, start + size * rows * (k1 - k0)).arrayBuffer());
      const value = reader(new DataView(bytes.buffer), header.datatype, header.littleEndian);
      for (let k = k0; k < k1; ++k) for (let t = 0; t < rows; ++t) matrix[t * model.count + k] = value(size * ((k - k0) * rows + t));
    }
    return matrix;
  }
}
