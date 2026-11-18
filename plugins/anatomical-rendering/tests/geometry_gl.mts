/**
 * The surfaces' GLSL (geometry/live_geometry.ts) against the CPU reference,
 * on a GPU: a scene of a triangle mesh (a sphere), spheres and round cones,
 * one object hidden and one layer cut by a plane, traced a ray a pixel by a
 * fragment shader that writes each ray's hit (t, primitive) to a float
 * target; every pixel compared with a brute-force trace on the CPU (every
 * primitive tried, the same clipping and hiding).
 *
 * The same again for the WebGPU path tracer's WGSL (local/geometry.wgsl),
 * a compute shader writing each ray's hit to a storage buffer.
 *
 *   npm run e2e:geometry      (vite-node; Playwright's or CHROME's Chromium, SwiftShader)
 */
import { createRequire } from "node:module";
import { geoData, geoLayout, geometryGlsl } from "../geometry/live_geometry.ts";
import { CONE, SPHERE, TRIANGLE } from "../geometry/lbvh.ts";
import { NO_NORMAL, orientOutward, type Primitives } from "../geometry/primitives.ts";
import { buildBlock, packSurfaces, surfaceHit } from "../geometry/surfaces.ts";
import { geometryBuffer, geometryParams } from "../local/local_geometry.ts";

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
// Indexed (each primitive its own vertices), in two blocks under a top tree.
function indexed(from: number, to: number): Primitives {
  const v: number[] = [], index: number[] = [];
  const bits = new Float32Array(new Uint32Array([NO_NORMAL]).buffer)[0];
  for (let i = from; i < to; ++i) {
    const q = prims.slice(9 * i, 9 * i + 9), at = v.length / 4;
    if (kinds[i] === TRIANGLE) {
      v.push(...q.slice(0, 3), bits, ...q.slice(3, 6), bits, ...q.slice(6, 9), bits);
      index.push(at, at + 1, at + 2);
    } else if (kinds[i] === CONE) {
      v.push(...q.slice(0, 8));
      index.push(at, at + 1, at + 1);
    } else {
      v.push(...q.slice(0, 4));
      index.push(at, at, at);
    }
  }
  const out = { vertices: new Float32Array(v), index: new Uint32Array(index), objects: new Int32Array(objects.slice(from, to)), kinds: new Int32Array(kinds.slice(from, to)) };
  // Wound outward, as meshes are (the sphere of triangles; the others' volumes are none).
  orientOutward(out.vertices, out.index, out.objects, to - from);
  return out;
}
const half = n >> 1;
const s = packSurfaces([{ block: buildBlock(indexed(0, half), 4), objectBase: 0 }, { block: buildBlock(indexed(half, n), 4), objectBase: 0 }], 4);
const objectOf = (i: number) => s.prims[4 * i + 3] & 0x3fffffff;
// Objects: colour, and layer + 1 (0: hidden).
const colours = new Float32Array([1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 1, 1, 1, 1, 0]);
// Layer 1 cut: keep x <= 0.55 (the plane -x + 0.55 >= 0), in world coordinates.
// World is geometry scaled by 2 (geoFromWorld halves), so the cut is at world x 1.1.
const clip = [-1, 0, 0, 1.1];
// Capped cuts: layers 0 and 1 cut to world z >= 0.1 (the spheres' fronts away), closed; the cones (which overlap
// the sphere of triangles: a solid inside another is not closed) hidden.
const capClip = [0, 0, 1, -0.1];
const capColours = new Float32Array(colours);
capColours[4 * 2 + 3] = 0;
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
function expected(px: number, py: number, layers = [1, 2]): { t: number; prim: number } {
  const { o, d } = ray(px, py);
  // Geometry space: halve.
  const og = o.map((v) => v / 2) as [number, number, number], dg = d.map((v) => v / 2) as [number, number, number];
  let best = 1e30, hit = -1;
  for (let i = 0; i < s.n; ++i) {
    const t = surfaceHit(s, i, og, dg);
    if (!(t > 0 && t < best)) continue;
    const obj = objectOf(i), layer = colours[4 * obj + 3];
    if (layer < 0.5 || !layers.includes(layer)) continue;
    const w = o.map((v, a) => v + d[a] * t);
    if (layer === 2 && clip[0] * w[0] + clip[1] * w[1] + clip[2] * w[2] + clip[3] < 0) continue;
    best = t;
    hit = i;
  }
  return hit < 0 ? { t: -1, prim: -1 } : { t: best, prim: hit };
}

