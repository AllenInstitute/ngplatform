/**
 * How long the surfaces' traversal (geometry/live_geometry.ts) takes on this computer's own GPU, one small draw at
 * a time: synthetic scenes of growing size (a tessellated sphere; slender branching tubes, as a neuron's mesh),
 * each traced a camera ray a pixel into a small target, timed with gl.finish, and the nodes each ray visits.
 *
 * Each draw is small (64 × 64 first), and the run stops at the first draw over STOP_MS or the first lost context.
 * Even so, do not run it on the hardware GPU of a computer whose display you are using: real-GPU runs of the app's
 * tracer froze such a desktop (2026-11-18), and these still lag it.
 *
 *   npm run e2e:gpu-timing                  SwiftShader (the CPU): checks the script, times nothing real
 *   ANGLE=vulkan npm run e2e:gpu-timing     the hardware GPU (Vulkan; ANGLE=gl for OpenGL)
 */
import { createRequire } from "node:module";
import { geoData, geoLayout, geometryGlsl } from "../geometry/live_geometry.ts";
import { TRIANGLE } from "../geometry/lbvh.ts";
import { NO_NORMAL, type Primitives } from "../geometry/primitives.ts";
import { buildBlock, packSurfaces, type Surfaces } from "../geometry/surfaces.ts";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chromium: any;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

/** A draw this long stops the run (ms). */
const STOP_MS = 200;
const W = 4096;

// ----------------------------------------------------------------- scenes (geometry in mm, about a 1 mm cube)
function mesh(verts: number[], tris: number[]): Primitives {
  const v = new Float32Array((verts.length / 3) * 4);
  const bits = new Uint32Array(v.buffer);
  for (let i = 0; i < verts.length / 3; ++i) {
    v.set(verts.slice(3 * i, 3 * i + 3), 4 * i);
    bits[4 * i + 3] = NO_NORMAL;
  }
  const n = tris.length / 3;
  return { vertices: v, index: new Uint32Array(tris), objects: new Int32Array(n), kinds: new Int32Array(n).fill(TRIANGLE) };
}
/** A sphere of about `n` triangles, radius 0.4 about 0.5. */
function sphere(n: number): Primitives {
  const rings = Math.max(4, Math.round(Math.sqrt(n / 4))), seg = 2 * rings;
  const verts: number[] = [], tris: number[] = [];
  for (let i = 0; i <= rings; ++i)
    for (let j = 0; j < seg; ++j) {
      const th = (Math.PI * i) / rings, ph = (2 * Math.PI * j) / seg;
      verts.push(0.5 + 0.4 * Math.sin(th) * Math.cos(ph), 0.5 + 0.4 * Math.sin(th) * Math.sin(ph), 0.5 + 0.4 * Math.cos(th));
    }
  for (let i = 0; i < rings; ++i)
    for (let j = 0; j < seg; ++j) {
      const a = i * seg + j, b = i * seg + ((j + 1) % seg), c = (i + 1) * seg + ((j + 1) % seg), d = (i + 1) * seg + j;
      tris.push(a, b, c, a, c, d);
    }
  return mesh(verts, tris);
}
/** Slender tubes (radius 2 µm, 8 sides) wandering through the cube, about `n` triangles: a neuron's mesh's shape. */
function tubes(n: number): Primitives {
  const sides = 8, perTube = 400;
  const count = Math.max(1, Math.round(n / (2 * sides * perTube)));
  const verts: number[] = [], tris: number[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let t = 0; t < count; ++t) {
    let p = [0.5 + 0.3 * (rnd() - 0.5), 0.5 + 0.3 * (rnd() - 0.5), 0.5 + 0.3 * (rnd() - 0.5)];
    let d = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const base = verts.length / 3;
    for (let k = 0; k < perTube; ++k) {
      d = d.map((x) => x + 0.3 * (rnd() - 0.5));
      const l = Math.hypot(...d);
      d = d.map((x) => x / l);
      p = p.map((x, a) => Math.min(0.98, Math.max(0.02, x + 0.004 * d[a])));
      // A ring about p, normal to d.
      const u = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const e1 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
      const m = Math.hypot(...e1);
      const a1 = e1.map((x) => x / m);
      const a2 = [d[1] * a1[2] - d[2] * a1[1], d[2] * a1[0] - d[0] * a1[2], d[0] * a1[1] - d[1] * a1[0]];
      for (let s = 0; s < sides; ++s) {
        const an = (2 * Math.PI * s) / sides;
        verts.push(...p.map((x, a) => x + 0.002 * (Math.cos(an) * a1[a] + Math.sin(an) * a2[a])));
      }
      if (k > 0)
        for (let s = 0; s < sides; ++s) {
          const a = base + (k - 1) * sides + s, b = base + (k - 1) * sides + ((s + 1) % sides);
          tris.push(a, b, b + sides, a, b + sides, a + sides);
        }
    }
  }
  return mesh(verts, tris);
}

/** The scenes, built one at a time (as they are timed). */
const SCENES = [
  ["sphere", sphere, 5e3], ["sphere", sphere, 5e4], ["sphere", sphere, 5e5],
  ["tubes", tubes, 5e3], ["tubes", tubes, 5e4], ["tubes", tubes, 5e5],
] as const;
function build(make: (n: number) => Primitives, n: number): Surfaces {
  return packSurfaces([{ block: buildBlock(make(n), 1), objectBase: 0 }], 1);
}

