/**
 * Straightening a volume with landmarks, as Freeview's Transform Volume
 * does with its landmarks: two lines through points marked on the image
 * (#1 to #2, #3 to #4; the AC to the PC, say, and a point above the
 * midline) are turned onto two of the axes, rotating about the volume's
 * centre.  The first line lands exactly on its axis; the second as nearly
 * as it can, in the plane the two lines span.
 */
import type { Mat4, Vec3 } from "./fit.js";

export type Direction = "L→R" | "R→L" | "P→A" | "A→P" | "I→S" | "S→I";

export const DIRECTIONS: Direction[] = ["L→R", "R→L", "P→A", "A→P", "I→S", "S→I"];

/** Each direction as an axis (0 x, 1 y, 2 z of RAS) and a sign. */
const AXIS: Record<Direction, [number, number]> = { "L→R": [0, 1], "R→L": [0, -1], "P→A": [1, 1], "A→P": [1, -1], "I→S": [2, 1], "S→I": [2, -1] };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(...a);
  if (!(n > 1e-9)) throw new Error("two of the landmarks are at the same place");
  return [a[0] / n, a[1] / n, a[2] / n];
};
const axisVector = (d: Direction): Vec3 => {
  const [axis, sign] = AXIS[d];
  const v: Vec3 = [0, 0, 0];
  v[axis] = sign;
  return v;
};

/**
 * The rotation (a 4 × 4 on RAS mm, about `centre`) turning #1→#2 onto
 * `first` and #3→#4 as nearly as it can onto `second`.
 */
export function straighten(points: [Vec3, Vec3, Vec3, Vec3], first: Direction, second: Direction, centre: Vec3): Mat4 {
  if (AXIS[first][0] === AXIS[second][0]) throw new Error("the two lines need two different axes");
  const v0 = unit(sub(points[1], points[0]));
  const v2 = unit(cross(v0, sub(points[3], points[2])));
  const v1 = cross(v2, v0);
  const t0 = axisVector(first);
  const t1 = axisVector(second);
  const t2 = cross(t0, t1);
  // R = Σ t_i v_iᵀ: takes each landmark direction to its axis.
  const r = [0, 1, 2].map((row) => [0, 1, 2].map((col) => t0[row] * v0[col] + t1[row] * v1[col] + t2[row] * v2[col]));
  const out = new Float64Array(16);
  out[15] = 1;
  for (let row = 0; row < 3; ++row) {
    for (let col = 0; col < 3; ++col) out[4 * row + col] = r[row][col];
    // About the centre: c - R c.
    out[4 * row + 3] = centre[row] - (r[row][0] * centre[0] + r[row][1] * centre[1] + r[row][2] * centre[2]);
  }
  return out;
}
