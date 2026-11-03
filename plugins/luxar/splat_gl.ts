/**
 * Drawing Gaussian splats in WebGL2: one instanced quad per splat, its 3-D
 * covariance projected to the screen through the view's Jacobian at its
 * centre (as EWA splatting does), widened by a fraction of a pixel so tiny
 * splats still cover one, and cut at three standard deviations.  Each
 * fragment adds the splat's light, its weight through the colormap times
 * the Gaussian there, into a float target that the lines' composite then
 * tone maps (./render_gl.ts), and for emission and absorption its optical
 * depth in alpha (composited as the lines' is, order-independent): splats
 * need no depth sort.
 */
import { COLORMAP_GLSL } from "./render_gl.js";

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aCentre;
layout(location = 1) in vec3 aCovA;
layout(location = 2) in vec3 aCovB;
layout(location = 3) in float aWeight;
uniform mat4 uModelToClip;
uniform vec2 uViewport;
// A 2-D view's section: millimetres from it, as dot(xyz, centre) + w (model units are mm); off in 3-D.
uniform bool uSection;
uniform vec4 uPlane;
// In a section, each Gaussian widened by this (its total kept), so a grid of cells reads as one image.
uniform float uWiden;
out vec2 vOffset;
out vec3 vInvCov;
out float vWeight;
out float vColourAt;

void main() {
  // The quad's corner, (±1, ±1).
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  mat3 S = mat3(aCovA.x, aCovA.y, aCovA.z, aCovA.y, aCovB.x, aCovB.y, aCovA.z, aCovB.y, aCovB.z);
  vec3 centre = aCentre;
  float weight = aWeight;
  if (uSection) {
    // The Gaussian cut by the section: its peak there (the weight times the Gaussian along
    // the plane's normal), its centre and covariance in the plane given where it is cut.
    vec3 n = uPlane.xyz;
    vec3 Sn = S * n;
    float s = max(dot(n, Sn), 1e-6);
    float d = dot(n, aCentre) + uPlane.w;
    if (d * d > 9.0 * s) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    // Light, not intensity times light: the colour says the intensity.
    weight = exp(-0.5 * d * d / s) / uWiden;
    centre -= Sn * (d / s);
    S = (S - outerProduct(Sn, Sn) / s) * uWiden;
  }
  vec4 c = uModelToClip * vec4(centre, 1.0);
  if (c.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 ndc = c.xy / c.w;
  // Pixels per unit of each model axis at the centre.
  vec2 hv = 0.5 * uViewport;
  vec2 j0 = hv * (uModelToClip[0].xy - ndc * uModelToClip[0].w) / c.w;
  vec2 j1 = hv * (uModelToClip[1].xy - ndc * uModelToClip[1].w) / c.w;
  vec2 j2 = hv * (uModelToClip[2].xy - ndc * uModelToClip[2].w) / c.w;
  mat3x2 J = mat3x2(j0, j1, j2);
  mat2 P = J * S * transpose(J) + mat2(0.3, 0.0, 0.0, 0.3);
  float det = P[0][0] * P[1][1] - P[0][1] * P[1][0];
  vInvCov = vec3(P[1][1], -P[0][1], P[0][0]) / det;
  // Three standard deviations along each screen axis.
  vec2 extent = 3.0 * sqrt(vec2(P[0][0], P[1][1]));
  vOffset = corner * extent;
  vWeight = weight;
  vColourAt = aWeight;
  gl_Position = vec4(c.xy + vOffset / hv * c.w, c.z, c.w);
}`;

const FS = `#version 300 es
precision highp float;
uniform float uGain;
uniform float uAbsorption;
uniform int uColormap;
uniform bool uOneColour;
uniform vec3 uColour;
in vec2 vOffset;
in vec3 vInvCov;
in float vWeight;
in float vColourAt;
out vec4 outLight;

${COLORMAP_GLSL}

void main() {
  float power = -0.5 * (vInvCov.x * vOffset.x * vOffset.x + 2.0 * vInvCov.y * vOffset.x * vOffset.y + vInvCov.z * vOffset.y * vOffset.y);
  if (power < -4.5) discard;
  float g = exp(power) * vWeight;
  vec3 colour = uOneColour ? uColour : colormap(uColormap, vColourAt);
  // Light, and (for emission and absorption) optical depth.
  outLight = vec4(colour * g * uGain, g * uAbsorption);
}`;

export interface GpuSplats {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
  bytes: number;
}

export interface SplatUniforms {
  modelToClip: Float32Array;
  viewport: [number, number];
  gain: number;
  /** Optical depth per unit of light (0: glow only). */
  absorption: number;
  colormap: number;
  /** One colour (rgb 0..1) rather than the colormap. */
  colour?: [number, number, number];
  /** A 2-D view's section (mm from it, as a plane on the model's mm): each splat cut by it. */
  plane?: [number, number, number, number];
  /** In a section, how much wider each Gaussian is drawn (its total kept). */
  widen?: number;
}

export class SplatRenderer {
  private readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(readonly gl: WebGL2RenderingContext) {
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "the splat shader did not compile");
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "the splat program did not link");
    this.program = program;
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }

  /** A block's splats on the GPU: centre, covariance (two vec3) and weight per splat, interleaved. */
  upload(centres: Float32Array, covariances: Float32Array, weights: Float32Array): GpuSplats {
    const { gl } = this;
    const n = weights.length;
    const data = new Float32Array(10 * n);
    for (let i = 0; i < n; ++i) {
      data.set(centres.subarray(3 * i, 3 * i + 3), 10 * i);
      data.set(covariances.subarray(6 * i, 6 * i + 6), 10 * i + 3);
      data[10 * i + 9] = weights[i];
    }
    const vao = gl.createVertexArray()!;
    const buffer = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attribute = (location: number, size: number, offset: number) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 40, offset);
      gl.vertexAttribDivisor(location, 1);
    };
    attribute(0, 3, 0);
    attribute(1, 3, 12);
    attribute(2, 3, 24);
    attribute(3, 1, 36);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vao, buffer, count: n, bytes: data.byteLength };
  }

  release(s: GpuSplats): void {
    this.gl.deleteVertexArray(s.vao);
    this.gl.deleteBuffer(s.buffer);
  }

  /** Adds the splats' light into the bound target (blending and depth as the caller set them). */
  draw(splats: GpuSplats[], u: SplatUniforms): void {
    const { gl } = this;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.u("uModelToClip"), false, u.modelToClip);
    gl.uniform2fv(this.u("uViewport"), u.viewport);
    gl.uniform1f(this.u("uGain"), u.gain);
    gl.uniform1f(this.u("uAbsorption"), u.absorption);
    gl.uniform1i(this.u("uColormap"), u.colormap);
    gl.uniform1i(this.u("uOneColour"), u.colour ? 1 : 0);
    gl.uniform3fv(this.u("uColour"), u.colour ?? [1, 1, 1]);
    gl.uniform1i(this.u("uSection"), u.plane ? 1 : 0);
    gl.uniform4fv(this.u("uPlane"), u.plane ?? [0, 0, 0, 0]);
    gl.uniform1f(this.u("uWiden"), u.widen ?? 1);
    for (const s of splats) {
      gl.bindVertexArray(s.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.count);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}
