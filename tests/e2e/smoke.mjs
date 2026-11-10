// Smoke test: load the built app in Chromium and drive the platform GUI,
// on local data only, waiting on the app's state rather than on time.
//
//   npm run build
//   python3 -m http.server 4231 --bind 127.0.0.1 --directory dist &
//   node tests/e2e/smoke.mjs [base-url] [screenshot-dir]
//
// Nothing it opens is on the network.  The test builds a small OME-Zarr in
// memory and serves it from a static server of its own on 127.0.0.1; the
// runner it pairs with is a fake one answered by page.route; the web fonts
// are answered empty; any other request off the machine is refused and
// fails the test.
//
// Playwright must be reachable: a project install, or a global one through
// NODE_PATH.  Set CHROME=/path/to/chrome to use an installed Chrome with
// the machine's GPU, or with SWIFTSHADER=1 its software WebGL2; without
// CHROME, Playwright's own Chromium runs with SwiftShader.  In CI this
// needs Chrome or Playwright's Chromium (`npx playwright install chromium`),
// which brings SwiftShader with it, and the built app served as above.
import { createServer } from "node:http";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
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

const base = process.argv[2] ?? "http://127.0.0.1:4231/";
const shots = process.argv[3] ?? "tests/e2e/screenshots";
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

// ----------------------------------------------------------------- fixtures

/**
 * A small OME-Zarr (0.4, Zarr v2, uncompressed): one 16 × 32 × 32 uint8
 * scale of a bright ball in a dim box, made here and served from memory.
 */
function omeZarr() {
  const [nz, ny, nx] = [16, 32, 32];
  const voxels = Buffer.alloc(nz * ny * nx);
  for (let z = 0; z < nz; ++z)
    for (let y = 0; y < ny; ++y)
      for (let x = 0; x < nx; ++x) {
        const r = Math.hypot((z - nz / 2) * 2, y - ny / 2, x - nx / 2);
        voxels[(z * ny + y) * nx + x] = r < 10 ? 200 : 20;
      }
  const axis = (name) => ({ name, type: "space", unit: "micrometer" });
  const json = (value) => Buffer.from(JSON.stringify(value));
  return new Map([
    [".zgroup", json({ zarr_format: 2 })],
    [
      ".zattrs",
      json({
        multiscales: [
          {
            version: "0.4",
            name: "ball",
            axes: [axis("z"), axis("y"), axis("x")],
            datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [2, 1, 1] }] }],
          },
        ],
      }),
    ],
    ["0/.zarray", json({ zarr_format: 2, shape: [nz, ny, nx], chunks: [nz, ny, nx], dtype: "|u1", compressor: null, fill_value: 0, order: "C", filters: null, dimension_separator: "/" })],
    ["0/0/0/0", voxels],
  ]);
}

