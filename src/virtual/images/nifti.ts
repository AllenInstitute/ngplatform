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
 *   (intent NIFTI_INTENT_LABEL or NEURONAME).  A file can bring some of its
 *   own (a TIFF's reduced-resolution pages): those are read, not computed.
 * - Computed levels are made in slabs (./slabs.ts): a chunk asked for is
 *   made with the rest of its chunk row, from the finer level's slabs under
 *   it, down to the file, read once across.  The coarsest levels are kept
 *   between visits within a budget (./overview_cache.ts), and a build in
 *   the background (`{ overview: "build" }`) makes and keeps them in one
 *   pass over the file; Export → OME-Zarr writes every level in that same
 *   one pass (`eachChunk`).
 * - Diffusion tensors (six float components a voxel) are averaged
 *   log-Euclidean (./tensors.ts), which keeps their determinants: when the
 *   header's intent is NIFTI_INTENT_SYMMATRIX (the lower triangle by rows,
 *   DIPY's order), or when the page asks with a message
 *   (`{ tensor: "fsl" | "dipy" | "mrtrix" | null }`, as the Orientations
 *   plugin does for an image it draws as tensors).
 */
import { cacheBudget, levelsKept, memoryBudgets, OverviewCache, readSettings } from "./overview_cache.js";
import { type Box, chunkFromSlab, chunksOf, finerSlabs, type Grid, levelSlabs, Reducer, type Slab, slabFromChunks, slabOf, slabWidth, type Voxels } from "./slabs.js";
import { type ByteSource, blobSource, gunzipHead, gunzipSource, isGzip, jsonBytes, Lru, readInto, type VirtualStore } from "./store.js";
import { LogEuclideanSum, NIFTI_INTENT_SYMMATRIX, TENSOR_ORDER_NAMES, type TensorOrder } from "./tensors.js";

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
  /** The display range the file asks for (cal_min, cal_max); used when cal_max > cal_min. */
  calMin?: number;
  calMax?: number;
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
      calMax: f32(124, 1)[0],
      calMin: f32(128, 1)[0],
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
    calMax: f64(192, 1)[0],
    calMin: f64(200, 1)[0],
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
/** NIfTI's colour types: samples a voxel. */
const COLOUR: Record<number, number> = { 128: 3, 2304: 4 };

/**
 * A colour image's voxels (RGB or RGBA bytes from `offset`) as packed
 * uint32s, alpha 255 for RGB: what the store serves for colour images.
 */
export function packedColours(source: ByteSource, offset: number, voxels: number, samples: number): ByteSource {
  return {
    size: 4 * voxels,
    async read(start, end) {
      const v0 = Math.floor(start / 4);
      const v1 = Math.min(voxels, Math.ceil(end / 4));
      const raw = await source.read(offset + samples * v0, offset + samples * v1);
      const out = new Uint8Array(4 * (v1 - v0));
      for (let i = 0; i < v1 - v0; ++i) {
        out[4 * i] = raw[samples * i];
        out[4 * i + 1] = raw[samples * i + 1];
        out[4 * i + 2] = raw[samples * i + 2];
        out[4 * i + 3] = samples === 4 ? raw[samples * i + 3] : 255;
      }
      return out.subarray(start - 4 * v0, Math.min(out.length, end - 4 * v0));
    },
  };
}

/** A colour NIfTI's header as the packed store reads it: uint32, the pyramid by nearest voxel (a label intent). */
function packedHeader(h: NiftiHeader): NiftiHeader {
  return { ...h, datatype: 768, bitpix: 32, voxOffset: 0, intentCode: 1002, sclSlope: 0, sclInter: 0 };
}
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
/** A 4th axis this long or shorter, and not a time series, is kept whole in each chunk. */
const WHOLE_EXTRA = 128;

interface Level {
  /** Voxels along i, j, k. */
  size: number[];
  /** Level-0 voxels per voxel of this level, along i, j, k. */
  factor: number[];
  /** This level's halving of the one before it, along i, j, k. */
  step: number[];
  /** Chunk size along i, j, k. */
  chunk: number[];
  /** For a level read from the file (level 0, a TIFF's own reduced pages): its bytes, from `offset`, laid out as level 0's are. */
  read?: () => Promise<ByteSource>;
  offset?: number;
}

/** A coarser level the file holds itself (a TIFF's reduced-resolution pages), read as level 0 is. */
export interface FileLevel {
  /** Voxels along i, j, k. */
  size: number[];
  /** Level-0 voxels per voxel, along i, j, k (2, 4, … along i and j; 1 along k for a TIFF). */
  factor: number[];
  read: () => Promise<ByteSource>;
}

/** What identifies a file for the overview cache: its name, size and date. */
export interface CacheKey {
  name: string;
  size: number;
  lastModified: number;
}

/** A slab of a level past this many bytes is cut along i into pieces. */
const SLAB_LIMIT = 256 * 2 ** 20;
/** Files smaller than this keep no overview: their coarser levels are made in a moment. */
const MIN_CACHED = 64 * 2 ** 20;
/** Bytes of the overview cache's writes that may wait while slabs are made. */
const WRITES_AHEAD = 64 * 2 ** 20;
/** The longest the worker works on slabs without letting other requests in, ms. */
const PAUSE_EVERY = 100;
let lastPause = 0;

/** Lets requests waiting on this worker in, once PAUSE_EVERY ms have passed since the last time (a pause costs a few ms). */
async function pause(): Promise<void> {
  if (performance.now() - lastPause < PAUSE_EVERY) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  lastPause = performance.now();
}

/** Chunk rows made at once for the viewer (each may read a large part of the file). */
const ROWS_AT_ONCE = 2;

class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

/** How a slab's making is reported and stopped. */
interface SlabContext {
  /** Level-0 voxels' worth done (a slab of a level read from the file, or one found kept). */
  progress?(voxels: number): void;
  cancelled?(): boolean;
  /** Each finer slab once made (Export → OME-Zarr writes its chunks). */
  emit?(index: number, e: number, slab: Slab): Promise<void>;
  /** Every level made from the file, none put together from kept chunks (the levels below are wanted too). */
  fresh?: boolean;
}

/** The overview build's state, as `{ overview: "status" }` answers it. */
export interface OverviewStatus {
  state: "idle" | "building" | "done" | "cancelled" | "failed";
  /** Level-0 voxels' worth done, of `total`. */
  done: number;
  total: number;
  message?: string;
  /** The file's bytes, and the bytes its overview may keep. */
  fileBytes: number;
  budget: number;
  /** Levels kept whole, the one kept in part, and the bytes of the whole ones. */
  kept: { whole: number[]; partial?: number; bytes: number };
  /** What the cache holds now. */
  cached: { bytes: number; chunks: number; byLevel: Record<number, { chunks: number; bytes: number }> };
  built: boolean;
  /** Whether this worker keeps the cache (another tab may). */
  writer: boolean;
  levels: { size: number[]; bytes: number; from: "file" | "computed" }[];
  /** No cache here (no private file system, or a file made in the page). */
  noCache?: boolean;
}

interface BuildState {
  status: OverviewStatus["state"];
  done: number;
  total: number;
  message?: string;
  cancel: boolean;
  running?: Promise<void>;
}

/** Runs at most `n` at a time. */
class Gate {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly n: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
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
  /**
   * Whether each chunk holds the whole extra axis: always for components,
   * and for a short 4th axis that is not a time series (no time unit and
   * step in the header), such as spherical-harmonic coefficients or
   * tensors, so they can be read together (as a channel) in one chunk.
   */
  private readonly wholeExtra: boolean;
  readonly inType: DType;
  readonly outType: DType;
  readonly label: boolean;
  private readonly affine: NiftiAffine;
  private readonly scale: { slope: number; inter: number } | undefined;
  /** Whether level 0's bytes are the file's (after byte order), with no arithmetic. */
  private readonly raw: boolean;
  /** Coarser levels' chunks (each made from many finer ones); level 0's are cut again from the bands.  Sized from the device's memory. */
  private readonly chunks = new Lru<Uint8Array>(memoryBudgets().chunks);
  private readonly bands = new Lru<Uint8Array>(memoryBudgets().bands);
  /** Slabs being made, by level and box, shared by whoever needs them meanwhile. */
  private readonly running = new Map<string, Promise<Slab>>();
  private readonly rows = new Gate(ROWS_AT_ONCE);
  /** The overview cache, opened when first needed. */
  private cache: Promise<OverviewCache | undefined> | undefined;
  private build: BuildState = { status: "idle", done: 0, total: 0, cancel: false };
  /**
   * Coarser levels as log-Euclidean means of the tensors stored in this
   * order of their six components; otherwise plain means.
   */
  private tensors: TensorOrder | undefined;
  private windows: Promise<DisplayWindow[] | undefined> | undefined;

  constructor(
    readonly header: NiftiHeader,
    private readonly data: () => Promise<ByteSource>,
    readonly name: string,
    /**
     * rgb: each voxel's colour packed in a uint32 (R lowest), which the group's metadata says.
     * label: a label image whatever its intent says (a FreeSurfer aseg, say): picked, not
     * averaged, when downsampled, and signed integers as uint32, as segmentations are read.
     */
    readonly options: {
      rgb?: boolean;
      label?: boolean;
      /** Coarser levels the file holds itself (a TIFF's reduced pages), finest first. */
      levels?: FileLevel[];
      /** The file, for keeping its overview between visits; none for a file made in the page. */
      cacheKey?: CacheKey;
      /** A slab larger than this many bytes is cut along i (256 MB). */
      slabBytes?: number;
    } = {},
  ) {
    const h = header;
    if (h.magic !== "n+1" && h.magic !== "n+2") {
      throw new Error(h.magic === "ni1" || h.magic === "ni2" ? "this header's image is in a separate .img file: open the folder holding both" : "not a NIfTI file (no n+1 or n+2 mark)");
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
    const timeSeries = timeUnit(h) !== undefined && Number.isFinite(h.pixdim[4]) && h.pixdim[4] > 0;
    this.wholeExtra = this.extra !== undefined && (this.extra.name === "c" || (this.extra.size <= WHOLE_EXTRA && !timeSeries));
    const slope = h.sclSlope;
    const inter = Number.isFinite(h.sclInter) ? h.sclInter : 0;
    this.scale = Number.isFinite(slope) && slope !== 0 && (slope !== 1 || inter !== 0) ? { slope, inter } : undefined;
    this.label = options.label === true || LABEL_INTENTS.has(h.intentCode);
    this.outType =
      this.label && (inType === "int8" || inType === "int16" || inType === "int32")
        ? "uint32"
        : this.scale !== undefined || inType === "float64"
          ? "float32"
          : inType === "int64"
            ? this.label
              ? "uint64"
              : "float32"
            : inType;
    this.raw = this.scale === undefined && (this.outType === inType || (inType === "int64" && this.outType === "uint64"));
    this.affine = niftiAffine(h);
    this.levels = this.pyramid();
    if (h.intentCode === NIFTI_INTENT_SYMMATRIX && this.holdsTensors()) this.tensors = "dipy";
  }

  /** Whether coarser levels can be tensor means: six float components a voxel, each chunk holding all six. */
  holdsTensors(): boolean {
    return this.extra?.size === 6 && this.wholeExtra && this.outType === "float32" && !this.label;
  }

  /** How coarser levels are made: the first voxel of a box, its mean, or its tensors' log-Euclidean mean. */
  get coarsening(): { type: "nearest" | "mean" | "log-euclidean"; order?: TensorOrder } {
    if (this.label) return { type: "nearest" };
    return this.tensors === undefined ? { type: "mean" } : { type: "log-euclidean", order: this.tensors };
  }

  /**
   * A message from the page: `{ tensor: order }` makes coarser levels
   * log-Euclidean means of tensors stored in that order, `{ tensor: null }`
   * plain means again.  Answers how they are made now, and whether that
   * changed (the page then reads them again).
   *
   * `{ overview: "status" | "build" | "cancel" | "clear" | "settings" }`:
   * the overview cache and its build (answering an `OverviewStatus`):
   * start the build in the background, stop it, drop what is kept, or
   * read the budget's settings again.
   */
  message(body: unknown): unknown {
    const overview = (body as { overview?: unknown } | null)?.overview;
    if (overview !== undefined) return this.overviewMessage(overview);
    const asked = (body as { tensor?: unknown } | null)?.tensor;
    const before = this.tensors;
    let reason: string | undefined;
    if (asked === null) this.tensors = undefined;
    else if (typeof asked === "string") {
      if (!TENSOR_ORDER_NAMES.includes(asked as TensorOrder)) throw new Error(`${asked} is not a tensor order (${TENSOR_ORDER_NAMES.join(", ")})`);
      if (this.holdsTensors()) this.tensors = asked as TensorOrder;
      else reason = "coarser levels stay plain means: tensors need six float components together in each chunk";
    } else if (asked !== undefined) throw new Error("tensor is an order or null");
    return { tensor: this.tensors ?? null, changed: before !== this.tensors, ...(reason ? { reason } : {}) };
  }

  private pyramid(): Level[] {
    const m = this.affine.matrix;
    const spacing = [0, 1, 2].map((a) => Math.hypot(m[0][a], m[1][a], m[2][a]) || 1);
    // With the extra axis whole, smaller spatial chunks: about four single-volume chunks' voxels each.
    const volumes = this.wholeExtra ? this.extra!.size : 1;
    const side = (c: number, d: number) => Math.max(8, Math.min(c, Math.floor(((4 * c ** d) / volumes) ** (1 / d))));
    const chunk = this.shape[2] > 1 ? [side(CHUNK, 3), side(CHUNK, 3), side(CHUNK, 3)] : [side(CHUNK_2D, 2), side(CHUNK_2D, 2), 1];
    const levels: Level[] = [{ size: this.shape, factor: [1, 1, 1], step: [1, 1, 1], chunk: chunk.map((c, a) => Math.min(c, this.shape[a])), read: this.data, offset: this.header.voxOffset }];
    // The file's own coarser levels, while each is smaller than the one before.
    for (const own of this.options.levels ?? []) {
      const last = levels[levels.length - 1];
      if ([0, 1, 2].every((a) => last.size[a] <= chunk[a])) break;
      if (!own.size.every((n, a) => n <= last.size[a]) || own.size.every((n, a) => n === last.size[a])) break;
      levels.push({ size: own.size, factor: own.factor, step: own.factor.map((f, a) => f / last.factor[a]), chunk: chunk.map((c, a) => Math.min(c, own.size[a])), read: own.read, offset: 0 });
    }
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
   * takes for the contrast): the header's cal_min to cal_max where it sets
   * them, else the 0.5th to 99.5th percentile of its middle plane; and the
   * plane's range.  None for label images.
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
      const { calMin, calMax } = this.header;
      // The file's own display range, where it gives one.
      if (calMin !== undefined && calMax !== undefined && Number.isFinite(calMin) && Number.isFinite(calMax) && calMax > calMin) [start, end] = [calMin, calMax];
      else if (!(end > start)) [start, end] = max > min ? [min, max] : [min, min + 1];
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
              type: this.coarsening.type,
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
        ...(this.options.rgb ? { ngplatform: { rendering: "rgb" } } : {}),
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
          ...(this.tensors ? { tensor_order: this.tensors } : {}),
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
      chunk_grid: { name: "regular", configuration: { chunk_shape: [...(this.wholeExtra ? extra : this.extra ? [1] : []), ...chunk] } },
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
    if (this.extra !== undefined && e >= (this.wholeExtra ? 1 : this.extra.size)) return undefined;
    const b = at.slice(at.length - 3);
    if (b.some((v, a) => v * level.chunk[a] >= level.size[a])) return undefined;
    return this.chunk(index, e, b);
  }

  /** The 3-D volumes (in file order) in chunks with extra index `e`. */
  private volumesOf(e: number): number[] {
    if (this.wholeExtra) return Array.from({ length: this.extra!.size }, (_, c) => c);
    return [e];
  }

  private chunk(index: number, e: number, b: number[], tensors = this.tensors): Promise<Uint8Array> {
    if (this.levels[index].read !== undefined) return this.cut(index, e, b);
    if (tensors !== undefined) {
      // Tensors are averaged chunk by chunk, keyed by their order, so a change of mind never mixes the two.
      return this.chunks.get(`${tensors}|${index}/${e}/${b.join("/")}`, () => this.reduceTensors(index, b, tensors), (d) => d.byteLength);
    }
    return this.chunks.get(`${index}/${e}/${b.join("/")}`, () => this.computed(index, e, b), (d) => d.byteLength);
  }

  // ------------------------------------------------------------ slabs

  private grid(index: number): Grid {
    const l = this.levels[index];
    return { size: l.size, chunk: l.chunk, step: l.step };
  }

  /** Volumes a chunk holds (time points or components kept together), and the chunk groups along the extra axis. */
  private get slots(): number {
    return this.wholeExtra ? this.extra!.size : 1;
  }

  private get groups(): number {
    return this.extra === undefined || this.wholeExtra ? 1 : this.extra.size;
  }

  private width(index: number): number {
    return slabWidth(this.grid(index), BYTES[this.outType], this.slots, this.options.slabBytes ?? SLAB_LIMIT);
  }

  private makeVoxels = (n: number): Voxels => new ARRAYS[this.outType](n);

  /** Level-0 voxels under a box of a level. */
  private voxels0(index: number, box: Box): number {
    const f = this.levels[index].factor;
    return [0, 1, 2].reduce((n, a) => n * Math.max(0, Math.min(this.shape[a], Math.round(box.hi[a] * f[a])) - Math.round(box.lo[a] * f[a])), 1);
  }

  /**
   * A chunk of a computed level: kept (the overview cache), or made with the
   * rest of its chunk row (a slab), whose chunks are then kept in memory.
   */
  private async computed(index: number, e: number, b: number[]): Promise<Uint8Array> {
    const key = `${index}/${e}/${b.join("/")}`;
    const cache = await this.overviewCache();
    const kept = await cache?.get(key);
    if (kept !== undefined) return kept;
    const grid = this.grid(index);
    const box = slabOf(grid, b, this.width(index));
    const slab = await this.rows.run(() => this.slab(index, e, box, {}));
    const bytes = BYTES[this.outType];
    let mine: Uint8Array | undefined;
    for (const c of chunksOf(grid, box)) {
      const chunk = chunkFromSlab(grid, slab, c, bytes);
      if (c.every((v, a) => v === b[a])) mine = chunk;
      else this.chunks.put(`${index}/${e}/${c.join("/")}`, chunk, chunk.byteLength);
    }
    return mine!;
  }

  /** A slab of a level: read (a level from the file), put together from kept chunks, or made from the finer level's. */
  private async slab(index: number, e: number, box: Box, ctx: SlabContext): Promise<Slab> {
    const key = `${index}/${e}/${box.lo.join(",")}/${box.hi.join(",")}`;
    for (;;) {
      const running = this.running.get(key);
      if (running === undefined) break;
      try {
        const slab = await running;
        ctx.progress?.(this.voxels0(index, box));
        return slab;
      } catch (err) {
        // Made for a build that was cancelled: made here instead.
        if (!(err instanceof Cancelled) || ctx.cancelled?.()) throw err;
      }
    }
    const made = this.makeSlab(index, e, box, ctx);
    this.running.set(key, made);
    const done = () => {
      if (this.running.get(key) === made) this.running.delete(key);
    };
    made.then(done, done);
    return made;
  }

  private async makeSlab(index: number, e: number, box: Box, ctx: SlabContext): Promise<Slab> {
    if (this.levels[index].read !== undefined) {
      const slab = await this.readSlab(index, e, box);
      ctx.progress?.(this.voxels0(index, box));
      return slab;
    }
    const kept = ctx.fresh ? undefined : await this.keptSlab(index, e, box);
    if (kept !== undefined) {
      ctx.progress?.(this.voxels0(index, box));
      return kept;
    }
    const grid = this.grid(index);
    const reducer = new Reducer(grid, this.grid(index - 1), box, this.slots, this.label || this.outType === "uint64" ? "nearest" : "mean", this.makeVoxels);
    const boxes = finerSlabs(grid, this.grid(index - 1), box, this.width(index - 1));
    // The next finer slabs are read (or made) while this one is added, so the file is read while the
    // worker reduces: two ahead when they are read from the file, one when they are made.
    const ahead = this.levels[index - 1].read !== undefined ? 2 : 1;
    const started: Promise<Slab>[] = [];
    const start = (i: number) => {
      if (i >= boxes.length || started[i] !== undefined) return;
      started[i] = this.slab(index - 1, e, boxes[i], ctx);
      started[i].catch(() => {});
    };
    for (let i = 0; i < ahead; ++i) start(i);
    for (let i = 0; i < boxes.length; ++i) {
      if (ctx.cancelled?.()) throw new Cancelled();
      const slab = await started[i];
      delete started[i];
      start(i + ahead);
      await ctx.emit?.(index - 1, e, slab);
      reducer.add(slab);
      // Let requests waiting on this worker in (now and then: each pause costs a few ms).
      await pause();
    }
    const slab = reducer.finish();
    await this.keep(index, e, slab);
    return slab;
  }

  /** A slab put together from chunks kept in memory or in the overview cache, when every one of them is. */
  private async keptSlab(index: number, e: number, box: Box): Promise<Slab | undefined> {
    const grid = this.grid(index);
    const cache = await this.overviewCache();
    const wanted = chunksOf(grid, box);
    const found = new Map<string, Promise<Uint8Array | undefined>>();
    for (const b of wanted) {
      const key = `${index}/${e}/${b.join("/")}`;
      const inMemory = this.chunks.peek(key);
      if (inMemory !== undefined) found.set(b.join("/"), inMemory.catch(() => undefined));
      else if (cache?.has(key)) found.set(b.join("/"), cache.get(key));
      else return undefined;
    }
    const chunks = new Map<string, Uint8Array>();
    for (const [k, p] of found) {
      const bytes = await p;
      if (bytes === undefined) return undefined;
      chunks.set(k, bytes);
    }
    return slabFromChunks(grid, box, this.slots, BYTES[this.outType], chunks, this.makeVoxels);
  }

  /** Keeps a computed slab's chunks in the overview cache, as far as its budget and levels allow. */
  private async keep(index: number, e: number, slab: Slab): Promise<void> {
    const cache = await this.overviewCache();
    if (cache === undefined || !cache.writer || index < cache.policy.floor) return;
    const grid = this.grid(index);
    // Written in the background: this waits only while more than WRITES_AHEAD bytes are still to be written.
    for (const b of chunksOf(grid, slab.box)) void cache.put(`${index}/${e}/${b.join("/")}`, index, chunkFromSlab(grid, slab, b, BYTES[this.outType]));
    await cache.drained(WRITES_AHEAD);
  }

  /** A slab of a level read from the file, from its bands, as the type served. */
  private async readSlab(index: number, e: number, box: Box): Promise<Slab> {
    const level = this.levels[index];
    const [ci, cj, ck] = level.chunk;
    const nx = level.size[0];
    const [ni, nj, nk] = [0, 1, 2].map((a) => box.hi[a] - box.lo[a]);
    const volumes = this.volumesOf(e);
    const bk = box.lo[2] / ck;
    const bj = box.lo[1] / cj;
    if (box.lo[0] % ci !== 0 || !Number.isInteger(bk) || !Number.isInteger(bj)) throw new Error("a slab off the chunks");
    const inSize = BYTES[this.inType];
    // A piece of a very wide level: only its part of each row is read.
    const bandOf = (v: number) => (ni === nx ? this.band(index, v, bk, bj) : this.readBand(index, v, bk, bj, box.lo[0], box.hi[0]));
    if (this.raw && volumes.length === 1) {
      // The file's bytes are the slab's voxels: no copy (the band is only read from).
      const band = await bandOf(volumes[0]);
      if (band.byteOffset % inSize === 0) return { box, slots: 1, data: typed(this.outType, band.subarray(0, ni * nj * nk * inSize)) as Voxels };
    }
    const out = this.makeVoxels(volumes.length * ni * nj * nk);
    const { slope, inter } = this.scale ?? { slope: 1, inter: 0 };
    for (let slot = 0; slot < volumes.length; ++slot) {
      const band = await bandOf(volumes[slot]);
      const at = slot * ni * nj * nk;
      if (this.raw) {
        const dst = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        dst.set(band.subarray(0, ni * nj * nk * inSize), at * inSize);
        continue;
      }
      const from = typed(this.inType, band);
      const to = out as Float32Array;
      for (let r = 0; r < nj * nk; ++r) {
        const src = r * ni;
        const dst = at + r * ni;
        for (let x = 0; x < ni; ++x) to[dst + x] = Number(from[src + x]) * slope + inter;
      }
    }
    return { box, slots: volumes.length, data: out };
  }

  /** The file's rows for chunk row (k, j) of volume `v` of a level read from the file: every i, little-endian. */
  private band(index: number, v: number, bk: number, bj: number): Promise<Uint8Array> {
    return this.bands.get(`${index}/${v}/${bk}/${bj}`, () => this.readBand(index, v, bk, bj), (d) => d.byteLength);
  }

  /** The rows of a chunk row; with `x0` and `x1`, only those columns of each (a piece of a very wide level). */
  private async readBand(index: number, v: number, bk: number, bj: number, x0?: number, x1?: number): Promise<Uint8Array> {
    const level = this.levels[index];
    const source = await level.read!();
    const [nx, ny, nz] = level.size;
    const [, cj, ck] = level.chunk;
    const size = BYTES[this.inType];
    const z0 = bk * ck;
    const z1 = Math.min(nz, z0 + ck);
    const y0 = bj * cj;
    const y1 = Math.min(ny, y0 + cj);
    const row = nx * size;
    const plane = ny * row;
    const base = (level.offset ?? 0) + v * nz * plane;
    let data: Uint8Array;
    const short = () => new Error("the file is shorter than its header says");
    if (x0 !== undefined && x1 !== undefined && (x0 > 0 || x1 < nx)) {
      // A piece of each row, read straight into place.
      const piece = (x1 - x0) * size;
      data = new Uint8Array((z1 - z0) * (y1 - y0) * piece);
      for (let z = z0; z < z1; ++z) {
        const got = await Promise.all(
          Array.from({ length: y1 - y0 }, (_, dy) => {
            const from = base + z * plane + (y0 + dy) * row + x0 * size;
            return readInto(source, from, from + piece, data.subarray(((z - z0) * (y1 - y0) + dy) * piece, ((z - z0) * (y1 - y0) + dy + 1) * piece));
          }),
        );
        if (got.some((n) => n < piece)) throw short();
      }
    } else if (y0 === 0 && y1 === ny) data = await source.read(base + z0 * plane, base + z1 * plane);
    else {
      // The rows of each plane, read straight into place (no copy to join them).
      const part = (y1 - y0) * row;
      data = new Uint8Array((z1 - z0) * part);
      const got = await Promise.all(Array.from({ length: z1 - z0 }, (_, dz) => readInto(source, base + (z0 + dz) * plane + y0 * row, base + (z0 + dz) * plane + y1 * row, data.subarray(dz * part, (dz + 1) * part))));
      if (got.some((n) => n < part)) throw short();
    }
    if (x0 === undefined && data.byteLength < (z1 - z0) * (y1 - y0) * row) throw short();
    if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) data = data.slice();
    if (!this.header.littleEndian && size > 1) swapBytes(data, size);
    return data;
  }

  /** A chunk of a level read from the file, cut from its bands. */
  private async cut(index: number, e: number, b: number[]): Promise<Uint8Array> {
    const level = this.levels[index];
    const nx = level.size[0];
    const [ci, cj, ck] = level.chunk;
    const lo = [0, 1, 2].map((a) => b[a] * level.chunk[a]);
    const hi = [0, 1, 2].map((a) => Math.min(level.size[a], lo[a] + level.chunk[a]));
    const volumes = this.volumesOf(e);
    const inSize = BYTES[this.inType];
    const outSize = BYTES[this.outType];
    const out = new Uint8Array(volumes.length * ci * cj * ck * outSize);
    const to = this.raw ? undefined : (typed(this.outType, out) as Float32Array);
    const { slope, inter } = this.scale ?? { slope: 1, inter: 0 };
    const width = hi[0] - lo[0];
    const rows = hi[1] - lo[1];
    const bands = await Promise.all(volumes.map((v) => this.band(index, v, b[2], b[1])));
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

  // ------------------------------------------------------------ the overview cache and build

  /** The bytes of a level's chunks (as kept: whole chunks), every group. */
  private levelBytes(index: number): number {
    const l = this.levels[index];
    const chunks = [0, 1, 2].reduce((n, a) => n * Math.ceil(l.size[a] / l.chunk[a]), 1);
    return chunks * l.chunk[0] * l.chunk[1] * l.chunk[2] * this.slots * this.groups * BYTES[this.outType];
  }

  private async plan(free?: number): Promise<{ budget: number; kept: ReturnType<typeof levelsKept> }> {
    const fileBytes = this.options.cacheKey?.size ?? 0;
    const budget = cacheBudget(fileBytes, await readSettings().catch(() => undefined), free);
    const kept = levelsKept(
      this.levels.map((_, i) => this.levelBytes(i)),
      this.levels.map((l) => l.read === undefined),
      budget,
    );
    return { budget, kept };
  }

  /** The overview cache, opened once (none for tensors, which are averaged chunk by chunk, or without a file to key it by). */
  private overviewCache(): Promise<OverviewCache | undefined> {
    const key = this.options.cacheKey;
    // Small images make their coarser levels in a moment: nothing kept.
    if (key === undefined || key.size < MIN_CACHED) return Promise.resolve(undefined);
    return (this.cache ??= OverviewCache.open(`${key.name}|${key.size}|${key.lastModified}|${this.coarsening.type}|v1`, key, async (free) => {
      const { budget, kept } = await this.plan(free);
      return { budget, floor: kept.floor };
    }).catch(() => undefined));
  }

  /** The levels made from slabs at the top of each run of computed levels: [base read from the file, top]. */
  private segments(): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < this.levels.length; ++i) {
      if (this.levels[i].read === undefined) continue;
      let top = i;
      while (top + 1 < this.levels.length && this.levels[top + 1].read === undefined) top++;
      out.push([i, top]);
    }
    return out;
  }

  private async overviewMessage(what: unknown): Promise<OverviewStatus> {
    if (what === "build") this.startBuild();
    else if (what === "cancel") this.cancelBuild();
    else if (what === "clear") await this.clearCache();
    else if (what === "settings") {
      const cache = await this.overviewCache();
      if (cache !== undefined) {
        const { budget, kept } = await this.plan();
        await cache.rebudget(budget, kept.floor);
      }
    } else if (what !== "status") throw new Error(`overview: ${String(what)} is not status, build, cancel, clear or settings`);
    return this.status();
  }

  async status(): Promise<OverviewStatus> {
    const cache = await this.overviewCache();
    const { budget, kept } = await this.plan();
    const policy = cache?.policy;
    return {
      state: this.build.status,
      done: this.build.done,
      total: this.build.total,
      ...(this.build.message ? { message: this.build.message } : {}),
      fileBytes: this.options.cacheKey?.size ?? 0,
      budget: policy?.budget ?? budget,
      kept: { whole: kept.whole, ...(kept.partial !== undefined ? { partial: kept.partial } : {}), bytes: kept.bytes },
      cached: { bytes: policy?.total ?? 0, chunks: policy?.entries.size ?? 0, byLevel: policy?.byLevel() ?? {} },
      built: cache?.built ?? false,
      writer: cache?.writer ?? false,
      levels: this.levels.map((l, i) => ({ size: l.size, bytes: this.levelBytes(i), from: l.read === undefined ? "computed" : "file" })),
      ...(cache === undefined ? { noCache: true } : {}),
    };
  }

  /**
   * Makes the overview in the background: every computed level, slab by
   * slab from the file, read once; the levels the budget keeps are kept as
   * they pass.  Chunks the viewer asks for meanwhile are made as before.
   */
  startBuild(): void {
    if (this.build.status === "building") return;
    if (this.tensors !== undefined) {
      this.build = { status: "failed", done: 0, total: 0, cancel: false, message: "tensors are averaged as they are viewed" };
      return;
    }
    const groups = this.groups;
    const segments = this.segments();
    const total = segments.length * groups * this.shape.reduce((a, b) => a * b, 1);
    const state: BuildState = { status: "building", done: 0, total, cancel: false };
    this.build = state;
    state.running = (async () => {
      const cache = await this.overviewCache();
      if (cache === undefined || !cache.writer) throw new Error(cache === undefined ? "this browser keeps no overviews (no private file system)" : "another tab is keeping this image's overview");
      const ctx: SlabContext = { progress: (n) => (state.done += n), cancelled: () => state.cancel };
      for (const [base, top] of segments) {
        for (let e = 0; e < groups; ++e) {
          // Nothing to make from this base, or nothing kept above it: counted done.
          if (top === base || top < cache.policy.floor) {
            state.done += this.shape.reduce((a, b) => a * b, 1);
            continue;
          }
          for (const box of levelSlabs(this.grid(top), this.width(top))) await this.slab(top, e, box, ctx);
        }
      }
      await cache.flush();
      cache.markBuilt(true);
    })().then(
      () => {
        state.status = "done";
        state.done = state.total;
      },
      (err) => {
        state.status = state.cancel ? "cancelled" : "failed";
        if (!(err instanceof Cancelled)) state.message = (err as Error).message;
      },
    );
  }

  cancelBuild(): void {
    if (this.build.status === "building") this.build.cancel = true;
  }

  async clearCache(): Promise<void> {
    this.cancelBuild();
    await this.build.running?.catch(() => {});
    const cache = await this.overviewCache();
    await cache?.clear();
    this.build = { status: "idle", done: 0, total: 0, cancel: false };
  }

  /**
   * Every chunk of every level, each once (Export → OME-Zarr): the file read
   * once, slab by slab, each computed level made from the slabs below it as
   * they pass and handed to `write` with its key.  Chunks all zero (Zarr's
   * fill value) are left out.  Levels the overview cache holds are
   * read from it.
   */
  async eachChunk(write: (key: string, bytes: Uint8Array) => Promise<void>, control: { progress(done: number, total: number): void; readonly cancelled: boolean }): Promise<void> {
    const bytes = BYTES[this.outType];
    const keyOf = (index: number, e: number, b: number[]) => `${index}/c/${[...(this.extra ? [e] : []), ...b].join("/")}`;
    if (this.tensors !== undefined) {
      // Tensors: chunk by chunk, each level from the one below as it is asked for.
      const keys: string[] = [];
      for (let i = 0; i < this.levels.length; ++i) for (let e = 0; e < this.groups; ++e) for (const b of chunksOf(this.grid(i), { lo: [0, 0, 0], hi: this.levels[i].size })) keys.push(keyOf(i, e, b));
      let done = 0;
      for (const key of keys) {
        if (control.cancelled) throw new Cancelled();
        const chunk = await this.get(key);
        if (chunk !== undefined && chunk.some((v) => v !== 0)) await write(key, chunk);
        control.progress(++done, keys.length);
      }
      return;
    }
    const segments = this.segments();
    const total = segments.length * this.groups * this.shape.reduce((a, b) => a * b, 1);
    let done = 0;
    const emit = async (index: number, e: number, slab: Slab) => {
      const grid = this.grid(index);
      for (const b of chunksOf(grid, slab.box)) {
        const chunk = chunkFromSlab(grid, slab, b, bytes);
        if (chunk.some((v) => v !== 0)) await write(keyOf(index, e, b), chunk);
      }
    };
    const ctx: SlabContext = {
      progress: (n) => control.progress((done += n), total),
      cancelled: () => control.cancelled,
      emit,
      fresh: true,
    };
    for (const [, top] of segments) {
      for (let e = 0; e < this.groups; ++e) {
        for (const box of levelSlabs(this.grid(top), this.width(top))) {
          const slab = await this.slab(top, e, box, ctx);
          await emit(top, e, slab);
        }
      }
    }
  }

  /**
   * A chunk of a coarser level of tensors: each voxel the log-Euclidean
   * mean of the finer level's box (of its tensors that are positive
   * definite; zeros when none is).  Each chunk holds all six components.
   */
  private async reduceTensors(index: number, b: number[], order: TensorOrder): Promise<Uint8Array> {
    const level = this.levels[index];
    const finer = this.levels[index - 1];
    const [ci, cj, ck] = level.chunk;
    const [fi, fj, fk] = finer.chunk;
    const step = level.step;
    const lo = [0, 1, 2].map((a) => b[a] * level.chunk[a]);
    const hi = [0, 1, 2].map((a) => Math.min(level.size[a], lo[a] + level.chunk[a]));
    const srcLo = lo.map((v, a) => v * step[a]);
    const srcHi = hi.map((v, a) => Math.min(finer.size[a], v * step[a]));
    const voxels = ci * cj * ck;
    const sums = new LogEuclideanSum(voxels, order);
    const first = srcLo.map((v, a) => Math.floor(v / finer.chunk[a]));
    const last = srcHi.map((v, a) => Math.floor((v - 1) / finer.chunk[a]));
    // A component's stride in a finer chunk (components slowest).
    const fineStride = fi * fj * fk;
    for (let pk = first[2]; pk <= last[2]; ++pk) {
      for (let pj = first[1]; pj <= last[1]; ++pj) {
        for (let pi = first[0]; pi <= last[0]; ++pi) {
          const p = [pi, pj, pk];
          const from = typed("float32", await this.chunk(index - 1, 0, p, order)) as unknown as Float32Array;
          const slo = p.map((v, a) => v * finer.chunk[a]);
          const xlo = Math.max(slo[0], srcLo[0]);
          const xhi = Math.min(slo[0] + fi, srcHi[0]);
          for (let z = Math.max(slo[2], srcLo[2]); z < Math.min(slo[2] + fk, srcHi[2]); ++z) {
            const dz = Math.floor(z / step[2]) - lo[2];
            for (let y = Math.max(slo[1], srcLo[1]); y < Math.min(slo[1] + fj, srcHi[1]); ++y) {
              const dy = Math.floor(y / step[1]) - lo[1];
              const srcRow = ((z - slo[2]) * fj + (y - slo[1])) * fi - slo[0];
              const dstRow = (dz * cj + dy) * ci - lo[0];
              for (let x = xlo; x < xhi; ++x) sums.add(dstRow + Math.floor(x / step[0]), from, srcRow + x, fineStride);
            }
          }
        }
      }
    }
    const out = new Uint8Array(6 * voxels * 4);
    const to = typed("float32", out) as unknown as Float32Array;
    for (let d = 0; d < voxels; ++d) if (sums.count(d) > 0) sums.mean(d, to, d, voxels);
    return out;
  }
}

