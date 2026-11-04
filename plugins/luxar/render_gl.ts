/**
 * Drawing lines and points the way Luxar does, in raw WebGL2, for any
 * context (Neuroglancer's 3-D view, or this plugin's canvas over the 2-D
 * views).
 *
 * A line segment is one instanced quad, widened in screen space to a width
 * in pixels.  Where two segments meet at a joint the quad's end edge is
 * turned onto the joint's mitre line, so the two quads tile with neither a
 * gap on the outside of the bend nor an overlap inside it (with additive
 * light, an overlap shows as a bright tick).  Across the line the light
 * falls off as Luxar's shifted, truncated super-Gaussian, whose exponent is
 * the sharpness: 0.5 a Gaussian, 1 a hard edge.  Points are round sprites
 * with the same profile.
 *
 * A mesh's triangles are drawn lit, or in a 2-D view as where they cross
 * the section (./mesh_gl.ts), with the same uniforms and object tables.
 *
 * The light is added up in a float (HDR) target and then tone mapped onto
 * the view (`composite`): "glow" adds, "emission" also absorbs, so that a
 * dense bundle hides what is behind it.  "Solid" skips the target and
 * draws shaded, depth-tested tubes.
 *
 * The cross-section, the mitre and the tone curves follow Luxar's viewer
 * (BSD-3-Clause, Copyright (c) 2024-2026, Loic A. Royer and Luxar
 * Contributors; see ./README.md); the code is written for this plugin.
 */
import { type BuiltChunk, PIECE_STRIDE, SAMPLES, TEXTURE_WIDTH } from "./chunk_build.js";
import { cutVertexShader, meshFragmentShader, meshVertexShader } from "./mesh_gl.js";
import { needsTable, type ObjectShading, objectTable } from "./segments.js";

/** Where a program's outputs go: Neuroglancer's three (colour, depth, pick) or one. */
export interface Outputs {
  color: number;
  z?: number;
  pick?: number;
}

export type Pass = "accumulate" | "solid" | "depth";

export interface DrawUniforms {
  modelToClip: Float32Array;
  /** Store directions to physical ones, for direction colours. */
  directions: Float32Array;
  /** The drawing target's size, device pixels. */
  viewport: [number, number];
  /** Half the line width (or a point's radius), device pixels. */
  halfWidth: number;
  sharpness: number;
  colourBy: number;
  colour: [number, number, number];
  colormap: number;
  range: [number, number];
  /** Light per line before tone mapping, and how much it absorbs (emission). */
  gain: number;
  absorption: number;
  /** 2-D: signed distance from the section (mm) = dot(plane.xyz, p) + plane.w; slab is half the thickness shown. Slab 0: no section. */
  plane: [number, number, number, number];
  slab: number;
  /** Depth pass: where the line is at least this bright it writes depth. */
  depthCut: number;
  /** Depth pass: write depth at the near plane (over everything). */
  depthNear: boolean;
  /** Each vertex's object is looked up in its chunk's table: hidden objects are not drawn, and "segment" colours come from it. */
  objectTable: boolean;
  /** A mesh's light comes from the eye: a point (w 1) or, far away, a direction (w 0), store coordinates. */
  eye: [number, number, number, number];
  /**
   * A mesh's glow, 3-D: the nearest surface's depth at each pixel (a depth
   * texture the size of the target), the clip-to-store matrix, and the
   * distance (store units) over which light behind it fades by e.
   */
  front?: { texture: WebGLTexture; clipToModel: Float32Array; falloff: number };
}

/** One chunk on the GPU. */
export interface GpuChunk {
  texture: WebGLTexture;
  segments: WebGLBuffer | undefined;
  vao: WebGLVertexArrayObject;
  segmentCount: number;
  pointCount: number;
  bytes: number;
  /** The segments' total length, store units. */
  length: number;
  /** Per vertex, its object's slot (R32UI, as the vertex texture). */
  slots: WebGLTexture;
  /** The chunk's objects (ids as word pairs) and weights, for its table. */
  objectIds: Uint32Array;
  objectWeight: Float32Array;
  /** Per object, its colour and whether it shows (RGBA8), made for `tableVersion`. */
  objects: WebGLTexture | undefined;
  tableVersion: number;
  /** The share of the chunk's lines (or points, or triangles) drawn at all: 0 skips it. */
  shown: number;
  /** The same share, each object counted at how strongly it is drawn (for automatic brightness). */
  light: number;
  /** The vertices' bounds, store coordinates. */
  lower: [number, number, number];
  upper: [number, number, number];
  /** Objects read whole: the segments' pieces of space (BuiltChunk.pieces), so a view draws only those it can show. */
  pieces: Float64Array | undefined;
  /** A mesh's triangles, their normals per vertex, and the arrays that draw them in 3-D and (cut by the section) in 2-D. */
  triangleCount: number;
  area: number;
  normals: WebGLTexture | undefined;
  faces: WebGLBuffer | undefined;
  meshVao: WebGLVertexArrayObject | undefined;
  cutVao: WebGLVertexArrayObject | undefined;
}

