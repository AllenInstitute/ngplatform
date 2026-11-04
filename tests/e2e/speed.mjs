// Speed measurements of a built app (docs/dev/speed.md), one run per call.
//
//   node tests/e2e/speed.mjs URL MODE [out.json]
//
// MODE:
//   load  a fresh profile opens URL: time to the ready status, to the first
//         visible chunk, to the view complete (Neuroglancer's isReady), long
//         tasks, main-thread JS heap and array buffers, renderer and GPU
//         process memory, the scripts fetched.
//   pan   load, then 30 s of dragging in the first 2-D panel and 30 s in the
//         3-D panel: frame intervals, main-thread script and task time per
//         frame, memory afterwards.
//   draw  as pan, but with every layer except images removed first (the
//         default example's template alone).
//
// URL "…/#!%7B%7D" is an empty workspace; the app's own URL opens the
// default example.  As tests/e2e/smoke.mjs: CHROME=/path/to/chrome to use an
// installed Chrome with the machine's GPU, otherwise SwiftShader.
// THROTTLE=latency_ms,mbit_per_s slows the connection.
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const [url, mode = "load", outPath] = process.argv.slice(2);
if (url === undefined) {
  console.error("usage: node tests/e2e/speed.mjs URL load|pan|draw [out.json]");
  process.exit(2);
}
const gpu = process.env.CHROME !== undefined && !process.env.SWIFTSHADER;
const icd = join(dirname(process.env.CHROME ?? chromium.executablePath()), "vk_swiftshader_icd.json");
const env = !gpu && existsSync(icd) ? { ...process.env, VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd } : undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  env,
});
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
await context.addInitScript(() => {
  const m = (window.__speed = { longTasks: [], ready: null, viewer: null, firstChunk: null, complete: null, serviceWorker: null });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) m.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // No long task timing in this browser.
  }
  // Ready: the status says the scene is loaded, or that it is empty.
  const ready = () => ["ok", "idle"].includes(document.querySelector(".status")?.dataset.state ?? "");
  const observer = new MutationObserver(() => {
    if (m.ready === null && ready()) m.ready = performance.now();
  });
  document.addEventListener("DOMContentLoaded", () => observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true }));
  navigator.serviceWorker?.ready.then(() => (m.serviceWorker = performance.now()));
  const poll = () => {
    const v = window.viewer;
    if (v !== undefined && m.viewer === null) {
      m.viewer = performance.now();
      v.chunkManager.layerChunkStatisticsUpdated.add(() => {
        if (m.firstChunk !== null) return;
        if (v.chunkManager.prevStatisticsLayers.some((s) => s.numVisibleChunksAvailable > 0)) m.firstChunk = performance.now();
      });
    }
    if (v !== undefined && m.complete === null && v.layerManager.managedLayers.length > 0 && v.isReady()) m.complete = performance.now();
    if (m.complete === null || m.firstChunk === null) requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
});
const page = await context.newPage();
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
if (process.env.THROTTLE) {
  const [latency, mbit] = process.env.THROTTLE.split(",").map(Number);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: (mbit * 1e6) / 8, uploadThroughput: (mbit * 1e6) / 8 });
}

const started = Date.now();
await page.goto(url);
await page.waitForFunction(() => window.__speed.ready !== null, null, { timeout: 180_000 }).catch(() => problems.push("not ready in 180 s"));
const empty = url.includes("#!%7B%7D");
if (mode === "draw") {
  await page.waitForFunction(() => window.workbench?.store !== undefined && window.viewer.layerManager.managedLayers.length > 0, null, { timeout: 60_000 });
  await page.evaluate(() => window.workbench.store.patchState((ng) => {
    ng.layers = ng.layers.filter((l) => l.type === "image");
  }));
  await page.waitForTimeout(2000);
  await page.waitForFunction(() => window.viewer.isReady(), null, { timeout: 120_000, polling: 500 }).catch(() => problems.push("images not complete in 120 s"));
} else if (!empty) {
  await page.waitForFunction(() => window.__speed.complete !== null && window.__speed.firstChunk !== null, null, { timeout: 180_000 }).catch(() => problems.push("view not complete in 180 s"));
}
await page.waitForTimeout(3000);