// ----------------------------------------------------------------- the GPU's
const fs = `#version 300 es
precision highp float;
precision highp int;
${geometryGlsl(W, 6)}
out vec4 o;
uniform vec2 uSize;
void main() {
  // A camera at (0.5, 0.5, -1.5) looking along +z over the cube.
  vec2 q = (gl_FragCoord.xy / uSize) * 2.0 - 1.0;
  vec3 d = normalize(vec3(0.35 * q, 1.0));
  int prim;
  vec2 uv;
  float t = geoHit(vec3(0.5, 0.5, -1.5), d, 0.0, 1e30, prim, uv);
  o = vec4(t, float(prim), float(geoVisits), 0.0);
}`;
const args = { vulkan: ["--use-angle=vulkan", "--enable-features=Vulkan,VulkanFromANGLE", "--use-vulkan=native"], gl: ["--use-angle=gl"], swiftshader: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }[process.env.ANGLE ?? "swiftshader"] ?? [];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", headless: true, args: [...args, "--ignore-gpu-blocklist", "--disable-vulkan-surface", "--no-sandbox"] });
const page = await browser.newPage();
const lost: string[] = [];
page.on("console", (m: { text(): string }) => /CONTEXT_LOST|device has been lost/i.test(m.text()) && lost.push(m.text()));
console.log("GPU:", await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2")!;
  const e = gl.getExtension("WEBGL_debug_renderer_info");
  return gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
}));
let stopped = false;
for (const [kind, make, count] of SCENES) {
  if (stopped) break;
  const s = build(make, count);
  const name = `${kind} ${s.n.toLocaleString()}`;
  const layout = geoLayout(s, W);
  const data = geoData(s, W);
  // The one object: white, layer 1.
  data.set(new Uint32Array(new Float32Array([1, 1, 1, 1]).buffer), 4 * layout.objAt);
  const r: { error?: string; runs?: { size: number; ms: number; hit: number; visits: number[] }[] } = await page.evaluate(
    async ({ fs, b64, rows, primAt, nodeAt, objAt, root, n, W, STOP_MS }: { fs: string; b64: string; rows: number; primAt: number; nodeAt: number; objAt: number; root: number; n: number; W: number; STOP_MS: number }) => {
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
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(p) ?? "link" };
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, W, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, new Uint32Array(bytes.buffer));
      const u = (k: string) => gl.getUniformLocation(p, k);
      gl.uniform1i(u("uGeo"), 0);
      gl.uniform1i(u("uGeoN"), n);
      gl.uniform1i(u("uGeoRoot"), root);
      gl.uniform1i(u("uGeoPrimAt"), primAt);
      gl.uniform1i(u("uGeoNodeAt"), nodeAt);
      gl.uniform1i(u("uGeoObjAt"), objAt);
      gl.uniformMatrix4fv(u("uGeoFromWorld"), false, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      gl.uniform1iv(u("uGeoNClip"), [0, 0, 0, 0]);
      gl.uniform3fv(u("uGeoCropLo"), new Float32Array(12).fill(-1e30));
      gl.uniform3fv(u("uGeoCropHi"), new Float32Array(12).fill(1e30));
      gl.uniform4fv(u("uGeoMat"), new Float32Array([0.5, 0.1, 0, 1, 0.5, 0.1, 0, 1, 0.5, 0.1, 0, 1, 0.5, 0.1, 0, 1]));
      gl.activeTexture(gl.TEXTURE0 + 7);
      const runs: { size: number; ms: number; hit: number; visits: number[] }[] = [];
      for (const size of [64, 128, 256, 512]) {
        const target = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, target);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        gl.viewport(0, 0, size, size);
        gl.uniform2f(u("uSize"), size, size);
        // (Chrome's gl.finish does not wait for the GPU; reading a pixel back does.) A first draw of one pixel:
        // the shader is compiled for the GPU at its first draw, not timed.
        const one = new Float32Array(4);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, 1, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.SCISSOR_TEST);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, one);
        const t0 = performance.now();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, one);
        const ms = performance.now() - t0;
        if (gl.isContextLost()) return { error: `context lost at ${size}²`, runs };
        const out = new Float32Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, out);
        const v: number[] = [];
        let hit = 0;
        for (let i = 0; i < size * size; ++i) {
          v.push(out[4 * i + 2]);
          if (out[4 * i] > 0) hit++;
        }
        v.sort((a, b) => a - b);
        runs.push({ size, ms, hit: hit / (size * size), visits: [v[v.length >> 1], v[Math.floor(v.length * 0.99)], v[v.length - 1]] });
        // Each step four times the pixels: stop before one could pass STOP_MS.
        if (ms * 4 > STOP_MS) break;
      }
      return { runs };
    },
    { fs, b64: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), rows: layout.rows, primAt: layout.primAt, nodeAt: layout.nodeAt, objAt: layout.objAt, root: s.root, n: s.n, W, STOP_MS },
  );
  for (const x of r.runs ?? []) console.log(`${name.padEnd(18)} ${String(x.size).padStart(4)}²: ${x.ms.toFixed(1).padStart(7)} ms, ${(100 * x.hit).toFixed(0)}% met, nodes a ray: median ${x.visits[0]}, 99% ${x.visits[1]}, most ${x.visits[2]}`);
  if (r.error || lost.length) {
    console.log(`STOP ${name}: ${r.error ?? ""} ${lost[0] ?? ""}`);
    stopped = true;
  }
  if ((r.runs?.at(-1)?.ms ?? 0) * 4 > STOP_MS && (r.runs?.at(-1)?.size ?? 0) === 64) {
    console.log(`STOP: ${name} is already slow at 64²`);
    stopped = true;
  }
}
await browser.close();
process.exit(0);
