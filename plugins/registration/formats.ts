/**
 * Affine transforms in the files registration tools write, read and written
 * as one convention: a 4 × 4 row-major matrix taking moving RAS
 * millimetres to fixed RAS millimetres (as ngtools keeps them).
 *
 * - Plain text: 4 rows of 4 numbers (or 3 rows; the last is 0 0 0 1),
 *   moving → fixed, as written.
 * - ITK / ANTs text (`.txt`, AffineTransform_*_3_3): maps fixed LPS points
 *   to moving LPS points about a centre; turned to RAS and inverted.
 * - FreeSurfer LTA (`.lta`): RAS to RAS (type 1), source → destination, as
 *   written, with the volumes' geometry when known (as Freeview's Save Reg
 *   writes it, so FreeSurfer's tools need no other file); VOX to VOX (type
 *   0, Freeview's own) read through the geometry it carries.
 * - MNI `.xfm`: RAS to RAS, as written.
 * - FreeSurfer `register.dat` (tkregister) and FSL FLIRT `.mat`: relative
 *   to both volumes' voxel grids, so read with both geometries.
 * - ANTs `.mat` (binary, as antsRegistration's 0GenericAffine.mat): the
 *   ITK parameters in a MATLAB v4 file.
 */
import { apply4, identity4, invert4, type Mat4, multiply4 } from "./fit.js";

