/**
 * A viewer of Gaussian splats (`.splat`, or a 3-D Gaussian splatting `.ply`)
 * in a window over the page: WebGL 2, each Gaussian a quad its projected
 * covariance shapes, sorted front to back by depth (a counting sort, again
 * whenever the camera has moved) and blended under what is drawn before it.
 * The camera turns about a centre (drag), moves (right or shift drag) and
 * comes closer (wheel); it starts as the camera the splat's first view was
 * rendered from.  Cameras are in OpenCV's axes, as the host writes them:
 * x right, y down, z forward.
 */

/** Gaussians as the viewer draws them: positions (3 a Gaussian), covariances (6: xx xy xz yy yz zz), colours (RGBA bytes). */
export interface Splats {
  count: number;
  positions: Float32Array;
  covariances: Float32Array;
  colors: Uint8Array;
}

/** Where the viewer's camera starts: camera to world (OpenCV axes, rows), the vertical field of view, and the point it turns about. */
export interface SplatCamera {
  c2w: number[][];
  fovy: number;
  centre: number[];
}

const C0 = 0.28209479177387814;

/** The covariance R S S^T R^T of a Gaussian with scales `s` and rotation quaternion w, x, y, z (normalised here). */
export function covariance(s: ArrayLike<number>, q: ArrayLike<number>): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const w = q[0] / n, x = q[1] / n, y = q[2] / n, z = q[3] / n;
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
  // M = R S; covariance = M M^T.
  const M = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => R[r * 3 + c] * s[c]));
  const dot = (a: number, b: number) => M[a * 3] * M[b * 3] + M[a * 3 + 1] * M[b * 3 + 1] + M[a * 3 + 2] * M[b * 3 + 2];
  return [dot(0, 0), dot(0, 1), dot(0, 2), dot(1, 1), dot(1, 2), dot(2, 2)];
}

/** A `.splat` file: 32 bytes a Gaussian (position and scale as float32, colour and opacity as bytes, rotation as bytes (q + 1) * 128). */
export function parseSplat(buffer: ArrayBuffer): Splats {
  const count = Math.floor(buffer.byteLength / 32);
  const f = new Float32Array(buffer, 0, count * 8);
  const u = new Uint8Array(buffer, 0, count * 32);
  const out = blank(count);
  for (let i = 0; i < count; ++i) {
    out.positions.set(f.subarray(i * 8, i * 8 + 3), i * 3);
    const q = [0, 1, 2, 3].map((k) => (u[i * 32 + 28 + k] - 128) / 128);
    out.covariances.set(covariance(f.subarray(i * 8 + 3, i * 8 + 6), q), i * 6);
    out.colors.set(u.subarray(i * 32 + 24, i * 32 + 28), i * 4);
  }
  return out;
}

/** A 3-D Gaussian splatting `.ply` (binary, float properties x y z, f_dc_*, opacity, scale_*, rot_*; the rest ignored). */
export function parsePly(buffer: ArrayBuffer): Splats {
  const bytes = new Uint8Array(buffer);
  const marker = new TextEncoder().encode("end_header\n");
  let end = -1;
  for (let i = 0; i + marker.length <= Math.min(bytes.length, 1 << 16); ++i) {
    if (marker.every((b, k) => bytes[i + k] === b)) {
      end = i + marker.length;
      break;
    }
  }
  if (end < 0) throw new Error("not a PLY file (no end_header)");
  const head = new TextDecoder().decode(bytes.subarray(0, end));
  if (!/format binary_little_endian/.test(head)) throw new Error("only binary little-endian PLY files are read");
  const count = Number(/element vertex (\d+)/.exec(head)?.[1] ?? NaN);
  const props = [...head.matchAll(/^property (\w+) (\w+)$/gm)].map((m) => ({ type: m[1], name: m[2] }));
  if (!Number.isFinite(count) || props.some((p) => p.type !== "float")) throw new Error("a splat PLY has only float properties");
  const at = Object.fromEntries(props.map((p, i) => [p.name, i]));
  for (const k of ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]) {
    if (!(k in at)) throw new Error(`the PLY has no ${k}: not a Gaussian splat`);
  }
  const stride = props.length;
  const f = new Float32Array(buffer.slice(end, end + count * stride * 4));
  const out = blank(count);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < count; ++i) {
    const r = (k: string) => f[i * stride + at[k]];
    out.positions.set([r("x"), r("y"), r("z")], i * 3);
    out.covariances.set(covariance([Math.exp(r("scale_0")), Math.exp(r("scale_1")), Math.exp(r("scale_2"))], [r("rot_0"), r("rot_1"), r("rot_2"), r("rot_3")]), i * 6);
    out.colors.set([clamp(0.5 + C0 * r("f_dc_0")), clamp(0.5 + C0 * r("f_dc_1")), clamp(0.5 + C0 * r("f_dc_2")), clamp(1 / (1 + Math.exp(-r("opacity"))))], i * 4);
  }
  return out;
}

