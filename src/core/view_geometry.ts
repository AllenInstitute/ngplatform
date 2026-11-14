/**
 * The geometry of shapes drawn over the views (../ui/view_tools.ts): where
 * a shape shows on screen, and how a movement of the mouse maps to a
 * movement in the world.  Pure functions on display coordinates (the three
 * displayed global dimensions) and screen pixels, tested in
 * tests/view_geometry.test.ts.
 *
 * A view's projection is known only through its `project` function; its
 * local behaviour is the screen Jacobian: the screen x, y and depth of a
 * unit step along each display axis.  In a 2-D view (orthographic) it is
 * the same everywhere; in the 3-D view it is taken where the handle is.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export interface ScreenPoint {
  x: number;
  y: number;
  depth: number;
}
/** Display coordinates to screen pixels and depth; undefined behind the camera. */
export type Project3 = (p: Vec3) => ScreenPoint | undefined;
/** Row-major 3 × 3; as a Jacobian, rows are screen x, y and depth, columns the display axes. */
export type Mat3 = number[];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function unit(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}
export const axis = (k: number): Vec3 => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];

/**
 * The screen Jacobian at `p`: rows screen x, y and depth, columns a unit
 * step along each display axis (central differences, so a perspective
 * view's curvature cancels to second order).  Undefined when a step lands
 * behind the camera.
 */
export function jacobian(project: Project3, p: Vec3): Mat3 | undefined {
  const h = 1e-3 * Math.max(1, norm(p));
  const m = new Array<number>(9);
  for (let k = 0; k < 3; ++k) {
    const a = project(add(p, scale(axis(k), h)));
    const b = project(add(p, scale(axis(k), -h)));
    if (a === undefined || b === undefined) return undefined;
    m[k] = (a.x - b.x) / (2 * h);
    m[3 + k] = (a.y - b.y) / (2 * h);
    m[6 + k] = (a.depth - b.depth) / (2 * h);
  }
  return m;
}

/** A vector's screen image under a Jacobian: pixels along x and y. */
export function screenOf(j: Mat3, v: Vec3): Vec2 {
  return [j[0] * v[0] + j[1] * v[1] + j[2] * v[2], j[3] * v[0] + j[4] * v[1] + j[5] * v[2]];
}

/** Solves the 2 × 2 system [a b; c d] [s t] = [x y]; undefined when singular. */
export function solve2(a: number, b: number, c: number, d: number, x: number, y: number): Vec2 | undefined {
  const det = a * d - b * c;
  const size = Math.max(Math.abs(a * d), Math.abs(b * c), 1e-300);
  if (Math.abs(det) <= 1e-12 * size) return undefined;
  return [(x * d - b * y) / det, (a * y - c * x) / det];
}

/** Solves m x = r (row-major 3 × 3); undefined when singular. */
export function solve3(m: Mat3, r: Vec3): Vec3 | undefined {
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const size = Math.max(...m.map(Math.abs)) ** 3;
  if (!(Math.abs(det) > 1e-12 * size)) return undefined;
  const col = (k: number): Vec3 => [m[k], m[3 + k], m[6 + k]];
  // Cramer's rule.
  const d = (a: Vec3, b: Vec3, c: Vec3) => dot(a, cross(b, c));
  return [d(r, col(1), col(2)) / det, d(col(0), r, col(2)) / det, d(col(0), col(1), r) / det];
}

/**
 * Moving the mouse by (dx, dy) pixels moves a handle in the plane spanned
 * by `u` and `v` (world vectors) through `p`: project p, p + u and p + v,
 * and solve the 2 × 2 system for the step along each.
 */
export function planeDelta(project: Project3, p: Vec3, u: Vec3, v: Vec3, dx: number, dy: number): Vec3 | undefined {
  const o = project(p);
  const a = project(add(p, u));
  const b = project(add(p, v));
  if (o === undefined || a === undefined || b === undefined) return undefined;
  const st = solve2(a.x - o.x, b.x - o.x, a.y - o.y, b.y - o.y, dx, dy);
  return st && add(scale(u, st[0]), scale(v, st[1]));
}

/**
 * Moving the mouse by (dx, dy) pixels moves a handle in the plane through
 * it that keeps its depth: the section in a 2-D view, the plane facing the
 * camera in the 3-D view.  Where the depth does not change along any axis
 * (a degenerate view), the smallest step that matches the movement.
 */
export function viewPlaneDelta(j: Mat3, dx: number, dy: number): Vec3 {
  const exact = solve3(j, [dx, dy, 0]);
  if (exact !== undefined) return exact;
  // Least norm over the x and y rows: J'(JJ')⁻¹ d.
  const r0: Vec3 = [j[0], j[1], j[2]];
  const r1: Vec3 = [j[3], j[4], j[5]];
  const st = solve2(dot(r0, r0), dot(r0, r1), dot(r1, r0), dot(r1, r1), dx, dy);
  return st ? add(scale(r0, st[0]), scale(r1, st[1])) : [0, 0, 0];
}