/** LPS <-> RAS: flip x and y. */
const FLIP = Float64Array.from([-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function numbers(text: string): number[] {
  return (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

function fromRows(values: number[]): Mat4 {
  if (values.length !== 12 && values.length !== 16) throw new Error(`expected 12 or 16 numbers, found ${values.length}`);
  const m = identity4();
  for (let i = 0; i < 12; ++i) m[i] = values[i];
  return m;
}

export function readPlain(text: string): Mat4 {
  return fromRows(numbers(text.replace(/#.*$/gm, "")));
}

export function writePlain(m: Mat4): string {
  return [0, 1, 2, 3].map((r) => Array.from(m.slice(4 * r, 4 * r + 4), (v) => v.toPrecision(10)).join(" ")).join("\n") + "\n";
}

export function readItk(text: string): Mat4 {
  const parameters = /^Parameters:(.*)$/m.exec(text);
  if (parameters === null) throw new Error("no Parameters line (an ITK transform file has one)");
  const p = numbers(parameters[1]);
  if (p.length !== 12) throw new Error(`an affine ITK transform has 12 parameters; this one has ${p.length}`);
  const fixed = /^FixedParameters:(.*)$/m.exec(text);
  const c = fixed ? numbers(fixed[1]) : [0, 0, 0];
  // x' = A (x - c) + c + t, in LPS, fixed to moving.
  const m = identity4();
  for (let r = 0; r < 3; ++r) {
    for (let k = 0; k < 3; ++k) m[4 * r + k] = p[3 * r + k];
    m[4 * r + 3] = p[9 + r] + c[r] - (p[3 * r] * c[0] + p[3 * r + 1] * c[1] + p[3 * r + 2] * c[2]);
  }
  const fixedToMovingRas = multiply4(FLIP, multiply4(m, FLIP));
  return invert4(fixedToMovingRas);
}

export function writeItk(movingToFixed: Mat4): string {
  const lps = multiply4(FLIP, multiply4(invert4(movingToFixed), FLIP));
  const a = [0, 1, 2].flatMap((r) => [0, 1, 2].map((k) => lps[4 * r + k]));
  const t = [0, 1, 2].map((r) => lps[4 * r + 3]);
  return [
    "#Insight Transform File V1.0",
    "#Transform 0",
    "Transform: AffineTransform_double_3_3",
    `Parameters: ${[...a, ...t].map((v) => v.toPrecision(10)).join(" ")}`,
    "FixedParameters: 0 0 0",
    "",
  ].join("\n");
}

/** A volume as an LTA records it: voxels along x, y, z, and their placement (voxel indices to RAS mm). */
export interface VolumeGeometry {
  size: [number, number, number];
  voxelToRas: Mat4;
  filename?: string;
}

/** FreeSurfer's volume info lines: voxel sizes, the axes' directions, and the RAS of voxel size / 2 (its c_ras). */
function volumeInfo(g: VolumeGeometry | undefined): string[] {
  if (g === undefined) return ["valid = 0  # volume info invalid"];
  const m = g.voxelToRas;
  const d = [0, 1, 2].map((k) => Math.hypot(m[k], m[4 + k], m[8 + k]));
  const direction = (k: number) => [0, 1, 2].map((r) => m[4 * r + k] / d[k]);
  const e = (v: number[]) => v.map((x) => x.toExponential(15)).join(" ");
  return [
    "valid = 1  # volume info valid",
    `filename = ${g.filename ?? "unknown"}`,
    `volume = ${g.size.join(" ")}`,
    `voxelsize = ${e(d)}`,
    `xras   = ${e(direction(0))}`,
    `yras   = ${e(direction(1))}`,
    `zras   = ${e(direction(2))}`,
    `cras   = ${e(apply4(m, g.size.map((n) => n / 2)))}`,
  ];
}

/** A volume info block read back (undefined when it says it is not valid). */
function readVolumeInfo(block: string): VolumeGeometry | undefined {
  const field = (name: string) => {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m").exec(block);
    return m === null ? undefined : numbers(m[1]);
  };
  if (field("valid")?.[0] !== 1) return undefined;
  const size = field("volume");
  const voxel = field("voxelsize");
  const axes = ["xras", "yras", "zras"].map(field);
  const cras = field("cras");
  if (size?.length !== 3 || voxel?.length !== 3 || cras?.length !== 3 || axes.some((a) => a?.length !== 3)) return undefined;
  const m = identity4();
  for (let r = 0; r < 3; ++r) for (let k = 0; k < 3; ++k) m[4 * r + k] = axes[k]![r] * voxel[k];
  const centre = apply4(m, size.map((n) => n / 2));
  for (let r = 0; r < 3; ++r) m[4 * r + 3] = cras[r] - centre[r];
  return { size: size as [number, number, number], voxelToRas: m };
}

export function readLta(text: string): Mat4 {
  const type = /^\s*type\s*=\s*(\d+)/m.exec(text)?.[1] ?? "1";
  if (type !== "0" && type !== "1") throw new Error(`LTA type ${type} cannot be read here (RAS to RAS, type 1, and VOX to VOX, type 0, can)`);
  const at = /^\s*1\s+4\s+4\s*$/m.exec(text);
  if (at === null) throw new Error("no 4 × 4 matrix (a line reading 1 4 4) in the file");
  const matrix = fromRows(numbers(text.slice(at.index + at[0].length)).slice(0, 16));
  if (type === "1") return matrix;
  // VOX to VOX: through the volumes' placements, to RAS to RAS.
  const src = /src volume info([\s\S]*?)(?=dst volume info|$)/.exec(text);
  const dst = /dst volume info([\s\S]*?)$/.exec(text);
  const from = src && readVolumeInfo(src[1]);
  const to = dst && readVolumeInfo(dst[1]);
  if (!from || !to) throw new Error("a VOX to VOX LTA needs its volumes' info (valid = 1) to be read");
  return multiply4(to.voxelToRas, multiply4(matrix, invert4(from.voxelToRas)));
}

/**
 * An LTA, RAS to RAS, moving (src) to fixed (dst); with the volumes'
 * geometry when given, so FreeSurfer's tools (mri_vol2vol, lta_convert,
 * Freeview) can use it alone.
 */
export function writeLta(movingToFixed: Mat4, geometry: { src?: VolumeGeometry; dst?: VolumeGeometry } = {}): string {
  return [
    "# transform file written by ngplatform registration",
    "type      = 1 # LINEAR_RAS_TO_RAS",
    "nxforms   = 1",
    "mean      = 0.0000 0.0000 0.0000",
    "sigma     = 1.0000",
    "1 4 4",
    writePlain(movingToFixed).trimEnd(),
    "src volume info",
    ...volumeInfo(geometry.src),
    "dst volume info",
    ...volumeInfo(geometry.dst),
    "",
  ].join("\n");
}

/**
 * An MNI .xfm (MINC's linear transform, as FreeSurfer's talairach.xfm):
 * the three rows after `Linear_Transform =`, from the source's world (RAS
 * mm) to the target's, so moving to fixed as it stands.
 */
export function readXfm(text: string): Mat4 {
  const at = text.search(/Linear_Transform\s*=/);
  if (at === -1) throw new Error("not a linear MNI transform (no Linear_Transform)");
  const numbers = text
    .slice(at)
    .replace(/^Linear_Transform\s*=/, "")
    .split(";")[0]
    .trim()
    .split(/\s+/)
    .map(Number);
  if (numbers.length < 12 || numbers.slice(0, 12).some((v) => !Number.isFinite(v))) throw new Error("the transform needs 12 numbers (3 rows of 4)");
  return Float64Array.from([...numbers.slice(0, 12), 0, 0, 0, 1]);
}

/** tkregister's voxel-to-RAS: the volume's voxel sizes, laid out as a conformed (LIA) volume, centred on 0. */
function tkrVoxelToRas(g: VolumeGeometry): Mat4 {
  const m = g.voxelToRas;
  const [dx, dy, dz] = [0, 1, 2].map((k) => Math.hypot(m[k], m[4 + k], m[8 + k]));
  const [nx, ny, nz] = g.size;
  return Float64Array.from([-dx, 0, 0, (dx * nx) / 2, 0, 0, dz, (-dz * nz) / 2, 0, -dy, 0, (dy * ny) / 2, 0, 0, 0, 1]);
}

/**
 * FreeSurfer's register.dat (tkregister, bbregister): after four header
 * lines (subject, in-plane and between-plane resolution, intensity), a
 * 4 × 4 from the fixed volume's tkregister RAS to the moving one's.
 */
export function readRegisterDat(text: string, moving: VolumeGeometry, fixed: VolumeGeometry): Mat4 {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 8) throw new Error("a register.dat has 4 header lines and 4 matrix rows");
  const r = fromRows(lines.slice(4, 8).flatMap((l) => numbers(l)));
  // fixed RAS <- fixed tkRAS <- moving tkRAS <- moving RAS
  return multiply4(fixed.voxelToRas, multiply4(invert4(tkrVoxelToRas(fixed)), multiply4(invert4(r), multiply4(tkrVoxelToRas(moving), invert4(moving.voxelToRas)))));
}

/** FSL's scaled voxel coordinates: voxel sizes along each axis, x reversed when the voxel-to-RAS keeps handedness. */
function fslVoxelToCoords(g: VolumeGeometry): Mat4 {
  const m = g.voxelToRas;
  const d = [0, 1, 2].map((k) => Math.hypot(m[k], m[4 + k], m[8 + k]));
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  const s = Float64Array.from([d[0], 0, 0, 0, 0, d[1], 0, 0, 0, 0, d[2], 0, 0, 0, 0, 1]);
  if (det > 0) {
    s[0] = -d[0];
    s[3] = (g.size[0] - 1) * d[0];
  }
  return s;
}

/** FSL FLIRT's .mat: a 4 × 4 from the moving (input) volume's FSL coordinates to the fixed (reference) one's. */
export function readFslMat(text: string, moving: VolumeGeometry, fixed: VolumeGeometry): Mat4 {
  const f = readPlain(text);
  return multiply4(fixed.voxelToRas, multiply4(invert4(fslVoxelToCoords(fixed)), multiply4(f, multiply4(fslVoxelToCoords(moving), invert4(moving.voxelToRas)))));
}

/** The variables in a MATLAB v4 file of doubles (as ITK writes ANTs' .mat), each as its values. */
function readMatV4(bytes: Uint8Array): Map<string, Float64Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, Float64Array>();
  for (let at = 0; at + 20 <= bytes.length; ) {
    let little = true;
    let type = view.getInt32(at, true);
    if (type < 0 || type > 4052) {
      little = false;
      type = view.getInt32(at, false);
    }
    const [rows, cols, imaginary, nameLength] = [4, 8, 12, 16].map((o) => view.getInt32(at + o, little));
    const precision = Math.floor(type / 10) % 10;
    if (precision !== 0 && precision !== 1) throw new Error("only double and single precision MATLAB v4 variables are read");
    const name = new TextDecoder().decode(bytes.subarray(at + 20, at + 20 + nameLength - 1));
    const size = precision === 0 ? 8 : 4;
    const n = rows * cols * (imaginary ? 2 : 1);
    let p = at + 20 + nameLength;
    if (p + n * size > bytes.length) throw new Error("the file ends inside a variable");
    const values = new Float64Array(rows * cols);
    for (let i = 0; i < values.length; ++i, p += size) values[i] = size === 8 ? view.getFloat64(p, little) : view.getFloat32(p, little);
    out.set(name, values);
    at = at + 20 + nameLength + n * size;
  }
  return out;
}

/** ANTs' binary .mat (ITK's MATLAB transform file): the affine's parameters and its centre, as the ITK text file. */
export function readAntsMat(bytes: Uint8Array): Mat4 {
  const variables = readMatV4(bytes);
  const key = [...variables.keys()].find((k) => /^(Affine|MatrixOffset)Transform_(double|float)_3_3$/.test(k));
  if (key === undefined) throw new Error(`no 3-D affine in the file (found ${[...variables.keys()].join(", ") || "nothing"})`);
  const fixed = variables.get("fixed") ?? [0, 0, 0];
  return readItk(`Transform: ${key}\nParameters: ${Array.from(variables.get(key)!).join(" ")}\nFixedParameters: ${Array.from(fixed).join(" ")}\n`);
}

/** What a transform file needs besides itself: both volumes' geometry (register.dat, FSL .mat). */
export function needsGeometry(name: string, bytes: Uint8Array): boolean {
  return /\.dat$/i.test(name) || (/\.mat$/i.test(name) && !isBinary(bytes));
}

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 512).includes(0);

/**
 * Reads a file by its name and contents, in whichever of the formats it
 * is; register.dat and FSL .mat need `geometry`.
 */
export function readTransformFile(name: string, contents: string | Uint8Array, geometry?: { moving?: VolumeGeometry; fixed?: VolumeGeometry }): Mat4 {
  const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents;
  if (/\.mat$/i.test(name) && isBinary(bytes)) return readAntsMat(bytes);
  const text = typeof contents === "string" ? contents : new TextDecoder().decode(contents);
  if (needsGeometry(name, bytes)) {
    const { moving, fixed } = geometry ?? {};
    if (moving === undefined || fixed === undefined) throw new Error("this file is relative to both images' voxel grids, so both are needed");
    return /\.dat$/i.test(name) ? readRegisterDat(text, moving, fixed) : readFslMat(text, moving, fixed);
  }
  if (/\.xfm$/i.test(name) || /Linear_Transform\s*=/.test(text)) return readXfm(text);
  if (/\.lta$/i.test(name) || /^\s*type\s*=/m.test(text)) return readLta(text);
  if (/^Transform:/m.test(text) || /^Parameters:/m.test(text)) return readItk(text);
  return readPlain(text);
}