/** A file on this computer, by its name, size and date (for the caches); none for data made in the page without a date. */
export function cacheKeyOf(file: Blob): CacheKey | undefined {
  return file instanceof File ? { name: file.name, size: file.size, lastModified: file.lastModified } : undefined;
}

/** A NIfTI file as a store; reads only its header until a chunk is asked for. */
export async function openNifti(file: Blob, name: string, options: { label?: boolean } = {}): Promise<NiftiStore> {
  const start = new Uint8Array(await file.slice(0, 540).arrayBuffer());
  const gz = isGzip(start);
  const header = parseNiftiHeader(gz ? await gunzipHead(file, 540) : start);
  const whole = blobSource(file);
  // A file from this computer is kept decompressed between visits, by its name, size and date.
  const key = file instanceof File ? `${file.name}|${file.size}|${file.lastModified}` : undefined;
  const data = gz ? gunzipSource(file, key) : () => Promise.resolve(whole);
  const samples = COLOUR[header.datatype];
  if (samples !== undefined) {
    const voxels = header.dim.slice(1, 1 + header.dim[0]).reduce((a, d) => a * Math.max(1, d), 1);
    return new NiftiStore(packedHeader(header), () => data().then((s) => packedColours(s, header.voxOffset, voxels, samples)), name, { rgb: true, cacheKey: cacheKeyOf(file) });
  }
  return new NiftiStore(header, data, name, { ...options, cacheKey: cacheKeyOf(file) });
}