function blank(count: number): Splats {
  return { count, positions: new Float32Array(count * 3), covariances: new Float32Array(count * 6), colors: new Uint8Array(count * 4) };
}

/**
 * The Gaussians' order front to back for a world-to-camera matrix (column-major, OpenCV axes: depth is the
 * camera's z), by a counting sort of their depths into 65536 steps; `order` is filled and returned.
 */
export function sortByDepth(positions: Float32Array, count: number, w2c: ArrayLike<number>, order: Uint32Array = new Uint32Array(count)): Uint32Array {
  const depth = new Float32Array(count);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < count; ++i) {
    const d = w2c[2] * positions[i * 3] + w2c[6] * positions[i * 3 + 1] + w2c[10] * positions[i * 3 + 2] + w2c[14];
    depth[i] = d;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const bins = 65536;
  const scale = hi > lo ? (bins - 1) / (hi - lo) : 0;
  const key = new Uint16Array(count);
  const counts = new Uint32Array(bins);
  for (let i = 0; i < count; ++i) {
    key[i] = (depth[i] - lo) * scale;
    counts[key[i]]++;
  }
  for (let b = 1; b < bins; ++b) counts[b] += counts[b - 1];
  for (let i = count - 1; i >= 0; --i) order[--counts[key[i]]] = i;
  return order;
}

/** World to camera, column-major (OpenCV axes), of a camera at `eye` looking at `target` with `up` above. */
export function worldToCamera(eye: number[], target: number[], up: number[]): Float32Array {
  const f = norm(sub(target, eye));
  const s = norm(cross(f, up));
  const u = cross(s, f);
  const rows = [s, u.map((v) => -v), f];
  const m = new Float32Array(16);
  for (let r = 0; r < 3; ++r) {
    for (let c = 0; c < 3; ++c) m[c * 4 + r] = rows[r][c];
    m[12 + r] = -(rows[r][0] * eye[0] + rows[r][1] * eye[1] + rows[r][2] * eye[2]);
  }
  m[15] = 1;
  return m;
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: number[], k: number) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
/** `v` turned by `angle` about the unit axis `k` (Rodrigues). */
const turn = (v: number[], k: number[], angle: number) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot3(k, v) * (1 - c)));
};

