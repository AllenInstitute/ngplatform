/**
 * CIFTI-2 values on a surface (HCP's `.dscalar.nii` and `.dlabel.nii`): a
 * NIfTI-2 file whose XML extension says which vertices of which surface
 * each column is (brain models), and what each row is (a named map, with a
 * label table for a parcellation).  A hemisphere's surface takes the
 * columns of its cortex: each map becomes values on its vertices, the
 * vertices not in it (the medial wall) NaN, or 0 for labels.  Rows vary
 * fastest in the file (NIfTI order), so a map is read in one pass.
 */
import type { SurfaceLabel, SurfaceValues } from "./surface_values.js";

/** A CIFTI file's names: dense scalars and labels, read here; and the kinds that are not (time series, parcels). */
export const CIFTI_FILE = /\.d(scalar|label)\.nii$/i;

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
  /** Each row's name, and for labels, its table. */
  maps: { name: string; labels?: SurfaceLabel[] }[];
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
  for (const m of xml.matchAll(/<MatrixIndicesMap\b([^>]*)>([\s\S]*?)<\/MatrixIndicesMap>/g)) {
    const applies = (attr(m[1], "AppliesToMatrixDimension") ?? "").split(",").map((s) => Number(s.trim()));
    const type = attr(m[1], "IndicesMapToDataType") ?? "";
    if (applies.includes(0) && /SCALARS|LABELS/.test(type)) {
      for (const named of m[2].matchAll(/<NamedMap\b[^>]*>([\s\S]*?)<\/NamedMap>/g)) {
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
      for (const b of m[2].matchAll(/<BrainModel\b([^>]*)>([\s\S]*?)<\/BrainModel>/g)) {
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
  return { offset, datatype, littleEndian: little, rows: dim[5], columns: dim[6], maps, models };
}

const SIZES: Record<number, number> = { 2: 1, 4: 2, 8: 4, 16: 4, 64: 8, 256: 1, 512: 2, 768: 4 };

/** Map `row` of the file on the vertices of `structure`'s surface (`vertexCount` of them). */
export function ciftiMap(bytes: Uint8Array, header: CiftiHeader, row: number, structure: string, vertexCount: number): SurfaceValues {
  const model = header.models.find((m) => m.structure === structure && m.vertices !== undefined);
  if (model === undefined) throw new Error(`no ${structure} in the file`);
  const size = SIZES[header.datatype];
  if (size === undefined) throw new Error(`CIFTI data type ${header.datatype} is not read`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = header.littleEndian;
  const read = (at: number): number => {
    switch (header.datatype) {
      case 2: return view.getUint8(at);
      case 256: return view.getInt8(at);
      case 4: return view.getInt16(at, little);
      case 512: return view.getUint16(at, little);
      case 8: return view.getInt32(at, little);
      case 768: return view.getUint32(at, little);
      case 16: return view.getFloat32(at, little);
      default: return view.getFloat64(at, little);
    }
  };
  const map = header.maps[row];
  const values = new Float32Array(vertexCount).fill(map?.labels !== undefined ? 0 : NaN);
  for (let k = 0; k < model.count; ++k) {
    const vertex = model.vertices![k];
    // Element (row, column) at row + rows × column: rows vary fastest.
    if (vertex >= 0 && vertex < vertexCount) values[vertex] = read(header.offset + size * (row + header.rows * (model.offset + k)));
  }
  return { values, ...(map?.labels !== undefined ? { labels: map.labels } : {}) };
}
