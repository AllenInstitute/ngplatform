/**
 * Moving a layer by hand, as Freeview's Transform Volume tool does (Tools →
 * Transform Volume): translate, rotate, scale and flip along the world's x
 * (L-R), y (P-A) and z (I-S) axes, in millimetres and degrees, each with a
 * slider and a typed value.
 *
 * Composed as Freeview's LayerMRI::DoTransform composes them: flip first,
 * then scale about the volume's centre, then rotate about x, then y, then z
 * (about the volume's centre or the cursor: the pivot), then translate.
 * The pivot is fixed when the first rotation or flip is made, as Freeview
 * fixes it.  The sliders' ranges and steps are Freeview's too: translation
 * across the volume's size either way, rotation ±180° in half degrees,
 * scale 0.5 to 2 with 1 in the middle.
 */
import { identity4, type Mat4, multiply4, type Vec3 } from "./fit.js";

export interface Manual {
  /** Millimetres along x, y, z. */
  translate: Vec3;
  /** Degrees about x, y, z. */
  rotate: Vec3;
  scale: Vec3;
  flip: [boolean, boolean, boolean];
  /** What rotations and flips turn about. */
  around: "centre" | "cursor";
  /** That point, global mm along x, y, z, fixed by the first rotation or flip. */
  pivot?: Vec3;
}

export function identityManual(around: Manual["around"] = "centre"): Manual {
  return { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1], flip: [false, false, false], around };
}

export function isIdentityManual(m: Manual): boolean {
  return m.translate.every((v) => v === 0) && m.rotate.every((v) => v === 0) && m.scale.every((v) => v === 1) && m.flip.every((f) => !f);
}

/** Whether the pivot is in use (a rotation or a flip is made), so it stays where it is. */
export function turned(m: Manual): boolean {
  return m.rotate.some((v) => v !== 0) || m.flip.some((f) => f);
}

const vec3 = (v: unknown, fallback: number): Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as Vec3) : [fallback, fallback, fallback];

export function readManual(raw: unknown): Manual {
  const m = (raw ?? {}) as Partial<Manual>;
  const flip = Array.isArray(m.flip) && m.flip.length === 3 ? (m.flip.map(Boolean) as Manual["flip"]) : ([false, false, false] as Manual["flip"]);
  return {
    translate: vec3(m.translate, 0),
    rotate: vec3(m.rotate, 0),
    scale: vec3(m.scale, 1).map((s) => (s > 0 ? s : 1)) as Vec3,
    flip,
    around: m.around === "cursor" ? "cursor" : "centre",
    pivot: m.pivot === undefined ? undefined : vec3(m.pivot, 0),
  };
}

function about(point: Vec3, linear: number[]): Mat4 {
  const m = identity4();
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) m[4 * r + c] = linear[3 * r + c];
    m[4 * r + 3] = point[r] - (linear[3 * r] * point[0] + linear[3 * r + 1] * point[1] + linear[3 * r + 2] * point[2]);
  }
  return m;
}

/** Rotation by `degrees` about axis `k` (0 x, 1 y, 2 z), right-handed, as a 3 × 3 row-major. */
export function axisRotation(k: number, degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (k === 0) return [1, 0, 0, 0, c, -s, 0, s, c];
  if (k === 1) return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/**
 * The hand-made transform (global mm to global mm, along x, y, z):
 * T · Rz Ry Rx (about the pivot) · S (about the centre) · F (about the pivot).
 * `centre` is the volume's centre; the pivot, when not yet fixed, is the
 * centre too.
 */
export function manualMatrix(m: Manual, centre: Vec3): Mat4 {
  const pivot = m.pivot ?? centre;
  const flip = about(pivot, [m.flip[0] ? -1 : 1, 0, 0, 0, m.flip[1] ? -1 : 1, 0, 0, 0, m.flip[2] ? -1 : 1]);
  const scale = about(centre, [m.scale[0], 0, 0, 0, m.scale[1], 0, 0, 0, m.scale[2]]);
  let rotation = identity4();
  for (let k = 0; k < 3; ++k) if (m.rotate[k] !== 0) rotation = multiply4(about(pivot, axisRotation(k, m.rotate[k])), rotation);
  const translation = identity4();
  for (let k = 0; k < 3; ++k) translation[4 * k + 3] = m.translate[k];
  return multiply4(translation, multiply4(rotation, multiply4(scale, flip)));
}

/**
 * For axes named x, y, z in some order: P with P·xyz = the axes' order, so a
 * matrix along x, y, z is P M Pᵀ along them.  Axes without those names are
 * taken in their own order.
 */
export function axisOrder(names: string[]): [number, number, number] {
  const at = ["x", "y", "z"].map((n) => names.indexOf(n));
  return at.every((i) => i >= 0 && i < 3) ? (at as [number, number, number]) : [0, 1, 2];
}

/** A matrix along x, y, z as one along axes in `order` (order[k]: where x, y, z's k-th is). */
export function permute(m: Mat4, order: [number, number, number]): Mat4 {
  const out = identity4();
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) out[4 * order[r] + order[c]] = m[4 * r + c];
    out[4 * order[r] + 3] = m[4 * r + 3];
  }
  return out;
}

