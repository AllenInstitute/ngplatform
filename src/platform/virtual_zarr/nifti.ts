/**
 * A NIfTI image (`.nii` or `.nii.gz`; NIfTI-1 or NIfTI-2, either byte
 * order) read as an OME-Zarr 0.6 image in a Zarr v3 store.
 *
 * - Metadata: the array's axes are the file's i, j, k (after time or
 *   components, when there are any), each named for the world axis it lies
 *   closest to; a transpose codec says the bytes are in the file's order
 *   (i fastest), so no voxel is moved.  The levels map into the array's own
 *   system (level 0's voxels), and the header's voxel-to-world affine
 *   (the sform, else the qform, else the voxel sizes, in the NIfTI
 *   standard's order) leads from there to a system named for the header's
 *   code (scanner, aligned, talairach, mni152, template) with axes x, y, z
 *   in the header's unit (millimetres when it gives none).  So an oblique
 *   or sagittal image keeps its orientation exactly, and a scene it opens
 *   first is laid out x, y, z.
 * - Level 0's chunks are cut from the file: the rows a chunk needs are read
 *   once for every chunk along them (a band), turned to little-endian, and,
 *   where the header scales its values (scl_slope, scl_inter), to float32.
 *   float64 is shown as float32 (Neuroglancer has no float64).
 * - Coarser levels halve the finest axes (voxel sizes within 2× of the
 *   smallest) until a level fits in one chunk.  Each voxel is the mean of
 *   the finer level's box, or the box's first voxel for label images
 *   (intent NIFTI_INTENT_LABEL or NEURONAME).  They are made when asked
 *   for, so the coarsest needs the whole file read once.
 */
import { type ByteSource, blobSource, gunzipHead, gunzipSource, isGzip, jsonBytes, Lru, type VirtualStore } from "./store.js";

export interface NiftiHeader {
  version: 1 | 2;
  littleEndian: boolean;
  /** "n+1" or "n+2" for a single file; "ni1" or "ni2" for a .hdr/.img pair. */
  magic: string;
  /** dim[0] (the rank) to dim[7]. */
  dim: number[];
  datatype: number;
  bitpix: number;
  pixdim: number[];
  voxOffset: number;
  sclSlope: number;
  sclInter: number;
  xyztUnits: number;
  toffset: number;
  intentCode: number;
  qformCode: number;
  sformCode: number;
  quatern: number[];
  qoffset: number[];
  srow: number[][];
  description: string;
}

function text(bytes: Uint8Array, at: number, n: number): string {
  const raw = bytes.subarray(at, at + n);
  const end = raw.indexOf(0);
  return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end)).trim();
}