/** The colormaps as GLSL: `vec3 colormap(int which, float t)` (shared with the splats' shader). */
export const COLORMAP_GLSL = `// Colormaps as polynomial fits (viridis, magma, inferno and plasma after
// Matt Zucker's fits of matplotlib's, CC0; turbo after Google's).
vec3 colormap(int which, float t) {
  t = clamp(t, 0.0, 1.0);
  if (which == 5) return vec3(t);
  if (which == 4) {
    const vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 kr2 = vec2(-152.94239396, 59.28637943);
    const vec2 kg2 = vec2(4.27729857, 2.82956604);
    const vec2 kb2 = vec2(-89.90310912, 27.34824973);
    vec4 v4 = vec4(1.0, t, t * t, t * t * t);
    vec2 v2 = v4.zw * v4.z;
    return clamp(vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2)), 0.0, 1.0);
  }
  vec3 c0, c1, c2, c3, c4, c5, c6;
  if (which == 0) {
    c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
    c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
    c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
    c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
    c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
    c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
    c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  } else if (which == 1) {
    c0 = vec3(-0.002136485053939582, -0.000749655052795221, -0.005386127855323933);
    c1 = vec3(0.2516605407371642, 0.6775232436837668, 2.494026599312351);
    c2 = vec3(8.353717279216625, -3.577719514958484, 0.3144679030132573);
    c3 = vec3(-27.66873308576866, 14.26473078096533, -13.64921318813922);
    c4 = vec3(52.17613981234068, -27.94360607168351, 12.94416944238394);
    c5 = vec3(-50.76852536473588, 29.04658282127291, 4.23415299384598);
    c6 = vec3(18.65570506591883, -11.48977351997711, -5.601961508734096);
  } else if (which == 2) {
    c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
    c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
    c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
    c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
    c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
    c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
    c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  } else {
    c0 = vec3(0.05873234392399702, 0.02333670892565664, 0.5433401826748754);
    c1 = vec3(2.176514634195958, 0.2383834171260182, 0.7539604599784036);
    c2 = vec3(-2.689460476458034, -7.455851135738909, 3.110799939717086);
    c3 = vec3(6.130348345893603, 42.3461881477227, -28.51885465332158);
    c4 = vec3(-11.10743619062271, -82.66631109428045, 60.13984767418263);
    c5 = vec3(10.02306557647065, 71.41361770095349, -54.07218655560067);
    c6 = vec3(-3.658713842777788, -22.93153465461149, 18.19190778539828);
  }
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}`;

const COMMON = `
uniform highp sampler2D uVertices;
uniform mat4 uModelToClip;
uniform mat3 uDirections;
uniform vec2 uViewport;
uniform float uHalfWidth;
uniform int uColourBy;
uniform vec3 uColour;
uniform int uColormap;
uniform vec2 uRange;
uniform vec4 uPlane;
uniform float uSlab;
uniform highp usampler2D uSlots;
uniform lowp sampler2D uObjects;
uniform bool uObjectTable;
// Drawn opaque (solid): an object drawn faintly (the layer's notSelectedAlpha) is left out.
uniform bool uOpaque;

vec4 vertexAt(uint i) {
  return texelFetch(uVertices, ivec2(int(i % ${TEXTURE_WIDTH}u), int(i / ${TEXTURE_WIDTH}u)), 0);
}

// Whether an object (its table entry, from objectAt) is not drawn: not shown, or faint and drawn opaque.
bool hidden(vec4 object) {
  return object.a < 0.5 / 255.0 || (uOpaque && object.a < 254.5 / 255.0);
}

// A vertex's object: its colour (as the layer colours segments) and how strongly it is drawn (alpha; 0 not at all).
vec4 objectAt(uint i) {
  if (!uObjectTable) return vec4(1.0);
  uint slot = texelFetch(uSlots, ivec2(int(i % ${TEXTURE_WIDTH}u), int(i / ${TEXTURE_WIDTH}u)), 0).r;
  return texelFetch(uObjects, ivec2(int(slot % ${TEXTURE_WIDTH}u), int(slot / ${TEXTURE_WIDTH}u)), 0);
}

${COLORMAP_GLSL}

vec3 hue(float h) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), k, 0.75);
}

// A vertex's colour: by the direction there, its object, its value, one colour, or its segment's colour.
vec3 colourAt(vec4 v, vec3 tangent, vec3 segment) {
  if (uColourBy == 0) {
    vec3 d = uDirections * tangent;
    float l = length(d);
    return l > 0.0 ? abs(d) / l : vec3(0.5);
  }
  if (uColourBy == 1) return hue(v.w);
  if (uColourBy == 2) return colormap(uColormap, (v.w - uRange.x) / max(uRange.y - uRange.x, 1e-12));
  if (uColourBy == 4) return segment;
  return uColour;
}

float sectionDistance(vec3 p) {
  return dot(uPlane.xyz, p) + uPlane.w;
}
`;