/** Serves the fixture under /ball.ome.zarr/ with CORS, counting what is fetched. */
async function fixtureServer() {
  const files = omeZarr();
  const served = [];
  /** Resolves once the chunk has been fetched: the views drew the data. */
  let drawn;
  const chunkServed = new Promise((resolve) => (drawn = resolve));
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/ball\.ome\.zarr\//, "");
    const body = files.get(path);
    if (body === undefined) return void res.writeHead(404).end();
    served.push(path);
    if (path === "0/0/0/0") drawn();
    res.writeHead(200, { "Content-Type": path.endsWith("0/0/0") ? "application/octet-stream" : "application/json", "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, served, chunkServed, url: `http://127.0.0.1:${server.address().port}/ball.ome.zarr/` };
}

/** The fake runner's address and token, and what it answers (as ngplatform_runner does). */
const RUNNER = "http://127.0.0.1:8799";
const TOKEN = "smoke-test-token-0123456789";
const RUNNER_STATUS = {
  name: "ngplatform-runner",
  version: "0.1.0",
  pid: 4242,
  address: RUNNER,
  roots: ["/data"],
  python: "/usr/bin/python3",
  tools: "0.9.0",
  maxRunning: 2,
  kinds: [],
  hostname: "smoke",
  platform: "linux",
  gpus: [],
  services: {},
};
async function fakeRunner(route) {
  const request = route.request();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" };
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const json = (body, status = 200) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  if ((await request.headerValue("authorization")) !== `Bearer ${TOKEN}`) return json({ error: "unauthorised" }, 401);
  const path = new URL(request.url()).pathname;
  if (path === "/status") return json(RUNNER_STATUS);
  if (path === "/jobs") return json({ jobs: [] });
  if (path === "/serve") return json({ serves: [] });
  return json({ error: `no ${path} here` }, 404);
}

// ------------------------------------------------------------------ browser

const fixture = await fixtureServer();
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
const gpu = process.env.CHROME !== undefined && !process.env.SWIFTSHADER;
// With SwiftShader, the Vulkan loader is pointed at the browser's own
// SwiftShader driver: a GPU vendor's driver is otherwise still probed, and
// NVIDIA's blocks for good opening /dev/nvidia-modeset in some sandboxes.
const icd = join(dirname(realpathSync(process.env.CHROME ?? chromium.executablePath())), "vk_swiftshader_icd.json");
const env = !gpu && existsSync(icd) ? { ...process.env, VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd } : undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  env,
  proxy,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

// Off the machine: the fonts are answered empty, the fake runner by itself, anything else refused.
const offMachine = [];
await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
await page.route(`${RUNNER}/**`, fakeRunner);
await page.route(
  (url) => !["http://127.0.0.1", "http://localhost"].some((h) => url.origin.startsWith(h)) && !/^https:\/\/fonts\./.test(url.href) && url.protocol.startsWith("http"),
  (route) => {
    offMachine.push(route.request().url());
    return route.abort("blockedbyclient");
  },
);

// Waits on the app's state or DOM (never on time); says what it waited for when it fails.
const STATE_TIMEOUT = process.env.SWIFTSHADER || !process.env.CHROME ? 120_000 : 30_000;
async function until(what, fn, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout: STATE_TIMEOUT });
    return true;
  } catch {
    check(false, `waited for ${what}`);
    return false;
  }
}
const sheetOpen = () => page.evaluate(() => document.querySelector(".scrim") !== null);
const noSheet = (what) => until(what, () => document.querySelector(".scrim") === null);
// Clicks on the platform's own controls skip Playwright's wait for the page
// to hold still across two frames, which software WebGL can take longer
// than the timeout to give while the views draw.
const click = (locator) => locator.click({ force: true });

// ---------------------------------------------------- pairing from a link

// A runner's pairing link (`#runner=…&token=…`) asks first, then pairs and shows Settings › Compute.
await page.goto(`${base}#runner=${encodeURIComponent(RUNNER)}&token=${TOKEN}`);
await until("the pairing question", () => [...document.querySelectorAll(".sheet p")].some((p) => p.textContent.startsWith("Pair this browser with the runner at")));
check(!(await page.evaluate(() => location.href)).includes(TOKEN), "the pairing link's token is taken out of the address bar");
await click(page.locator(".sheet .btn.primary", { hasText: "Pair" }));
await until("the runner paired from the link", () => window.workbench?.runner.connection() === "connected");
await until("Settings › Compute showing the runner", () => document.querySelector('.settings-nav [aria-selected="true"]')?.textContent === "Compute" && document.querySelector(".runner-connection")?.textContent === "connected");
check((await page.locator(".runner-section").first().innerText()).includes("Runner 0.1.0 at http://127.0.0.1:8799 (PID 4242)"), "Settings › Compute shows the paired runner");
await page.keyboard.press("Escape");
await noSheet("Escape to close Settings");

// ---------------------------------------------------------- the start card

await until("the start card over the empty scene", () => document.querySelector(".start-card")?.hidden === false);
check((await page.locator(".start-card .start-example").count()) >= 1, "the start card offers the examples");
check((await page.locator(".start-card button", { hasText: "Open a file…" }).count()) === 1 && (await page.locator(".start-card button", { hasText: "Paste a link…" }).count()) === 1, "the start card offers Open a file and Paste a link");
await page.screenshot({ path: `${shots}/1-start.png` });

// ------------------------------------------------------------------ keyboard