export function parseNiftiHeader(bytes: Uint8Array): NiftiHeader {
  if (bytes.byteLength < 348) throw new Error("the file is too short for a NIfTI header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sizes = [348, 540];
  const le = sizes.includes(view.getInt32(0, true));
  if (!le && !sizes.includes(view.getInt32(0, false))) throw new Error("not a NIfTI file (its header size is neither 348 nor 540)");
  const i16 = (o: number) => view.getInt16(o, le);
  const i32 = (o: number) => view.getInt32(o, le);
  if (view.getInt32(0, le) === 348) {
    const f32 = (o: number, n: number) => Array.from({ length: n }, (_, k) => view.getFloat32(o + 4 * k, le));
    return {
      version: 1,
      littleEndian: le,
      magic: text(bytes, 344, 4),
      dim: Array.from({ length: 8 }, (_, k) => i16(40 + 2 * k)),
      intentCode: i16(68),
      datatype: i16(70),
      bitpix: i16(72),
      pixdim: f32(76, 8),
      voxOffset: f32(108, 1)[0],
      sclSlope: f32(112, 1)[0],
      sclInter: f32(116, 1)[0],
      xyztUnits: bytes[123],
      toffset: f32(136, 1)[0],
      description: text(bytes, 148, 80),
      qformCode: i16(252),
      sformCode: i16(254),
      quatern: f32(256, 3),
      qoffset: f32(268, 3),
      srow: [f32(280, 4), f32(296, 4), f32(312, 4)],
    };
  }
  if (bytes.byteLength < 540) throw new Error("the file is too short for a NIfTI-2 header");
  const f64 = (o: number, n: number) => Array.from({ length: n }, (_, k) => view.getFloat64(o + 8 * k, le));
  const i64 = (o: number) => Number(view.getBigInt64(o, le));
  return {
    version: 2,
    littleEndian: le,
    magic: text(bytes, 4, 8),
    datatype: i16(12),
    bitpix: i16(14),
    dim: Array.from({ length: 8 }, (_, k) => i64(16 + 8 * k)),
    pixdim: f64(104, 8),
    voxOffset: i64(168),
    sclSlope: f64(176, 1)[0],
    sclInter: f64(184, 1)[0],
    toffset: f64(216, 1)[0],
    description: text(bytes, 240, 80),
    qformCode: i32(344),
    sformCode: i32(348),
    quatern: f64(352, 3),
    qoffset: f64(376, 3),
    srow: [f64(400, 4), f64(432, 4), f64(464, 4)],
    xyztUnits: i32(500),
    intentCode: i32(504),
  };
}

const SPACES: Record<number, string> = { 1: "scanner", 2: "aligned", 3: "talairach", 4: "mni152", 5: "template" };

function det3(m: number[][]): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

export interface NiftiAffine {
  /** Voxel (i, j, k) centres to world: rows x, y, z; columns i, j, k, 1. */
  matrix: number[][];
  /** The coordinate system's name, from the code of the form used. */
  space: string;
  from: "sform" | "qform" | "pixdim";
}

/** The header's voxel-to-world matrix, in its spatial unit. */
export function niftiAffine(h: NiftiHeader): NiftiAffine {
  const d = [1, 2, 3].map((k) => (Number.isFinite(h.pixdim[k]) && h.pixdim[k] !== 0 ? Math.abs(h.pixdim[k]) : 1));
  if (h.sformCode > 0 && h.srow.flat().every(Number.isFinite) && Math.abs(det3(h.srow)) > 1e-12) {
    return { matrix: h.srow.map((row) => [...row]), space: SPACES[h.sformCode] ?? "world", from: "sform" };
  }
  if (h.qformCode > 0) {
    const [b, c, q] = h.quatern;
    const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - q * q));
    const r = [
      [a * a + b * b - c * c - q * q, 2 * (b * c - a * q), 2 * (b * q + a * c)],
      [2 * (b * c + a * q), a * a + c * c - b * b - q * q, 2 * (c * q - a * b)],
      [2 * (b * q - a * c), 2 * (c * q + a * b), a * a + q * q - c * c - b * b],
    ];
    const s = [d[0], d[1], h.pixdim[0] === -1 ? -d[2] : d[2]];
    return { matrix: r.map((row, w) => [...row.map((v, k) => v * s[k]), h.qoffset[w]]), space: SPACES[h.qformCode] ?? "world", from: "qform" };
  }
  return { matrix: [[d[0], 0, 0, 0], [0, d[1], 0, 0], [0, 0, d[2], 0]], space: "voxel", from: "pixdim" };
}

/** For each voxel axis (i, j, k), the world axis (0 x, 1 y, 2 z) it lies closest to; each used once. */
export function nearestAxes(m: number[][]): number[] {
  const pairs: { a: number; w: number; v: number }[] = [];
  for (let a = 0; a < 3; ++a) {
    const norm = Math.hypot(m[0][a], m[1][a], m[2][a]) || 1;
    for (let w = 0; w < 3; ++w) pairs.push({ a, w, v: Math.abs(m[w][a]) / norm });
  }
  pairs.sort((p, q) => q.v - p.v);
  const of = [-1, -1, -1];
  const used = new Set<number>();
  for (const p of pairs) {
    if (of[p.a] !== -1 || used.has(p.w)) continue;
    of[p.a] = p.w;
    used.add(p.w);
  }
  return of;
}

function spatialUnit(h: NiftiHeader): string {
  switch (h.xyztUnits & 7) {
    case 1:
      return "meter";
    case 3:
      return "micrometer";
    default:
      return "millimeter";
  }
}

function timeUnit(h: NiftiHeader): string | undefined {
  return ({ 8: "second", 16: "millisecond", 24: "microsecond" } as Record<number, string>)[h.xyztUnits & 0x38];
}

type DType = "uint8" | "int8" | "uint16" | "int16" | "uint32" | "int32" | "uint64" | "int64" | "float32" | "float64";

