/**
 * The volume view's drawing, in WebGL2: a solid brain ray-marched from a
 * coarse level held as one 3-D texture, with the octant facing the camera
 * cut away and its three faces showing sections from finer levels; then
 * tracts, as line strips, depth-tested against the brain.
 *
 * The brain pass writes depth, so a tract shows where the cut exposes it and
 * is hidden by solid tissue.  Empty space is skipped with a coarse grid of
 * block maxima.  Frames are drawn into an off-screen buffer at a chosen
 * scale (lower while the view moves) and stretched to the canvas.
 */
import { invert, type Mat4, multiply } from "./ome.js";

export interface Camera {
  /** The point orbited, RAS mm. */
  target: [number, number, number];
  distance: number;
  /** Radians: azimuth about S, elevation from the axial plane. */
  yaw: number;
  pitch: number;
}

export interface Options {
  /** The cut's corner (RAS mm), or undefined for no cut. */
  cut: [number, number, number] | undefined;
  sections: boolean;
  tracts: boolean;
  /** Tissue starts where 1 - value exceeds this (0..1). */
  threshold: number;
}

interface Plane {
  texture: WebGLTexture;
  rect: [number, number, number, number];
  value: number;
}

interface Tracts {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  colour: [number, number, number];
}

const BLOCK = 8;

const QUAD_VS = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BRAIN_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVolume;
uniform sampler3D uOccupancy;
uniform sampler2D uPlane0;
uniform sampler2D uPlane1;
uniform sampler2D uPlane2;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform mat4 uWorldToTex;
uniform vec3 uOccScale;
uniform vec3 uBoxLo;
uniform vec3 uBoxHi;
uniform float uStep;
uniform float uBlockStep;
uniform float uThreshold;
uniform bool uCut;
uniform vec3 uCutPoint;
uniform vec3 uCutSide;
uniform bvec3 uPlaneReady;
uniform vec4 uPlaneRect[3];
uniform float uVoxel;
in vec2 vNdc;
out vec4 outColor;

vec2 slab(vec3 o, vec3 inv, vec3 lo, vec3 hi, out vec3 tExit) {
  vec3 a = (lo - o) * inv;
  vec3 b = (hi - o) * inv;
  vec3 tmin = min(a, b);
  tExit = max(a, b);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tExit.x, tExit.y), tExit.z));
}

vec3 texOf(vec3 p) { return (uWorldToTex * vec4(p, 1.0)).xyz; }

float value(vec3 p) {
  vec3 tc = texOf(p);
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return 1.0;
  return texture(uVolume, tc).r;
}

float occupied(vec3 p) {
  vec3 tc = texOf(p) * uOccScale;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThan(tc, vec3(1.0)))) return 0.0;
  return texture(uOccupancy, tc).r;
}

bool removed(vec3 p) {
  if (!uCut) return false;
  vec3 s = (p - uCutPoint) * uCutSide;
  return s.x > 0.0 && s.y > 0.0 && s.z > 0.0;
}

float section(int axis, vec3 p, out bool ok) {
  vec2 uv = axis == 0 ? p.yz : axis == 1 ? p.xz : p.xy;
  vec4 r = uPlaneRect[axis];
  vec2 tc = (uv - r.xz) / (r.yw - r.xz);
  ok = all(greaterThanEqual(tc, vec2(0.0))) && all(lessThanEqual(tc, vec2(1.0)));
  if (axis == 0) { ok = ok && uPlaneReady.x; return texture(uPlane0, tc).r; }
  if (axis == 1) { ok = ok && uPlaneReady.y; return texture(uPlane1, tc).r; }
  ok = ok && uPlaneReady.z;
  return texture(uPlane2, tc).r;
}

