/**
 * The cameras of a movie made in this browser, as the render computer makes
 * them (runner/ngplatform_render/movie.py frames_for and rotation_frames,
 * camera.py interpolate_cameras, renderer.py look_at), so a movie moves the
 * same here as there: each keyframe's inverse view-projection taken apart
 * into eye, target (level with the point the view turns about), up and
 * field of view; between two keyframes the target and up linearly, the eye
 * along the orbit about the target (its direction by spherical
 * interpolation, its distance geometrically), eased into and out of each
 * keyframe ("smooth") or not ("linear").
 *
 * Matrices are column-major, as Frame3d's and a view spec's.
 */
import { invert4 } from "./draw.js";

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => scale(a, 1 / norm(a));

export interface MovieCamera {
  eye: V3;
  target: V3;
  up: V3;
  /** Vertical field of view, degrees. */
  fovy: number;
}

/** A keyframe as the movie takes it: its time (seconds), its camera's inverse view-projection, the point it turns about. */
export interface MovieKey {
  time: number;
  inv: ArrayLike<number>;
  center?: ArrayLike<number>;
}

/** A frame's matrices (column-major). */
export interface MovieView {
  viewProjection: Float32Array;
  invViewProjection: Float32Array;
}

/** Clip point (x, y, z) unprojected by `inv` (column-major). */
function unproject(inv: ArrayLike<number>, x: number, y: number, z: number, w = 1): [number, number, number, number] {
  const p = [0, 1, 2, 3].map((r) => inv[r] * x + inv[4 + r] * y + inv[8 + r] * z + inv[12 + r] * w);
  return [p[0], p[1], p[2], p[3]];
}

/** Eye, target, up and field of view, and the aspect, near and far, of a perspective inverse view-projection. */
export function cameraFromInverse(inv: ArrayLike<number>, center?: ArrayLike<number>): { camera: MovieCamera; aspect: number; near: number; far: number } {
  const un = (x: number, y: number, z: number): V3 => {
    const p = unproject(inv, x, y, z);
    return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
  };
  // The camera's centre: clip (0, 0, 1, 0).
  const e = unproject(inv, 0, 0, 1, 0);
  if (Math.abs(e[3]) < 1e-12 * Math.max(1, Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2]))) throw new Error("movies need the perspective 3-D view (this view is orthographic)");
  const eye: V3 = [e[0] / e[3], e[1] / e[3], e[2] / e[3]];
  const n0 = un(0, 0, -1), f0 = un(0, 0, 1);
  const fwd = unit(sub(f0, n0));
  const near = norm(sub(n0, eye)), far = norm(sub(f0, eye));
  let up = sub(un(0, 1, -1), n0);
  up = sub(up, scale(fwd, dot(up, fwd)));
  const halfH = norm(up);
  up = scale(up, 1 / halfH);
  const halfW = norm(sub(un(1, 0, -1), n0));
  const fovy = (2 * Math.atan(halfH / near) * 180) / Math.PI;
  const along = center ? Math.max(dot(sub([center[0], center[1], center[2]], eye), fwd), near) : Math.sqrt(near * far);
  return { camera: { eye, target: add(eye, scale(fwd, along)), up, fovy }, aspect: halfW / halfH, near, far };
}

/** View-projection (column-major) of a camera, as OpenGL's lookAt and perspective. */
export function lookAt(c: MovieCamera, aspect: number, near: number, far: number): Float32Array {
  const f = unit(sub(c.target, c.eye));
  const s = unit(cross(f, c.up));
  const u = cross(s, f);
  const t = 1 / Math.tan((c.fovy * Math.PI) / 360);
  // Row-major view and projection, then their product, written column-major.
  const view = [s[0], s[1], s[2], -dot(s, c.eye), u[0], u[1], u[2], -dot(u, c.eye), -f[0], -f[1], -f[2], dot(f, c.eye), 0, 0, 0, 1];
  const proj = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), (2 * far * near) / (near - far), 0, 0, -1, 0];
  const out = new Float32Array(16);
  for (let r = 0; r < 4; ++r)
    for (let k = 0; k < 4; ++k) {
      let v = 0;
      for (let j = 0; j < 4; ++j) v += proj[4 * r + j] * view[4 * j + k];
      out[4 * k + r] = v;
    }
  return out;
}