const NIFTI_TYPES = new Map<number, DType>([
  [2, "uint8"],
  [4, "int16"],
  [8, "int32"],
  [16, "float32"],
  [64, "float64"],
  [256, "int8"],
  [512, "uint16"],
  [768, "uint32"],
  [1024, "int64"],
  [1280, "uint64"],
]);
const UNREAD: Record<number, string> = { 1: "binary", 32: "complex64", 128: "RGB", 1536: "float128", 1792: "complex128", 2048: "complex256", 2304: "RGBA" };
const BYTES: Record<DType, number> = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, uint64: 8, int64: 8, float32: 4, float64: 8 };
const ARRAYS = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  uint64: BigUint64Array,
  int64: BigInt64Array,
  float32: Float32Array,
  float64: Float64Array,
};
/** A typed array of any of the types, indexed (bigint for the 64-bit integers). */
type Typed = { [index: number]: number | bigint };

function typed(type: DType, bytes: Uint8Array): Typed {
  return new ARRAYS[type](bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / BYTES[type]) as Typed;
}

/** A display window as OME's omero metadata writes it. */
export interface DisplayWindow {
  min: number;
  max: number;
  start: number;
  end: number;
}

const LABEL_INTENTS = new Set([1002, 1003]);
const CHUNK = 64;
const CHUNK_2D = 256;

interface Level {
  /** Voxels along i, j, k. */
  size: number[];
  /** Level-0 voxels per voxel of this level, along i, j, k. */
  factor: number[];
  /** This level's halving of the one before it, along i, j, k. */
  step: number[];
  /** Chunk size along i, j, k. */
  chunk: number[];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function swapBytes(data: Uint8Array, size: number): void {
  for (let i = 0; i < data.length; i += size) {
    for (let a = i, z = i + size - 1; a < z; ++a, --z) {
      const t = data[a];
      data[a] = data[z];
      data[z] = t;
    }
  }
}

export class NiftiStore implements VirtualStore {
  readonly levels: Level[];
  /** Voxels along i, j, k. */
  readonly shape: number[];
  /** The axis before the spatial ones: time points, components (vectors, tensors), or none. */
  readonly extra: { name: "t" | "c"; size: number } | undefined;
  readonly inType: DType;
  readonly outType: DType;
  readonly label: boolean;
  private readonly affine: NiftiAffine;
  private readonly scale: { slope: number; inter: number } | undefined;
  /** Whether level 0's bytes are the file's (after byte order), with no arithmetic. */
  private readonly raw: boolean;
  /** Coarser levels' chunks (each made from many finer ones); level 0's are cut again from the bands. */
  private readonly chunks = new Lru<Uint8Array>(96 << 20);
  private readonly bands = new Lru<Uint8Array>(64 << 20);
  private windows: Promise<DisplayWindow[] | undefined> | undefined;

  constructor(
    readonly header: NiftiHeader,
    private readonly data: () => Promise<ByteSource>,
    readonly name: string,
  ) {
    const h = header;
    if (h.magic !== "n+1" && h.magic !== "n+2") {
      throw new Error(h.magic === "ni1" || h.magic === "ni2" ? "this header's image is in a separate .img file, which is not read yet" : "not a NIfTI file (no n+1 or n+2 mark)");
    }
    const inType = NIFTI_TYPES.get(h.datatype);
    if (inType === undefined) throw new Error(`${UNREAD[h.datatype] ?? `data type ${h.datatype}`} NIfTI images are not read yet`);
    this.inType = inType;
    const rank = h.dim[0];
    if (!(rank >= 1 && rank <= 7)) throw new Error(`the header's rank (dim[0] = ${rank}) is not 1 to 7`);
    const n = (k: number) => (k <= rank ? Math.max(1, h.dim[k]) : 1);
    this.shape = [n(1), n(2), n(3)];
    const nt = n(4);
    const nc = n(5) * n(6) * n(7);
    if (nt > 1 && nc > 1) throw new Error("NIfTI images with both time points and components are not read yet");
    this.extra = nt > 1 ? { name: "t", size: nt } : nc > 1 ? { name: "c", size: nc } : undefined;
    const slope = h.sclSlope;
    const inter = Number.isFinite(h.sclInter) ? h.sclInter : 0;
    this.scale = Number.isFinite(slope) && slope !== 0 && (slope !== 1 || inter !== 0) ? { slope, inter } : undefined;
    this.label = LABEL_INTENTS.has(h.intentCode);
    this.outType = this.scale !== undefined || inType === "float64" ? "float32" : inType === "int64" ? (this.label ? "uint64" : "float32") : inType;
    this.raw = this.scale === undefined && (this.outType === inType || (inType === "int64" && this.outType === "uint64"));
    this.affine = niftiAffine(h);
    this.levels = this.pyramid();
  }

