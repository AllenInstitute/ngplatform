/**
 * Crops and cuts as shapes with handles in the views (the platform's
 * in-view tools): between what the plugin keeps (a box as fractions of the
 * volume, a camera plane as a point, a normal and an offset in mm, an axis
 * plane as an offset in mm from the position) and the shapes' display
 * coordinates.  Pure; tested in tests/handles.test.ts.
 */
import type { CameraPlane, Cut } from "./view.js";

export type Vec3 = [number, number, number];

/** How a level's voxel axes lie in display coordinates: for each, the display axis it runs along, and display = scale · voxel + offset there. */
export interface LevelAxes {
  axis: [number, number, number];
  scale: Vec3;
  offset: Vec3;
}

/**
 * A level's voxel axes in display coordinates, from display-from-physical
 * (column-major, as `displayFromPhysical` gives it) and the level's
 * voxel-to-RAS (row-major); undefined when its axes are turned against
 * the display's (a box of fractions is then not a box there).
 */
export function levelAxes(displayFromPhysical: ArrayLike<number>, voxelToRas: ArrayLike<number>): LevelAxes | undefined {
  // Row-major display-from-voxel: D (column-major) times V (row-major).
  const m = (r: number, c: number) => {
    let s = 0;
    for (let k = 0; k < 4; ++k) s += displayFromPhysical[4 * k + r] * voxelToRas[4 * k + c];
    return s;
  };
  const axis: number[] = [];
  const scale: number[] = [];
  const offset: number[] = [0, 0, 0];
  for (let a = 0; a < 3; ++a) {
    const column = [0, 1, 2].map((r) => m(r, a));
    const largest = Math.max(...column.map(Math.abs));
    const k = column.findIndex((v) => Math.abs(v) === largest);
    if (!(largest > 0) || column.some((v, r) => r !== k && Math.abs(v) > 1e-6 * largest) || axis.includes(k)) return undefined;
    axis.push(k);
    scale.push(column[k]);
  }
  for (let r = 0; r < 3; ++r) offset[r] = m(r, 3);
  return { axis: axis as LevelAxes["axis"], scale: scale as Vec3, offset: offset as Vec3 };
}

/** The display coordinate where a fraction of the volume along voxel axis a lies (voxel centres at f · size − 0.5, as the renderers crop). */
const at = (l: LevelAxes, size: ArrayLike<number>, a: number, f: number) => l.scale[a] * (f * size[a] - 0.5) + l.offset[l.axis[a]];

/** A crop box (fractions of the volume) in display coordinates. */
export function cropToDisplay(crop: { lo: ArrayLike<number>; hi: ArrayLike<number> }, size: ArrayLike<number>, l: LevelAxes): { lower: Vec3; upper: Vec3 } {
  const lower: Vec3 = [0, 0, 0];
  const upper: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; ++a) {
    const p = at(l, size, a, crop.lo[a]);
    const q = at(l, size, a, crop.hi[a]);
    lower[l.axis[a]] = Math.min(p, q);
    upper[l.axis[a]] = Math.max(p, q);
  }
  return { lower, upper };
}

/** A box in display coordinates as a crop: fractions of the volume, within 0 and 1, low below high by at least `gap`. */
export function displayToCrop(lower: ArrayLike<number>, upper: ArrayLike<number>, size: ArrayLike<number>, l: LevelAxes, gap = 0.005): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [1, 1, 1];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (let a = 0; a < 3; ++a) {
    const k = l.axis[a];
    const f = (d: number) => ((d - l.offset[k]) / l.scale[a] + 0.5) / size[a];
    const p = clamp(f(lower[k]));
    const q = clamp(f(upper[k]));
    lo[a] = Math.min(p, q);
    hi[a] = Math.max(p, q);
    if (hi[a] - lo[a] < gap) {
      if (lo[a] + gap <= 1) hi[a] = lo[a] + gap;
      else lo[a] = hi[a] - gap;
    }
  }
  return { lo, hi };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function unit(v: ArrayLike<number>): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** A camera plane as a shape: the point it passes through now (its point moved `offset` mm along its normal), and its normal. */
export function planeShape(p: CameraPlane, mmPerUnit: number): { point: Vec3; normal: Vec3 } {
  const n = unit(p.normal);
  const u = p.offset / mmPerUnit;
  return { point: [p.point[0] + n[0] * u, p.point[1] + n[1] * u, p.point[2] + n[2] * u], normal: n };
}

/**
 * A camera plane after its shape was dragged: moved along its normal, its
 * offset changes (its point stays, so the offset slider follows); turned,
 * its normal changes and its point moves so it still passes where it did,
 * offset kept.
 */
export function planeFromShape(p: CameraPlane, point: ArrayLike<number>, normal: ArrayLike<number>, mmPerUnit: number): CameraPlane {
  const n0 = unit(p.normal);
  const n = unit(normal);
  if (Math.abs(dot(n, n0) - 1) < 1e-9) {
    const d = [point[0] - p.point[0], point[1] - p.point[1], point[2] - p.point[2]];
    return { ...p, normal: [...p.normal], point: [...p.point], offset: dot(d, n0) * mmPerUnit };
  }
  const u = p.offset / mmPerUnit;
  return { ...p, normal: n, point: [point[0] - n[0] * u, point[1] - n[1] * u, point[2] - n[2] * u] };
}

/** An axis plane (display axis k) as a shape: through the position moved `offset` mm along the axis, facing the side it keeps. */
export function cutShape(c: Cut, k: number, position: ArrayLike<number>, mmPerUnit: number): { point: Vec3; normal: Vec3 } {
  const point: Vec3 = [position[0], position[1], position[2]];
  point[k] += c.offset / mmPerUnit;
  const normal: Vec3 = [0, 0, 0];
  normal[k] = c.keep;
  return { point, normal };
}

/** An axis plane's offset (mm from the position) after its shape was moved to `point`. */
export function cutOffset(point: ArrayLike<number>, k: number, position: ArrayLike<number>, mmPerUnit: number): number {
  return (point[k] - position[k]) * mmPerUnit;
}