// Tab moves the keyboard through the controls, and Shift+Tab back.
await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
await page.keyboard.press("Tab");
const first = await page.evaluate(() => { const e = document.activeElement; return e === document.body ? null : `${e.tagName} ${e.getAttribute("aria-label") ?? e.textContent.trim().slice(0, 30)}`; });
await page.keyboard.press("Tab");
const second = await page.evaluate(() => { const e = document.activeElement; return `${e.tagName} ${e.getAttribute("aria-label") ?? e.textContent.trim().slice(0, 30)}`; });
await page.keyboard.press("Shift+Tab");
const back = await page.evaluate(() => { const e = document.activeElement; return `${e.tagName} ${e.getAttribute("aria-label") ?? e.textContent.trim().slice(0, 30)}`; });
check(first !== null && second !== first && back === first, `Tab moves the focus (${first} → ${second}) and Shift+Tab back`);

// Ctrl+K opens the palette with the keyboard in it; Escape closes it.
await page.keyboard.press("Control+k");
await until("Ctrl+K to open the palette", () => document.activeElement?.id === "palette-input");
await page.keyboard.type("settings");
check((await page.locator("#palette-results [role=option]").first().innerText()).includes("Settings"), "the palette finds Settings as it is typed");
await page.keyboard.press("Escape");
await noSheet("Escape to close the palette");
// The palette runs a command with Enter: Settings opens, and Escape closes it.
await page.keyboard.press("Control+k");
await until("the palette again", () => document.activeElement?.id === "palette-input");
await page.keyboard.type("settings");
await page.keyboard.press("Enter");
await until("Enter in the palette to open Settings", () => document.querySelector(".settings-nav") !== null);
await page.keyboard.press("Escape");
check(await noSheet("Escape to close Settings"), "Escape closes a sheet");

// ---------------------------------------------------------------- Settings

// Each section opens, and none fails.
await click(page.locator('.topbar button[aria-label="Settings"]'));
await until("Settings", () => document.querySelector(".settings-nav") !== null);
const sections = await page.locator(".settings-nav button").allInnerTexts();
check(sections.join(",") === "View,Sign-in,Compute,Storage,Developer", `Settings has its sections (${sections.join(", ")})`);
for (const name of sections) {
  await click(page.locator(".settings-nav button", { hasText: name }));
  const opened = await until(`Settings › ${name}`, (n) => document.querySelector('.settings-nav [aria-selected="true"]')?.textContent === n && document.querySelector(".settings-body")?.childElementCount > 0, name);
  const failed = await page.locator(".settings-body .empty.error").count();
  check(opened && failed === 0, `Settings › ${name} opens${failed ? " (it shows an error)" : ""}`);
  if (name === "View") await page.screenshot({ path: `${shots}/2-settings.png` });
}

// Settings › Compute: unpair, then pair again from the form, a wrong token first.
await click(page.locator(".settings-nav button", { hasText: "Compute" }));
await click(page.locator(".runner-unpair").first());
await until("the pairing form after Unpair", () => document.querySelector(".runner-token") !== null && window.workbench.runner.connection() === "unpaired");
await page.locator(".runner-address").first().fill(RUNNER);
await page.locator(".runner-token").first().fill("not-the-token-it-printed");
await page.locator(".runner-token").first().press("Enter");
await until("the refused token said in the panel", () => document.querySelector(".runner-pair-error")?.hidden === false);
check((await page.locator(".runner-pair-error").first().innerText()).includes("refused the pairing token"), "a wrong token is refused in plain words");
await page.locator(".runner-token").first().fill(TOKEN);
await click(page.locator(".runner-pair-button").first());
check(await until("pairing from the form", () => document.querySelector(".runner-connection")?.textContent === "connected"), "Settings › Compute pairs the runner from its form");
await page.keyboard.press("Escape");
await noSheet("Escape to close Settings");

// ------------------------------------------------- a dataset from the fixture

const source = `zarr://${fixture.url}`;
await page.keyboard.press("Control+o");
await until("Ctrl+O to open Open", () => document.activeElement?.id === "open-input");
await page.locator("#open-input").fill(source);
check((await page.locator(".sheet .detected").innerText()).startsWith("A data source."), "Open recognises a data URL");
await click(page.locator(".sheet-foot .btn.primary"));
await noSheet("Open to close");
await until("the fixture's layer to load", () => window.engine.layers().some((l) => l.ready || l.error));
const opened = await page.evaluate(() => window.engine.layers());
check(opened.length === 1 && opened[0].ready && !opened[0].error, `the local OME-Zarr opens as a layer (${JSON.stringify(opened.map((l) => ({ name: l.name, ready: l.ready, error: l.error })))})`);
await until("the status to say ready", () => document.querySelector(".topbar .status")?.dataset.state === "ok");
// The chunk is fetched once the views draw it.
const drew = await Promise.race([fixture.chunkServed.then(() => true), new Promise((r) => setTimeout(() => r(false), STATE_TIMEOUT).unref())]);
check(drew, "the views fetch the fixture's chunk to draw it");
check(await page.evaluate(() => document.querySelector(".start-card").hidden), "the start card goes once the scene has data");
check((await page.evaluate(() => location.hash)).startsWith("#!"), "the address bar holds the state");
await page.screenshot({ path: `${shots}/3-dataset.png` });