/** The world vectors one screen pixel right and one down within the view's plane through a point (see viewPlaneDelta). */
export function viewPlaneBasis(j: Mat3): { right: Vec3; down: Vec3 } {
  return { right: viewPlaneDelta(j, 1, 0), down: viewPlaneDelta(j, 0, 1) };
}

/**
 * Moving the mouse by (dx, dy) pixels moves a handle along `dir`: the step
 * (in multiples of dir) whose screen image is nearest the movement.  Zero
 * when dir points at the viewer.
 */
export function axisDelta(j: Mat3, dir: Vec3, dx: number, dy: number): number {
  const [sx, sy] = screenOf(j, dir);
  const len2 = sx * sx + sy * sy;
  return len2 > 1e-18 ? (dx * sx + dy * sy) / len2 : 0;
}

/**
 * A plane of a 2-D view, in section coordinates: a world point `origin` at
 * screen point `at`, and the world vectors `right` and `down` of one screen
 * pixel.  `normal` is the unit normal (display coordinates).
 */
export interface Section {
  origin: Vec3;
  at: Vec2;
  right: Vec3;
  down: Vec3;
  normal: Vec3;
}

/** A section from a 2-D view's Jacobian, through `origin` shown at `at`. */
export function sectionOf(j: Mat3, origin: Vec3, at: Vec2): Section {
  const { right, down } = viewPlaneBasis(j);
  return { origin, at, right, down, normal: unit(cross(right, down)) };
}

/** Signed distance (display units) of a point from a section. */
export function sectionDistance(s: Section, p: Vec3): number {
  return dot(sub(p, s.origin), s.normal);
}

/** A point of a section from its screen position. */
export function sectionPoint(s: Section, x: number, y: number): Vec3 {
  return add(s.origin, add(scale(s.right, x - s.at[0]), scale(s.down, y - s.at[1])));
}

/** A world point's foot on a section (along the section's normal). */
export function onSection(s: Section, p: Vec3): Vec3 {
  return sub(p, scale(s.normal, sectionDistance(s, p)));
}

/** An ellipse on screen: centre, and its two semi-axes as screen vectors. */
export interface Ellipse {
  centre: Vec2;
  a: Vec2;
  b: Vec2;
}

/**
 * Where an axis-aligned ellipsoid (centre, radii along the display axes)
 * meets a section: an ellipse in screen pixels; undefined when they do not
 * meet.  With s the screen offset from the section's `at` and w = origin +
 * U s, the ellipsoid Σ((w − c)ᵢ / rᵢ)² = 1 is the quadratic sᵀMs + 2bᵀs + k = 0.
 */
export function ellipsoidSection(centre: Vec3, radii: Vec3, s: Section): Ellipse | undefined {
  if (radii.some((r) => !(r > 0))) return undefined;
  const D = radii.map((r) => 1 / (r * r));
  const q = (a: Vec3, b: Vec3) => a[0] * D[0] * b[0] + a[1] * D[1] * b[1] + a[2] * D[2] * b[2];
  const m = sub(s.origin, centre);
  const M = [q(s.right, s.right), q(s.right, s.down), q(s.down, s.down)];
  const bx = q(s.right, m);
  const by = q(s.down, m);
  const k = q(m, m) - 1;
  // Centre: −M⁻¹b.
  const c = solve2(M[0], M[1], M[1], M[2], -bx, -by);
  if (c === undefined) return undefined;
  const level = -(bx * c[0] + by * c[1]) - k;
  if (!(level > 0)) return undefined;
  const { values, vectors } = symmetricEigen2(M[0], M[1], M[2]);
  if (!(values[0] > 0 && values[1] > 0)) return undefined;
  const ra = Math.sqrt(level / values[0]);
  const rb = Math.sqrt(level / values[1]);
  return {
    centre: [s.at[0] + c[0], s.at[1] + c[1]],
    a: [vectors[0][0] * ra, vectors[0][1] * ra],
    b: [vectors[1][0] * rb, vectors[1][1] * rb],
  };
}

/** Eigenvalues and unit eigenvectors of the symmetric [a b; b c]. */
export function symmetricEigen2(a: number, b: number, c: number): { values: Vec2; vectors: [Vec2, Vec2] } {
  const mean = (a + c) / 2;
  const r = Math.hypot((a - c) / 2, b);
  const values: Vec2 = [mean + r, mean - r];
  if (Math.abs(b) < 1e-300 * Math.max(Math.abs(a), Math.abs(c), 1)) {
    return a >= c ? { values, vectors: [[1, 0], [0, 1]] } : { values, vectors: [[0, 1], [1, 0]] };
  }
  const v: Vec2 = [values[0] - c, b];
  const n = Math.hypot(v[0], v[1]);
  const e: Vec2 = [v[0] / n, v[1] / n];
  return { values, vectors: [e, [-e[1], e[0]]] };
}

/** Points round an ellipse (closed: the first is not repeated). */
export function ellipsePoints(e: Ellipse, n = 64): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; ++i) {
    const t = (2 * Math.PI * i) / n;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([e.centre[0] + e.a[0] * c + e.b[0] * s, e.centre[1] + e.a[1] * c + e.b[1] * s]);
  }
  return out;
}