const MESH_VS = meshVertexShader(COMMON);
const CUT_VS = cutVertexShader(COMMON);

const LINE_VS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
layout(location = 0) in uvec4 aSegment;
out vec3 vColour;
out float vAcross;
out float vSection;
out float vFade;

const float NEAR_W = 1e-6;

vec2 pixels(vec4 clip) {
  return clip.xy / clip.w * 0.5 * uViewport;
}

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColour = vec3(0.0);
  vAcross = 0.0;
  vSection = 0.0;
  vFade = 0.0;
}

void main() {
  bool atEnd = gl_VertexID >= 2;
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec4 P = vertexAt(aSegment.x);
  vec4 A = vertexAt(aSegment.y);
  vec4 B = vertexAt(aSegment.z);
  vec4 N = vertexAt(aSegment.w);
  bool joinA = aSegment.x != aSegment.y;
  bool joinB = aSegment.w != aSegment.z;
  vec4 object = objectAt(aSegment.y);
  if (hidden(object)) {
    hide();
    return;
  }

  float dA = sectionDistance(A.xyz);
  float dB = sectionDistance(B.xyz);
  if (uSlab > 0.0 && ((dA > uSlab && dB > uSlab) || (dA < -uSlab && dB < -uSlab))) {
    hide();
    return;
  }

  vec4 cA = uModelToClip * vec4(A.xyz, 1.0);
  vec4 cB = uModelToClip * vec4(B.xyz, 1.0);
  if (cA.w < NEAR_W && cB.w < NEAR_W) {
    hide();
    return;
  }
  // A segment crossing the camera's plane is cut there, and joins nothing at that end.
  if (cA.w < NEAR_W) {
    cA = mix(cA, cB, (NEAR_W - cA.w) / (cB.w - cA.w));
    joinA = false;
  }
  if (cB.w < NEAR_W) {
    cB = mix(cB, cA, (NEAR_W - cB.w) / (cA.w - cB.w));
    joinB = false;
  }
  vec4 cP = uModelToClip * vec4(P.xyz, 1.0);
  vec4 cN = uModelToClip * vec4(N.xyz, 1.0);
  if (cP.w < NEAR_W) joinA = false;
  if (cN.w < NEAR_W) joinB = false;

  vec2 sA = pixels(cA);
  vec2 sB = pixels(cB);
  vec2 d = sB - sA;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);

  // At a joint the corner goes to the mitre: where the two segments' edges
  // meet.  Both segments work it out from the same three points, so they
  // agree exactly.  Past a 120 degree turn the mitre would reach too far,
  // and both square off instead.
  vec2 offset = normal;
  bool join = atEnd ? joinB : joinA;
  if (join) {
    vec2 other = atEnd ? pixels(cN) - sB : sA - pixels(cP);
    float otherLen = length(other);
    if (otherLen > 1e-6 && len > 1e-6) {
      vec2 o = other / otherLen;
      vec2 otherNormal = vec2(-o.y, o.x);
      vec2 m = normal + otherNormal;
      float k = dot(m, normal);
      if (k > 0.5) offset = m / k;
    }
  }

  // Thinner than a pixel and a half, a line is drawn that wide and dimmer, so its light is kept.
  float halfWidth = max(uHalfWidth, 0.75);
  // A faint object (the layer's notSelectedAlpha) gives that share of the light.
  vFade = uHalfWidth / halfWidth * object.a;

  vec4 c = atEnd ? cB : cA;
  c.xy += offset * side * halfWidth / (0.5 * uViewport) * c.w;
  gl_Position = c;
  vAcross = side;
  vSection = atEnd ? dB : dA;
  vec3 tangent = atEnd ? (joinB ? N.xyz - A.xyz : B.xyz - A.xyz) : (joinA ? B.xyz - P.xyz : B.xyz - A.xyz);
  vColour = colourAt(atEnd ? B : A, tangent, object.rgb);
}
`;

const POINT_VS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
out vec3 vColour;
out vec2 vCorner;
out float vSection;
out float vFade;

void main() {
  vec4 v = vertexAt(uint(gl_InstanceID));
  vec2 corner = vec2((gl_VertexID & 1) == 0 ? -1.0 : 1.0, gl_VertexID >= 2 ? 1.0 : -1.0);
  float d = sectionDistance(v.xyz);
  vec4 c = uModelToClip * vec4(v.xyz, 1.0);
  vec4 object = objectAt(uint(gl_InstanceID));
  if ((uSlab > 0.0 && abs(d) > uSlab) || c.w < 1e-6 || hidden(object)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float radius = max(uHalfWidth, 0.75);
  vFade = (uHalfWidth / radius) * (uHalfWidth / radius) * object.a;
  c.xy += corner * radius / (0.5 * uViewport) * c.w;
  gl_Position = c;
  vCorner = corner;
  vSection = d;
  vColour = colourAt(v, vec3(0.0), object.rgb);
}
`;

