/**
 * The surfaces' GLSL (geometry/live_geometry.ts) against the CPU reference,
 * on a GPU: a scene of a triangle mesh (a sphere), spheres and round cones,
 * one object hidden and one layer cut by a plane, traced a ray a pixel by a
 * fragment shader that writes each ray's hit (t, primitive) to a float
 * target; every pixel compared with a brute-force trace on the CPU (every
 * primitive tried, the same clipping and hiding).
 *
 *   npm run e2e:geometry      (vite-node; Playwright's or CHROME's Chromium, SwiftShader)
 */
import { createRequire } from "node:module";
import { geoData, geoLayout, geometryGlsl } from "../geometry/live_geometry.ts";
import { CONE, primHit, SPHERE, TRIANGLE } from "../geometry/lbvh.ts";
import { packNormal } from "../geometry/primitives.ts";
import { buildSurfaces } from "../geometry/surfaces.ts";

const require = createRequire(import.meta.url);
// Playwright is not a dependency of the app (no types here): what this script uses of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chromium: any;
try {
  ({ chromium } = require("playwright"));
} catch {
  // A global install, reached through NODE_PATH (as tests/e2e/smoke.mjs finds it).
  ({ chromium } = require("playwright-core"));
}

// ----------------------------------------------------------------- the scene (geometry space)
const prims: number[] = [];
const kinds: number[] = [];
const objects: number[] = [];
// A sphere of triangles (object 0, layer 0), radius 0.6 about (-0.4, 0, 0).
const N = 24;
const at = (i: number, j: number) => {
  const th = (Math.PI * i) / N, ph = (2 * Math.PI * j) / (2 * N);
  return [-0.4 + 0.6 * Math.sin(th) * Math.cos(ph), 0.6 * Math.sin(th) * Math.sin(ph), 0.6 * Math.cos(th)];
};
for (let i = 0; i < N; ++i)
  for (let j = 0; j < 2 * N; ++j) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    for (const t of [[a, b, c], [a, c, d]]) {
      prims.push(...t.flat());
      kinds.push(TRIANGLE);
      objects.push(0);
    }
  }
// Spheres (object 1, layer 1: cut by a plane), and one hidden (object 3).
for (let k = 0; k < 30; ++k) {
  const x = 0.3 + 0.08 * (k % 6), y = -0.5 + 0.2 * Math.floor(k / 6);
  prims.push(x, y, 0.1 * Math.sin(k), 0.07, 0, 0, 0, 0, 0);
  kinds.push(SPHERE);
  objects.push(k === 7 ? 3 : 1);
}
// Round cones (object 2, layer 0).
for (let k = 0; k < 20; ++k) {
  const y = -0.9 + 0.09 * k;
  prims.push(-0.9, y, -0.2, 0.02, 0.9, y + 0.3, 0.3, 0.035, 0);
  kinds.push(CONE);
  objects.push(2);
}
const n = kinds.length;
const s = buildSurfaces({ prims: new Float32Array(prims), objects: new Int32Array(objects), normals: new Uint32Array(4 * n).fill(packNormal(0, 0, 1)) }, 4, new Int32Array(kinds));
// Objects: colour, and layer + 1 (0: hidden).
const colours = new Float32Array([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 1, 1, 1, 1, 0]);
// Layer 1 cut: keep x <= 0.55 (the plane -x + 0.55 >= 0), in world coordinates.
// World is geometry scaled by 2 (geoFromWorld halves), so the cut is at world x 1.1.
const clip = [-1, 0, 0, 1.1];
const W = 256;

// ----------------------------------------------------------------- the CPU's answer
const SIZE = 96;
function ray(px: number, py: number): { o: number[]; d: number[] } {
  // World rays: from z = -6, along +z with a slight tilt, over x, y in -2.4..2.4.
  const x = ((px + 0.5) / SIZE) * 4.8 - 2.4, y = ((py + 0.5) / SIZE) * 4.8 - 2.4;
  const d = [0.05 * x, 0.03, 1];
  const l = Math.hypot(...d);
  return { o: [x, y, -6], d: d.map((v) => v / l) };
}
function expected(px: number, py: number): { t: number; prim: number } {
  const { o, d } = ray(px, py);
  // Geometry space: halve.
  const og = o.map((v) => v / 2) as [number, number, number], dg = d.map((v) => v / 2) as [number, number, number];
  let best = 1e30, hit = -1;
  for (let i = 0; i < s.bvh.n; ++i) {
    const t = primHit(s.bvh, i, og, dg);
    if (!(t > 0 && t < best)) continue;
    const obj = s.bvh.objects[i], layer = colours[4 * obj + 3];
    if (layer < 0.5) continue;
    const w = o.map((v, a) => v + d[a] * t);
    if (layer === 2 && clip[0] * w[0] + clip[1] * w[1] + clip[2] * w[2] + clip[3] < 0) continue;
    best = t;
    hit = i;
  }
  return hit < 0 ? { t: -1, prim: -1 } : { t: best, prim: hit };
}

