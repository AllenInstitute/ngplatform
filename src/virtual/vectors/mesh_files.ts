/**
 * Triangle meshes from files: Wavefront .obj (objects by `o`/`g`, polygons
 * fanned into triangles), STL (binary or ASCII; repeated corners merged),
 * PLY (ASCII or binary, either byte order), GIFTI surfaces and FreeSurfer
 * surfaces (lh.pial, …).  Coordinates are as the file stores them, except
 * that anatomical GIFTI and FreeSurfer surfaces are moved into scanner RAS
 * as zarr-vectors-tools does (the GIFTI matrix to a named space; FreeSurfer's
 * c_ras), so they sit with the subject's volumes and tractography.
 */

export interface MeshData {
  /** x y z per vertex. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  triangles: Uint32Array;
  /** Each triangle's object, an index into `objects`. */
  triangleObject: Uint32Array;
  /** Object names, in order. */
  objects: string[];
}

/** One object: every triangle is object 0. */
function single(positions: Float32Array, triangles: Uint32Array, name: string): MeshData {
  return { positions, triangles, triangleObject: new Uint32Array(triangles.length / 3), objects: [name] };
}

/** Merges corners at exactly the same place, keeping the order they first appear in. */
function mergeCorners(corners: Float32Array): { positions: Float32Array; triangles: Uint32Array } {
  const n = corners.length / 3;
  const bits = new Uint32Array(corners.buffer, corners.byteOffset, corners.length);
  const index = new Map<string, number>();
  const triangles = new Uint32Array(n);
  const kept: number[] = [];
  for (let i = 0; i < n; ++i) {
    const key = `${bits[3 * i]},${bits[3 * i + 1]},${bits[3 * i + 2]}`;
    let v = index.get(key);
    if (v === undefined) {
      v = kept.length;
      index.set(key, v);
      kept.push(i);
    }
    triangles[i] = v;
  }
  const positions = new Float32Array(3 * kept.length);
  kept.forEach((i, v) => positions.set(corners.subarray(3 * i, 3 * i + 3), 3 * v));
  return { positions, triangles };
}

export function parseStl(bytes: Uint8Array, name = "mesh"): MeshData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryCount = bytes.byteLength >= 84 ? view.getUint32(80, true) : -1;
  const binary = binaryCount >= 0 && Math.abs(84 + 50 * binaryCount - bytes.byteLength) <= 2;
  let corners: Float32Array;
  if (binary) {
    corners = new Float32Array(9 * binaryCount);
    for (let f = 0; f < binaryCount; ++f) {
      const at = 84 + 50 * f + 12;
      for (let k = 0; k < 9; ++k) corners[9 * f + k] = view.getFloat32(at + 4 * k, true);
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*solid/.test(text)) throw new Error("not an STL file");
    const values: number[] = [];
    const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m = vertex.exec(text); m !== null; m = vertex.exec(text)) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (values.length % 9 !== 0) throw new Error("an ASCII STL whose facets do not have three vertices each");
    corners = Float32Array.from(values);
  }
  const { positions, triangles } = mergeCorners(corners);
  return single(positions, triangles, name);
}

export function parseObj(text: string, name = "mesh"): MeshData {
  const positions: number[] = [];
  const triangles: number[] = [];
  const triangleObject: number[] = [];
  const objects: string[] = [];
  const objectIndex = new Map<string, number>();
  let current = -1;
  const use = (label: string) => {
    let i = objectIndex.get(label);
    if (i === undefined) {
      i = objects.length;
      objects.push(label);
      objectIndex.set(label, i);
    }
    current = i;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === "v") {
      positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (tag === "o" || tag === "g") {
      if (parts.length > 1) use(parts.slice(1).join(" "));
    } else if (tag === "f") {
      if (current === -1) use(name);
      const count = positions.length / 3;
      const corners = parts.slice(1).map((p) => {
        const i = Number.parseInt(p.split("/")[0], 10);
        return i < 0 ? count + i : i - 1;
      });
      if (corners.some((i) => !(i >= 0 && i < count))) throw new Error(`a face with a vertex out of range: ${line}`);
      // A polygon as a fan of triangles from its first corner.
      for (let k = 1; k + 1 < corners.length; ++k) {
        triangles.push(corners[0], corners[k], corners[k + 1]);
        triangleObject.push(current);
      }
    }
  }
  if (objects.length === 0) objects.push(name);
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(triangles), triangleObject: Uint32Array.from(triangleObject), objects };
}