/** Resident memory of this browser's renderer and GPU processes, MiB. */
const rss = () => {
  const ps = execSync("ps -eo pid,ppid,rss,args --no-headers").toString().trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] };
  });
  const mine = new Set([process.pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of ps) if (!mine.has(p.pid) && mine.has(p.ppid)) mine.add(p.pid), (changed = true);
  }
  const sum = (re) => Math.round(ps.filter((p) => mine.has(p.pid) && re.test(p.args)).reduce((a, p) => a + p.rss, 0) / 1024);
  return { renderer: sum(/--type=renderer/), gpu: sum(/--type=gpu-process/) };
};
/** The main thread's JS heap and array buffers after a collection, MiB. */
const heap = async () => {
  await cdp.send("HeapProfiler.collectGarbage");
  const u = await cdp.send("Runtime.getHeapUsage");
  return { js: +(u.usedSize / 1048576).toFixed(1), buffers: +((u.backingStorageSize ?? 0) / 1048576).toFixed(1) };
};

const res = { url, mode, times: await page.evaluate(() => window.__speed) };
const until = res.times.complete ?? res.times.ready ?? Infinity;
const tasks = res.times.longTasks.filter(([s]) => s < until);
res.longTasks = { n: tasks.length, ms: Math.round(tasks.reduce((a, [, d]) => a + d, 0)), max: Math.round(Math.max(0, ...tasks.map(([, d]) => d))) };
delete res.times.longTasks;
res.scripts = await page.evaluate(() =>
  performance.getEntriesByType("resource").filter((e) => /\.(js|css)$/.test(e.name)).map((e) => [e.name.replace(/^.*\//, ""), Math.round(e.startTime), e.encodedBodySize]),
);
res.heapAfterLoad = await heap();
res.rssAfterLoad = rss();

if (mode === "pan" || mode === "draw") {
  const panels = await page.evaluate(() =>
    [...document.querySelectorAll(".neuroglancer-rendered-data-panel")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 50).map((r) => [r.x, r.y, r.width, r.height]),
  );
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  // Frame intervals from requestAnimationFrame, and main-thread time per frame.
  const measure = async (run) => {
    const before = await metrics();
    await page.evaluate(() => {
      const f = (window.__frames = []);
      let last = performance.now();
      const tick = (t) => {
        f.push(t - last);
        last = t;
        if (window.__frames === f) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await run();
    const f = await page.evaluate(() => {
      const f = window.__frames;
      window.__frames = null;
      return f;
    });
    const after = await metrics();
    const s = [...f].sort((a, b) => a - b);
    const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
    const per = (k) => +(((after[k] - before[k]) * 1000) / Math.max(1, s.length)).toFixed(2);
    return { frames: s.length, median: q(0.5), p95: q(0.95), over50: s.filter((x) => x > 50).length, scriptMsPerFrame: per("ScriptDuration"), taskMsPerFrame: per("TaskDuration") };
  };
  // Drags in a circle: in a 2-D panel it pans, in the 3-D panel it rotates.
  const drag = async ([x, y, w, h], seconds) => {
    const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 4;
    const end = Date.now() + seconds * 1000;
    await page.mouse.move(cx + r, cy);
    await page.mouse.down();
    for (let a = 0; Date.now() < end; a += 0.08) {
      await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  };
  res.pan2d = await measure(() => drag(panels[0], 30));
  res.rotate3d = await measure(() => drag(panels[panels.length - 1], 30));
  await page.waitForTimeout(3000);
  res.heapAfterPan = await heap();
  res.rssAfterPan = rss();
}
res.wall = Date.now() - started;
res.problems = [...new Set(problems)].slice(0, 10);
if (outPath) writeFileSync(outPath, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ ...res, scripts: res.scripts.length }));
await browser.close();
