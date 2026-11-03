/**
 * Luxar's bloom: a glow around bright light.  The light added up in a
 * view's float target (before tone mapping) goes through a bright pass (only
 * what is brighter than a threshold, with a soft knee), and is blurred by a
 * separable Gaussian at three scales (half, quarter and eighth of the
 * view's size, each a Gaussian of two of its pixels, so about 4, 8 and 16
 * pixels of the view).  The composite adds the three, times the layer's
 * Bloom amount, to the light before tone mapping (render_gl.ts), so a
 * bright bundle bleeds light into its surroundings as a bright light seen
 * through a lens does.
 *
 * The kernels and the bright pass are pure (tested); the GL passes need
 * only a renderer to compile with.
 */
import type { Renderer } from "./render_gl.js";

/** Light at which the bright pass starts to let light through (tone mapping shows it at about 0.8). */
export const BLOOM_THRESHOLD = 1;
/** The soft knee's half width around the threshold. */
export const BLOOM_KNEE = 0.5;
/** Blur scales: each level half the size of the one before, starting at half the view's. */
export const BLOOM_LEVELS = 3;
/** Each level's Gaussian, in its own pixels, and how many taps either side. */
export const BLOOM_SIGMA = 2;
export const BLOOM_RADIUS = 6;

/**
 * A Gaussian's weights for taps 0..radius (tap 0 the centre), normalised
 * so the centre plus twice the rest is 1: a blur that keeps the light.
 */
