// Smoke test: load the built app in Chromium and drive the platform GUI.
//
//   npm run build && (cd dist && python3 -m http.server 4174 &)
//   node tests/e2e/smoke.mjs [base-url] [screenshot-dir]
//
// Set CHROME=/path/to/chrome to use an installed Chrome with the machine's
// GPU; otherwise Playwright's Chromium (or that Chrome, with SWIFTSHADER=1)
// runs with SwiftShader's software WebGL2.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// A project install of playwright, or a global one reached through NODE_PATH.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const base = process.argv[2] ?? "http://localhost:4174/";
const shots = process.argv[3] ?? "tests/e2e/screenshots";
mkdirSync(shots, { recursive: true });

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
const gpu = process.env.CHROME !== undefined && !process.env.SWIFTSHADER;
// With SwiftShader, the Vulkan loader is pointed at the browser's own
// SwiftShader driver: a GPU vendor's driver is otherwise still probed, and
// NVIDIA's blocks for good opening /dev/nvidia-modeset in some sandboxes.
const icd = join(dirname(process.env.CHROME ?? chromium.executablePath()), "vk_swiftshader_icd.json");
const env = !gpu && existsSync(icd) ? { ...process.env, VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd } : undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  env,
  proxy,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(String(e)));
const cannotDraw = () => problems.some((p) => p.includes("Framebuffer configuration not supported"));
let dataRequests = 0;
// Neuroglancer's data, not the volume view's (its sections stream in on their own).
const volumeStore = (url) => url.includes("bigbrainproject.org/") || url.includes("/ngplatform/data/");
const requested = [];
page.on("request", (r) => {
  if (r.url().startsWith(base) || volumeStore(r.url())) return;
  dataRequests++;
  requested.push(r.url());
});

// The status shows only while loading or failing; its state says when all is ready.
const status = () => page.evaluate(() => document.querySelector(".status")?.textContent ?? "");
async function waitReady(label, timeout = 90_000) {
  await page.waitForFunction(() => document.querySelector(".status")?.dataset.state === "ok", null, { timeout });
  await page.waitForTimeout(4000); // let chunks stream in and draw
  console.log(`${label}: ${await status()}`);
}
// Clicks on the platform's own controls skip Playwright's wait for the page
// to hold still across two frames, which software WebGL (SwiftShader) can
// take longer than the timeout to give while the views draw.
const click = (locator) => locator.click({ force: true });
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) process.exitCode = 1; };
const layers = () => page.evaluate(() => window.engine.layers());
/** The default example's tractogram: its layer, and a part of its store's URL. */
const TRACTOGRAM = { layer: "S-21-46", url: "bridgeanatomical" };

await page.goto(base);
await waitReady("default example");
// The whole-brain tractogram is slow to draw on a software GPU (a frame a
// second or more); the checks are about the platform, so it is hidden here.
if (process.env.SWIFTSHADER) {
  await page.evaluate((name) => window.engine.setLayerVisible(name, false), TRACTOGRAM.layer);
  await page.waitForTimeout(3000);
}
await page.screenshot({ path: `${shots}/1-default.png`, timeout: 120_000 });
check((await page.evaluate(() => location.hash)).startsWith("#!"), "address bar holds the state");

// The views fill their column, and hold no Neuroglancer interface.
const fill = await page.evaluate(() => {
  const engine = document.querySelector(".engine").getBoundingClientRect();
  const host = document.querySelector(".engine-host").getBoundingClientRect();
  return host.height / engine.height;
});
check(fill > 0.98, `the viewer fills the views area (${(fill * 100).toFixed(0)}% of its height)`);
const chrome = await page.evaluate(() => {
  const visible = (sel) => [...document.querySelectorAll(`.engine ${sel}`)].filter((e) => e.offsetParent !== null).length;
  return {
    layerPanel: visible(".neuroglancer-layer-panel"),
    sidePanels: visible(".neuroglancer-side-panel"),
    status: visible("#neuroglancer-status-container"),
    position: visible(".neuroglancer-position-widget"),
    layoutButtons: visible(".neuroglancer-data-panel-layout-controls"),
  };
});
check(chrome.layerPanel + chrome.sidePanels + chrome.status === 0, `no layer bar, side panels or status inside the views ${JSON.stringify(chrome)}`);
check(chrome.position === 1 && chrome.layoutButtons > 0, "position top left and layout buttons on the panels, as in Neuroglancer");

