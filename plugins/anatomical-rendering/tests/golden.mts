/**
 * The browser's path tracer against the render computer's, on one scene: an empty volume and a Zarr Vectors mesh
 * (a sphere and a torus; runner/tests/golden_scene.py), drawn by the app in this browser (one image with geometry:
 * the WebGPU tracer's picture at rest), and the same view (the view spec the browser's tracer was given) rendered by
 * the render computer's CUDA. Their depths are compared pixel by pixel: where each meets the mesh (its outline) and
 * how far (the depth there). Then their shading, object by object: how the light falls across each (the rank
 * correlation of the two pictures' luminance over its pixels), which does not depend on the objects' colours (the
 * two colour objects by design apart) nor on the tone curve, but does on the light's direction and the falloff.
 *
 *   NGP_RENDER_PYTHON=…/python [ZARR_VECTORS_PY=…/zarr-vectors-py] npm run e2e:golden
 *
 * NGP_RENDER_PYTHON: a Python with the runner's render dependencies (CuPy, zarr 3) and `zarr_vectors` (or its source
 * in ZARR_VECTORS_PY), on a computer with a CUDA GPU. Chrome (CHROME, else /usr/bin/google-chrome) with WebGPU on
 * SwiftShader.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chromium: any;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const python = process.env.NGP_RENDER_PYTHON;
if (!python) {
  console.error("SKIP: set NGP_RENDER_PYTHON to a Python with the runner's render dependencies and zarr_vectors");
  process.exit(0);
}
const repo = resolve(new URL("../../..", import.meta.url).pathname);
const script = join(repo, "runner/tests/golden_scene.py");
const env = { ...process.env, PYTHONUTF8: "1", LANG: "C.UTF-8", PYTHONPATH: [process.env.ZARR_VECTORS_PY, process.env.PYTHONPATH].filter(Boolean).join(":") };
const dir = mkdtempSync(join(tmpdir(), "ngp-golden-"));
execFileSync(python, [script, "write", dir], { env, stdio: ["ignore", "ignore", "inherit"] });

// The scene over HTTP, as a browser reads a store.
const files = createServer((req, res) => {
  const path = join(dir, decodeURIComponent((req.url ?? "/").split("?")[0]));
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (!path.startsWith(dir) || !existsSync(path) || statSync(path).isDirectory()) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader("Content-Type", extname(path) === ".json" || path.endsWith("info") ? "application/json" : "application/octet-stream");
  res.end(readFileSync(path));
});
await new Promise<void>((r) => files.listen(0, "127.0.0.1", r));
const filesUrl = `http://127.0.0.1:${(files.address() as { port: number }).port}`;

// The app, as `npm run dev` serves it.
const vite = spawn("npx", ["vite", "--port", "5191", "--strictPort"], { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolveReady, reject) => {
  vite.stdout!.on("data", (d: Buffer) => {
    if (/Local:/.test(String(d))) resolveReady();
  });
  vite.on("exit", (c) => reject(new Error(`vite exited (${c})`)));
});
const app = "http://localhost:5191";

const done = (code: number) => {
  vite.kill();
  files.close();
  process.exit(code);
};

const state = {
  ng: {
    dimensions: { x: [0.001, "m"], y: [0.001, "m"], z: [0.001, "m"] }, position: [24, 24, 24], projectionScale: 60,
    projectionOrientation: [0.2, 0.15, 0.05, 0.966],
    layers: [
      { type: "image", source: `precomputed://${filesUrl}/em`, name: "em" },
      { type: "segmentation", source: `${filesUrl}/mesh.zv/|zarr-vectors:`, segments: [], name: "mesh" },
    ],
    selectedLayer: { layer: "em" }, layout: "3d",
  },
  app: { anatomicalRendering: { version: 1, data: { on: true, where: "browser", layer: "em", restPicture: true, maxSamples: 16, looks: { em: { on: true, density: 0 }, mesh: { on: true } } } } },
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--disable-vulkan-surface"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
await page.goto(app);
// The plugin on, and its state reachable from the page (ngplatform.debug).
await page.evaluate(() => {
  localStorage.setItem("ngplatform.plugins.enabled", JSON.stringify({ "org.ngplatform.anatomical-rendering": true }));
  localStorage.setItem("ngplatform.debug", "1");
});
await page.goto(`${app}/#!${encodeURIComponent(JSON.stringify(state))}`);
await page.waitForTimeout(2000);
await page.reload();

// The browser's: the WebGPU tracer's depth for its view, once it has 16 samples of it.
interface Got { depth: { width: number; height: number; data: number[] }; lum: { width: number; height: number; data: number[] }; view: Record<string, unknown>; status: string }
let got: Got | undefined;
for (let i = 0; i < 120 && got === undefined; ++i) {
  await page.waitForTimeout(3000);
  if (i % 10 === 0) console.log("waiting:", await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).anatomicalRendering;
    return [a?.local ? `local ready=${a.local.ready} ${a.local.status}` : "no local", a?.localText ?? "", a?.problem ?? "", String(a?.live?.text ?? "").replace(/\n/g, " / ")].join(" | ").slice(0, 300);
  }));
  got = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = (window as any).anatomicalRendering, r = a?.local;
    if (!r?.ready || !a.live?.heldSurfaces) return undefined;
    if (!r.__golden) {
      r.__golden = true;
      const on = r.onFrame;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      r.onFrame = (f: any) => {
        r.__last = f;
        on?.(f);
      };
    }
    const f = r.__last;
    if (!f || f.samples < 16 || !f.depth) return undefined;
    // The picture's luminance.
    const bm = f.bitmap as ImageBitmap;
    const cv = new OffscreenCanvas(bm.width, bm.height);
    const cx = cv.getContext("2d")!;
    cx.drawImage(bm, 0, 0);
    const px = cx.getImageData(0, 0, bm.width, bm.height).data;
    const lum = Array.from({ length: bm.width * bm.height }, (_, i) => (0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255);
    return { depth: { width: f.depth.width, height: f.depth.height, data: Array.from(f.depth.data as Float32Array) }, lum: { width: bm.width, height: bm.height, data: lum }, view: r.view, status: String(a.live.text) };
  });
}
if (got === undefined) await page.screenshot({ path: join(dir, "browser.png") });
await browser.close();
if (got === undefined) {
  console.error(`FAIL the browser's tracer gave no picture of the scene (${errors.slice(0, 3).join("; ")})`);
  done(1);
}
const b = got!;
writeFileSync(join(dir, "view.json"), JSON.stringify(b.view));
writeFileSync(join(dir, "browser.json"), JSON.stringify({ depth: b.depth, lum: b.lum }));
execFileSync(python, [script, "render", dir, join(dir, "view.json"), join(dir, "cuda")], { env, stdio: ["ignore", "ignore", "inherit"] });
const c = JSON.parse(readFileSync(join(dir, "cuda.json"), "utf8")) as { width: number; height: number; depth: number[]; picture: { width: number; height: number; lum: number[] } };

// Pixel by pixel, on the browser's grid (the computer's sampled at the same place); depths as world points
// (unprojected through the view's inverse, column-major), how far apart in millimetres.
const W = b.depth.width, H = b.depth.height;
const inv = b.view.inv_view_projection as number[];
const world = (x: number, y: number, d: number) => {
  // Pixel centres, the top row first (as the tracers' rays); inv_view_projection column-major (Frame3d's).
  const n = [((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, d * 2 - 1, 1];
  const p = [0, 1, 2, 3].map((r) => inv[r] * n[0] + inv[4 + r] * n[1] + inv[8 + r] * n[2] + inv[12 + r] * n[3]);
  return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
};
const mmPerWorld = 1;
// The least rank correlation of the two pictures' luminance over an object.
const SHADING = 0.8; // the scene's display unit is a millimetre
let both = 0, either = 0, agree = 0, close = 0;
const diffs: number[] = [];
const steps: number[] = [];
// Where both meet the same object: each picture's luminance there, by object (0 the sphere, 1 the torus).
const shade: [number[], number[]][] = [[[], []], [[], []]];
const lumAt = (l: { width: number; height: number; data?: number[]; lum?: number[] }, x: number, y: number) =>
  (l.data ?? l.lum!)[Math.min(l.height - 1, Math.floor(((y + 0.5) / H) * l.height)) * l.width + Math.min(l.width - 1, Math.floor(((x + 0.5) / W) * l.width))];
for (let y = 0; y < H; ++y)
  for (let x = 0; x < W; ++x) {
    const db = b.depth.data[y * W + x];
    const cx = Math.min(c.width - 1, Math.floor(((x + 0.5) / W) * c.width)), cy = Math.min(c.height - 1, Math.floor(((y + 0.5) / H) * c.height));
    const dc = c.depth[cy * c.width + cx];
    const hb = db < 1, hc = dc < 1;
    if (hb === hc) agree++;
    if (hb || hc) either++;
    if (hb && hc) {
      both++;
      const pb = world(x, y, db), pc = world(x, y, dc);
      const mm = Math.hypot(pb[0] - pc[0], pb[1] - pc[1], pb[2] - pc[2]) * mmPerWorld;
      diffs.push(mm);
      // The computer's depth comes as float16 (NDC 0..1): one of its steps there, as a distance, is allowed too.
      const ulp = 2 ** (Math.floor(Math.log2(Math.max(dc, 2 ** -14))) - 10);
      const pu = world(x, y, Math.min(dc + ulp, 1 - 1e-7));
      const step = Math.hypot(pu[0] - pc[0], pu[1] - pc[1], pu[2] - pc[2]) * mmPerWorld;
      steps.push(step);
      if (mm < 0.05 + step) {
        close++;
        // On the sphere (radius 9 about (16, 24, 24)) or the torus; not at the outline, where pixels mix.
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([u, v]) => (b.depth.data[Math.min(H - 1, Math.max(0, y + v)) * W + Math.min(W - 1, Math.max(0, x + u))] ?? 1) >= 1);
        if (!edge) {
          const k = Math.abs(Math.hypot(pb[0] - 16, pb[1] - 24, pb[2] - 24) - 9) < 0.3 ? 0 : 1;
          shade[k][0].push(lumAt(b.lum, x, y));
          shade[k][1].push(lumAt(c.picture, x, y));
        }
      }
    }
  }
diffs.sort((p, q) => p - q);
steps.sort((p, q) => p - q);
/** Spearman's rank correlation. */
function spearman(a: number[], q: number[]): number {
  const rank = (v: number[]) => {
    const o = v.map((x, i) => [x, i]).sort((m, n) => m[0] - n[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < o.length; ) {
      let j = i;
      while (j + 1 < o.length && o[j + 1][0] === o[i][0]) ++j;
      for (let k = i; k <= j; ++k) r[o[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rq = rank(q), n = a.length, ma = (n - 1) / 2;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; ++i) {
    sab += (ra[i] - ma) * (rq[i] - ma);
    saa += (ra[i] - ma) ** 2;
    sbb += (rq[i] - ma) ** 2;
  }
  return sab / Math.sqrt(saa * sbb || 1);
}
const rho = shade.map(([p, q]) => (p.length > 50 ? spearman(p, q) : NaN));
const median = diffs.length ? diffs[diffs.length >> 1] : 1;
const checks: [boolean, string][] = [
  [either > 0.02 * W * H, `the mesh is in view: ${either} of ${W * H} pixels`],
  [agree / (W * H) > 0.99, `the same outline: ${agree} of ${W * H} pixels agree (met or not)`],
  [both / either > 0.95, `met by both where met by either: ${both} of ${either}`],
  ...rho.map((r, k): [boolean, string] => [r > SHADING, `the light falls across the ${["sphere", "torus"][k]} alike: rank correlation ${r.toFixed(3)} over ${shade[k][0].length} pixels (above ${SHADING})`]),
  [close / Math.max(both, 1) > 0.98, `the same place where both meet it: ${close} of ${both} within 0.05 mm and a step of the computer's float16 depth (median step ${steps[steps.length >> 1]?.toExponential(1)} mm; distances median ${median.toExponential(1)} mm, 99th percentile ${diffs[Math.floor(0.99 * (diffs.length - 1))]?.toExponential(1)} mm)`],
];
let failed = 0;
for (const [ok, what] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
}
console.log(`(browser ${W}×${H}, computer ${c.width}×${c.height}; scene in ${dir})`);
done(failed ? 1 : 0);
