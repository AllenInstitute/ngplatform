/**
 * The geometry of the view aids, pure: quaternions as Neuroglancer keeps
 * them (x, y, z, w; the 3-D view's orientation turns view coordinates,
 * x right, y down, z into the screen, into display coordinates), the
 * orientation cube (what is under the pointer, what a face is called, the
 * standard views and the nearest of them) and easing.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const IDENTITY: Quat = [0, 0, 0, 1];

export function normalise(q: readonly number[]): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 0) || !Number.isFinite(l)) return [...IDENTITY];
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** A quaternion from the state's `projectionOrientation` (identity when missing or broken). */
export function readQuat(value: unknown): Quat {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === "number" && Number.isFinite(v))) return [...IDENTITY];
  return normalise(value as number[]);
}

export function dot4(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** The angle (radians) of the rotation between two orientations. */
export function angleBetween(a: Quat, b: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(dot4(normalise(a), normalise(b)))));
}

/** Spherical linear interpolation, the shorter way round. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  const qa = normalise(a);
  let qb = normalise(b);
  let d = dot4(qa, qb);
  if (d < 0) {
    qb = [-qb[0], -qb[1], -qb[2], -qb[3]];
    d = -d;
  }
  if (d > 0.9995) return normalise(qa.map((v, i) => v + (qb[i] - v) * t));
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return normalise(qa.map((v, i) => v * wa + qb[i] * wb));
}

/** Ease in and out (cubic), for camera moves: 0 at 0, 1 at 1. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** The rotation matrix of q, row-major: its columns are the view's right, down and forward in display coordinates. */
export function matrix(q: Quat): number[] {
  const [x, y, z, w] = normalise(q);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** A display-space direction in view coordinates (x right, y down, z away from the viewer). */
export function toView(q: Quat, v: Vec3): Vec3 {
  const m = matrix(q);
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}

/** A view-coordinate direction in display space. */
export function toDisplay(q: Quat, v: Vec3): Vec3 {
  const m = matrix(q);
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The orientation whose view has these axes (display coordinates, orthonormal, right × down = forward). */
export function fromBasis(right: Vec3, down: Vec3, forward: Vec3): Quat {
  // Rows of the matrix whose columns are right, down, forward.
  const m = [
    [right[0], down[0], forward[0]],
    [right[1], down[1], forward[1]],
    [right[2], down[2], forward[2]],
  ];
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s];
  }
  q = normalise(q);
  // One sign for each rotation, so equal views compare equal.
  return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

// ------------------------------------------------------------------ axes

/**
 * What the 3-D view's display axes are: each one's name, the letters of its
 * two ends (R and L, or +x and −x), and which way is up.  Anatomical data
 * (RAS: +x right, +y anterior, +z superior) stands superior up, and anterior
 * up when seen from above or below; other data keeps Neuroglancer's own
 * convention, +y down, and +z down when seen along y.
 */
export interface Axes {
  anatomical: boolean;
  /** Per display axis: [the + end's letter, the − end's]. */
  ends: [string, string][];
  /** Per display axis: [the + end's word, the − end's] ("right", "left"; "+x", "−x"). */
  words: [string, string][];
  up: Vec3;
  /** Up when looking along `up`. */
  alt: Vec3;
}

const RAS: Record<string, [string, string, string, string]> = {
  x: ["R", "L", "right", "left"],
  y: ["A", "P", "anterior", "posterior"],
  z: ["S", "I", "superior", "inferior"],
};

/**
 * Whether the global space reads as anatomy in RAS: spatial axes x, y and z
 * in units of a micrometre or more.  The same test the engine makes to
 * choose radiological panels (src/engine/anatomical.ts, looksAnatomical).
 */
export function looksAnatomical(names: readonly string[], scales: readonly number[], units: readonly string[]): boolean {
  const xyz = ["x", "y", "z"].map((n) => names.indexOf(n));
  if (xyz.some((i) => i === -1)) return false;
  return xyz.every((i) => units[i] === "m" && scales[i] >= 0.5e-6);
}

/**
 * The axes of the 3-D view, from the state's `dimensions` ({name: [scale,
 * unit]}) and `displayDimensions` (the names shown; the first three when
 * not given).
 */
export function axesOf(dimensions: unknown, displayDimensions: unknown): Axes {
  const entries = dimensions !== null && typeof dimensions === "object" ? Object.entries(dimensions as Record<string, unknown>) : [];
  const names = entries.map(([n]) => n);
  const scales = entries.map(([, v]) => (Array.isArray(v) && typeof v[0] === "number" ? v[0] : NaN));
  const units = entries.map(([, v]) => (Array.isArray(v) && typeof v[1] === "string" ? v[1] : ""));
  const shown = (Array.isArray(displayDimensions) ? (displayDimensions as unknown[]).filter((n): n is string => typeof n === "string") : names).slice(0, 3);
  while (shown.length < 3) shown.push("");
  const anatomical = looksAnatomical(names, scales, units) && ["x", "y", "z"].every((n) => shown.includes(n));
  const e = (i: number): Vec3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  if (anatomical) {
    return {
      anatomical,
      ends: shown.map((n) => [RAS[n][0], RAS[n][1]]),
      words: shown.map((n) => [RAS[n][2], RAS[n][3]]),
      up: e(shown.indexOf("z")),
      alt: e(shown.indexOf("y")),
    };
  }
  const label = (n: string, i: number) => (n === "" ? `d${i}` : n);
  return {
    anatomical,
    ends: shown.map((n, i) => [`+${label(n, i)}`, `−${label(n, i)}`]),
    words: shown.map((n, i) => [`+${label(n, i)}`, `−${label(n, i)}`]),
    up: [0, -1, 0],
    alt: [0, 0, -1],
  };
}

/** The view's up when looking along `forward`: the axes' up, made square to it (or the other up when along it). */
export function upFor(forward: Vec3, axes: Pick<Axes, "up" | "alt">): Vec3 {
  const f = unit(forward);
  const pick = Math.abs(dot3(f, axes.up)) > 0.999 ? axes.alt : axes.up;
  const d = dot3(f, pick);
  return unit([pick[0] - d * f[0], pick[1] - d * f[1], pick[2] - d * f[2]]);
}

/** The orientation looking at the data from `from` (a direction from its centre), standing upright. */
export function lookingFrom(from: Vec3, axes: Pick<Axes, "up" | "alt">): Quat {
  const forward = unit([-from[0], -from[1], -from[2]]);
  const up = upFor(forward, axes);
  const right = unit(cross(forward, up));
  const down = cross(forward, right);
  return fromBasis(right, down, forward);
}

/** The six faces' directions, + then − of each axis. */
export const FACES: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** What a direction of the cube (a face, edge or corner: components −1, 0 or 1) is called: "R", "R A", "R A S". */
export function targetLetters(target: Vec3, axes: Pick<Axes, "ends">): string {
  return [0, 1, 2]
    .filter((i) => target[i] !== 0)
    .map((i) => axes.ends[i][target[i] > 0 ? 0 : 1])
    .join(" ");
}

/** The same in words, for names read out: "right", "right anterior superior". */
export function targetWords(target: Vec3, axes: Pick<Axes, "words">): string {
  return [0, 1, 2]
    .filter((i) => target[i] !== 0)
    .map((i) => axes.words[i][target[i] > 0 ? 0 : 1])
    .join(" ");
}

/** The standard views: from each face, upright. */
export function standardViews(axes: Pick<Axes, "up" | "alt">): { from: Vec3; orientation: Quat }[] {
  return FACES.map((from) => ({ from, orientation: lookingFrom(from, axes) }));
}

/** The standard view nearest an orientation (the smallest turn from it). */
export function nearestStandard(q: Quat, axes: Pick<Axes, "up" | "alt">): { from: Vec3; orientation: Quat; angle: number } {
  let best: { from: Vec3; orientation: Quat; angle: number } | undefined;
  for (const view of standardViews(axes)) {
    const angle = angleBetween(q, view.orientation);
    if (best === undefined || angle < best.angle - 1e-9) best = { ...view, angle };
  }
  return best!;
}

// ------------------------------------------------------------------ the cube

/** How far in from a face's edge the edge and corner zones reach (the cube spans −1 to 1). */
export const BAND = 0.35;

/**
 * How far the eye is from the cube's centre, in the cube's half-sizes: the
 * cube is seen in perspective, as Neuroglancer's 3-D view (45° from top to
 * bottom) sees an object filling about half its height, so it is drawn as
 * the data in the view is, its near faces larger than its far ones.
 */
export const CUBE_EYE = 5;

/**
 * A point of the cube (display coordinates, the cube spanning −1 to 1) on
 * its picture: x right and y down in the cube's half-sizes from its centre
 * (the plane through its centre at its own size), and its depth.
 */
export function projectCube(q: Quat, p: Vec3): Vec3 {
  const v = toView(q, p);
  const s = CUBE_EYE / (CUBE_EYE + v[2]);
  return [v[0] * s, v[1] * s, v[2]];
}

/**
 * What of the cube (spanning −1 to 1) is under a point of its picture:
 * `sx`, `sy` in the cube's half-sizes from its centre, x right and y down,
 * as the view draws it (in perspective, `projectCube`).  A face's middle
 * names the face, its borders an edge, its corners a corner: the direction
 * (components −1, 0 or 1) to look from.  Undefined off the cube.
 */
export function pickCube(q: Quat, sx: number, sy: number, band = BAND): Vec3 | undefined {
  // The ray from the eye through the point, in display coordinates.
  const origin = toDisplay(q, [0, 0, -CUBE_EYE]);
  const dir = toDisplay(q, [sx / CUBE_EYE, sy / CUBE_EYE, 1]);
  let near = -Infinity;
  let far = Infinity;
  for (let i = 0; i < 3; ++i) {
    if (Math.abs(dir[i]) < 1e-12) {
      if (Math.abs(origin[i]) > 1) return undefined;
      continue;
    }
    const a = (-1 - origin[i]) / dir[i];
    const b = (1 - origin[i]) / dir[i];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (near > far) return undefined;
  const p = origin.map((o, i) => o + near * dir[i]);
  const edge = 1 - band;
  return p.map((v) => (v > edge ? 1 : v < -edge ? -1 : 0)) as Vec3;
}

/** Hamilton product a·b of quaternions [x, y, z, w]. */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/**
 * How much more than the view the cube is drawn turned, degrees: about the
 * view's vertical (yaw) and its horizontal (pitch).  None: the cube turns
 * exactly as the view does (it was turned 12° each way, which put it about
 * 17° off the data); its perspective shows its depth instead.
 */
export const CUBE_TILT = { yaw: 0, pitch: 0 };

/** The orientation the cube is drawn with: the view's, turned by `tilt` in view coordinates (toView of it is the tilt after toView of the view's). */
export function shownOrientation(q: Quat, tilt: { yaw: number; pitch: number } = CUBE_TILT): Quat {
  const half = (deg: number) => (deg * Math.PI) / 360;
  // Seen from a little to the right and above: the right and top faces show.
  const yaw: Quat = [0, Math.sin(half(tilt.yaw)), 0, Math.cos(half(tilt.yaw))];
  const pitch: Quat = [Math.sin(half(tilt.pitch)), 0, 0, Math.cos(half(tilt.pitch))];
  const t = multiplyQuat(pitch, yaw);
  const inverse: Quat = [-t[0], -t[1], -t[2], t[3]];
  return normalise(multiplyQuat(normalise(q), inverse));
}

/** A face of the cube as drawn: its direction, its corners (display coordinates) and how squarely it faces the viewer (0 to 1). */
export interface CubeFace {
  normal: Vec3;
  corners: Vec3[];
  facing: number;
}

/** A face's corners, in order round it. */
export function faceCorners(normal: Vec3): Vec3[] {
  const k = normal.findIndex((v) => v !== 0);
  const [i, j] = [0, 1, 2].filter((a) => a !== k);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => {
    const p: Vec3 = [0, 0, 0];
    p[k] = normal[k];
    p[i] = a;
    p[j] = b;
    return p;
  });
}

/** The faces the eye sees (at most three), from CUBE_EYE away: a face whose plane the eye is in front of. */
export function visibleFaces(q: Quat): CubeFace[] {
  const out: CubeFace[] = [];
  for (const normal of FACES) {
    // Towards the viewer: against the view's forward.
    const facing = -toView(q, normal)[2];
    // The eye (0, 0, −CUBE_EYE in view coordinates) on the face's outer side: n·(eye − n) > 0.
    if (facing * CUBE_EYE - 1 > 1e-6) out.push({ normal, corners: faceCorners(normal), facing });
  }
  return out;
}

/**
 * The part of a face that picking a target there would name (the middle
 * for a face, a border strip for an edge, a corner square), as four
 * corners in display coordinates; undefined when the target does not
 * touch that face.
 */
export function zoneOnFace(normal: Vec3, target: Vec3, band = BAND): Vec3[] | undefined {
  const k = normal.findIndex((v) => v !== 0);
  if (target[k] !== normal[k]) return undefined;
  const [i, j] = [0, 1, 2].filter((a) => a !== k);
  const edge = 1 - band;
  const range = (t: number): [number, number] => (t > 0 ? [edge, 1] : t < 0 ? [-1, -edge] : [-edge, edge]);
  const [i0, i1] = range(target[i]);
  const [j0, j1] = range(target[j]);
  return [
    [i0, j0],
    [i1, j0],
    [i1, j1],
    [i0, j1],
  ].map(([a, b]) => {
    const p: Vec3 = [0, 0, 0];
    p[k] = normal[k];
    p[i] = a;
    p[j] = b;
    return p;
  });
}

/**
 * The directions on a face that its letter is written along (right and
 * down, display coordinates): as the face is seen from its standard view,
 * so the letter reads upright there.
 */
export function letterBasis(normal: Vec3, axes: Pick<Axes, "up" | "alt">): { right: Vec3; down: Vec3 } {
  const m = matrix(lookingFrom(normal, axes));
  return { right: [m[0], m[3], m[6]], down: [m[1], m[4], m[7]] };
}