// Datasets tab and Inspector.
check((await page.locator(".datasets .ds-row").count()) >= 1, "Datasets lists the scene's datasets");
await click(page.locator(".datasets .ds-row", { hasText: TRACTOGRAM.layer }).first());
await page.waitForTimeout(800);
check((await page.locator(".ins-tab").count()) > 0 && (await page.locator(".ins-root .neuroglancer-tab-label").count()) === 0, "the Layer tab shows the layer's controls in the platform's own tabs");
// The inspector's tabs, built by the platform from the layer's models.
await click(page.locator(".ins-tab", { hasText: "Source" }));
await page.waitForTimeout(800);
check((await page.locator(".ins-url").first().inputValue()).includes(TRACTOGRAM.url), "Source shows the data source URL");
check((await page.locator(".ins-tx-grid input").count()) > 0, "Source shows the transform as an editable table");
await click(page.locator(".ins-tab", { hasText: "Render" }));
await page.waitForTimeout(800);
check((await page.locator(".ins-content .ins-slider").count()) >= 4, "Render shows the layer's sliders");
await click(page.locator(".ins-tab", { hasText: "Segments" }));
await page.waitForTimeout(800);
// The segment properties (a row a streamline: 3.3 million) arrive after the views.
await page.locator(".ins-status button").waitFor({ timeout: 240_000 }).catch(() => {});
await click(page.locator(".ins-status button"));
await page.waitForTimeout(1500);
check((await page.locator(".ins-seg-row:not(.ins-seg-head)").count()) > 5, `Segments lists the segments (${await page.locator(".ins-status").innerText()})`);
await page.locator(".ins-query").fill("");
await page.waitForTimeout(500);

// Hide and show the dataset from its row.
await page.locator(".datasets .ds-row .vis").first().uncheck({ force: true });
await page.waitForTimeout(500);
check((await layers())[0].visible === false, "the row's checkbox hides the dataset");
await page.locator(".datasets .ds-row .vis").first().check({ force: true });

// The 3-D panel is Neuroglancer's own, with its Sections switch.
check((await page.locator("div.perspective-panel-show-slice-views label").count()) >= 1, "the 3-D panel has Neuroglancer's Sections switch");
check((await page.locator(".status").isHidden()), "no status shown when everything is ready");
// Scenes have no tab of their own: they are the tabs at the top.
check((await page.locator("#tab-scenes").count()) === 0, "no Scenes tab: scenes are the tabs at the top");

// The example's track groups switch to stores of their own streamlines
// once their exact answers settle (a quiet change, not an undo step); the
// undo check below counts data requests, so it waits for that first.
for (let waited = 0; waited < 300_000; waited += 2000) {
  const own = await page.evaluate(() =>
    window.viewer.layerManager.managedLayers
      .filter((l) => /callosum|corticospinal/i.test(l.name))
      .map((l) => JSON.stringify(l.layer?.toJSON()?.source ?? "").includes("/local/derived-")),
  );
  if (own.length > 0 && own.every(Boolean)) break;
  await page.waitForTimeout(2000);
}