/**
 * How far from an ellipse's centre, along the screen direction `dir` (unit),
 * the ellipse is: where a radius knob sits.
 */
export function ellipseReach(e: Ellipse, dir: Vec2): number {
  // In the ellipse's own frame the point t·dir has coordinates (p, q) with p² + q² = 1.
  const la = e.a[0] * e.a[0] + e.a[1] * e.a[1];
  const lb = e.b[0] * e.b[0] + e.b[1] * e.b[1];
  if (!(la > 0 && lb > 0)) return 0;
  const p = (dir[0] * e.a[0] + dir[1] * e.a[1]) / la;
  const q = (dir[0] * e.b[0] + dir[1] * e.b[1]) / lb;
  const g = Math.hypot(p, q);
  return g > 0 ? 1 / g : 0;
}

/** The corners of a box, index bits 0, 1 and 2 choosing the upper side along x, y and z. */
export function boxCorners(lower: Vec3, upper: Vec3): Vec3[] {
  return Array.from({ length: 8 }, (_, i) => [0, 1, 2].map((k) => ((i >> k) & 1 ? upper[k] : lower[k])) as Vec3);
}

/** The edges of a box, as pairs of corner indices. */
export const BOX_EDGES: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let i = 0; i < 8; ++i) for (let k = 0; k < 3; ++k) if (!((i >> k) & 1)) out.push([i, i | (1 << k)]);
  return out;
})();

/** Where a box meets a section: the points where its edges cross it (unordered; empty when they do not meet). */
export function boxSection(lower: Vec3, upper: Vec3, s: Section): Vec3[] {
  const corners = boxCorners(lower, upper);
  const d = corners.map((c) => sectionDistance(s, c));
  const out: Vec3[] = [];
  for (const [i, j] of BOX_EDGES) {
    if (d[i] === 0 && d[j] === 0) {
      out.push(corners[i], corners[j]);
      continue;
    }
    if ((d[i] <= 0 && d[j] >= 0) || (d[i] >= 0 && d[j] <= 0)) {
      const t = d[i] / (d[i] - d[j]);
      out.push(add(corners[i], scale(sub(corners[j], corners[i]), t)));
    }
  }
  return out;
}

/** Screen points as a convex polygon: duplicates (within `tolerance` px) dropped, ordered round their centre. */
export function convexOrder(points: Vec2[], tolerance = 0.5): Vec2[] {
  const kept: Vec2[] = [];
  for (const p of points) if (!kept.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance)) kept.push(p);
  if (kept.length < 3) return kept;
  const cx = kept.reduce((s, p) => s + p[0], 0) / kept.length;
  const cy = kept.reduce((s, p) => s + p[1], 0) / kept.length;
  return kept.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

/**
 * Where a plane (through `point`, normal `n`) meets a section: the point of
 * that line nearest `point`, and its direction (unit); undefined when the
 * two are parallel.
 */
export function planeSection(point: Vec3, n: Vec3, s: Section): { at: Vec3; dir: Vec3 } | undefined {
  const g = s.normal;
  const nn = unit(n);
  const ng = dot(nn, g);
  // x = point + α n + β g, with n·(x − point) = 0 and g·(x − origin) = 0.
  const ab = solve2(1, ng, ng, 1, 0, -sectionDistance(s, point));
  if (ab === undefined || Math.abs(ng) > 1 - 1e-9) return undefined;
  const at = add(point, add(scale(nn, ab[0]), scale(g, ab[1])));
  return { at, dir: unit(cross(nn, g)) };
}

/** Two unit vectors that, with the unit normal n, make a right-handed frame. */
export function planeFrame(n: Vec3): [Vec3, Vec3] {
  const nn = unit(n);
  const a = Math.abs(nn[0]) < 0.9 ? axis(0) : axis(1);
  const e1 = unit(cross(nn, a));
  return [e1, cross(nn, e1)];
}

/**
 * An arcball turn (Shoemake): the mouse moving from `from` to `to` (screen
 * pixels, relative to the ball's centre) on a ball of `radius` pixels.
 * Outside the ball the mouse is on its rim, so moving round the rim turns
 * about the line of sight.  The axis is in camera coordinates (x right, y
 * up, z towards the viewer), the angle in radians.
 */
export function arcball(from: Vec2, to: Vec2, radius: number, rimOnly = false): { axis: Vec3; angle: number } {
  const onBall = (p: Vec2): Vec3 => {
    const x = p[0] / radius;
    const y = -p[1] / radius;
    const r2 = x * x + y * y;
    if (r2 >= 1 || rimOnly) {
      const r = Math.sqrt(r2) || 1;
      return [x / r, y / r, 0];
    }
    return [x, y, Math.sqrt(1 - r2)];
  };
  const a = onBall(from);
  const b = onBall(to);
  const c = cross(a, b);
  const angle = Math.atan2(norm(c), dot(a, b));
  return { axis: norm(c) > 1e-12 ? unit(c) : [0, 0, 1], angle };
}

/** Turns v about the unit axis by angle radians (Rodrigues). */
export function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** The distance from p to the segment a–b (screen pixels). */
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Whether p is inside a polygon (even-odd). */
export function insidePolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