/** With capped cuts: the cut's t where the ray crosses it inside a solid (the sphere of triangles, a sphere), else the nearest kept hit. */
function expectedCap(px: number, py: number): number {
  const { o, d } = ray(px, py);
  const te = (0.1 - o[2]) / d[2];
  const p = o.map((v, a) => v + d[a] * te);
  // World: geometry doubled. The sphere of triangles (object 0) and the shown spheres (object 1).
  let inside = Math.hypot(p[0] + 0.8, p[1], p[2]) < 1.2 * 0.995;
  for (let i = 0; i < s.n && !inside; ++i) {
    if (s.prims[4 * i + 3] >>> 30 !== SPHERE || objectOf(i) !== 1) continue;
    const c = s.vertices.subarray(4 * s.prims[4 * i], 4 * s.prims[4 * i] + 4);
    inside = Math.hypot(p[0] - 2 * c[0], p[1] - 2 * c[1], p[2] - 2 * c[2]) < 2 * c[3];
  }
  if (inside) return te;
  const og = o.map((v) => v / 2) as [number, number, number], dg = d.map((v) => v / 2) as [number, number, number];
  let best = 1e30;
  for (let i = 0; i < s.n; ++i) {
    const t = surfaceHit(s, i, og, dg);
    if (!(t > 0 && t < best)) continue;
    if (capColours[4 * objectOf(i) + 3] < 0.5) continue;
    if (o[2] + d[2] * t < 0.1) continue;
    best = t;
  }
  return best < 1e30 ? best : -1;
}
function reportCap(name: string, out: number[]): void {
  let agree = 0, caps = 0;
  for (let py = 0; py < SIZE; ++py)
    for (let px = 0; px < SIZE; ++px) {
      const g = out[4 * (py * SIZE + px)];
      const want = expectedCap(px, py);
      const { o, d } = ray(px, py);
      if (want > 0 && Math.abs(want - (0.1 - o[2]) / d[2]) < 1e-9) caps++;
      if ((g > 0) === want > 0 && (want < 0 || Math.abs(g - want) < 1e-3 * Math.max(1, want))) agree++;
    }
  const total = SIZE * SIZE;
  for (const [ok, what] of [
    [caps > total * 0.05, `the cut crosses solids at ${caps} of ${total} rays`],
    [agree / total > 0.99, `capped cuts as the CPU: ${agree} of ${total}`],
  ] as [boolean, string][]) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${what}`);
    if (!ok) failed++;
  }
}

// ----------------------------------------------------------------- the GPU's
const fs = `#version 300 es
precision highp float;
precision highp int;
${geometryGlsl(W, 6)}
out vec4 o;
uniform bool uSolid;
void main() {
  geoSolid = uSolid;
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
const capData = data.slice();
// The objects' colours and layers, as float bits.
data.splice(4 * layout.objAt, colours.length, ...new Uint32Array(colours.buffer));
capData.splice(4 * layout.objAt, capColours.length, ...new Uint32Array(capColours.buffer));

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? (require("node:fs").existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
interface Args { fs: string; data: number[]; capData: number[]; rows: number; primAt: number; nodeAt: number; objAt: number; root: number; n: number; W: number; SIZE: number; clip: number[]; capClip: number[] }
const result: { error?: string | null; out?: number[]; seen?: number[]; solid?: number[]; capped?: number[] } = await page.evaluate(
  ({ fs, data, capData, rows, primAt, nodeAt, objAt, root, n, W, SIZE, clip, capClip }: Args) => {
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
    tex(0, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, rows, new Uint32Array(data));
    const u = (k: string) => gl.getUniformLocation(p, k);
    gl.uniform1i(u("uGeo"), 0);
    gl.uniform1i(u("uGeoN"), n);
    gl.uniform1i(u("uGeoRoot"), root);
    gl.uniform1i(u("uGeoPrimAt"), primAt);
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
    // The target on a unit of its own (not the data's).
    gl.activeTexture(gl.TEXTURE0 + 7);
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SIZE, SIZE, 0, gl.RGBA, gl.FLOAT, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.viewport(0, 0, SIZE, SIZE);
    // Per layer: roughness, specular, emission, opacity.
    const render = (opacity: number[], solid = false) => {
      gl.uniform1i(u("uSolid"), solid ? 1 : 0);
      gl.uniform4fv(u("uGeoMat"), new Float32Array(opacity.flatMap((a) => [0.5, 0.1, 0, a])));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const out = new Float32Array(SIZE * SIZE * 4);
      gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.FLOAT, out);
      return Array.from(out);
    };
    // All opaque; then layer 0 clear and layer 1 half opaque.
    const out = render([1, 1, 1, 1]), seen = render([0, 0.5, 1, 1]), solid = render([0, 0.5, 1, 1], true);
    // Capped cuts on layers 0 and 1.
    tex(0, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, rows, new Uint32Array(capData));
    clips.fill(0);
    clips.set(capClip, 0);
    clips.set(capClip, 4 * 6);
    gl.uniform4fv(u("uGeoClips"), clips);
    gl.uniform1iv(u("uGeoNClip"), [257, 257, 0, 0]);
    gl.activeTexture(gl.TEXTURE0 + 7);
    const capped = render([1, 1, 1, 1]);
    return { out, seen, solid, capped };
  },
  { fs, data, capData, rows: layout.rows, primAt: layout.primAt, nodeAt: layout.nodeAt, objAt: layout.objAt, root: s.root, n: s.n, W, SIZE, clip, capClip },
);
await browser.close();
if (result.error !== undefined || result.out === undefined) {
  console.error(`FAIL ${result.error}`);
  process.exit(1);
}

let failed = 0;
/** Each ray's (t, primitive, any hit) as the GPU found them, all opaque (`out`) and layer 0 clear, layer 1 half opaque (`seen`), against the CPU's. */
function report(name: string, out: number[], seen: number[], solid: number[]): void {
  let agree = 0, hits = 0, sameT = 0, anyAgree = 0, clipped = 0, hidden = 0;
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
        const obj = objectOf(g[1]);
        if (obj === 3) hidden++;
        const { o, d } = ray(px, py);
        if (obj === 1 && -(o[0] + d[0] * g[0]) + 1.1 < -1e-4) clipped++;
      }
    }
  // Layer 0 clear and layer 1 (the spheres) half opaque: nothing of layer 0, nothing nearer than the CPU's nearest
  // sphere, and the spheres met by about half the rays that reach one (more where a ray passes several).
  let ofClear = 0, nearer = 0, reach = 0, stopped = 0;
  for (let py = 0; py < SIZE; ++py)
    for (let px = 0; px < SIZE; ++px) {
      const g = seen.slice(4 * (py * SIZE + px), 4 * (py * SIZE + px) + 4);
      const want = expected(px, py, [2]);
      if (g[0] > 0) {
        const obj = objectOf(g[1]);
        if (obj === 0 || obj === 2) ofClear++;
        if (want.t < 0 || g[0] < want.t * (1 - 1e-3)) nearer++;
      }
      if (want.t > 0) {
        reach++;
        if (g[0] > 0) stopped++;
      }
    }
  // Met as solid (a camera's ray): the half-opaque layer every time, the clear one never: as the CPU without layer 0.
  let solidAgree = 0;
  for (let py = 0; py < SIZE; ++py)
    for (let px = 0; px < SIZE; ++px) {
      const g = solid.slice(4 * (py * SIZE + px), 4 * (py * SIZE + px) + 4);
      const want = expected(px, py, [2]);
      if ((g[0] > 0) === want.t > 0 && (want.t < 0 || Math.abs(g[0] - want.t) < 1e-3 * Math.max(1, want.t))) solidAgree++;
    }
  const total = SIZE * SIZE;
  const checks: [boolean, string][] = [
    [hits > total * 0.2, `the scene is met by ${hits} of ${total} rays`],
    [agree / total > 0.998, `hit or miss as the CPU: ${agree} of ${total}`],
    [sameT / hits > 0.995, `the same distance where both hit: ${sameT} of ${hits}`],
    [anyAgree / total > 0.998, `a shadow ray (any hit) as the CPU: ${anyAgree} of ${total}`],
    [hidden === 0, `nothing hit of the hidden object (${hidden})`],
    [clipped === 0, `nothing hit beyond the cut (${clipped})`],
    [ofClear === 0 && nearer === 0, `a clear layer is passed, and nothing met before the half-opaque one (${ofClear}, ${nearer})`],
    [reach > 100 && stopped / reach > 0.4 && stopped / reach < 0.85, `a half-opaque layer stops ${stopped} of the ${reach} rays reaching it`],
    [solidAgree / total > 0.998, `met as solid, the half-opaque layer where the CPU meets it: ${solidAgree} of ${total}`],
  ];
  for (const [ok, what] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${what}`);
    if (!ok) failed++;
  }
}
report("WebGL", result.out!, result.seen!, result.solid!);
reportCap("WebGL", result.capped!);

// ----------------------------------------------------------------- the WebGPU tracer's WGSL
const wgsl = require("node:fs").readFileSync(new URL("../local/geometry.wgsl", import.meta.url), "utf8") as string;
const cs = `${wgsl}
@group(0) @binding(0) var<storage, read_write> res: array<vec4f>;
@group(0) @binding(1) var<storage, read> solid: array<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= ${SIZE}u || gid.y >= ${SIZE}u) { return; }
  geoSolid = solid[0] > 0.5;
  let x = ((f32(gid.x) + 0.5) / ${SIZE}.0) * 4.8 - 2.4;
  let y = ((f32(gid.y) + 0.5) / ${SIZE}.0) * 4.8 - 2.4;
  let d = normalize(vec3f(0.05 * x, 0.03, 1.0));
  let h = geoTrace(vec3f(x, y, -6.0), d, 0.0, 1e30, false);
  let a = geoAny(vec3f(x, y, -6.0), d, 0.0, 1e30);
  res[gid.y * ${SIZE}u + gid.x] = vec4f(h.t, f32(h.prim), select(0.0, 1.0, a), 0.0);
}`;
const look = (opacity: number[], cap = false) => ({
  layers: opacity.map((a, i) => ({ clips: cap ? (i < 2 ? [capClip] : []) : i === 1 ? [clip] : [], crop: null, cap, material: { roughness: 0.5, specular: 0.1, emission: 0, opacity: a } })),
});
// World to geometry: halve. The numbers at the buffer's start, as the tracer writes them each view.
const half2 = [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1];
const buffers = [[1, 1, 1, 1], [0, 0.5, 1, 1], [0, 0.5, 1, 1], [1, 1, 1, 1]].map((o, k) => {
  const b = geometryBuffer(s, k === 3 ? capColours : colours);
  b.set(geometryParams(s, look(o, k === 3), half2, 1e-6));
  return Array.from(b);
});
const gpuBrowser = await chromium.launch({
  executablePath: process.env.CHROME ?? (require("node:fs").existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined),
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--disable-vulkan-surface", "--no-sandbox"],
});
const gpuPage = await gpuBrowser.newPage();
// WebGPU is only for a secure page: an empty one from a file.
const blank = require("node:path").join(require("node:os").tmpdir(), "ngplatform-webgpu.html");
require("node:fs").writeFileSync(blank, "<!doctype html><title>webgpu</title>");
await gpuPage.goto(`file://${blank}`);
interface GpuArgs { cs: string; buffers: number[][]; SIZE: number }
// The third: met as solid.
const solidFlags = [0, 0, 1, 0];
const gpu: { error?: string; outs?: number[][] } = await gpuPage.evaluate(async ({ cs, buffers, SIZE, solidFlags }: GpuArgs & { solidFlags: number[] }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = navigator as any;
  const adapter = await nav.gpu?.requestAdapter();
  if (!adapter) return { error: "no WebGPU adapter" };
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: cs });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m: { type: string }) => m.type === "error");
  if (errors.length) return { error: errors.map((m: { message: string; lineNum: number }) => `${m.lineNum}: ${m.message}`).join("; ") };
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { GPUBufferUsage: U, GPUMapMode: M } = globalThis as any;
  const buffer = (data: ArrayBufferView, usage: number) => {
    const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | U.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const outs: number[][] = [];
  for (const [bi, p] of buffers.entries()) {
    const res = device.createBuffer({ size: SIZE * SIZE * 16, usage: U.STORAGE | U.COPY_SRC });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: res } },
        { binding: 1, resource: { buffer: buffer(new Float32Array([solidFlags[bi]]), U.STORAGE) } },
        { binding: 10, resource: { buffer: buffer(new Uint32Array(p), U.STORAGE) } },
      ],
    });
    const read = device.createBuffer({ size: SIZE * SIZE * 16, usage: U.COPY_DST | U.MAP_READ });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(SIZE / 8), Math.ceil(SIZE / 8));
    pass.end();
    enc.copyBufferToBuffer(res, 0, read, 0, SIZE * SIZE * 16);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(M.READ);
    outs.push(Array.from(new Float32Array(read.getMappedRange().slice(0))));
    read.unmap();
  }
  return { outs };
}, { cs, buffers, SIZE, solidFlags });
await gpuBrowser.close();
if (gpu.error !== undefined || gpu.outs === undefined) {
  console.error(`FAIL WebGPU: ${gpu.error}`);
  process.exit(1);
}
report("WebGPU", gpu.outs[0], gpu.outs[1], gpu.outs[2]);
reportCap("WebGPU", gpu.outs[3]);
process.exit(failed ? 1 : 0);