// Palette: change the layout, then undo it.
await page.waitForTimeout(1500);
const layoutBefore = await page.evaluate(() => window.engine.layout());
dataRequests = 0;
await page.keyboard.press("Control+k");
await page.locator("#palette-input").fill("layout 3d");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
check(await page.evaluate(() => window.engine.layout() === "3d"), "palette ran Layout: 3D");
await page.screenshot({ path: `${shots}/2-3d.png`, timeout: 120_000 });
await click(page.locator(".brand")); // focus the page, not an input
// Undo restores the state in place: nothing is fetched again. (The 3-D
// panel the layout added fetches for itself first: wait until it is quiet,
// two seconds without a data request, which over the network can take a while.)
await page.waitForTimeout(3000);
for (let quiet = 0, seen = dataRequests, waited = 0; quiet < 2000 && waited < 60_000; waited += 250) {
  await page.waitForTimeout(250);
  quiet = dataRequests === seen ? quiet + 250 : 0;
  seen = dataRequests;
}
dataRequests = 0;
requested.length = 0;
await page.keyboard.press("Control+z");
await page.waitForTimeout(1500);
const layoutAfterUndo = await page.evaluate(() => window.engine.layout());
if (layoutAfterUndo !== layoutBefore) {
  const h = await page.evaluate(() => { const x = window.workbench.store.history; return `past ${x.past.length}, future ${x.future.length}, layouts in past: ${x.past.slice(-4).map((s) => JSON.parse(s).ng.layout).join(",")}, future: ${x.future.map((s) => JSON.parse(s).ng.layout).join(",")}`; });
  console.log(`  layout before ${layoutBefore}, after undo ${layoutAfterUndo}; history: ${h}`);
}
check(layoutAfterUndo === layoutBefore, "undo restored the layout");
check(dataRequests === 0, `undo made no data requests (${dataRequests}${requested.length ? `: ${[...new Set(requested.map((u) => u.replace(/[?#].*/, "").split("/").slice(-4).join("/")))].slice(0, 4).join(", ")}` : ""})`);

// Scenes: a new empty scene, the dataset added from the workspace, and back.
await click(page.locator(".scene-add"));
await page.waitForTimeout(800);
check((await page.locator(".scene-tab").count()) === 2, "New scene adds a scene tab");
check((await layers()).length === 0, "the new scene starts empty");
await click(page.locator(".ds-row.other .btn").first());
await page.waitForTimeout(800);
// The dataset's own layer, and its track groups' layers with it.
check((await layers()).length >= 1, "a workspace dataset adds to the new scene");
await click(page.locator(".scene-tab").first());
await page.waitForTimeout(800);
check((await page.locator('.scene-tab[aria-selected="true"]').innerText()) === "Scene 1", "switching back to Scene 1");

// Plugins: both listed with a switch; the filtering tab reads the attributes.
await click(page.locator("#tab-plugins"));
check((await page.locator(".plugin .switch").count()) >= 2, "the Plugins tab lists the plugins with switches");
await click(page.locator('[id="tab-trackFiltering.panel"]'));
await page
  .waitForFunction(() => { const c = [...document.querySelectorAll(".tf-group .count")]; return c.length === 3 && c.every((e) => /^[0-9,]+$/.test(e.textContent ?? "")); }, null, { timeout: 180_000 })
  .catch(() => {});
const counts = await page.locator(".tf-group .count").allInnerTexts();
console.log(`track groups: ${counts.join(", ")}`);
check(counts.length === 3 && counts.every((c) => /^[0-9,]+$/.test(c)), "the example's three track groups have exact counts");

// Open dialog: a pasted plain Neuroglancer link is recognised.
await page.keyboard.press("Control+o");
await page.locator("#open-input").fill('https://neuroglancer-demo.appspot.com/#!{"layers":[]}');
check((await page.locator(".detected").innerText()).startsWith("Neuroglancer state, 0 layers"), "Open recognises a Neuroglancer link");
await page.keyboard.press("Escape");

// Local data: a NIfTI made here, read through the service worker as virtual Zarr.
const local = await page.evaluate(async () => {
  const [nx, ny, nz] = [40, 30, 20];
  const bytes = new Uint8Array(352 + nx * ny * nz * 2);
  const v = new DataView(bytes.buffer);
  v.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((d, k) => v.setInt16(40 + 2 * k, d, true));
  v.setInt16(70, 4, true); // int16
  v.setInt16(72, 16, true);
  [1, 1, 1, 1].forEach((p, k) => v.setFloat32(76 + 4 * k, p, true));
  v.setFloat32(108, 352, true);
  bytes[123] = 2; // millimetres
  v.setInt16(254, 4, true);
  [[1, 0, 0, -20], [0, 1, 0, -15], [0, 0, 1, -10]].forEach((row, r) => row.forEach((x, c) => v.setFloat32(280 + 16 * r + 4 * c, x, true)));
  bytes.set([110, 43, 49, 0], 344); // n+1
  for (let i = 0; i < nx * ny * nz; ++i) v.setInt16(352 + 2 * i, i % 1000, true);
  const wb = window.workbench;
  await wb.localData.start();
  const id = "smoketest";
  wb.localData.entries.set(id, { id, name: "smoke.nii", kind: "file", files: new Map([["smoke.nii", new File([bytes], "smoke.nii")]]), needsPermission: false });
  navigator.serviceWorker.controller?.postMessage({ type: "local-register", id });
  const [found] = await wb.localData.detect(id);
  const root = found.source.replace(/^zarr3:\/\//, "");
  const group = await (await fetch(`${root}zarr.json`)).json();
  const chunk = new Int16Array(await (await fetch(`${root}0/c/0/0/0`)).arrayBuffer());
  return { source: found.source, version: group.attributes?.ome?.version, controlled: navigator.serviceWorker.controller !== null, voxels: [chunk[0], chunk[1], chunk[40], chunk[40 * 30 * 19 + 39]] };
});
check(local.version === "0.6" && local.controlled, `a local NIfTI is served as OME-Zarr through the service worker (${local.source})`);
check(JSON.stringify(local.voxels) === JSON.stringify([0, 1, 40, 839]), `its chunks hold the file's voxels (${local.voxels})`);
await page.evaluate((source) => {
  window.workbench.store.newScene({ name: "local" });
  window.workbench.store.addDataset({ source, name: "smoke", kind: "image" });
}, local.source);
// Under software WebGL (SwiftShader) the first shader compile after a heavy
// scene can hold the page for over a minute (getShaderParameter waits on a
// busy GPU process), so the layer is given three.
await page.waitForFunction(() => window.engine.layers().some((l) => l.name === "smoke" && (l.ready || l.error)), null, { timeout: process.env.SWIFTSHADER ? 180_000 : 60_000 }).catch(() => {});
const opened = (await layers()).find((l) => l.name === "smoke");
check(opened?.ready === true && !opened.error, `the local NIfTI opens as a layer${opened?.ready === true && !opened.error ? "" : ` (${JSON.stringify(await layers())})`}`);

// Narrow screen.
await page.setViewportSize({ width: 400, height: 800 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/4-phone.png`, timeout: 120_000 });
const past = await page.evaluate(() =>
  [...document.querySelectorAll("body *")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; })
    .slice(0, 4)
    .map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}`),
);
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll at 400 px${past.length ? ` (past the edge: ${past.join(", ")})` : ""}`);

console.log(problems.length ? `console errors:\n  ${[...new Set(problems)].slice(0, 10).join("\n  ")}` : "no console errors");
await browser.close();