function fragment(points: boolean, pass: Pass, outputs: Outputs): string {
  const outs: string[] = [];
  outs.push(`layout(location = ${outputs.color}) out vec4 outColour;`);
  if (outputs.z !== undefined) outs.push(`layout(location = ${outputs.z}) out highp vec4 outZ;`);
  if (outputs.pick !== undefined) outs.push(`layout(location = ${outputs.pick}) out highp vec4 outPick;`);
  // Neuroglancer's depth output holds 1 - depth; its pick output 0 is "nothing".
  const writeRest = `${outputs.z !== undefined ? "outZ = vec4(1.0 - fragDepth);" : ""}${outputs.pick !== undefined ? "outPick = vec4(0.0);" : ""}`;
  const body = {
    accumulate: `
      float fragDepth = gl_FragCoord.z;
      outColour = vec4(vColour * (light * uGain), light * uAbsorption);
      ${writeRest}`,
    solid: `
      // A tube's shading: lit from the viewer, with a small highlight.
      float nz = sqrt(max(1.0 - r * r, 0.0));
      vec3 shaded = vColour * (0.3 + 0.7 * nz) + vec3(0.25) * pow(nz, 24.0);
      float fragDepth = gl_FragCoord.z;
      outColour = vec4(shaded, 1.0);
      ${writeRest}`,
    depth: `
      if (light < uDepthCut) discard;
      float fragDepth = uDepthNear ? 0.0 : gl_FragCoord.z;
      gl_FragDepth = fragDepth;
      outColour = vec4(0.0);
      ${writeRest}`,
  }[pass];
  return `#version 300 es
precision highp float;
uniform float uSharpness;
uniform float uGain;
uniform float uAbsorption;
uniform float uSlab;
uniform float uDepthCut;
uniform bool uDepthNear;
in vec3 vColour;
${points ? "in vec2 vCorner;" : "in float vAcross;"}
in float vSection;
in float vFade;
${outs.join("\n")}

void main() {
  float r = ${points ? "length(vCorner)" : "abs(vAcross)"};
  if (r >= 1.0) discard;
  // Luxar's cross-section: exp(-K r^beta), shifted and truncated so it is 1
  // on the centre line and reaches 0 at the edge (K = ln 100, a 1% floor).
  float beta = exp2(6.0 * uSharpness - 2.0);
  float light = max(exp(-4.605170186 * pow(r, beta)) - 0.01, 0.0) / 0.99;
  light *= vFade;
  if (uSlab > 0.0) {
    // In a 2-D view, lines fade with their distance from the section.
    float s = vSection / uSlab;
    if (abs(s) >= 1.0) discard;
    light *= max(exp(-4.605170186 * s * s) - 0.01, 0.0) / 0.99;
  }
  ${body}
}
`;
}

const COMPOSITE_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * The tone-mapping composite.  As `depth`, it writes depth instead of
 * colour: the nearest line's depth (from `uDepth`), only where the light
 * shown is at least `uCut`, so lines that show block what Neuroglancer draws
 * behind them afterwards (its sections) and faint glow does not.
 */