  private pyramid(): Level[] {
    const m = this.affine.matrix;
    const spacing = [0, 1, 2].map((a) => Math.hypot(m[0][a], m[1][a], m[2][a]) || 1);
    const chunk = this.shape[2] > 1 ? [CHUNK, CHUNK, CHUNK] : [CHUNK_2D, CHUNK_2D, 1];
    const levels: Level[] = [{ size: this.shape, factor: [1, 1, 1], step: [1, 1, 1], chunk: chunk.map((c, a) => Math.min(c, this.shape[a])) }];
    while (levels.length < 16) {
      const last = levels[levels.length - 1];
      if ([0, 1, 2].every((a) => last.size[a] <= chunk[a])) break;
      const sp = [0, 1, 2].map((a) => spacing[a] * last.factor[a]);
      const finest = Math.min(...[0, 1, 2].filter((a) => last.size[a] > 1).map((a) => sp[a]));
      const step = [0, 1, 2].map((a) => (last.size[a] > 1 && sp[a] < 2 * finest * (1 - 1e-6) ? 2 : 1));
      const size = [0, 1, 2].map((a) => Math.ceil(last.size[a] / step[a]));
      levels.push({ size, factor: last.factor.map((f, a) => f * step[a]), step, chunk: chunk.map((c, a) => Math.min(c, size[a])) });
    }
    return levels;
  }

  /** The world axis names of the array's axes, in its order (extra first, then i, j, k). */
  private axisNames(): string[] {
    const world = nearestAxes(this.affine.matrix);
    return [...(this.extra ? [this.extra.name] : []), ...[0, 1, 2].map((a) => "xyz"[world[a]])];
  }

  /** The array's axes (extra, i, j, k) to world (extra, x, y, z): one row per world axis. */
  worldAffine(): number[][] {
    const m = this.affine.matrix;
    const e = this.extra ? 1 : 0;
    const n = e + 3;
    const rows: number[][] = [];
    if (this.extra !== undefined) {
      const row = new Array(n + 1).fill(0);
      const isTime = this.extra.name === "t";
      row[0] = isTime && Number.isFinite(this.header.pixdim[4]) && this.header.pixdim[4] > 0 ? this.header.pixdim[4] : 1;
      row[n] = isTime && Number.isFinite(this.header.toffset) ? this.header.toffset : 0;
      rows.push(row);
    }
    for (let w = 0; w < 3; ++w) {
      const row = new Array(n + 1).fill(0);
      for (let b = 0; b < 3; ++b) row[e + b] = m[w][b];
      row[n] = m[w][3];
      rows.push(row);
    }
    return rows;
  }

  /** Level `index`'s voxels to level 0's: a coarse voxel's centre is the centre of the fine voxels it covers. */
  private levelTransform(index: number): unknown {
    const path = String(index);
    const f = this.levels[index].factor;
    const scale = [...(this.extra ? [1] : []), ...f];
    if (index === 0) return { type: "scale", scale, input: path, output: "array" };
    return {
      type: "sequence",
      input: path,
      output: "array",
      transformations: [
        { type: "scale", scale },
        { type: "translation", translation: scale.map((v) => (v - 1) / 2) },
      ],
    };
  }

  /**
   * Each volume's display window (OME's omero window, which Neuroglancer
   * takes for the contrast): the 0.5th to 99.5th percentile of its middle
   * plane, and the plane's range.  None for label images.
   */
  displayWindows(): Promise<DisplayWindow[] | undefined> {
    return (this.windows ??= this.label ? Promise.resolve(undefined) : this.sampleWindows().catch(() => undefined));
  }

