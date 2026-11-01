/**
 * Affine transforms in the files registration tools write, read and written
 * as one convention: a 4 × 4 row-major matrix taking moving RAS
 * millimetres to fixed RAS millimetres (as ngtools keeps them).
 *
 * - Plain text: 4 rows of 4 numbers (or 3 rows; the last is 0 0 0 1),
 *   moving → fixed, as written.
 * - ITK / ANTs text (`.txt`, AffineTransform_*_3_3): maps fixed LPS points
 *   to moving LPS points about a centre; turned to RAS and inverted.
 * - FreeSurfer LTA (`.lta`), type 1 (RAS to RAS): source → destination, as
 *   written.  VOX to VOX needs the volumes' headers and is refused.
 */
import { identity4, invert4, type Mat4, multiply4 } from "./fit.js";

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

export function readLta(text: string): Mat4 {
  const type = /^\s*type\s*=\s*(\d+)/m.exec(text);
  if (type !== null && type[1] !== "1") throw new Error("only RAS-to-RAS LTA files (type = 1) can be read without their volumes");
  const at = /^\s*1\s+4\s+4\s*$/m.exec(text);
  if (at === null) throw new Error("no 4 × 4 matrix (a line reading 1 4 4) in the file");
  const values = numbers(text.slice(at.index + at[0].length)).slice(0, 16);
  return fromRows(values);
}

export function writeLta(movingToFixed: Mat4): string {
  return [
    "# transform file written by ngplatform registration",
    "type      = 1 # LINEAR_RAS_TO_RAS",
    "nxforms   = 1",
    "mean      = 0.0000 0.0000 0.0000",
    "sigma     = 1.0000",
    "1 4 4",
    writePlain(movingToFixed).trimEnd(),
    "src volume info",
    "valid = 0  # volume info invalid",
    "dst volume info",
    "valid = 0  # volume info invalid",
    "",
  ].join("\n");
}

/** Reads a file by its name and contents, in whichever of the formats it is. */
export function readTransformFile(name: string, text: string): Mat4 {
  if (/\.lta$/i.test(name) || /^\s*type\s*=/m.test(text)) return readLta(text);
  if (/^Transform:/m.test(text) || /^Parameters:/m.test(text)) return readItk(text);
  return readPlain(text);
}
