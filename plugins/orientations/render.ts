/**
 * Drawing glyph sets with WebGL2, in two places: the plugin's own canvas
 * over the 2-D views, and Neuroglancer's 3-D view (draw3d), which wants its
 * three outputs written.  One renderer per context; a set's buffers are
 * made in each context the first time it is drawn there.
 *
 * Surfaces are the sphere's mesh drawn once per glyph (instanced), each
 * vertex pushed out to its radius, read from a float texture (a row of
 * vertices per glyph).  The normal comes from four neighbours' pushed-out
 * points (central differences), so a lobe is shaded as the surface it is.
 * Lines are quads a few pixels wide, facing the screen.
 */
import type { GlyphSet } from "./glyphs.js";
import { icosphere, type Sphere } from "./sphere.js";

export interface Outputs {
  color: number;
  /** Neuroglancer's 3-D view: depth (as 1 - z, in all four channels) and pick id. */
  z?: number;
  pick?: number;
}

export interface DrawParams {
  /** RAS mm to clip space, column-major. */
  matrix: Float32Array;
  /** From the eye into the scene, RAS (unit). */
  viewDir: [number, number, number];
  /** Millimetres a glyph's radius 1 (or a line's half-length 1) spans. */
  scale: number;
  /** The viewport, device pixels, for line widths. */
  viewport: [number, number];
  lineWidth: number;
  /**
   * Draw each glyph this many millimetres nearer the eye in depth only (it
   * shows whole over a section it is centred on, in the 3-D view).
   */
  lift: number;
}

const SURFACE_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 uMatrix;
uniform sampler2D uRadii;
uniform sampler2D uSphere;
uniform int uVertices;
uniform int uPerRow;
uniform float uScale;
uniform float uLift;
uniform vec3 uViewDir;
uniform bool uByGlyph;
layout(location = 0) in vec3 aDir;
layout(location = 1) in uvec4 aAround;
layout(location = 2) in vec3 aCentre;
layout(location = 3) in vec3 aColour;
out vec3 vColour;
out vec3 vNormal;