  private async sampleWindows(): Promise<DisplayWindow[] | undefined> {
    const source = await this.data();
    const [nx, ny, nz] = this.shape;
    const size = BYTES[this.inType];
    const plane = nx * ny * size;
    const volumes = this.extra?.name === "c" ? this.extra.size : 1;
    const { slope, inter } = this.scale ?? { slope: 1, inter: 0 };
    const out: DisplayWindow[] = [];
    for (let v = 0; v < volumes; ++v) {
      const at = this.header.voxOffset + (v * nz + Math.floor(nz / 2)) * plane;
      const bytes = (await source.read(at, at + plane)).slice();
      if (bytes.byteLength < plane) return undefined;
      if (!this.header.littleEndian && size > 1) swapBytes(bytes, size);
      const values = typed(this.inType, bytes);
      const n = nx * ny;
      const step = Math.max(1, Math.floor(n / 65536));
      const sample: number[] = [];
      for (let i = 0; i < n; i += step) {
        const x = Number(values[i]) * slope + inter;
        if (Number.isFinite(x)) sample.push(x);
      }
      if (sample.length === 0) return undefined;
      sample.sort((a, b) => a - b);
      const quantile = (p: number) => sample[Math.round(p * (sample.length - 1))];
      const min = sample[0];
      const max = sample[sample.length - 1];
      let start = quantile(0.005);
      let end = quantile(0.995);
      if (!(end > start)) [start, end] = max > min ? [min, max] : [min, min + 1];
      out.push({ min, max: Math.max(max, end), start, end });
    }
    return out;
  }

  private group(windows?: DisplayWindow[]): unknown {
    const h = this.header;
    const unit = spatialUnit(h);
    const axis = (name: string, unit?: string) => {
      if (name === "t") {
        const tu = timeUnit(h);
        return { name, type: "time", ...(tu ? { unit: tu } : {}) };
      }
      if (name === "c") return { name, type: "channel" };
      return { name, type: "space", ...(unit ? { unit } : {}) };
    };
    const extra = this.extra ? [this.extra.name] : [];
    const space = this.affine.space;
    return {
      zarr_format: 3,
      node_type: "group",
      attributes: {
        ome: {
          version: "0.6",
          multiscales: [
            {
              name: this.name,
              // The world's axes x, y, z; and the array's, in its order (level 0's voxels).
              coordinateSystems: [
                { name: space, axes: [...extra, "x", "y", "z"].map((name) => axis(name, unit)) },
                { name: "array", axes: this.axisNames().map((name) => axis(name)) },
              ],
              datasets: this.levels.map((_, i) => ({ path: String(i), coordinateTransformations: [this.levelTransform(i)] })),
              coordinateTransformations: [{ type: "affine", affine: this.worldAffine(), input: "array", output: space }],
              type: this.label ? "nearest" : "mean",
              metadata: { description: h.description || `${this.name}, read from its NIfTI file` },
            },
          ],
          ...(windows === undefined
            ? {}
            : {
                omero: {
                  channels: windows.map((window, c) => ({ label: windows.length > 1 ? `${this.name} ${c}` : this.name, active: true, window })),
                },
              }),
        },
        nifti: {
          version: h.version,
          data_type: this.inType,
          shown_as: this.outType,
          dim: h.dim,
          pixdim: h.pixdim,
          affine: this.affine.matrix,
          affine_from: this.affine.from,
          sform_code: h.sformCode,
          qform_code: h.qformCode,
          scl_slope: h.sclSlope,
          scl_inter: h.sclInter,
          intent_code: h.intentCode,
          description: h.description,
        },
      },
    };
  }