function compositeFragment(outputs: Outputs, depth: boolean): string {
  const outs = depth
    ? [
        `layout(location = ${outputs.color}) out vec4 outColour;`,
        outputs.z !== undefined ? `layout(location = ${outputs.z}) out highp vec4 outZ;` : "",
        outputs.pick !== undefined ? `layout(location = ${outputs.pick}) out highp vec4 outPick;` : "",
      ].join("\n")
    : `layout(location = ${outputs.color}) out vec4 outColour;`;
  const write = depth
    ? `
  if (shown.a < uCut) discard;
  float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy) - uOrigin, 0).r;
  if (d >= 1.0) discard;
  float fragDepth = uNear ? 0.0 : d;
  gl_FragDepth = fragDepth;
  outColour = vec4(0.0);
  ${outputs.z !== undefined ? "outZ = vec4(1.0 - fragDepth);" : ""}
  ${outputs.pick !== undefined ? "outPick = vec4(0.0);" : ""}`
    : "outColour = shown;";
  return `#version 300 es
precision highp float;
uniform highp sampler2D uLight;
uniform highp sampler2D uDepth;
uniform ivec2 uOrigin;
uniform int uToneMap;
uniform bool uEmission;
uniform float uCut;
uniform bool uNear;
${depth ? "" : "uniform highp sampler2D uBloom0;\nuniform highp sampler2D uBloom1;\nuniform highp sampler2D uBloom2;\nuniform float uBloom;"}
${outs}

// ACES filmic, Narkowicz's fit.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 tone(vec3 x) {
  if (uToneMap == 0) return aces(x);
  if (uToneMap == 3) {
    // The same curve on the brightest channel, the colour scaled with it:
    // where many lines add up the light stays their colour instead of
    // every channel reaching white.
    float m = max(x.r, max(x.g, x.b));
    return m > 0.0 ? x * (aces(vec3(m)).r / m) : vec3(0.0);
  }
  if (uToneMap == 1) return x / (1.0 + x);
  return clamp(x, 0.0, 1.0);
}

void main() {
  vec4 light = texelFetch(uLight, ivec2(gl_FragCoord.xy) - uOrigin, 0);
  // Bloom (./bloom.ts): the bright light blurred at three scales, added before tone mapping.
  vec3 bloom = vec3(0.0);
  ${
    depth
      ? ""
      : `if (uBloom > 0.0) {
    vec2 uv = (vec2(ivec2(gl_FragCoord.xy) - uOrigin) + 0.5) / vec2(textureSize(uLight, 0));
    bloom = uBloom * (texture(uBloom0, uv).rgb + texture(uBloom1, uv).rgb + texture(uBloom2, uv).rgb) / 3.0;
  }`
  }
  vec4 shown;
  if (uEmission) {
    // Emission and absorption, order-independent: the light emitted, each
    // part dimmed by the absorption of the rest (Luxar's self-screening
    // (1 - e^-tau) / tau), over what is behind, which shows through e^-tau.
    float tau = max(light.a, 0.0);
    float through = exp(-tau);
    float screen = tau < 1e-3 ? 1.0 - 0.5 * tau : (1.0 - through) / tau;
    vec3 c = tone(light.rgb * screen + bloom);
    shown = vec4(c, 1.0 - through);
    ${depth ? "shown.a = max(shown.a, max(c.r, max(c.g, c.b)));" : ""}
  } else {
    vec3 c = tone(light.rgb + bloom);
    shown = vec4(c, max(c.r, max(c.g, c.b)));
  }
  ${write}
}`;
}

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export class Renderer {
  private readonly programs = new Map<string, Program>();
  private emptyVao: WebGLVertexArrayObject | undefined;
  readonly floatTargets: boolean;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.floatTargets = gl.getExtension("EXT_color_buffer_float") !== null;
  }

  private compile(key: string, vs: string, fs: string): Program {
    let p = this.programs.get(key);
    if (p !== undefined) return p;
    const { gl } = this;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Luxar shader: ${gl.getShaderInfoLog(s) ?? "did not compile"}`);
      return s;
    };
    const program = gl.createProgram()!;
    const v = shader(gl.VERTEX_SHADER, vs);
    const f = shader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Luxar program: ${gl.getProgramInfoLog(program) ?? "did not link"}`);
    p = { program, uniforms: new Map() };
    this.programs.set(key, p);
    return p;
  }

  private uniform(p: Program, name: string): WebGLUniformLocation | null {
    let u = p.uniforms.get(name);
    if (u === undefined) {
      u = this.gl.getUniformLocation(p.program, name);
      p.uniforms.set(name, u);
    }
    return u;
  }

  /** Puts a built chunk on the GPU. */
  upload(chunk: BuiltChunk): GpuChunk {
    const { gl } = this;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const rows = chunk.vertices.length / 4 / TEXTURE_WIDTH;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXTURE_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, chunk.vertices);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const slots = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, slots);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, TEXTURE_WIDTH, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, chunk.slots);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const vao = gl.createVertexArray()!;
    let segments: WebGLBuffer | undefined;
    if (chunk.segmentCount > 0) {
      gl.bindVertexArray(vao);
      segments = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, segments);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.segments, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    let normals: WebGLTexture | undefined;
    let faces: WebGLBuffer | undefined;
    let meshVao: WebGLVertexArrayObject | undefined;
    let cutVao: WebGLVertexArrayObject | undefined;
    if (chunk.triangleCount > 0) {
      normals = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, normals);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEXTURE_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, chunk.normals);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      faces = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, faces);
      gl.bufferData(gl.ARRAY_BUFFER, chunk.triangles, gl.STATIC_DRAW);
      // 3-D: each index a vertex of a triangle.
      meshVao = gl.createVertexArray()!;
      gl.bindVertexArray(meshVao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 0, 0);
      // 2-D: each triangle an instance, cut by the section.
      cutVao = gl.createVertexArray()!;
      gl.bindVertexArray(cutVao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 3, gl.UNSIGNED_INT, 12, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    return {
      texture,
      segments,
      vao,
      segmentCount: chunk.segmentCount,
      pointCount: chunk.pointCount,
      bytes: chunk.vertices.byteLength + chunk.slots.byteLength + chunk.segmentCount * 16 + chunk.normals.byteLength + chunk.triangles.byteLength,
      length: chunk.length,
      slots,
      objectIds: chunk.objectIds,
      objectWeight: chunk.objectWeight,
      objects: undefined,
      tableVersion: -1,
      shown: 1,
      light: 1,
      lower: chunk.lower,
      upper: chunk.upper,
      pieces: chunk.pieces,
      triangleCount: chunk.triangleCount,
      area: chunk.area,
      normals,
      faces,
      meshVao,
      cutVao,
    };
  }

  /**
   * Makes a chunk's object table for what the layer shows now (when it
   * needs one), and sets the share of it shown.
   */
  shade(chunk: GpuChunk, shading: ObjectShading): void {
    if (chunk.tableVersion === shading.version) return;
    chunk.tableVersion = shading.version;
    if (!needsTable(shading)) {
      chunk.shown = chunk.light = 1;
      return;
    }
    const { gl } = this;
    const { table, rows, shown, light } = objectTable(chunk.objectIds, chunk.objectWeight, shading);
    chunk.shown = shown;
    chunk.light = light;
    chunk.objects ??= gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, chunk.objects);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEXTURE_WIDTH, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, table);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  release(chunk: GpuChunk): void {
    const { gl } = this;
    gl.deleteTexture(chunk.texture);
    gl.deleteTexture(chunk.slots);
    if (chunk.objects) gl.deleteTexture(chunk.objects);
    if (chunk.segments) gl.deleteBuffer(chunk.segments);
    gl.deleteVertexArray(chunk.vao);
    if (chunk.normals) gl.deleteTexture(chunk.normals);
    if (chunk.faces) gl.deleteBuffer(chunk.faces);
    if (chunk.meshVao) gl.deleteVertexArray(chunk.meshVao);
    if (chunk.cutVao) gl.deleteVertexArray(chunk.cutVao);
  }

  /**
   * Draws chunks in one pass. The caller sets the target, blending and
   * depth state.  A chunk cut into pieces of space (objects read whole)
   * draws only the pieces `visible` says can show, and of them the first
   * `samples` of SAMPLES samples of its objects.
   */
  draw(chunks: GpuChunk[], pass: Pass, outputs: Outputs, u: DrawUniforms, visible?: (lower: number[], upper: number[]) => boolean, samples = SAMPLES): void {
    const { gl } = this;
    // Lines, points, and a mesh's triangles: lit in 3-D, cut by the section in 2-D.
    for (const kind of ["lines", "points", "triangles"] as const) {
      const points = kind === "points";
      const count = (c: GpuChunk) => (kind === "lines" ? c.segmentCount : points ? c.pointCount : c.triangleCount);
      const some = chunks.filter((c) => count(c) > 0 && (!u.objectTable || (c.shown > 0 && c.objects !== undefined)));
      if (some.length === 0) continue;
      const cut = kind === "triangles" && u.slab > 0;
      const mesh = kind === "triangles" && !cut;
      const key = `${cut ? "cut" : kind}|${pass}|${outputs.color},${outputs.z},${outputs.pick}`;
      const vs = kind === "lines" ? LINE_VS : points ? POINT_VS : cut ? CUT_VS : MESH_VS;
      const p = this.compile(key, vs, mesh ? meshFragmentShader(pass, outputs) : fragment(points, pass, outputs));
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(this.uniform(p, "uModelToClip"), false, u.modelToClip);
      gl.uniformMatrix3fv(this.uniform(p, "uDirections"), false, u.directions);
      gl.uniform2f(this.uniform(p, "uViewport"), u.viewport[0], u.viewport[1]);
      // A point is drawn three line widths across: a dot as wide as a line is lost.
      gl.uniform1f(this.uniform(p, "uHalfWidth"), points ? 3 * u.halfWidth : u.halfWidth);
      // Points have no direction: each object its own colour instead.
      gl.uniform1i(this.uniform(p, "uColourBy"), points && u.colourBy === 0 ? 1 : u.colourBy);
      gl.uniform3fv(this.uniform(p, "uColour"), u.colour);
      gl.uniform1i(this.uniform(p, "uColormap"), u.colormap);
      gl.uniform2f(this.uniform(p, "uRange"), u.range[0], u.range[1]);
      gl.uniform4fv(this.uniform(p, "uPlane"), u.plane);
      gl.uniform1f(this.uniform(p, "uSlab"), u.slab);
      gl.uniform1f(this.uniform(p, "uSharpness"), u.sharpness);
      gl.uniform1f(this.uniform(p, "uGain"), u.gain);
      gl.uniform1f(this.uniform(p, "uAbsorption"), u.absorption);
      gl.uniform1f(this.uniform(p, "uDepthCut"), u.depthCut);
      gl.uniform1i(this.uniform(p, "uDepthNear"), u.depthNear ? 1 : 0);
      gl.uniform1i(this.uniform(p, "uVertices"), 0);
      gl.uniform1i(this.uniform(p, "uSlots"), 1);
      gl.uniform1i(this.uniform(p, "uObjects"), 2);
      gl.uniform1i(this.uniform(p, "uObjectTable"), u.objectTable ? 1 : 0);
      gl.uniform1i(this.uniform(p, "uOpaque"), pass === "solid" ? 1 : 0);
      gl.uniform1i(this.uniform(p, "uNormals"), 3);
      gl.uniform4fv(this.uniform(p, "uEye"), u.eye);
      if (mesh) {
        gl.uniform1i(this.uniform(p, "uFront"), 4);
        gl.uniform1f(this.uniform(p, "uFalloff"), u.front?.falloff ?? 0);
        if (u.front !== undefined) gl.uniformMatrix4fv(this.uniform(p, "uClipToModel"), false, u.front.clipToModel);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, u.front?.texture ?? null);
      }
      for (const chunk of some) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, chunk.normals ?? null);
        // Bound whether used or not: a sampler must not meet a texture of another kind left on its unit.
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, chunk.slots);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, chunk.objects ?? null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, chunk.texture);
        if (points) {
          this.emptyVao ??= gl.createVertexArray()!;
          gl.bindVertexArray(this.emptyVao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, chunk.pointCount);
        } else if (mesh) {
          gl.bindVertexArray(chunk.meshVao!);
          gl.drawArrays(gl.TRIANGLES, 0, 3 * chunk.triangleCount);
        } else if (cut) {
          gl.bindVertexArray(chunk.cutVao!);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, chunk.triangleCount);
        } else if (chunk.pieces !== undefined && chunk.segments !== undefined) {
          // Only the pieces that can show: each a run of the sorted segments, the attribute pointed at its start.
          gl.bindVertexArray(chunk.vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, chunk.segments);
          const { pieces } = chunk;
          const k = Math.max(1, Math.min(SAMPLES, Math.round(samples)));
          for (let i = 0; i + PIECE_STRIDE <= pieces.length; i += PIECE_STRIDE) {
            if (visible !== undefined && !visible([pieces[i + 2], pieces[i + 3], pieces[i + 4]], [pieces[i + 5], pieces[i + 6], pieces[i + 7]])) continue;
            // The first k samples of the objects: whole objects, the same ones in every piece.
            const n = pieces[i + 7 + k];
            if (n === 0) continue;
            gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, 0, pieces[i] * 16);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
          }
          gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
        } else {
          gl.bindVertexArray(chunk.vao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, chunk.segmentCount);
        }
      }
      gl.bindVertexArray(null);
      for (const unit of [gl.TEXTURE4, gl.TEXTURE3, gl.TEXTURE2, gl.TEXTURE1]) {
        gl.activeTexture(unit);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /** Tone maps the light in `texture` onto the bound target (the caller sets blending). */
  composite(
    texture: WebGLTexture,
    outputs: Outputs,
    options: {
      toneMap: number;
      emission: boolean;
      origin: [number, number];
      depth?: { texture: WebGLTexture; cut: number; near: boolean };
      /** Bloom's blurred light (bloom.ts), finest first, and how much of it to add. */
      bloom?: { textures: WebGLTexture[]; amount: number };
    },
  ): void {
    const { gl } = this;
    const depth = options.depth;
    const p = this.compile(`composite|${depth ? "depth" : "colour"}|${outputs.color},${outputs.z},${outputs.pick}`, COMPOSITE_VS, compositeFragment(outputs, depth !== undefined));
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uniform(p, "uLight"), 0);
    if (depth) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, depth.texture);
      gl.uniform1i(this.uniform(p, "uDepth"), 1);
      gl.uniform1f(this.uniform(p, "uCut"), depth.cut);
      gl.uniform1i(this.uniform(p, "uNear"), depth.near ? 1 : 0);
    }
    if (!depth) {
      // Bound whether used or not (no other kind of texture left on a sampler's unit).
      const bloom = options.bloom;
      for (let i = 0; i < 3; ++i) {
        gl.activeTexture(gl.TEXTURE1 + i);
        gl.bindTexture(gl.TEXTURE_2D, bloom?.textures[i] ?? null);
        gl.uniform1i(this.uniform(p, `uBloom${i}`), 1 + i);
      }
      gl.uniform1f(this.uniform(p, "uBloom"), bloom !== undefined && bloom.textures.length >= 3 ? bloom.amount : 0);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniform2i(this.uniform(p, "uOrigin"), options.origin[0], options.origin[1]);
    gl.uniform1i(this.uniform(p, "uToneMap"), options.toneMap);
    gl.uniform1i(this.uniform(p, "uEmission"), options.emission ? 1 : 0);
    this.emptyVao ??= gl.createVertexArray()!;
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (depth) {
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    } else {
      for (let i = 3; i >= 1; --i) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Draws a full-screen triangle with a program of its own (bloom's passes):
   * `textures` on units 0, 1, … by sampler name, `ints` as ivec2 uniforms.
   */
  fullScreen(key: string, vs: string, fs: string, textures: Record<string, WebGLTexture>, ints: Record<string, [number, number]> = {}, floats: Record<string, number> = {}): void {
    const { gl } = this;
    const p = this.compile(key, vs, fs);
    gl.useProgram(p.program);
    const names = Object.keys(textures);
    names.forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[name]);
      gl.uniform1i(this.uniform(p, name), i);
    });
    for (const [name, v] of Object.entries(ints)) gl.uniform2i(this.uniform(p, name), v[0], v[1]);
    for (const [name, v] of Object.entries(floats)) gl.uniform1f(this.uniform(p, name), v);
    this.emptyVao ??= gl.createVertexArray()!;
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    for (let i = names.length - 1; i >= 0; --i) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  dispose(): void {
    for (const p of this.programs.values()) this.gl.deleteProgram(p.program);
    this.programs.clear();
    if (this.emptyVao) this.gl.deleteVertexArray(this.emptyVao);
    this.emptyVao = undefined;
  }
}