// ----------------------------------------------------------------- the GPU's
const fs = `#version 300 es
precision highp float;
precision highp int;
${geometryGlsl(W, 6)}
out vec4 o;
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float x = ((p.x + 0.5) / ${SIZE}.0) * 4.8 - 2.4, y = ((p.y + 0.5) / ${SIZE}.0) * 4.8 - 2.4;
  vec3 d = normalize(vec3(0.05 * x, 0.03, 1.0));
  int prim;
  vec2 uv;
  float t = geoHit(vec3(x, y, -6.0), d, 0.0, 1e30, prim, uv);
  bool any_ = geoAny(vec3(x, y, -6.0), d, 0.0, 1e30);
  o = vec4(t, float(prim), any_ ? 1.0 : 0.0, 0.0);
}`;
const layout = geoLayout(s, W);
const data = Array.from(geoData(s, W));
data.splice(4 * layout.objAt, colours.length, ...colours);

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? (require("node:fs").existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
interface Args { fs: string; data: number[]; rows: number; normals: number[]; nodeAt: number; objAt: number; n: number; W: number; SIZE: number; clip: number[] }
const result: { error?: string | null; out?: number[] } = await page.evaluate(
  ({ fs, data, rows, normals, nodeAt, objAt, n, W, SIZE, clip }: Args) => {
    const gl = document.createElement("canvas").getContext("webgl2")!;
    if (!gl.getExtension("EXT_color_buffer_float")) return { error: "no float targets" };
    const sh = (type: number, src: string) => {
      const x = gl.createShader(type)!;
      gl.shaderSource(x, src);
      gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? "");
      return x;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2))*2.0-1.0;gl_Position=vec4(p,0.0,1.0);}"));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(p) };
    gl.useProgram(p);
    const tex = (unit: number, internal: number, format: number, type: number, h: number, values: ArrayBufferView) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, W, h, 0, format, type, values);
    };
    tex(0, gl.RGBA32F, gl.RGBA, gl.FLOAT, rows, new Float32Array(data));
    const nrows = Math.ceil(n / W);
    const norm = new Uint32Array(nrows * W * 4);
    norm.set(normals);
    tex(1, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, nrows, norm);
    const u = (k: string) => gl.getUniformLocation(p, k);
    gl.uniform1i(u("uGeoData"), 0);
    gl.uniform1i(u("uGeoNorm"), 1);
    gl.uniform1i(u("uGeoN"), n);
    gl.uniform1i(u("uGeoNodeAt"), nodeAt);
    gl.uniform1i(u("uGeoObjAt"), objAt);
    // World to geometry: halve (column-major).
    gl.uniformMatrix4fv(u("uGeoFromWorld"), false, [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]);
    const clips = new Float32Array(4 * 6 * 4);
    clips.set(clip, 4 * 6 * 1);
    gl.uniform4fv(u("uGeoClips"), clips);
    gl.uniform1iv(u("uGeoNClip"), [0, 1, 0, 0]);
    gl.uniform3fv(u("uGeoCropLo"), new Float32Array(12).fill(-1e30));
    gl.uniform3fv(u("uGeoCropHi"), new Float32Array(12).fill(1e30));
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SIZE, SIZE, 0, gl.RGBA, gl.FLOAT, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, SIZE, SIZE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Float32Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.FLOAT, out);
    return { out: Array.from(out) };
  },
  { fs, data, rows: layout.rows, normals: Array.from(s.normals), nodeAt: layout.nodeAt, objAt: layout.objAt, n: s.bvh.n, W, SIZE, clip },
);
await browser.close();
if (result.error !== undefined || result.out === undefined) {
  console.error(`FAIL ${result.error}`);
  process.exit(1);
}

let agree = 0, hits = 0, sameT = 0, anyAgree = 0, clipped = 0, hidden = 0;
const out = result.out!;
for (let py = 0; py < SIZE; ++py)
  for (let px = 0; px < SIZE; ++px) {
    const g = out.slice(4 * (py * SIZE + px), 4 * (py * SIZE + px) + 4);
    const want = expected(px, py);
    const gotHit = g[0] > 0;
    if (gotHit === want.t > 0) agree++;
    if ((g[2] > 0.5) === want.t > 0) anyAgree++;
    if (want.t > 0) {
      hits++;
      if (gotHit && Math.abs(g[0] - want.t) < 1e-3 * Math.max(1, want.t)) sameT++;
    }
    if (gotHit) {
      const obj = s.bvh.objects[g[1]];
      if (obj === 3) hidden++;
      const { o, d } = ray(px, py);
      if (obj === 1 && -(o[0] + d[0] * g[0]) + 1.1 < -1e-4) clipped++;
    }
  }
const total = SIZE * SIZE;
const checks: [boolean, string][] = [
  [hits > total * 0.2, `the scene is met by ${hits} of ${total} rays`],
  [agree / total > 0.998, `hit or miss as the CPU: ${agree} of ${total}`],
  [sameT / hits > 0.995, `the same distance where both hit: ${sameT} of ${hits}`],
  [anyAgree / total > 0.998, `a shadow ray (any hit) as the CPU: ${anyAgree} of ${total}`],
  [hidden === 0, `nothing hit of the hidden object (${hidden})`],
  [clipped === 0, `nothing hit beyond the cut (${clipped})`],
];
let failed = 0;
for (const [ok, what] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