  private array(index: number): unknown {
    const { size, chunk } = this.levels[index];
    const extra = this.extra === undefined ? [] : [this.extra.size];
    return {
      zarr_format: 3,
      node_type: "array",
      shape: [...extra, ...size],
      data_type: this.outType,
      chunk_grid: { name: "regular", configuration: { chunk_shape: [...(this.extra?.name === "c" ? extra : this.extra ? [1] : []), ...chunk] } },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: 0,
      codecs: [
        // Stored (extra,) k, j, i: the file's order, i fastest.
        { name: "transpose", configuration: { order: this.extra ? [0, 3, 2, 1] : [2, 1, 0] } },
        BYTES[this.outType] > 1 ? { name: "bytes", configuration: { endian: "little" } } : { name: "bytes" },
      ],
      dimension_names: this.axisNames(),
      attributes: {},
    };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (key === "zarr.json") return jsonBytes(this.group(await this.displayWindows()));
    const meta = /^(\d+)\/zarr\.json$/.exec(key);
    if (meta !== null) {
      const index = Number(meta[1]);
      return index < this.levels.length ? jsonBytes(this.array(index)) : undefined;
    }
    const chunk = /^(\d+)\/c\/(\d+(?:\/\d+)*)$/.exec(key);
    if (chunk === null) return undefined;
    const index = Number(chunk[1]);
    const level = this.levels[index];
    if (level === undefined) return undefined;
    const at = chunk[2].split("/").map(Number);
    if (at.length !== (this.extra ? 4 : 3)) return undefined;
    const e = this.extra ? at[0] : 0;
    if (this.extra !== undefined && e >= (this.extra.name === "t" ? this.extra.size : 1)) return undefined;
    const b = at.slice(at.length - 3);
    if (b.some((v, a) => v * level.chunk[a] >= level.size[a])) return undefined;
    return this.chunk(index, e, b);
  }

  /** The 3-D volumes (in file order) in chunks with extra index `e`. */
  private volumesOf(e: number): number[] {
    if (this.extra?.name === "c") return Array.from({ length: this.extra.size }, (_, c) => c);
    return [e];
  }

  private chunk(index: number, e: number, b: number[]): Promise<Uint8Array> {
    if (index === 0) return this.cut(e, b);
    return this.chunks.get(`${index}/${e}/${b.join("/")}`, () => this.reduce(index, e, b), (d) => d.byteLength);
  }

  /** The file's rows for chunk row (k, j) of volume `v`: every i, little-endian. */
  private band(v: number, bk: number, bj: number): Promise<Uint8Array> {
    return this.bands.get(`${v}/${bk}/${bj}`, () => this.readBand(v, bk, bj), (d) => d.byteLength);
  }

  private async readBand(v: number, bk: number, bj: number): Promise<Uint8Array> {
    const source = await this.data();
    const [nx, ny, nz] = this.shape;
    const [, cj, ck] = this.levels[0].chunk;
    const size = BYTES[this.inType];
    const z0 = bk * ck;
    const z1 = Math.min(nz, z0 + ck);
    const y0 = bj * cj;
    const y1 = Math.min(ny, y0 + cj);
    const row = nx * size;
    const plane = ny * row;
    const base = this.header.voxOffset + v * nz * plane;
    let data: Uint8Array;
    if (y0 === 0 && y1 === ny) data = await source.read(base + z0 * plane, base + z1 * plane);
    else {
      const parts = await Promise.all(Array.from({ length: z1 - z0 }, (_, dz) => source.read(base + (z0 + dz) * plane + y0 * row, base + (z0 + dz) * plane + y1 * row)));
      data = concat(parts);
    }
    if (data.byteLength < (z1 - z0) * (y1 - y0) * row) throw new Error("the file is shorter than its header says");
    if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) data = data.slice();
    if (!this.header.littleEndian && size > 1) swapBytes(data, size);
    return data;
  }

  /** A level-0 chunk, cut from the file. */
  private async cut(e: number, b: number[]): Promise<Uint8Array> {
    const nx = this.shape[0];
    const [ci, cj, ck] = this.levels[0].chunk;
    const lo = [0, 1, 2].map((a) => b[a] * this.levels[0].chunk[a]);
    const hi = [0, 1, 2].map((a) => Math.min(this.shape[a], lo[a] + this.levels[0].chunk[a]));
    const volumes = this.volumesOf(e);
    const inSize = BYTES[this.inType];
    const outSize = BYTES[this.outType];
    const out = new Uint8Array(volumes.length * ci * cj * ck * outSize);
    const to = this.raw ? undefined : (typed(this.outType, out) as Float32Array);
    const { slope, inter } = this.scale ?? { slope: 1, inter: 0 };
    const width = hi[0] - lo[0];
    const rows = hi[1] - lo[1];
    const bands = await Promise.all(volumes.map((v) => this.band(v, b[2], b[1])));
    bands.forEach((band, slot) => {
      const from = to === undefined ? undefined : typed(this.inType, band);
      for (let z = lo[2]; z < hi[2]; ++z) {
        for (let y = lo[1]; y < hi[1]; ++y) {
          const src = ((z - lo[2]) * rows + (y - lo[1])) * nx + lo[0];
          const dst = ((slot * ck + (z - lo[2])) * cj + (y - lo[1])) * ci;
          if (to === undefined) out.set(band.subarray(src * inSize, (src + width) * inSize), dst * outSize);
          else for (let x = 0; x < width; ++x) to[dst + x] = Number(from![src + x]) * slope + inter;
        }
      }
    });
    return out;
  }

