/**
 * The rendered image in Neuroglancer's 3-D view: drawn over the whole
 * panel with the depth where each pixel's ray first meets tissue, so
 * Neuroglancer's own layers (tracts, meshes, annotations, sections) are
 * hidden behind tissue and show in front of it.  Pixels where the ray
 * met nothing are left to the view.
 */
import type { Drawer3d, Frame3d } from "@ngplatform/sdk";

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = (o: Frame3d["outputs"]) => `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform highp sampler2D uDepth;
uniform sampler2D uAlpha;
uniform vec4 uViewport;
uniform float uHasDepth;
uniform float uHasAlpha;
layout(location = ${o.color}) out vec4 out_color;
layout(location = ${o.z}) out highp vec4 out_z;
layout(location = ${o.pick}) out highp vec4 out_pickId;
void main() {
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  uv.y = 1.0 - uv.y;
  vec4 c = texture(uColor, uv);
  // A JPEG frame's alpha comes apart, and its colour is not premultiplied.
  if (uHasAlpha > 0.5) c = vec4(c.rgb * texture(uAlpha, uv).r, texture(uAlpha, uv).r);
  if (c.a < 0.5) discard;
  float d = uHasDepth > 0.5 ? texture(uDepth, uv).r : 0.5;
  d = clamp(d, 0.0, 0.99999);
  gl_FragDepth = d;
  out_color = vec4(c.rgb / max(c.a, 1e-3), 1.0);
  out_z = vec4(1.0 - d);
  out_pickId = vec4(0.0);
}`;

// The frame as points in space: a grid of vertices, each at its pixel's distance along that pixel's ray in
// the camera the frame was rendered from (uOldInv), drawn with the camera now (uNewVP), so the picture turns
// and zooms with the view at once. A triangle touching a pixel that met nothing, or spanning a jump in
// distance (an edge in front of something farther), is left out: a brief gap, not a stretched skin.
const MESH_VS = `#version 300 es
precision highp float;
uniform highp sampler2D uDist;
uniform mat4 uOldInv;
uniform mat4 uNewVP;
uniform ivec2 uSize;
uniform int uStep;
uniform int uCols;
out vec2 vUv;
out float vValid;
float dist(ivec2 p) { return texelFetch(uDist, clamp(p, ivec2(0), uSize - 1), 0).r; }
void main() {
  ivec2 cell = ivec2(gl_VertexID % uCols, gl_VertexID / uCols);
  ivec2 px = min(cell * uStep, uSize - 1);
  float d = dist(px), dr = dist(px + ivec2(uStep, 0)), dd = dist(px + ivec2(0, uStep));
  vec2 uv = (vec2(px) + 0.5) / vec2(uSize);
  vec2 ndc = vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  vec4 a = uOldInv * vec4(ndc, -1.0, 1.0);
  vec4 b = uOldInv * vec4(ndc, 1.0, 1.0);
  vec3 n = a.xyz / a.w;
  vec3 dir = normalize(b.xyz / b.w - n);
  gl_Position = uNewVP * vec4(n + dir * max(d, 0.0), 1.0);
  float jump = max(abs(dr - d), abs(dd - d)) / max(d, 1e-6);
  vValid = (d >= 0.0 && dr >= 0.0 && dd >= 0.0 && jump < 0.04) ? 1.0 : 0.0;
  vUv = uv;
}`;

const MESH_FS = (o: Frame3d["outputs"]) => `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uAlpha;
uniform float uHasAlpha;
in vec2 vUv;
in float vValid;
layout(location = ${o.color}) out vec4 out_color;
layout(location = ${o.z}) out highp vec4 out_z;
layout(location = ${o.pick}) out highp vec4 out_pickId;
void main() {
  if (vValid < 0.999) discard;
  vec4 c = texture(uColor, vUv);
  if (uHasAlpha > 0.5) c = vec4(c.rgb * texture(uAlpha, vUv).r, texture(uAlpha, vUv).r);
  if (c.a < 0.5) discard;
  out_color = vec4(c.rgb / max(c.a, 1e-3), 1.0);
  out_z = vec4(1.0 - gl_FragCoord.z);
  out_pickId = vec4(0.0);
}`;

/** The inverse of a 4x4 matrix (column-major, as GL takes it). */
export function invert4(m: ArrayLike<number>): Float32Array {
  const a = Array.from(m);
  const inv = new Array(16).fill(0);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  return Float32Array.from(inv.map((x) => x / (det || 1)));
}

export interface Picture {
  bitmap: ImageBitmap;
  /** One byte a pixel, rows from the top: the alpha of a colour that is not premultiplied (a JPEG frame). */
  alpha?: { width: number; height: number; data: Uint8Array };
  depth?: { width: number; height: number; data: Float32Array };
  /** The camera it was rendered from (inverse view-projection, column-major) and each pixel's distance to tissue: to draw it moving with the view. */
  view?: { invViewProjection: number[]; distance: { width: number; height: number; data: Float32Array } };
}

export class PictureDrawer implements Drawer3d {
  /** Called at each frame, before drawing, with the frame: the plugin sends the view from it. */
  onFrame: ((frame: Frame3d) => void) | undefined;
  private picture: Picture | undefined;
  private uploaded: Picture | undefined;
  private uploadedDepth: Picture["depth"] | undefined;
  private uploadedAlpha: Picture["alpha"] | undefined;
  private gl: WebGL2RenderingContext | undefined;
  private program: WebGLProgram | undefined;
  private programFor = "";
  private vao: WebGLVertexArrayObject | undefined;
  private color: WebGLTexture | undefined;
  private depth: WebGLTexture | undefined;
  private alpha: WebGLTexture | undefined;
  private dist: WebGLTexture | undefined;
  private uploadedDist: Picture["view"] | undefined;
  private mesh: WebGLProgram | undefined;
  private meshFor = "";
  private grid: { key: string; buffer: WebGLBuffer; count: number; cols: number; step: number } | undefined;