export function gaussianKernel(sigma: number, radius: number): Float32Array {
  const w = new Float32Array(radius + 1);
  let sum = 0;
  for (let i = 0; i <= radius; ++i) {
    w[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += i === 0 ? w[i] : 2 * w[i];
  }
  for (let i = 0; i <= radius; ++i) w[i] /= sum;
  return w;
}

/**
 * How much of light of brightness `x` (its brightest channel) the bright
 * pass keeps, as a factor of the light: nothing below threshold - knee,
 * all of what is above the threshold beyond threshold + knee, and a
 * quadratic between (the soft knee), so the glow fades in smoothly.
 */
export function brightPass(x: number, threshold = BLOOM_THRESHOLD, knee = BLOOM_KNEE): number {
  if (x <= 0) return 0;
  const soft = Math.min(Math.max(x - threshold + knee, 0), 2 * knee);
  const curve = knee > 0 ? (soft * soft) / (4 * knee) : 0;
  return Math.max(curve, x - threshold) / x;
}

const BRIGHT_GLSL = `
vec3 brightPass(vec3 c) {
  float x = max(c.r, max(c.g, c.b));
  if (x <= 0.0) return vec3(0.0);
  float soft = clamp(x - ${BLOOM_THRESHOLD.toFixed(4)} + ${BLOOM_KNEE.toFixed(4)}, 0.0, ${(2 * BLOOM_KNEE).toFixed(4)});
  float curve = soft * soft / ${(4 * BLOOM_KNEE).toFixed(4)};
  return c * (max(curve, x - ${BLOOM_THRESHOLD.toFixed(4)}) / x);
}`;

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** Half the size: the average of the 2x2 texels under each, through the bright pass for the first level. */
function downFragment(bright: boolean): string {
  return `#version 300 es
precision highp float;
uniform highp sampler2D uSource;
uniform float uEmission;
out vec4 outColour;
${BRIGHT_GLSL}
// The light as the composite shows it: with emission, screened by its own absorption.
vec3 shownLight(vec4 v) {
  if (uEmission < 0.5) return max(v.rgb, vec3(0.0));
  float tau = max(v.a, 0.0);
  float screen = tau < 1e-3 ? 1.0 - 0.5 * tau : (1.0 - exp(-tau)) / tau;
  return max(v.rgb, vec3(0.0)) * screen;
}
void main() {
  ivec2 size = textureSize(uSource, 0);
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  vec3 sum = vec3(0.0);
  for (int dy = 0; dy < 2; ++dy) {
    for (int dx = 0; dx < 2; ++dx) {
      vec4 v = texelFetch(uSource, min(p + ivec2(dx, dy), size - 1), 0);
      sum += ${bright ? "brightPass(shownLight(v))" : "max(v.rgb, vec3(0.0))"};
    }
  }
  outColour = vec4(sum * 0.25, 1.0);
}`;
}

function blurFragment(): string {
  const w = gaussianKernel(BLOOM_SIGMA, BLOOM_RADIUS);
  return `#version 300 es
precision highp float;
uniform highp sampler2D uSource;
uniform ivec2 uStep;
out vec4 outColour;
const float W[${BLOOM_RADIUS + 1}] = float[](${Array.from(w, (v) => v.toFixed(8)).join(", ")});
void main() {
  ivec2 size = textureSize(uSource, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 sum = texelFetch(uSource, p, 0).rgb * W[0];
  for (int i = 1; i <= ${BLOOM_RADIUS}; ++i) {
    sum += texelFetch(uSource, clamp(p + uStep * i, ivec2(0), size - 1), 0).rgb * W[i];
    sum += texelFetch(uSource, clamp(p - uStep * i, ivec2(0), size - 1), 0).rgb * W[i];
  }
  outColour = vec4(sum, 1.0);
}`;
}

interface Level {
  size: [number, number];
  /** The blurred light (and the half-way texture of the separable blur). */
  textures: [WebGLTexture, WebGLTexture];
  framebuffers: [WebGLFramebuffer, WebGLFramebuffer];
}

/** One view's bloom textures, made at its size. */
export class Bloom {
  private levels: Level[] = [];
  private size: [number, number] = [0, 0];

  constructor(
    private readonly renderer: Renderer,
    private readonly float: boolean,
  ) {}

  private make(width: number, height: number): void {
    this.release();
    const { gl } = this.renderer;
    let w = width;
    let h = height;
    for (let l = 0; l < BLOOM_LEVELS; ++l) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      const textures: WebGLTexture[] = [];
      const framebuffers: WebGLFramebuffer[] = [];
      for (let k = 0; k < 2; ++k) {
        const t = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, t);
        if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        // Read back with bilinear filtering by the composite, at the view's size.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const f = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        textures.push(t);
        framebuffers.push(f);
      }
      this.levels.push({ size: [w, h], textures: textures as [WebGLTexture, WebGLTexture], framebuffers: framebuffers as [WebGLFramebuffer, WebGLFramebuffer] });
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.size = [width, height];
  }

  /**
   * Blurs the bright part of `light` (the view's light target, `width` by
   * `height`; with `emission`, its light screened by its absorption, as the
   * composite shows it) at each scale.  Leaves its framebuffer bound, blending,
   * depth, stencil and scissor tests off: the caller sets its own again.
   * Returns the blurred textures, finest first, or undefined when they
   * cannot be drawn into.
   */
  run(light: WebGLTexture, width: number, height: number, emission: boolean): WebGLTexture[] | undefined {
    const { renderer } = this;
    const { gl } = renderer;
    if (this.size[0] !== width || this.size[1] !== height || this.levels.length === 0) this.make(width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(false);
    let source = light;
    for (let l = 0; l < this.levels.length; ++l) {
      const level = this.levels[l];
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffers[0]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return undefined;
      gl.viewport(0, 0, level.size[0], level.size[1]);
      renderer.fullScreen(`bloom-down|${l === 0}`, VS, downFragment(l === 0), { uSource: source }, {}, { uEmission: emission ? 1 : 0 });
      // Across, into the second texture; then down, back into the first.
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffers[1]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      renderer.fullScreen("bloom-blur", VS, blurFragment(), { uSource: level.textures[0] }, { uStep: [1, 0] });
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffers[0]);
      renderer.fullScreen("bloom-blur", VS, blurFragment(), { uSource: level.textures[1] }, { uStep: [0, 1] });
      source = level.textures[0];
    }
    return this.levels.map((l) => l.textures[0]);
  }

  release(): void {
    const { gl } = this.renderer;
    for (const level of this.levels) {
      level.textures.forEach((t) => gl.deleteTexture(t));
      level.framebuffers.forEach((f) => gl.deleteFramebuffer(f));
    }
    this.levels = [];
    this.size = [0, 0];
  }
}