const VERTEX = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPos;
uniform highp sampler2D uCovA;
uniform highp sampler2D uCovB;
uniform lowp sampler2D uColor;
uniform mat4 uView;
uniform vec2 uFocal;
uniform vec2 uViewport;
in vec2 aCorner;
in uint aIndex;
out vec4 vColor;
out vec2 vPos;
void main() {
  ivec2 t = ivec2(int(aIndex & 2047u), int(aIndex >> 11));
  vec4 cam = uView * vec4(texelFetch(uPos, t, 0).xyz, 1.0);
  float z = cam.z;
  if (z < 1e-3 || abs(cam.x / z) * uFocal.x > uViewport.x * 0.65 + 64.0 || abs(cam.y / z) * uFocal.y > uViewport.y * 0.65 + 64.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec4 a = texelFetch(uCovA, t, 0), b = texelFetch(uCovB, t, 0);
  mat3 V = mat3(a.x, a.y, a.z, a.y, a.w, b.x, a.z, b.x, b.y);
  mat3 J = mat3(uFocal.x / z, 0.0, 0.0, 0.0, uFocal.y / z, 0.0, -uFocal.x * cam.x / (z * z), -uFocal.y * cam.y / (z * z), 0.0);
  mat3 T = J * mat3(uView);
  mat3 C = T * V * transpose(T);
  float p = C[0][0] + 0.3, q = C[0][1], r = C[1][1] + 0.3;
  float mid = 0.5 * (p + r), rad = length(vec2(0.5 * (p - r), q));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 d = abs(q) > 1e-7 ? normalize(vec2(q, l1 - p)) : (p >= r ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * d;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(d.y, -d.x);
  vec2 px = vec2(uFocal.x * cam.x / z, uFocal.y * cam.y / z) + 0.5 * uViewport + aCorner.x * major + aCorner.y * minor;
  gl_Position = vec4(px.x / uViewport.x * 2.0 - 1.0, 1.0 - px.y / uViewport.y * 2.0, 0.0, 1.0);
  vColor = texelFetch(uColor, t, 0);
  vPos = aCorner;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vPos;
out vec4 fragColor;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  float B = exp(A) * vColor.a;
  fragColor = vec4(B * vColor.rgb, B);
}`;

/** The Gaussians drawn in a canvas, from a camera the pointer moves. */
export class SplatCanvas {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private order: Uint32Array;
  private indexBuffer: WebGLBuffer;
  private eye: number[] = [0, 0, 1];
  private target: number[] = [0, 0, 0];
  private up: number[] = [0, -1, 0];
  private fovy = 30;
  private start: SplatCamera | undefined;
  private frame = 0;
  private sortedFor = "";
  private offs: (() => void)[] = [];

  constructor(private readonly splats: Splats, camera?: SplatCamera) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "width: 100%; height: 100%; display: block; touch-action: none; cursor: grab";
    const gl = this.canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error("this browser has no WebGL 2");
    this.gl = gl;
    this.program = program(gl, VERTEX, FRAGMENT);
    this.order = new Uint32Array(splats.count);
    this.upload();
    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, -2, 2, 2, 2]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const aCorner = gl.getAttribLocation(this.program, "aCorner");
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
    this.indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.order, gl.DYNAMIC_DRAW);
    const aIndex = gl.getAttribLocation(this.program, "aIndex");
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribIPointer(aIndex, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(aIndex, 1);
    this.start = camera ?? this.framing();
    this.reset();
    this.controls();
  }

  /** Back to the camera it started from. */
  reset(): void {
    const c = this.start!;
    const m = c.c2w;
    this.eye = [m[0][3], m[1][3], m[2][3]];
    const fwd = [m[0][2], m[1][2], m[2][2]];
    const dist = Math.max(1e-6, dot3(sub(c.centre, this.eye), fwd));
    this.target = add(this.eye, mul(fwd, dist));
    this.up = [-m[0][1], -m[1][1], -m[2][1]];
    this.fovy = c.fovy;
    this.redraw();
  }

  /** A camera that shows all of the Gaussians, when the file came without one. */
  private framing(): SplatCamera {
    const p = this.splats.positions;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.splats.count; ++i) for (let k = 0; k < 3; ++k) {
      lo[k] = Math.min(lo[k], p[i * 3 + k]);
      hi[k] = Math.max(hi[k], p[i * 3 + k]);
    }
    const centre = mul(add(lo, hi), 0.5);
    const r = Math.max(1e-3, Math.hypot(...sub(hi, lo)) / 2);
    const d = r / Math.sin((30 * Math.PI) / 360) * 1.1;
    // From -y, z up: x right, y down (-z), z forward (+y).
    return { c2w: [[1, 0, 0, centre[0]], [0, 0, 1, centre[1] - d], [0, -1, 0, centre[2]], [0, 0, 0, 1]], fovy: 30, centre };
  }

  private upload(): void {
    const gl = this.gl;
    const n = this.splats.count;
    const W = 2048, H = Math.max(1, Math.ceil(n / W));
    const pos = new Float32Array(W * H * 4), a = new Float32Array(W * H * 4), b = new Float32Array(W * H * 4), col = new Uint8Array(W * H * 4);
    const { positions: P, covariances: C, colors } = this.splats;
    for (let i = 0; i < n; ++i) {
      pos[i * 4] = P[i * 3]; pos[i * 4 + 1] = P[i * 3 + 1]; pos[i * 4 + 2] = P[i * 3 + 2];
      a[i * 4] = C[i * 6]; a[i * 4 + 1] = C[i * 6 + 1]; a[i * 4 + 2] = C[i * 6 + 2]; a[i * 4 + 3] = C[i * 6 + 3];
      b[i * 4] = C[i * 6 + 4]; b[i * 4 + 1] = C[i * 6 + 5];
    }
    col.set(colors);
    gl.useProgram(this.program);
    const textures: [string, number, number, number, ArrayBufferView][] = [
      ["uPos", gl.RGBA32F, gl.RGBA, gl.FLOAT, pos],
      ["uCovA", gl.RGBA32F, gl.RGBA, gl.FLOAT, a],
      ["uCovB", gl.RGBA32F, gl.RGBA, gl.FLOAT, b],
      ["uColor", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, col],
    ];
    textures.forEach(([name, internal, format, type, data], unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, W, H, 0, format, type, data);
      gl.uniform1i(gl.getUniformLocation(this.program, name), unit);
    });
  }

  private controls(): void {
    const c = this.canvas;
    let last: { x: number; y: number; pan: boolean } | undefined;
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { ...last, x: e.clientX, y: e.clientY };
      const off = sub(this.eye, this.target);
      const fwd = norm(mul(off, -1));
      const right = norm(cross(fwd, this.up));
      if (last.pan) {
        const k = (Math.hypot(...off) * 2 * Math.tan((this.fovy * Math.PI) / 360)) / Math.max(1, c.clientHeight);
        const shift = add(mul(right, -dx * k), mul(this.up, dy * k));
        this.eye = add(this.eye, shift);
        this.target = add(this.target, shift);
      } else {
        // Across: about the camera's up; up and down: about its right (the up turning with it).
        let o = turn(off, norm(this.up), -dx * 0.006);
        const r = norm(cross(norm(mul(o, -1)), this.up));
        o = turn(o, r, -dy * 0.006);
        this.up = norm(turn(this.up, r, -dy * 0.006));
        this.eye = add(this.target, o);
      }
      this.redraw();
    };
    const up = (e: PointerEvent) => {
      last = undefined;
      c.releasePointerCapture(e.pointerId);
      c.style.cursor = "grab";
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const off = sub(this.eye, this.target);
      this.eye = add(this.target, mul(off, Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015)))));
      this.redraw();
    };
    const menu = (e: Event) => e.preventDefault();
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("contextmenu", menu);
    const resize = new ResizeObserver(() => this.redraw());
    resize.observe(c);
    this.offs.push(() => resize.disconnect());
  }

  redraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const view = worldToCamera(this.eye, this.target, this.up);
    const key = Array.from(view, (v) => v.toFixed(4)).join();
    if (key !== this.sortedFor) {
      sortByDepth(this.splats.positions, this.splats.count, view, this.order);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.order);
      this.sortedFor = key;
    }
    const f = H / 2 / Math.tan((this.fovy * Math.PI) / 360);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "uView"), false, view);
    gl.uniform2f(gl.getUniformLocation(this.program, "uFocal"), f, f);
    gl.uniform2f(gl.getUniformLocation(this.program, "uViewport"), W, H);
    // Front to back: each Gaussian goes under what is drawn already.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.splats.count);
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const off of this.offs) off();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`splat shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`splat program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

/**
 * The splats in a window over the page, with the buttons to download them; `downloads` maps a label to
 * what it saves.  Closing it (the button, Escape) disposes of it.
 */
export function openSplatWindow(title: string, splats: Splats, camera: SplatCamera | undefined, downloads: [string, () => void][] = []): () => void {
  const shade = document.createElement("div");
  shade.style.cssText = "position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center";
  const box = document.createElement("div");
  box.className = "splat-window";
  box.style.cssText = "width: min(92vw, 1400px); height: min(88vh, 1000px); display: flex; flex-direction: column; background: #101012; color: #ddd; border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,0.6); overflow: hidden";
  const bar = document.createElement("div");
  bar.style.cssText = "display: flex; gap: 8px; align-items: center; padding: 6px 10px; font-size: 12px; border-bottom: 1px solid #2a2a2e";
  const name = document.createElement("strong");
  name.textContent = title;
  const note = document.createElement("span");
  note.style.cssText = "opacity: 0.7; flex: 1";
  note.textContent = `${splats.count.toLocaleString()} Gaussians · drag to turn, right or shift drag to move, wheel to come closer`;
  const area = document.createElement("div");
  area.style.cssText = "flex: 1; min-height: 0; background: radial-gradient(#202024, #08080a)";
  let view: SplatCanvas | undefined;
  const btn = (label: string, run: () => void) => {
    const b = document.createElement("button");
    b.className = "btn outline small";
    b.type = "button";
    b.textContent = label;
    b.onclick = run;
    return b;
  };
  const close = () => {
    view?.dispose();
    shade.remove();
    document.removeEventListener("keydown", key);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  bar.append(name, note, btn("Reset view", () => view?.reset()), ...downloads.map(([label, run]) => btn(label, run)), btn("Close", close));
  box.append(bar, area);
  shade.append(box);
  shade.addEventListener("pointerdown", (e) => {
    if (e.target === shade) close();
  });
  document.addEventListener("keydown", key);
  document.body.append(shade);
  try {
    view = new SplatCanvas(splats, camera);
    area.append(view.canvas);
  } catch (e) {
    area.textContent = (e as Error).message;
  }
  return close;
}