float radius(int v) {
  int g = gl_InstanceID;
  return texelFetch(uRadii, ivec2((g % uPerRow) * uVertices + v, g / uPerRow), 0).r;
}
vec3 point(uint v) {
  return texelFetch(uSphere, ivec2(int(v), 0), 0).xyz * radius(int(v));
}
void main() {
  vec3 p = aDir * radius(gl_VertexID);
  vec3 n = cross(point(aAround.x) - point(aAround.z), point(aAround.y) - point(aAround.w));
  vNormal = dot(n, n) > 1e-12 ? n : aDir;
  vColour = uByGlyph ? aColour : abs(aDir);
  vec3 at = aCentre + p * uScale;
  gl_Position = uMatrix * vec4(at, 1.0);
  if (uLift > 0.0) {
    vec4 lifted = uMatrix * vec4(at - uViewDir * uLift, 1.0);
    gl_Position.z = lifted.z / lifted.w * gl_Position.w;
  }
}`;

const LINE_VS = `#version 300 es
precision highp float;
uniform mat4 uMatrix;
uniform float uScale;
uniform float uLift;
uniform vec3 uViewDir;
uniform vec2 uViewport;
uniform float uWidth;
layout(location = 2) in vec3 aCentre;
layout(location = 3) in vec3 aColour;
layout(location = 4) in vec3 aHalf;
out vec3 vColour;
out vec3 vNormal;
void main() {
  // Two triangles: corners (end, side) from the vertex number.
  int k = gl_VertexID;
  float end = (k == 0 || k == 1 || k == 3) ? -1.0 : 1.0;
  float side = (k == 0 || k == 2 || k == 4) ? -1.0 : 1.0;
  vec4 a = uMatrix * vec4(aCentre - aHalf * uScale, 1.0);
  vec4 b = uMatrix * vec4(aCentre + aHalf * uScale, 1.0);
  vec2 d = (b.xy / b.w - a.xy / a.w) * uViewport;
  vec2 across = dot(d, d) > 1e-6 ? normalize(vec2(-d.y, d.x)) : vec2(1.0, 0.0);
  vec4 p = end < 0.0 ? a : b;
  p.xy += across * side * uWidth / uViewport * p.w;
  if (uLift > 0.0) {
    vec4 lifted = uMatrix * vec4(aCentre + end * aHalf * uScale - uViewDir * uLift, 1.0);
    p.z = lifted.z / lifted.w * p.w;
  }
  gl_Position = p;
  vColour = aColour;
  // No normal: lines are drawn flat, in their colour.
  vNormal = vec3(0.0);
}`;

const fs = (outputs: Outputs) => `#version 300 es
precision highp float;
uniform vec3 uViewDir;
in vec3 vColour;
in vec3 vNormal;
layout(location = ${outputs.color}) out vec4 out_color;
${outputs.z !== undefined ? `layout(location = ${outputs.z}) out highp vec4 out_z;` : ""}
${outputs.pick !== undefined ? `layout(location = ${outputs.pick}) out highp vec4 out_pickId;` : ""}
void main() {
  vec3 colour = vColour;
  if (dot(vNormal, vNormal) > 0.0) {
    float diffuse = abs(dot(normalize(vNormal), uViewDir));
    colour = vColour * (0.3 + 0.7 * diffuse) + vec3(0.18) * pow(diffuse, 24.0);
  }
  out_color = vec4(colour, 1.0);
  ${outputs.z !== undefined ? "out_z = vec4(1.0 - gl_FragCoord.z);" : ""}
  ${outputs.pick !== undefined ? "out_pickId = vec4(0.0);" : ""}
}`;

interface SphereBuffers {
  vao: WebGLVertexArrayObject;
  dirs: WebGLBuffer;
  around: WebGLBuffer;
  elements: WebGLBuffer;
  texture: WebGLTexture;
  sphere: Sphere;
}

interface SetBuffers {
  vao: WebGLVertexArrayObject;
  centres: WebGLBuffer;
  colours: WebGLBuffer;
  dirs?: WebGLBuffer;
  radii?: WebGLTexture;
  perRow: number;
}

export class GlyphRenderer {
  private surface: WebGLProgram | undefined;
  private line: WebGLProgram | undefined;
  private spheres = new Map<number, SphereBuffers>();
  private sets = new WeakMap<GlyphSet, SetBuffers>();
  private made: { set: GlyphSet; buffers: SetBuffers }[] = [];
  private readonly maxTexture: number;

  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly outputs: Outputs,
  ) {
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  }

  private program(vs: string): WebGLProgram {
    const { gl } = this;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader did not compile");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs(this.outputs)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program did not link");
    return program;
  }

  private sphere(subdivisions: number): SphereBuffers {
    let s = this.spheres.get(subdivisions);
    if (s !== undefined) return s;
    const { gl } = this;
    const sphere = icosphere(subdivisions);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const dirs = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, dirs);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const around = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, around);
    gl.bufferData(gl.ARRAY_BUFFER, sphere.around, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_INT, 0, 0);
    const elements = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.faces, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const rgba = new Float32Array(4 * sphere.count);
    for (let v = 0; v < sphere.count; ++v) rgba.set(sphere.vertices.subarray(3 * v, 3 * v + 3), 4 * v);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sphere.count, 1, 0, gl.RGBA, gl.FLOAT, rgba);
    this.nearest();
    gl.bindTexture(gl.TEXTURE_2D, null);
    s = { vao, dirs, around, elements, texture, sphere };
    this.spheres.set(subdivisions, s);
    return s;
  }

  private nearest(): void {
    const { gl } = this;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private buffers(set: GlyphSet): SetBuffers {
    let b = this.sets.get(set);
    if (b !== undefined) return b;
    const { gl } = this;
    const vao = gl.createVertexArray()!;
    let perRow = 1;
    let radii: WebGLTexture | undefined;
    let dirs: WebGLBuffer | undefined;
    if (set.shape === "surface") {
      const s = this.sphere(set.subdivisions ?? 3);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.dirs);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.around);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_INT, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.elements);
      // Glyphs side by side in rows as wide as a texture may be.
      const nv = s.sphere.count;
      perRow = Math.max(1, Math.floor(this.maxTexture / nv));
      const rows = Math.max(1, Math.ceil(set.count / perRow));
      const width = Math.min(set.count, perRow) * nv || nv;
      const data = new Float32Array(width * rows);
      const src = set.radii!;
      for (let g = 0; g < set.count; ++g) {
        const row = Math.floor(g / perRow);
        data.set(src.subarray(g * nv, (g + 1) * nv), row * width + (g % perRow) * nv);
      }
      radii = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, radii);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, rows, 0, gl.RED, gl.FLOAT, data);
      this.nearest();
      gl.bindTexture(gl.TEXTURE_2D, null);
    } else {
      gl.bindVertexArray(vao);
      dirs = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, dirs);
      gl.bufferData(gl.ARRAY_BUFFER, set.dirs!, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(4, 1);
    }
    const centres = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, centres);
    gl.bufferData(gl.ARRAY_BUFFER, set.centres, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    const colours = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colours);
    gl.bufferData(gl.ARRAY_BUFFER, set.colours ?? new Float32Array(3 * Math.max(1, set.count)), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    b = { vao, centres, colours, dirs, radii, perRow };
    this.sets.set(set, b);
    this.made.push({ set, buffers: b });
    return b;
  }

  /** Lets go of the buffers of sets no longer drawn. */
  keepOnly(sets: Iterable<GlyphSet>): void {
    const keep = new Set(sets);
    const { gl } = this;
    this.made = this.made.filter(({ set, buffers }) => {
      if (keep.has(set)) return true;
      gl.deleteVertexArray(buffers.vao);
      gl.deleteBuffer(buffers.centres);
      gl.deleteBuffer(buffers.colours);
      if (buffers.dirs) gl.deleteBuffer(buffers.dirs);
      if (buffers.radii) gl.deleteTexture(buffers.radii);
      this.sets.delete(set);
      return false;
    });
  }

  draw(set: GlyphSet, params: DrawParams): void {
    if (set.count === 0) return;
    const { gl } = this;
    const b = this.buffers(set);
    const surface = set.shape === "surface";
    const program = surface ? (this.surface ??= this.program(SURFACE_VS)) : (this.line ??= this.program(LINE_VS));
    gl.useProgram(program);
    const u = (name: string) => gl.getUniformLocation(program, name);
    gl.uniformMatrix4fv(u("uMatrix"), false, params.matrix);
    gl.uniform3fv(u("uViewDir"), params.viewDir);
    gl.uniform1f(u("uScale"), params.scale);
    gl.uniform1f(u("uLift"), params.lift);
    gl.bindVertexArray(b.vao);
    if (surface) {
      const s = this.sphere(set.subdivisions ?? 3);
      gl.uniform1i(u("uVertices"), s.sphere.count);
      gl.uniform1i(u("uPerRow"), b.perRow);
      gl.uniform1i(u("uByGlyph"), set.colours !== undefined ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.radii!);
      gl.uniform1i(u("uRadii"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, s.texture);
      gl.uniform1i(u("uSphere"), 1);
      gl.drawElementsInstanced(gl.TRIANGLES, s.sphere.faces.length, gl.UNSIGNED_INT, 0, set.count);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } else {
      gl.uniform2fv(u("uViewport"), params.viewport);
      gl.uniform1f(u("uWidth"), params.lineWidth);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, set.count);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const { gl } = this;
    this.keepOnly([]);
    for (const s of this.spheres.values()) {
      gl.deleteVertexArray(s.vao);
      gl.deleteBuffer(s.dirs);
      gl.deleteBuffer(s.around);
      gl.deleteBuffer(s.elements);
      gl.deleteTexture(s.texture);
    }
    this.spheres.clear();
    if (this.surface) gl.deleteProgram(this.surface);
    if (this.line) gl.deleteProgram(this.line);
    this.surface = this.line = undefined;
  }
}