  /** A chunk of a coarser level, from the finer level's chunks. */
  private async reduce(index: number, e: number, b: number[]): Promise<Uint8Array> {
    const level = this.levels[index];
    const finer = this.levels[index - 1];
    const [ci, cj, ck] = level.chunk;
    const [fi, fj, fk] = finer.chunk;
    const step = level.step;
    const lo = [0, 1, 2].map((a) => b[a] * level.chunk[a]);
    const hi = [0, 1, 2].map((a) => Math.min(level.size[a], lo[a] + level.chunk[a]));
    const srcLo = lo.map((v, a) => v * step[a]);
    const srcHi = hi.map((v, a) => Math.min(finer.size[a], v * step[a]));
    const slots = this.volumesOf(e).length;
    const n = slots * ci * cj * ck;
    const mean = !this.label && this.outType !== "uint64";
    const sum = mean ? new Float64Array(n) : undefined;
    const count = mean ? new Uint16Array(n) : undefined;
    const out = new Uint8Array(n * BYTES[this.outType]);
    const to = typed(this.outType, out);
    const first = srcLo.map((v, a) => Math.floor(v / finer.chunk[a]));
    const last = srcHi.map((v, a) => Math.floor((v - 1) / finer.chunk[a]));
    const parts: number[][] = [];
    for (let k = first[2]; k <= last[2]; ++k) for (let j = first[1]; j <= last[1]; ++j) for (let i = first[0]; i <= last[0]; ++i) parts.push([i, j, k]);
    // One finer chunk at a time, so making the coarsest level holds no more than a chunk per level.
    for (const p of parts) {
      const from = typed(this.outType, await this.chunk(index - 1, e, p));
      const slo = p.map((v, a) => v * finer.chunk[a]);
      const xlo = Math.max(slo[0], srcLo[0]);
      const xhi = Math.min(slo[0] + fi, srcHi[0]);
      for (let slot = 0; slot < slots; ++slot) {
        for (let z = Math.max(slo[2], srcLo[2]); z < Math.min(slo[2] + fk, srcHi[2]); ++z) {
          if (!mean && z % step[2] !== 0) continue;
          const dz = Math.floor(z / step[2]) - lo[2];
          for (let y = Math.max(slo[1], srcLo[1]); y < Math.min(slo[1] + fj, srcHi[1]); ++y) {
            if (!mean && y % step[1] !== 0) continue;
            const dy = Math.floor(y / step[1]) - lo[1];
            const srcRow = ((slot * fk + (z - slo[2])) * fj + (y - slo[1])) * fi - slo[0];
            const dstRow = ((slot * ck + dz) * cj + dy) * ci - lo[0];
            for (let x = xlo; x < xhi; ++x) {
              const d = dstRow + Math.floor(x / step[0]);
              if (mean) {
                sum![d] += Number(from[srcRow + x]);
                count![d]++;
              } else if (x % step[0] === 0) to[d] = from[srcRow + x];
            }
          }
        }
      }
    }
    if (mean) {
      const round = !this.outType.startsWith("float");
      for (let d = 0; d < n; ++d) if (count![d] > 0) to[d] = round ? Math.round(sum![d] / count![d]) : sum![d] / count![d];
    }
    return out;
  }
}

/** A NIfTI file as a store; reads only its header until a chunk is asked for. */
export async function openNifti(file: Blob, name: string): Promise<NiftiStore> {
  const start = new Uint8Array(await file.slice(0, 540).arrayBuffer());
  if (isGzip(start)) return new NiftiStore(parseNiftiHeader(await gunzipHead(file, 540)), gunzipSource(file), name);
  const whole = blobSource(file);
  return new NiftiStore(parseNiftiHeader(start), () => Promise.resolve(whole), name);
}