/** A float target to add light up in, sized to a view, optionally sharing a depth buffer. */
export class LightTarget {
  framebuffer: WebGLFramebuffer | undefined;
  texture: WebGLTexture | undefined;
  private size: [number, number] = [0, 0];
  private depth: WebGLRenderbuffer | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly float: boolean,
  ) {}

  /** Binds it, (re)made at this size and with this depth buffer; false when it cannot be made complete. */
  bind(width: number, height: number, depth: WebGLRenderbuffer | null): boolean {
    const { gl } = this;
    if (this.framebuffer === undefined || this.size[0] !== width || this.size[1] !== height) {
      this.release();
      this.texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      this.size = [width, height];
      this.depth = null;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    }
    if (depth !== this.depth) {
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
      this.depth = depth;
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  }

  release(): void {
    const { gl } = this;
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.texture) gl.deleteTexture(this.texture);
    this.framebuffer = this.texture = undefined;
    this.depth = null;
    this.size = [0, 0];
  }
}

/** A depth texture (no colour) for the nearest line at each pixel. */
export class DepthTarget {
  framebuffer: WebGLFramebuffer | undefined;
  texture: WebGLTexture | undefined;
  private size: [number, number] = [0, 0];

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** Binds it at this size, cleared to the far plane; false when it cannot be made complete. */
  bind(width: number, height: number): boolean {
    const { gl } = this;
    if (this.framebuffer === undefined || this.size[0] !== width || this.size[1] !== height) {
      this.release();
      this.texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.texture, 0);
      this.size = [width, height];
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.drawBuffers([gl.NONE]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    return true;
  }

  release(): void {
    const { gl } = this;
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    if (this.texture) gl.deleteTexture(this.texture);
    this.framebuffer = this.texture = undefined;
    this.size = [0, 0];
  }
}
