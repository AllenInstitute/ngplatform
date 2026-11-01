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

const status = () => page.locator(".status").innerText();
async function waitReady(label, timeout = 90_000) {
  await page.waitForFunction(() => /ready/.test(document.querySelector(".status")?.textContent ?? ""), null, { timeout });
  await page.waitForTimeout(4000); // let chunks stream in and draw
  console.log(`${label}: ${await status()}`);
}
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) process.exitCode = 1; };
const layers = () => page.evaluate(() => window.engine.layers());

await page.goto(base);
await waitReady("default example");
await page.screenshot({ path: `${shots}/1-default.png` });
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
await page.locator(".datasets .ds-row").first().click();
await page.waitForTimeout(800);
check((await page.locator(".ins-tab").count()) > 0 && (await page.locator(".ins-root .neuroglancer-tab-label").count()) === 0, "the Layer tab shows the layer's controls in the platform's own tabs");
// The inspector's tabs, built by the platform from the layer's models.
await page.locator(".ins-tab", { hasText: "Source" }).click();
await page.waitForTimeout(800);
check((await page.locator(".ins-url").first().inputValue()).includes("hcp1065"), "Source shows the data source URL");
check((await page.locator(".ins-tx-grid input").count()) > 0, "Source shows the transform as an editable table");
await page.locator(".ins-tab", { hasText: "Render" }).click();
await page.waitForTimeout(800);
check((await page.locator(".ins-content .ins-slider").count()) >= 4, "Render shows the layer's sliders");
await page.locator(".ins-tab", { hasText: "Segments" }).click();
await page.waitForTimeout(800);
await page.locator(".ins-status button").click();
await page.waitForTimeout(1500);
check((await page.locator(".ins-seg-row:not(.ins-seg-head)").count()) > 5, `Segments lists the segments (${await page.locator(".ins-status").innerText()})`);
await page.locator(".ins-query").fill("");
await page.waitForTimeout(500);

// Hide and show the dataset from its row.
await page.locator(".datasets .ds-row .vis").first().uncheck();
await page.waitForTimeout(500);
check((await layers())[0].visible === false, "the row's checkbox hides the dataset");
await page.locator(".datasets .ds-row .vis").first().check();

// The volume view, in place of the 3-D panel: BigBrain, cut open, with the groups.
await page.waitForTimeout(6000);
check((await page.locator(".vv-host canvas").count()) === 1, "volume view shown in place of the 3-D panel");
const volumeStatus = (await page.locator(".vv-status").textContent()) ?? "";
check(!/Cannot draw|Could not|shader|program/.test(volumeStatus), `volume view draws (${volumeStatus})`);
await page.screenshot({ path: `${shots}/1b-volume.png` });

// Palette: change the layout, then undo it.
await page.waitForTimeout(1500);
const layoutBefore = await page.evaluate(() => window.engine.layout());
dataRequests = 0;
await page.keyboard.press("Control+k");
await page.locator("#palette-input").fill("layout 3d");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
check(await page.evaluate(() => window.engine.layout() === "3d"), "palette ran Layout: 3D");
await page.screenshot({ path: `${shots}/2-3d.png` });
await page.locator(".brand").click(); // focus the page, not an input
// Undo restores the state in place: nothing is fetched again. (The 3-D
// panel the layout added may fetch for itself before this.)
await page.waitForTimeout(3000);
dataRequests = 0;
requested.length = 0;
await page.keyboard.press("Control+z");
await page.waitForTimeout(1500);
check((await page.evaluate(() => window.engine.layout())) === layoutBefore, "undo restored the layout");
check(dataRequests === 0, `undo made no data requests (${dataRequests}${requested.length ? `: ${[...new Set(requested.map((u) => u.replace(/[?#].*/, "").split("/").slice(-4).join("/")))].slice(0, 4).join(", ")}` : ""})`);

// Scenes: a new empty scene, the dataset added from the workspace, and back.
await page.locator(".scene-add").click();
await page.waitForTimeout(800);
check((await page.locator(".scene-tab").count()) === 2, "New scene adds a scene tab");
check((await layers()).length === 0, "the new scene starts empty");
await page.locator(".ds-row.other .btn").first().click();
await page.waitForTimeout(800);
// The dataset's own layer, and its track groups' layers with it.
check((await layers()).length >= 1, "a workspace dataset adds to the new scene");
await page.locator(".scene-tab").first().click();
await page.waitForTimeout(800);
check((await page.locator('.scene-tab[aria-selected="true"]').innerText()) === "Scene 1", "switching back to Scene 1");

// Plugins: both listed with a switch; the filtering tab reads the attributes.
await page.locator("#tab-plugins").click();
check((await page.locator(".plugin .switch").count()) >= 2, "the Plugins tab lists the plugins with switches");
await page.locator('[id="tab-trackFiltering.panel"]').click();
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

// Narrow screen.
await page.setViewportSize({ width: 400, height: 800 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/4-phone.png` });
const past = await page.evaluate(() =>
  [...document.querySelectorAll("body *")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; })
    .slice(0, 4)
    .map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}`),
);
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll at 400 px${past.length ? ` (past the edge: ${past.join(", ")})` : ""}`);

console.log(problems.length ? `console errors:\n  ${[...new Set(problems)].slice(0, 10).join("\n  ")}` : "no console errors");
await browser.close();