// The views fill their column and hold no Neuroglancer interface.
const fill = await page.evaluate(() => document.querySelector(".engine-host").getBoundingClientRect().height / document.querySelector(".engine").getBoundingClientRect().height);
check(fill > 0.98, `the viewer fills the views area (${(fill * 100).toFixed(0)}% of its height)`);
const chrome = await page.evaluate(() => {
  const visible = (sel) => [...document.querySelectorAll(`.engine ${sel}`)].filter((e) => e.offsetParent !== null).length;
  return { layerPanel: visible(".neuroglancer-layer-panel"), sidePanels: visible(".neuroglancer-side-panel"), status: visible("#neuroglancer-status-container") };
});
check(chrome.layerPanel + chrome.sidePanels + chrome.status === 0, `no layer bar, side panels or status inside the views ${JSON.stringify(chrome)}`);

// The Layers panel lists the dataset; its controls are the platform's own tabs.
await until("the dataset in the Layers panel", () => document.querySelectorAll(".datasets .ds-row").length === 1);
await click(page.locator(".datasets .ds-row").first());
await until("the layer's controls", () => document.querySelectorAll(".ins-tabs .tab").length > 0);
await click(page.locator(".ins-tabs .tab", { hasText: "Source" }));
await until("the Source tab", () => document.querySelector(".ins-url-field textarea") !== null);
check((await page.locator(".ins-url-field textarea").first().inputValue()).includes(fixture.url.replace(/\/$/, "")), "Source shows the data source URL");
await click(page.locator(".ins-tabs .tab", { hasText: "Display" }));
check(await until("the Display tab's sliders", () => document.querySelectorAll(".ins-content .ins-slider").length >= 1), "Display shows the layer's sliders");

// Hide and show the dataset from its row.
await page.locator(".datasets .ds-row .choice input").first().uncheck({ force: true });
check(await until("the dataset hidden", () => window.engine.layers()[0].visible === false), "the row's checkbox hides the dataset");
await page.locator(".datasets .ds-row .choice input").first().check({ force: true });
await until("the dataset shown", () => window.engine.layers()[0].visible === true);

// The palette changes the layout, and undo restores it without fetching anything again.
const layoutBefore = await page.evaluate(() => window.engine.layout());
await page.keyboard.press("Control+k");
await until("the palette", () => document.activeElement?.id === "palette-input");
await page.keyboard.type("layout 3d");
await page.keyboard.press("Enter");
check(await until("Layout: 3D", () => window.engine.layout() === "3d"), "the palette ran Layout: 3D");
await click(page.locator(".brand")); // the page has the keyboard, not an input
const fetchedBefore = fixture.served.length;
await page.keyboard.press("Control+z");
check(await until("undo", (l) => window.engine.layout() === l, layoutBefore), "undo restored the layout");
check(fixture.served.length === fetchedBefore, `undo fetched nothing again (${fixture.served.slice(fetchedBefore).join(", ") || "nothing"})`);

// --------------------------------------------------------------------- Share