/** The inverse of `permute`: a matrix along the axes as one along x, y, z. */
export function unpermute(m: Mat4, order: [number, number, number]): Mat4 {
  const out = identity4();
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) out[4 * r + c] = m[4 * order[r] + order[c]];
    out[4 * r + 3] = m[4 * order[r] + 3];
  }
  return out;
}

// ---------------------------------------------------------------- sliders

/** Freeview's scale slider: 0 to 400, 200 is 1; above it 1 to 2, below 0.5 to 1. */
export const SCALE_SLIDER = 400;

export function scaleFromSlider(n: number): number {
  const half = SCALE_SLIDER / 2;
  return n >= half ? (n - half) / half + 1 : (n - half) / SCALE_SLIDER + 1;
}

export function sliderFromScale(s: number): number {
  const half = SCALE_SLIDER / 2;
  const n = s >= 1 ? half + (s - 1) * half : half - (1 - s) * SCALE_SLIDER;
  return Math.max(0, Math.min(SCALE_SLIDER, Math.round(n)));
}

/** A round step (1, 2 or 5 times a power of ten) near a thousandth of `extent`: 0.2 mm for a brain. */
export function translationStep(extent: number): number {
  if (!(extent > 0)) return 0.5;
  const want = extent / 1000;
  const power = 10 ** Math.floor(Math.log10(want));
  return [1, 2, 5, 10].map((k) => k * power).find((v) => v >= want * (1 - 1e-9)) ?? 10 * power;
}

// ------------------------------------------------- moving in the views

/** 3 × 3 row-major product. */
function mul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; ++r) for (let c = 0; c < 3; ++c) for (let k = 0; k < 3; ++k) out[3 * r + c] += a[3 * r + k] * b[3 * k + c];
  return out;
}

/** The hand-made rotation, Rz Ry Rx of its angles (degrees), 3 × 3 row-major. */
export function rotationOf(rotate: Vec3): number[] {
  return mul3(axisRotation(2, rotate[2]), mul3(axisRotation(1, rotate[1]), axisRotation(0, rotate[0])));
}

/** Rotation by `degrees` about a unit `axis`, right-handed (3 × 3 row-major). */
export function axisAngleRotation(axis: Vec3, degrees: number): number[] {
  const n = Math.hypot(...axis) || 1;
  const [x, y, z] = axis.map((v) => v / n);
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}

/** Angles in degrees, rounded to a millionth (−0 and specks of rounding as 0). */
const tidy = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};

/** The angles about x, y and z (degrees, each in (−180, 180]) with R = Rz Ry Rx, as the sliders hold them. */
export function eulerOf(r: number[]): Vec3 {
  const deg = (v: number) => (v * 180) / Math.PI;
  const sy = Math.max(-1, Math.min(1, -r[6]));
  const y = Math.asin(sy);
  // Gimbal lock (y at ±90°): x taken as 0, all of the turn about z.
  if (Math.abs(sy) > 1 - 1e-12) return [0, tidy(deg(y)), tidy(deg(Math.atan2(-r[1], r[4])))];
  return [tidy(deg(Math.atan2(r[7], r[8]))), tidy(deg(y)), tidy(deg(Math.atan2(r[3], r[0])))];
}

/**
 * Where the hand-made rotation turns about, as it shows: the pivot (fixed
 * by the first rotation; until then the volume's centre or the cursor, as
 * Rotate around says) moved by the translation.  Whatever the angles, that
 * point stays where it is, so a turn about it changes the angles only.
 */
export function shownPivot(m: Manual, centre: Vec3, cursor: Vec3): Vec3 {
  const p = m.pivot ?? (m.around === "cursor" ? cursor : centre);
  return [p[0] + m.translate[0], p[1] + m.translate[1], p[2] + m.translate[2]];
}

/** Moved by `by` (mm along x, y, z) as dragging the layer's box in a view does. */
export function moveManual(m: Manual, by: Vec3): Manual {
  return { ...m, translate: [m.translate[0] + by[0], m.translate[1] + by[1], m.translate[2] + by[2]] };
}

/**
 * Turned by `degrees` about the unit `axis` (x, y, z) through the shown
 * pivot (shownPivot), as the box's ring turns it: the rotation becomes
 * Q·R and the translation stays.  `pivot` fixes the pivot when no rotation
 * or flip has yet.
 */
export function turnManual(m: Manual, axis: Vec3, degrees: number, pivot: Vec3): Manual {
  const rotate = eulerOf(mul3(axisAngleRotation(axis, degrees), rotationOf(m.rotate)));
  return { ...m, rotate, pivot: m.pivot ?? pivot };
}

/** Scaled by `factors` along x, y and z (each kept above 0), as the box's corners scale it. */
export function scaleManual(m: Manual, factors: Vec3): Manual {
  return { ...m, scale: m.scale.map((s, k) => Math.max(1e-3, s * (factors[k] > 0 ? factors[k] : 1))) as Vec3 };
}