void main() {
  vec4 n = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec4 f = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 o = n.xyz / n.w;
  vec3 d = normalize(f.xyz / f.w - o);
  vec3 inv = 1.0 / (d + vec3(equal(d, vec3(0.0))) * 1e-9);
  vec3 unused;
  vec2 box = slab(o, inv, uBoxLo, uBoxHi, unused);
  float t = max(box.x, 0.0);
  if (t >= box.y) discard;
  // The removed octant, as an interval along the ray.
  vec2 oct = vec2(1.0, 0.0);
  vec3 octExit = vec3(0.0);
  if (uCut) {
    vec3 up = step(0.0, uCutSide);
    vec3 lo = mix(uBoxLo - 1.0, uCutPoint, up);
    vec3 hi = mix(uCutPoint, uBoxHi + 1.0, up);
    oct = slab(o, inv, lo, hi, octExit);
  }
  float threshold = 1.0 - uThreshold;
  bool hit = false;
  bool face = false;
  float before = t;
  for (int i = 0; i < 4096; ++i) {
    if (t > box.y) break;
    if (oct.x < oct.y && t >= oct.x && t < oct.y) {
      t = oct.y + 1e-4;
      face = true;
      continue;
    }
    vec3 p = o + d * t;
    if (occupied(p) < uThreshold) {
      before = t;
      t += uBlockStep;
      face = false;
      continue;
    }
    if (value(p) < threshold) {
      hit = true;
      break;
    }
    face = false;
    before = t;
    t += uStep;
  }
  if (!hit) discard;
  vec3 p = o + d * t;
  vec3 colour;
  if (face) {
    // On a cut face: the section of the face the ray left the octant by.
    int axis = octExit.x <= octExit.y && octExit.x <= octExit.z ? 0 : octExit.y <= octExit.z ? 1 : 2;
    bool ok;
    float v = section(axis, p, ok);
    if (!ok) v = value(p);
    colour = vec3(v) * vec3(1.0, 0.97, 0.93);
  } else {
    // Refine the surface between the last empty sample and this one.
    float a = before;
    float b = t;
    for (int k = 0; k < 5; ++k) {
      float m = 0.5 * (a + b);
      vec3 q = o + d * m;
      if (!removed(q) && value(q) < threshold) b = m; else a = m;
    }
    t = b;
    p = o + d * t;
    float h = uVoxel;
    vec3 g = vec3(
      value(p + vec3(h, 0.0, 0.0)) - value(p - vec3(h, 0.0, 0.0)),
      value(p + vec3(0.0, h, 0.0)) - value(p - vec3(0.0, h, 0.0)),
      value(p + vec3(0.0, 0.0, h)) - value(p - vec3(0.0, 0.0, h)));
    vec3 normal = length(g) > 1e-6 ? normalize(g) : -d;
    if (dot(normal, d) > 0.0) normal = -normal;
    float tissue = value(p - normal * 2.0 * h);
    vec3 base = mix(vec3(0.42, 0.33, 0.31), vec3(0.86, 0.80, 0.74), smoothstep(0.35, 0.9, tissue));
    vec3 light = normalize(-d + vec3(0.0, 0.0, 0.35));
    float diffuse = max(dot(normal, light), 0.0);
    float spec = pow(max(dot(reflect(-light, normal), -d), 0.0), 24.0);
    colour = base * (0.28 + 0.72 * diffuse) + 0.12 * spec;
  }
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  outColor = vec4(colour, 1.0);
}`;

const LINE_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 uColour;
out vec4 outColor;
void main() { outColor = vec4(uColour, 1.0); }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

/** Row-major (as ome.ts keeps them) to column-major float32, as WebGL takes them. */
function gl4(m: Mat4): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; ++r) for (let c = 0; c < 4; ++c) out[4 * c + r] = m[4 * r + c];
  return out;
}

export function viewProjection(camera: Camera, aspect: number): Mat4 {
  const { target, distance, yaw, pitch } = camera;
  const eye = [
    target[0] + distance * Math.cos(pitch) * Math.cos(yaw),
    target[1] + distance * Math.cos(pitch) * Math.sin(yaw),
    target[2] + distance * Math.sin(pitch),
  ];
  const f = target.map((v, k) => v - eye[k]);
  const fl = Math.hypot(f[0], f[1], f[2]);
  const fwd = f.map((v) => v / fl);
  const upHint = [0, 0, 1];
  let side = [fwd[1] * upHint[2] - fwd[2] * upHint[1], fwd[2] * upHint[0] - fwd[0] * upHint[2], fwd[0] * upHint[1] - fwd[1] * upHint[0]];
  const sl = Math.hypot(side[0], side[1], side[2]) || 1;
  side = side.map((v) => v / sl);
  const up = [side[1] * fwd[2] - side[2] * fwd[1], side[2] * fwd[0] - side[0] * fwd[2], side[0] * fwd[1] - side[1] * fwd[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const view = Float64Array.from([...side, -dot(side, eye), ...up, -dot(up, eye), ...fwd.map((v) => -v), dot(fwd, eye), 0, 0, 0, 1]);
  const near = Math.max(0.5, distance * 0.05);
  const far = distance * 4 + 400;
  const fy = 1 / Math.tan((30 * Math.PI) / 180 / 2);
  const proj = Float64Array.from([fy / aspect, 0, 0, 0, 0, fy, 0, 0, 0, 0, (far + near) / (near - far), (2 * far * near) / (near - far), 0, 0, -1, 0]);
  return multiply(proj, view);
}

export class VolumeRenderer {
  readonly gl: WebGL2RenderingContext;
  private brain: WebGLProgram;
  private lines: WebGLProgram;
  private empty: WebGLVertexArrayObject;
  private volume: WebGLTexture | undefined;
  private occupancy: WebGLTexture | undefined;
  private occScale: [number, number, number] = [1, 1, 1];
  private worldToTex: Mat4 | undefined;
  private box: { lo: number[]; hi: number[] } | undefined;
  private voxel = 1;
  private planes: (Plane | undefined)[] = [undefined, undefined, undefined];
  private tracts = new Map<string, Tracts>();
  private target: { fb: WebGLFramebuffer; colour: WebGLTexture; depth: WebGLRenderbuffer; w: number; h: number } | undefined;
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, depth: true, alpha: false, powerPreference: "default" });
    if (gl === null) throw new Error("This browser has no WebGL2.");
    this.gl = gl;
    this.brain = compile(gl, QUAD_VS, BRAIN_FS);
    this.lines = compile(gl, LINE_VS, LINE_FS);
    this.empty = gl.createVertexArray()!;
  }

  get ready(): boolean {
    return this.volume !== undefined;
  }

  private u(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${program === this.brain ? "b" : "l"}:${name}`;
    if (!this.uniforms.has(key)) this.uniforms.set(key, this.gl.getUniformLocation(program, name));
    return this.uniforms.get(key)!;
  }

  /** The solid level: `data` x fastest, `size` voxels along x, y, z. */
  setVolume(data: Uint8Array, size: [number, number, number], voxelToRas: Mat4, voxelSize: number): void {
    const { gl } = this;
    if (this.volume) gl.deleteTexture(this.volume);
    if (this.occupancy) gl.deleteTexture(this.occupancy);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.volume = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.volume);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size[0], size[1], size[2], 0, gl.RED, gl.UNSIGNED_BYTE, data);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    // Block maxima of the tissue (255 - value), grown by a block, for skipping empty space.
    const blocks = size.map((s) => Math.ceil(s / BLOCK)) as [number, number, number];
    const occ = new Uint8Array(blocks[0] * blocks[1] * blocks[2]);
    for (let z = 0; z < size[2]; ++z) {
      const bz = (z / BLOCK) | 0;
      for (let y = 0; y < size[1]; ++y) {
        const by = (y / BLOCK) | 0;
        let i = (z * size[1] + y) * size[0];
        const row = (bz * blocks[1] + by) * blocks[0];
        for (let x = 0; x < size[0]; ++x, ++i) {
          const v = 255 - data[i];
          const b = row + ((x / BLOCK) | 0);
          if (v > occ[b]) occ[b] = v;
        }
      }
    }
    const grown = new Uint8Array(occ.length);
    for (let z = 0; z < blocks[2]; ++z) {
      for (let y = 0; y < blocks[1]; ++y) {
        for (let x = 0; x < blocks[0]; ++x) {
          let m = 0;
          for (let dz = -1; dz <= 1; ++dz) {
            for (let dy = -1; dy <= 1; ++dy) {
              for (let dx = -1; dx <= 1; ++dx) {
                const X = x + dx;
                const Y = y + dy;
                const Z = z + dz;
                if (X < 0 || Y < 0 || Z < 0 || X >= blocks[0] || Y >= blocks[1] || Z >= blocks[2]) continue;
                const v = occ[(Z * blocks[1] + Y) * blocks[0] + X];
                if (v > m) m = v;
              }
            }
          }
          grown[(z * blocks[1] + y) * blocks[0] + x] = m;
        }
      }
    }
    this.occupancy = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.occupancy);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, blocks[0], blocks[1], blocks[2], 0, gl.RED, gl.UNSIGNED_BYTE, grown);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    this.occScale = size.map((s, k) => s / (blocks[k] * BLOCK)) as [number, number, number];
    // World (RAS mm) to texture coordinates: voxel centres at (i + 0.5) / size.
    const texOfVoxel = Float64Array.from([1 / size[0], 0, 0, 0.5 / size[0], 0, 1 / size[1], 0, 0.5 / size[1], 0, 0, 1 / size[2], 0.5 / size[2], 0, 0, 0, 1]);
    this.worldToTex = multiply(texOfVoxel, invert(voxelToRas));
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; ++c) {
      const v = [0, 1, 2].map((k) => ((c >> k) & 1 ? size[k] - 0.5 : -0.5));
      for (let r = 0; r < 3; ++r) {
        const w = voxelToRas[4 * r] * v[0] + voxelToRas[4 * r + 1] * v[1] + voxelToRas[4 * r + 2] * v[2] + voxelToRas[4 * r + 3];
        lo[r] = Math.min(lo[r], w);
        hi[r] = Math.max(hi[r], w);
      }
    }
    this.box = { lo, hi };
    this.voxel = voxelSize;
  }

  /** The brain's bounding box in RAS mm, once the volume is in. */
  bounds(): { lo: number[]; hi: number[] } | undefined {
    return this.box;
  }

  /** A section on the plane `axis` = `value`, covering `rect` (u0, u1, v0, v1 mm). */
  setPlane(axis: number, data: Uint8Array, width: number, height: number, rect: [number, number, number, number], value: number): void {
    const { gl } = this;
    let plane = this.planes[axis];
    if (plane === undefined) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      plane = { texture, rect, value };
      this.planes[axis] = plane;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, plane.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    plane.rect = rect;
    plane.value = value;
  }

  /** Forgets the sections (the cut moved, so they no longer lie on it). */
  clearPlanes(): void {
    for (const p of this.planes) if (p) this.gl.deleteTexture(p.texture);
    this.planes = [undefined, undefined, undefined];
  }

  /** A set of tracts: points in RAS mm, curve k from offsets[k] to offsets[k + 1]. */
  setTracts(id: string, positions: Float32Array, offsets: Uint32Array, colour: [number, number, number]): void {
    this.removeTracts(id);
    const { gl } = this;
    const curves = offsets.length - 1;
    // Line strips, one restart index between curves.
    const indices = new Uint32Array(positions.length / 3 + curves);
    let at = 0;
    for (let c = 0; c < curves; ++c) {
      for (let v = offsets[c]; v < offsets[c + 1]; ++v) indices[at++] = v;
      indices[at++] = 0xffffffff;
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.lines, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.tracts.set(id, { vao, buffers: [vbo, ibo], count: at, colour });
  }

  setTractColour(id: string, colour: [number, number, number]): void {
    const t = this.tracts.get(id);
    if (t) t.colour = colour;
  }

  removeTracts(id: string): void {
    const t = this.tracts.get(id);
    if (t === undefined) return;
    this.gl.deleteVertexArray(t.vao);
    for (const b of t.buffers) this.gl.deleteBuffer(b);
    this.tracts.delete(id);
  }

  tractIds(): string[] {
    return [...this.tracts.keys()];
  }

  private frame(width: number, height: number) {
    const { gl } = this;
    if (this.target && this.target.w === width && this.target.h === height) return this.target;
    if (this.target) {
      gl.deleteFramebuffer(this.target.fb);
      gl.deleteTexture(this.target.colour);
      gl.deleteRenderbuffer(this.target.depth);
    }
    const fb = gl.createFramebuffer()!;
    const colour = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, colour);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    this.target = { fb, colour, depth, w: width, h: height };
    return this.target;
  }

  /** Draws a frame at `scale` of the canvas's resolution. */
  render(camera: Camera, options: Options, scale = 1): void {
    const { gl, canvas } = this;
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    const target = this.frame(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.04, 0.04, 0.05, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const viewProj = viewProjection(camera, width / height);
    const vp = gl4(viewProj);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    if (this.volume && this.occupancy && this.worldToTex && this.box) {
      const p = this.brain;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.volume);
      gl.uniform1i(this.u(p, "uVolume"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.occupancy);
      gl.uniform1i(this.u(p, "uOccupancy"), 1);
      const ready = [false, false, false];
      const rects = new Float32Array(12);
      for (let k = 0; k < 3; ++k) {
        const plane = this.planes[k];
        gl.activeTexture(gl.TEXTURE2 + k);
        gl.bindTexture(gl.TEXTURE_2D, plane?.texture ?? null);
        gl.uniform1i(this.u(p, `uPlane${k}`), 2 + k);
        const onCut = plane !== undefined && options.cut !== undefined && Math.abs(plane.value - options.cut[k]) < 1e-6;
        ready[k] = options.sections && onCut;
        if (plane) rects.set(plane.rect, 4 * k);
      }
      gl.uniform3i(this.u(p, "uPlaneReady"), +ready[0], +ready[1], +ready[2]);
      gl.uniform4fv(this.u(p, "uPlaneRect"), rects);
      gl.uniformMatrix4fv(this.u(p, "uInvViewProj"), false, gl4(invert(viewProj)));
      gl.uniformMatrix4fv(this.u(p, "uViewProj"), false, vp);
      gl.uniformMatrix4fv(this.u(p, "uWorldToTex"), false, gl4(this.worldToTex));
      gl.uniform3fv(this.u(p, "uOccScale"), this.occScale);
      gl.uniform3fv(this.u(p, "uBoxLo"), this.box.lo);
      gl.uniform3fv(this.u(p, "uBoxHi"), this.box.hi);
      gl.uniform1f(this.u(p, "uVoxel"), this.voxel);
      gl.uniform1f(this.u(p, "uStep"), this.voxel * 0.6);
      gl.uniform1f(this.u(p, "uBlockStep"), this.voxel * BLOCK * 0.9);
      gl.uniform1f(this.u(p, "uThreshold"), options.threshold);
      const cut = options.cut;
      gl.uniform1i(this.u(p, "uCut"), cut === undefined ? 0 : 1);
      if (cut !== undefined) {
        gl.uniform3fv(this.u(p, "uCutPoint"), cut);
        // The removed octant is on the camera's side of the cut on every axis.
        const eye = [
          camera.target[0] + camera.distance * Math.cos(camera.pitch) * Math.cos(camera.yaw),
          camera.target[1] + camera.distance * Math.cos(camera.pitch) * Math.sin(camera.yaw),
          camera.target[2] + camera.distance * Math.sin(camera.pitch),
        ];
        gl.uniform3fv(this.u(p, "uCutSide"), eye.map((e, k) => (e >= cut[k] ? 1 : -1)));
      }
      gl.bindVertexArray(this.empty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (options.tracts && this.tracts.size > 0) {
      const p = this.lines;
      gl.useProgram(p);
      gl.uniformMatrix4fv(this.u(p, "uViewProj"), false, vp);
      for (const t of this.tracts.values()) {
        gl.uniform3fv(this.u(p, "uColour"), t.colour);
        gl.bindVertexArray(t.vao);
        gl.drawElements(gl.LINE_STRIP, t.count, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);

    // Stretch the frame to the canvas.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, canvas.width, canvas.height, gl.COLOR_BUFFER_BIT, width === canvas.width ? gl.NEAREST : gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    const { gl } = this;
    for (const id of this.tractIds()) this.removeTracts(id);
    this.clearPlanes();
    if (this.volume) gl.deleteTexture(this.volume);
    if (this.occupancy) gl.deleteTexture(this.occupancy);
    if (this.target) {
      gl.deleteFramebuffer(this.target.fb);
      gl.deleteTexture(this.target.colour);
      gl.deleteRenderbuffer(this.target.depth);
    }
    gl.deleteProgram(this.brain);
    gl.deleteProgram(this.lines);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