const PLY_TYPES: Record<string, [number, string]> = {
  char: [1, "Int8"], int8: [1, "Int8"], uchar: [1, "Uint8"], uint8: [1, "Uint8"],
  short: [2, "Int16"], int16: [2, "Int16"], ushort: [2, "Uint16"], uint16: [2, "Uint16"],
  int: [4, "Int32"], int32: [4, "Int32"], uint: [4, "Uint32"], uint32: [4, "Uint32"],
  float: [4, "Float32"], float32: [4, "Float32"], double: [8, "Float64"], float64: [8, "Float64"],
};

export function parsePly(bytes: Uint8Array, name = "mesh"): MeshData {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 65536)));
  if (!head.startsWith("ply")) throw new Error("not a PLY file");
  const end = head.indexOf("end_header");
  if (end === -1) throw new Error("a PLY header without end_header");
  const bodyStart = head.indexOf("\n", end) + 1;
  type Property = { name: string; type: string; list?: { count: string; item: string } };
  const elements: { name: string; count: number; properties: Property[] }[] = [];
  let format = "ascii";
  for (const line of head.slice(0, end).split("\n").map((l) => l.trim())) {
    const p = line.split(/\s+/);
    if (p[0] === "format") format = p[1];
    else if (p[0] === "element") elements.push({ name: p[1], count: Number(p[2]), properties: [] });
    else if (p[0] === "property" && elements.length) {
      const props = elements[elements.length - 1].properties;
      if (p[1] === "list") props.push({ name: p[4], type: "list", list: { count: p[2], item: p[3] } });
      else props.push({ name: p[2], type: p[1] });
    }
  }
  const vertexElement = elements.find((e) => e.name === "vertex");
  if (vertexElement === undefined) throw new Error("a PLY without vertices");
  const positions = new Float32Array(3 * vertexElement.count);
  const triangles: number[] = [];
  const axes = ["x", "y", "z"].map((a) => vertexElement.properties.findIndex((p) => p.name === a));
  if (axes.some((i) => i === -1)) throw new Error("a PLY whose vertices have no x, y or z");
  if (format === "ascii") {
    const tokens = new TextDecoder("latin1").decode(bytes.subarray(bodyStart)).split(/\s+/).filter(Boolean);
    let t = 0;
    for (const element of elements) {
      for (let i = 0; i < element.count; ++i) {
        const row: number[][] = [];
        for (const p of element.properties) {
          if (p.list) {
            const n = Number(tokens[t++]);
            row.push(tokens.slice(t, t + n).map(Number));
            t += n;
          } else row.push([Number(tokens[t++])]);
        }
        if (element === vertexElement) axes.forEach((a, k) => (positions[3 * i + k] = row[a][0]));
        else if (element.name === "face") {
          const corners = row[element.properties.findIndex((p) => p.list !== undefined)] ?? [];
          for (let k = 1; k + 1 < corners.length; ++k) triangles.push(corners[0], corners[k], corners[k + 1]);
        }
      }
    }
  } else {
    const little = format === "binary_little_endian";
    const view = new DataView(bytes.buffer, bytes.byteOffset + bodyStart, bytes.byteLength - bodyStart);
    let at = 0;
    const read = (type: string) => {
      const [size, getter] = PLY_TYPES[type] ?? [0, ""];
      if (size === 0) throw new Error(`a PLY property of type ${type}`);
      const v = (view as unknown as Record<string, (o: number, l?: boolean) => number>)[`get${getter}`](at, little);
      at += size;
      return v;
    };
    for (const element of elements) {
      for (let i = 0; i < element.count; ++i) {
        let corners: number[] | undefined;
        element.properties.forEach((p, k) => {
          if (p.list) {
            const n = read(p.list.count);
            const items: number[] = [];
            for (let j = 0; j < n; ++j) items.push(read(p.list.item));
            if (corners === undefined) corners = items;
          } else {
            const v = read(p.type);
            if (element === vertexElement) {
              const axis = axes.indexOf(k);
              if (axis !== -1) positions[3 * i + axis] = v;
            }
          }
        });
        if (element.name === "face" && corners) for (let k = 1; k + 1 < corners.length; ++k) triangles.push(corners[0], corners[k], corners[k + 1]);
      }
    }
  }
  return single(positions, Uint32Array.from(triangles), name);
}

/** Surfaces in no anatomical space: left where the file puts them. */
const NOT_ANATOMICAL = /inflated|sphere|flat/i;