  set(picture: Picture | undefined): void {
    this.picture = picture;
  }

  isReady(): boolean {
    return this.picture !== undefined;
  }

  draw(frame: Frame3d): void {
    this.onFrame?.(frame);
    const pic = this.picture;
    if (pic === undefined) return;
    const gl = frame.gl;
    if (this.gl !== gl) this.reset(gl);
    const program = this.compile(gl, frame.outputs);
    if (program === undefined) return;
    if (this.uploaded !== pic) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.color!);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, pic.bitmap);
      this.uploaded = pic;
    }
    if (pic.depth !== undefined && this.uploadedDepth !== pic.depth) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depth!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, pic.depth.width, pic.depth.height, 0, gl.RED, gl.FLOAT, pic.depth.data);
      this.uploadedDepth = pic.depth;
    }
    if (pic.alpha !== undefined && this.uploadedAlpha !== pic.alpha) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.alpha!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pic.alpha.width, pic.alpha.height, 0, gl.RED, gl.UNSIGNED_BYTE, pic.alpha.data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      this.uploadedAlpha = pic.alpha;
    }
    if (pic.view !== undefined && this.drawMesh(gl, frame, pic)) return;
    gl.useProgram(program);
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.uniform4f(gl.getUniformLocation(program, "uViewport"), vp[0], vp[1], vp[2], vp[3]);
    gl.uniform1f(gl.getUniformLocation(program, "uHasDepth"), pic.depth !== undefined ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program, "uHasAlpha"), pic.alpha !== undefined ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.color!);
    gl.uniform1i(gl.getUniformLocation(program, "uColor"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depth!);
    gl.uniform1i(gl.getUniformLocation(program, "uDepth"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.alpha!);
    gl.uniform1i(gl.getUniformLocation(program, "uAlpha"), 2);
    gl.bindVertexArray(this.vao!);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The picture as a mesh in space, drawn with the camera now; false when it cannot be (then flat). */
  private drawMesh(gl: WebGL2RenderingContext, frame: Frame3d, pic: Picture): boolean {
    const v = pic.view!;
    const W = v.distance.width, H = v.distance.height;
    const key = JSON.stringify(frame.outputs);
    if (this.mesh === undefined || this.meshFor !== key) {
      try {
        this.mesh = this.link(gl, MESH_VS, MESH_FS(frame.outputs));
        this.meshFor = key;
      } catch {
        return false;
      }
    }
    if (this.uploadedDist !== v) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.dist!);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, W, H, 0, gl.RED, gl.FLOAT, v.distance.data);
      this.uploadedDist = v;
    }
    // A vertex every pixel, or every 2nd for large frames; two triangles a cell.
    const step = W * H > 400_000 ? 2 : 1;
    const cols = Math.floor((W - 1) / step) + 1, rows = Math.floor((H - 1) / step) + 1;
    const gkey = `${cols}x${rows}`;
    if (this.grid?.key !== gkey) {
      const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
      let k = 0;
      for (let r = 0; r < rows - 1; ++r)
        for (let c = 0; c < cols - 1; ++c) {
          const i = r * cols + c;
          idx.set([i, i + 1, i + cols, i + 1, i + cols + 1, i + cols], k);
          k += 6;
        }
      const buffer = this.grid?.buffer ?? gl.createBuffer()!;
      gl.bindVertexArray(this.vao!);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.grid = { key: gkey, buffer, count: idx.length, cols, step };
    }
    const p = this.mesh!;
    gl.useProgram(p);
    const u = (n: string) => gl.getUniformLocation(p, n);
    gl.uniformMatrix4fv(u("uOldInv"), false, Float32Array.from(v.invViewProjection));
    gl.uniformMatrix4fv(u("uNewVP"), false, invert4(frame.invViewProjection));
    gl.uniform2i(u("uSize"), W, H);
    gl.uniform1i(u("uStep"), step);
    gl.uniform1i(u("uCols"), cols);
    gl.uniform1f(u("uHasAlpha"), pic.alpha !== undefined ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.color!);
    gl.uniform1i(u("uColor"), 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.alpha!);
    gl.uniform1i(u("uAlpha"), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.dist!);
    gl.uniform1i(u("uDist"), 3);
    gl.bindVertexArray(this.vao!);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.grid!.buffer);
    gl.drawElements(gl.TRIANGLES, this.grid!.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  private link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  }

  private reset(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.program = undefined;
    this.programFor = "";
    this.uploaded = undefined;
    this.uploadedDepth = undefined;
    this.uploadedAlpha = undefined;
    this.uploadedDist = undefined;
    this.mesh = undefined;
    this.meshFor = "";
    this.grid = undefined;
    this.vao = gl.createVertexArray()!;
    const tex = (filter: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.color = tex(gl.LINEAR);
    this.depth = tex(gl.NEAREST);
    this.alpha = tex(gl.LINEAR);
    this.dist = tex(gl.NEAREST);
  }

  private compile(gl: WebGL2RenderingContext, outputs: Frame3d["outputs"]): WebGLProgram | undefined {
    const key = JSON.stringify(outputs);
    if (this.program !== undefined && this.programFor === key) return this.program;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS(outputs)));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    this.program = p;
    this.programFor = key;
    return p;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl === undefined) return;
    if (this.program) gl.deleteProgram(this.program);
    if (this.color) gl.deleteTexture(this.color);
    if (this.depth) gl.deleteTexture(this.depth);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.gl = undefined;
  }
}