const smooth = (u: number) => u * u * (3 - 2 * u);

/** Between two cameras at `u` (0..1). */
export function interpolateCameras(a: MovieCamera, b: MovieCamera, u: number, ease = true): MovieCamera {
  u = Math.min(Math.max(u, 0), 1);
  if (ease) u = smooth(u);
  const target = add(a.target, scale(sub(b.target, a.target), u));
  const va = sub(a.eye, a.target), vb = sub(b.eye, b.target);
  const ra = norm(va), rb = norm(vb);
  const da = scale(va, 1 / ra), db = scale(vb, 1 / rb);
  const om = Math.acos(Math.min(1, Math.max(-1, dot(da, db))));
  const d = om < 1e-6 ? da : add(scale(da, Math.sin((1 - u) * om) / Math.sin(om)), scale(db, Math.sin(u * om) / Math.sin(om)));
  const r = ra * (rb / ra) ** u;
  const up = unit(add(a.up, scale(sub(b.up, a.up), u)));
  return { eye: add(target, scale(d, r)), target, up, fovy: a.fovy + (b.fovy - a.fovy) * u };
}

const view = (vp: Float32Array): MovieView => ({ viewProjection: vp, invViewProjection: invert4(vp) });

/** How many frames keyframes spanning `times` make at `fps`. */
export function keyframeCount(times: readonly number[], fps: number): number {
  return times.length < 2 ? 1 : Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) * fps) + 1);
}

/** Every frame's view along the keyframes, at `aspect` (the movie's width / height). */
export function framesFor(keys: readonly MovieKey[], fps: number, easing: "smooth" | "linear", aspect: number): MovieView[] {
  const kf = [...keys].sort((p, q) => p.time - q.time);
  const cams = kf.map((k) => cameraFromInverse(k.inv, k.center));
  if (kf.length === 1) return [view(lookAt(cams[0].camera, aspect, cams[0].near, cams[0].far))];
  const n = keyframeCount(kf.map((k) => k.time), fps);
  const out: MovieView[] = [];
  for (let i = 0; i < n; ++i) {
    const t = kf[0].time + i / fps;
    let j = 0;
    while (j < kf.length - 2 && kf[j + 1].time <= t) ++j;
    const ta = kf[j].time, tb = kf[j + 1].time;
    const u = tb <= ta ? 0 : Math.min(1, Math.max(0, (t - ta) / (tb - ta)));
    const a = cams[j], b = cams[j + 1];
    const cam = interpolateCameras(a.camera, b.camera, u, easing !== "linear");
    out.push(view(lookAt(cam, aspect, a.near + (b.near - a.near) * u, a.far + (b.far - a.far) * u)));
  }
  return out;
}

/** How many frames a turn of `degrees` by `step` has (a full circle leaves out its last, the first again). */
export function rotationCount(degrees: number, step: number): number {
  if (!(step > 0) || !(degrees > 0)) throw new Error("step and degrees must be positive");
  return Math.floor(degrees / step + 1e-9) + (Math.abs(degrees - 360) < 1e-9 ? 0 : 1);
}

/** Views turning about `center` by `step` degrees up to `degrees`: about the camera's up ("vertical") or its right ("horizontal"). */
export function rotationFrames(inv: ArrayLike<number>, center: ArrayLike<number> | undefined, axis: "vertical" | "horizontal", degrees: number, step: number, aspect: number): MovieView[] {
  const { camera: cam, near, far } = cameraFromInverse(inv, center);
  const c: V3 = center ? [center[0], center[1], center[2]] : cam.target;
  const off = sub(cam.eye, c);
  const right = unit(cross(unit(sub(cam.target, cam.eye)), cam.up));
  const k = axis === "vertical" ? unit(cam.up) : right;
  const out: MovieView[] = [];
  for (let i = 0, n = rotationCount(degrees, step); i < n; ++i) {
    const t = (i * step * Math.PI) / 180;
    // Rodrigues' rotation about k.
    const rot = (v: V3): V3 => add(add(scale(v, Math.cos(t)), scale(cross(k, v), Math.sin(t))), scale(k, dot(k, v) * (1 - Math.cos(t))));
    out.push(view(lookAt({ eye: add(c, rot(off)), target: c, up: rot(cam.up), fovy: cam.fovy }, aspect, near, far)));
  }
  return out;
}