await click(page.locator(".topbar button", { hasText: "Share" }));
await until("the Share menu", () => document.querySelector(".menu") !== null);
const shareItems = await page.locator(".menu .menu-item").allInnerTexts();
check(shareItems.includes("Copy workspace link") && shareItems.includes("Save workspace as a file") && shareItems.includes("Copy scene as Neuroglancer link"), `Share offers the link, the file and Neuroglancer (${shareItems.length} items)`);
check(await page.evaluate(() => document.activeElement?.classList.contains("menu-item")), "the Share menu has the keyboard");
await page.keyboard.press("Escape");
check(await until("Escape to close the Share menu", () => document.querySelector(".menu") === null), "Escape closes the Share menu");
await click(page.locator(".topbar button", { hasText: "Share" }));
await until("the Share menu", () => document.querySelector(".menu") !== null);
await click(page.locator(".menu .menu-item", { hasText: "Copy workspace link" }));
// The clipboard, or the sheet that shows the link when the clipboard refuses.
await until("the link copied", () => document.querySelector("#copy-fallback") !== null || [...document.querySelectorAll(".toast")].some((t) => /cop/i.test(t.textContent)));
const copied = (await sheetOpen()) ? await page.locator("#copy-fallback").inputValue() : await page.evaluate(() => navigator.clipboard.readText());
check(copied.startsWith(base) && copied.includes("#!") && copied.includes("ball.ome.zarr"), `Copy workspace link copies the workspace (${copied.slice(0, 60)}…)`);
if (await sheetOpen()) await page.keyboard.press("Escape");

// --------------------------------------------------------------------- scenes

await click(page.locator(".scene-add"));
check(await until("a new scene", () => document.querySelectorAll(".scene-tab").length === 2 && window.engine.layers().length === 0), "New scene adds an empty scene");
check(await until("the start card in the new scene", () => document.querySelector(".start-card")?.hidden === false), "the start card shows over the new, empty scene");
await click(page.locator(".scene-tab").first());
check(await until("Scene 1 again", () => document.querySelector('.scene-tab[aria-selected="true"]')?.textContent.includes("Scene 1") && window.engine.layers().length === 1), "switching back to Scene 1 brings its dataset");

// ------------------------------------------------ local data, through the service worker

await until("the service worker to control the page", () => navigator.serviceWorker.controller !== null);
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
  navigator.serviceWorker.controller.postMessage({ type: "local-register", id });
  const [found] = await wb.localData.detect(id);
  const root = found.source.replace(/^zarr3:\/\//, "");
  const group = await (await fetch(`${root}zarr.json`)).json();
  const chunk = new Int16Array(await (await fetch(`${root}0/c/0/0/0`)).arrayBuffer());
  return { source: found.source, version: group.attributes?.ome?.version, voxels: [chunk[0], chunk[1], chunk[40], chunk[40 * 30 * 19 + 39]] };
});
check(local.version === "0.6", `a local NIfTI is served as OME-Zarr through the service worker (${local.source})`);
check(JSON.stringify(local.voxels) === JSON.stringify([0, 1, 40, 839]), `its chunks hold the file's voxels (${local.voxels})`);
await page.evaluate((src) => {
  window.workbench.store.newScene({ name: "local" });
  window.workbench.store.addDataset({ source: src, name: "smoke", kind: "image" });
}, local.source);
await until("the local NIfTI's layer", () => window.engine.layers().some((l) => l.name === "smoke" && (l.ready || l.error)));
const nifti = (await page.evaluate(() => window.engine.layers())).find((l) => l.name === "smoke");
check(nifti?.ready === true && !nifti.error, `the local NIfTI opens as a layer${nifti?.ready ? "" : ` (${JSON.stringify(nifti)})`}`);

// ------------------------------------------------------------- narrow screen

await page.setViewportSize({ width: 400, height: 800 });
await until("the narrow layout", () => window.innerWidth === 400);
await page.screenshot({ path: `${shots}/4-phone.png` });
const past = await page.evaluate(() =>
  [...document.querySelectorAll("body *")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; })
    .slice(0, 4)
    .map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}`),
);
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll at 400 px${past.length ? ` (past the edge: ${past.join(", ")})` : ""}`);

// ------------------------------------------------------------------- the end

check(offMachine.length === 0, `nothing fetched off this machine${offMachine.length ? `: ${[...new Set(offMachine)].slice(0, 4).join(", ")}` : ""}`);
check(pageErrors.length === 0, `no page errors${pageErrors.length ? `:\n  ${[...new Set(pageErrors)].slice(0, 5).join("\n  ")}` : ""}`);
if (consoleErrors.length) console.log(`console errors (not failures):\n  ${[...new Set(consoleErrors)].slice(0, 8).join("\n  ")}`);
await browser.close();
fixture.server.close();
console.log(failures === 0 ? "smoke test passed" : `${failures} check${failures === 1 ? "" : "s"} failed`);
process.exitCode = failures === 0 ? 0 : 1;
