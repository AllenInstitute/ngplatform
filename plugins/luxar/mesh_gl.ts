/**
 * A mesh drawn in Luxar's style (render_gl.ts draws with these shaders).
 *
 * In 3-D each triangle is drawn lit, by a light at the eye: its colour (the
 * layer's colour, colormap, segment colour, or its normal's direction)
 * times how squarely it faces the viewer, with a rim where it turns away.
 * *Glow* adds that light up in the layer's float target, as lines do, so a
 * surface reads as a lit, glowing shell and lines and splats composite
 * with it; *emission and absorption* also absorbs, more where the surface is
 * seen edge on (a longer path through it), so a dense fold darkens what is
 * behind; *solid* draws it opaque, lit, with a highlight, into the view.
 *
 * In a 2-D view each triangle the section cuts is drawn as the segment
 * where it crosses the section (as Neuroglancer draws a mesh there), widened
 * to the layer's width with the line's cross-section, so a surface shows as
 * its glowing outline.
 */
import { TEXTURE_WIDTH } from "./chunk_build.js";
import type { Outputs, Pass } from "./render_gl.js";

/** The 3-D vertex shader: one vertex of a triangle per index (`aVertex`, from the chunk's triangles). */
export function meshVertexShader(common: string): string {
  return `#version 300 es
precision highp float;
precision highp int;
${common}
uniform highp sampler2D uNormals;
// The eye in store coordinates: a point (w = 1) or, for a view from far away, a direction (w = 0).
uniform vec4 uEye;
layout(location = 0) in uint aVertex;
out vec3 vColour;
out vec3 vNormal;
out vec3 vToEye;
out float vWeight;

void main() {
  vec4 object = objectAt(aVertex);
  vColour = vec3(0.0);
  vNormal = vec3(0.0, 0.0, 1.0);
  vToEye = vec3(0.0, 0.0, 1.0);
  // How strongly the object is drawn (the layer's notSelectedAlpha for one not chosen).
  vWeight = object.a;
  if (hidden(object)) {
    // A hidden object's triangles shrink to a point outside the view.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 v = vertexAt(aVertex);
  vec3 n = texelFetch(uNormals, ivec2(int(aVertex % ${TEXTURE_WIDTH}u), int(aVertex / ${TEXTURE_WIDTH}u)), 0).xyz;
  gl_Position = uModelToClip * vec4(v.xyz, 1.0);
  vNormal = n;
  vToEye = uEye.w > 0.5 ? uEye.xyz - v.xyz : uEye.xyz;
  vColour = colourAt(v, n, object.rgb);
}
`;
}

/** The 3-D fragment shader for a pass: light added up, opaque and lit, or depth. */
export function meshFragmentShader(pass: Pass, outputs: Outputs): string {
  const outs: string[] = [`layout(location = ${outputs.color}) out vec4 outColour;`];
  if (outputs.z !== undefined) outs.push(`layout(location = ${outputs.z}) out highp vec4 outZ;`);
  if (outputs.pick !== undefined) outs.push(`layout(location = ${outputs.pick}) out highp vec4 outPick;`);
  const writeRest = `${outputs.z !== undefined ? "outZ = vec4(1.0 - fragDepth);" : ""}${outputs.pick !== undefined ? "outPick = vec4(0.0);" : ""}`;
  const body = {
    accumulate: `
      // Lit from the eye, with a rim where the surface turns away: a glowing shell.
      float light = 0.2 + 0.6 * facing + 0.6 * pow(1.0 - facing, 3.0);
      float fragDepth = gl_FragCoord.z;
      // Seen edge on, the path through the surface is longer: it absorbs more.
      outColour = vec4(vColour * (light * uGain), uAbsorption / max(facing, 0.2)) * vWeight;
      ${writeRest}`,
    solid: `
      vec3 shaded = vColour * (0.25 + 0.75 * facing) + vec3(0.2) * pow(facing, 24.0);
      float fragDepth = gl_FragCoord.z;
      outColour = vec4(shaded, 1.0);
      ${writeRest}`,
    depth: `
      // A faint surface does not keep what is behind it from showing.
      if (vWeight < 0.5) discard;
      float fragDepth = uDepthNear ? 0.0 : gl_FragCoord.z;
      gl_FragDepth = fragDepth;
      outColour = vec4(0.0);
      ${writeRest}`,
  }[pass];
  return `#version 300 es
precision highp float;
uniform float uGain;
uniform float uAbsorption;
uniform bool uDepthNear;
in vec3 vColour;
in vec3 vNormal;
in vec3 vToEye;
in float vWeight;
${outs.join("\n")}

void main() {
  vec3 n = length(vNormal) > 0.0 ? normalize(vNormal) : vec3(0.0, 0.0, 1.0);
  vec3 e = length(vToEye) > 0.0 ? normalize(vToEye) : vec3(0.0, 0.0, 1.0);
  // Either side faces the light at the eye.
  float facing = abs(dot(n, e));
  ${body}
}
`;
}

/**
 * The 2-D vertex shader: one quad per triangle (`aFace`, instanced), along
 * the segment where it crosses the section; nothing when it does not.  The
 * line fragment shader draws it (its cross-section, its fade).
 */
export function cutVertexShader(common: string): string {
  return `#version 300 es
precision highp float;
precision highp int;
${common}
layout(location = 0) in uvec3 aFace;
out vec3 vColour;
out float vAcross;
out float vSection;
out float vFade;

void hide() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColour = vec3(0.0);
  vAcross = 0.0;
  vSection = 0.0;
  vFade = 0.0;
}

// Where the edge from a to b crosses the section, if it does.
bool crossing(vec4 a, vec4 b, float da, float db, out vec4 p) {
  if ((da < 0.0) == (db < 0.0) || da == db) return false;
  p = mix(a, b, da / (da - db));
  return true;
}

void main() {
  vec4 object = objectAt(aFace.x);
  if (hidden(object)) {
    hide();
    return;
  }
  vec4 A = vertexAt(aFace.x);
  vec4 B = vertexAt(aFace.y);
  vec4 C = vertexAt(aFace.z);
  float dA = sectionDistance(A.xyz);
  float dB = sectionDistance(B.xyz);
  float dC = sectionDistance(C.xyz);
  vec4 p0 = vec4(0.0);
  vec4 p1 = vec4(0.0);
  vec4 q;
  int k = 0;
  if (crossing(A, B, dA, dB, q)) { p0 = q; k = 1; }
  if (crossing(B, C, dB, dC, q)) { if (k == 0) p0 = q; else p1 = q; ++k; }
  if (k < 2 && crossing(C, A, dC, dA, q)) { if (k == 0) p0 = q; else p1 = q; ++k; }
  if (k < 2) {
    hide();
    return;
  }
  bool atEnd = gl_VertexID >= 2;
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec4 c0 = uModelToClip * vec4(p0.xyz, 1.0);
  vec4 c1 = uModelToClip * vec4(p1.xyz, 1.0);
  vec2 s0 = c0.xy / c0.w * 0.5 * uViewport;
  vec2 s1 = c1.xy / c1.w * 0.5 * uViewport;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float halfWidth = max(uHalfWidth, 0.75);
  vFade = uHalfWidth / halfWidth * object.a;
  vec4 c = atEnd ? c1 : c0;
  c.xy += normal * side * halfWidth / (0.5 * uViewport) * c.w;
  gl_Position = c;
  vAcross = side;
  vSection = 0.0;
  vColour = colourAt(atEnd ? p1 : p0, cross(B.xyz - A.xyz, C.xyz - A.xyz), object.rgb);
}
`;
}