/** FreeSurfer surface names (lh.pial, rh.white, …): the files read as surfaces. */
export const FREESURFER_SURFACE = /^(lh|rh)\.(pial|white|orig|smoothwm|inflated|very_inflated|sphere|sphere\.reg|midthickness|graymid|pial\.T1|orig\.nofix|inflated_pre|qsphere\.nofix)$/i;

/**
 * A FreeSurfer triangle surface: magic FF FF FE, a "created by" line, then
 * big-endian counts, float32 vertices and int32 faces, then an optional
 * footer whose `cras` (when `valid = 1`) moves an anatomical surface into
 * scanner RAS.
 */
export function parseFreeSurfer(bytes: Uint8Array, name: string): MeshData {
  if (bytes[0] !== 0xff || bytes[1] !== 0xff || bytes[2] !== 0xfe) throw new Error("not a FreeSurfer triangle surface");
  let at = bytes.indexOf(0x0a, 3);
  if (at === -1 || bytes[at + 1] !== 0x0a) throw new Error("a FreeSurfer surface without its created-by line");
  at += 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nv = view.getInt32(at, false);
  const nf = view.getInt32(at + 4, false);
  at += 8;
  const positions = new Float32Array(3 * nv);
  for (let i = 0; i < 3 * nv; ++i, at += 4) positions[i] = view.getFloat32(at, false);
  const triangles = new Uint32Array(3 * nf);
  for (let i = 0; i < 3 * nf; ++i, at += 4) triangles[i] = view.getInt32(at, false);
  const footer = new TextDecoder("latin1").decode(bytes.subarray(at));
  const valid = /valid\s*=\s*1/.test(footer);
  const cras = /cras\s*=\s*(\S+)\s+(\S+)\s+(\S+)/.exec(footer);
  if (valid && cras !== null && !NOT_ANATOMICAL.test(name)) {
    const c = [Number(cras[1]), Number(cras[2]), Number(cras[3])];
    for (let i = 0; i < positions.length; ++i) positions[i] += c[i % 3];
  }
  return single(positions, triangles, name);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(text: string): Uint8Array {
  const raw = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

const cdata = (text: string) => text.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();

/** One GIFTI data array, decoded, rows in row-major order. */
export interface GiftiArray {
  intent: string;
  /** Rows, and values per row (1 for a vector). */
  dims: [number, number];
  values: Float32Array | Int32Array;
  /** Its `Name` metadata, or "". */
  name: string;
  /** The array's XML, for metadata and transforms. */
  xml: string;
}

const metaValue = (xml: string, key: string) =>
  new RegExp(`<Name>\\s*(?:<!\\[CDATA\\[)?${key}(?:\\]\\]>)?\\s*<\\/Name>\\s*<Value>\\s*(?:<!\\[CDATA\\[)?([^<\\]]*)`).exec(xml)?.[1] ?? "";

/** A GIFTI file's data arrays (ASCII, base64 or gzipped base64; either byte order and indexing order). */
export async function giftiArrays(text: string): Promise<GiftiArray[]> {
  if (!/<GIFTI[\s>]/.test(text)) throw new Error("not a GIFTI file");
  const out: GiftiArray[] = [];
  for (const m of text.matchAll(/<DataArray\b([^>]*)>([\s\S]*?)<\/DataArray>/g)) {
    const attr = (key: string) => new RegExp(`${key}\\s*=\\s*"([^"]*)"`).exec(m[1])?.[1] ?? "";
    const dims: [number, number] = [Number(attr("Dim0")), Number(attr("Dim1") || 1)];
    const encoding = attr("Encoding");
    const body = cdata(/<Data>([\s\S]*?)<\/Data>/.exec(m[2])?.[1] ?? "");
    const type = attr("DataType");
    const float = type === "NIFTI_TYPE_FLOAT32" || type === "NIFTI_TYPE_FLOAT64";
    let values: Float32Array | Int32Array;
    if (encoding === "ASCII") {
      const numbers = body.split(/\s+/).filter(Boolean).map(Number);
      values = float ? Float32Array.from(numbers) : Int32Array.from(numbers);
    } else if (encoding === "Base64Binary" || encoding === "GZipBase64Binary") {
      let bytes = base64(body);
      if (encoding === "GZipBase64Binary") bytes = await inflate(bytes);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const little = attr("Endian") !== "BigEndian";
      const size = type === "NIFTI_TYPE_UINT8" || type === "NIFTI_TYPE_INT8" ? 1 : type === "NIFTI_TYPE_FLOAT64" ? 8 : type === "NIFTI_TYPE_INT16" || type === "NIFTI_TYPE_UINT16" ? 2 : 4;
      const n = Math.floor(bytes.byteLength / size);
      values = float ? new Float32Array(n) : new Int32Array(n);
      for (let i = 0; i < n; ++i) {
        const at = size * i;
        values[i] =
          type === "NIFTI_TYPE_FLOAT32" ? view.getFloat32(at, little)
          : type === "NIFTI_TYPE_FLOAT64" ? view.getFloat64(at, little)
          : type === "NIFTI_TYPE_UINT8" ? view.getUint8(at)
          : type === "NIFTI_TYPE_INT8" ? view.getInt8(at)
          : type === "NIFTI_TYPE_INT16" ? view.getInt16(at, little)
          : type === "NIFTI_TYPE_UINT16" ? view.getUint16(at, little)
          : view.getInt32(at, little);
      }
    } else {
      throw new Error(`a GIFTI array stored as ${encoding || "nothing"} (ASCII and base64 only)`);
    }
    if (attr("ArrayIndexingOrder") === "ColumnMajorOrder" && dims[1] > 1) {
      const rows = new (values.constructor as typeof Float32Array)(values.length);
      for (let i = 0; i < dims[0]; ++i) for (let k = 0; k < dims[1]; ++k) rows[i * dims[1] + k] = values[k * dims[0] + i];
      values = rows;
    }
    out.push({ intent: attr("Intent"), dims, values, name: metaValue(m[2], "Name"), xml: m[2] });
  }
  return out;
}

/**
 * A GIFTI surface: its POINTSET and TRIANGLE data arrays.  An anatomical
 * surface is moved by its CoordinateSystemTransformMatrix when that leads to
 * a named space and is not the identity.
 */
export async function parseGifti(text: string, name: string): Promise<MeshData> {
  let positions: Float32Array | undefined;
  let triangles: Uint32Array | undefined;
  let matrix: number[] | undefined;
  let geometric = "";
  for (const a of await giftiArrays(text)) {
    if (a.intent === "NIFTI_INTENT_POINTSET") {
      positions = Float32Array.from(a.values);
      geometric = metaValue(a.xml, "GeometricType");
      const xform = /<CoordinateSystemTransformMatrix>([\s\S]*?)<\/CoordinateSystemTransformMatrix>/.exec(a.xml)?.[1];
      const target = cdata(/<TransformedSpace>([\s\S]*?)<\/TransformedSpace>/.exec(xform ?? "")?.[1] ?? "");
      const data = cdata(/<MatrixData>([\s\S]*?)<\/MatrixData>/.exec(xform ?? "")?.[1] ?? "").split(/\s+/).filter(Boolean).map(Number);
      if (data.length === 16 && target !== "" && target !== "NIFTI_XFORM_UNKNOWN") matrix = data;
    } else if (a.intent === "NIFTI_INTENT_TRIANGLE") {
      triangles = Uint32Array.from(a.values);
    }
  }
  if (positions === undefined) throw new Error("a GIFTI file without a surface (no NIFTI_INTENT_POINTSET array)");
  const identity = matrix?.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6) ?? true;
  if (matrix !== undefined && !identity && !NOT_ANATOMICAL.test(geometric || name)) {
    const m = matrix;
    for (let i = 0; i < positions.length; i += 3) {
      const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
      for (let r = 0; r < 3; ++r) positions[i + r] = m[4 * r] * x + m[4 * r + 1] * y + m[4 * r + 2] * z + m[4 * r + 3];
    }
  }
  return single(positions, triangles ?? new Uint32Array(0), name);
}

/** A mesh file by its name: .obj, .stl, .ply, .gii, or a FreeSurfer surface (lh.pial, …). */
export async function parseMeshFile(bytes: Uint8Array, fileName: string): Promise<MeshData> {
  const name = fileName.replace(/\.(surf\.gii|gii|obj|stl|ply)$/i, "");
  if (/\.obj$/i.test(fileName)) return parseObj(new TextDecoder().decode(bytes), name);
  if (/\.stl$/i.test(fileName)) return parseStl(bytes, name);
  if (/\.ply$/i.test(fileName)) return parsePly(bytes, name);
  if (/\.gii$/i.test(fileName)) return parseGifti(new TextDecoder().decode(bytes), name);
  if (FREESURFER_SURFACE.test(fileName)) return parseFreeSurfer(bytes, fileName);
  throw new Error(`${fileName}: not a mesh file (.obj, .stl, .ply, .gii or a FreeSurfer surface)`);
}
