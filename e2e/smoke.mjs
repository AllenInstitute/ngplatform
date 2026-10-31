// Smoke test: load the built app in Chromium and drive the platform GUI.
//
//   npm run build && (cd dist && python3 -m http.server 4174 &)
//   node e2e/smoke.mjs [base-url] [screenshot-dir]
//
// Set CHROME=/path/to/chrome to use an installed Chrome with the machine's
// GPU; otherwise Playwright's Chromium runs with SwiftShader, which cannot
// draw Neuroglancer's views (checks that need drawing are then skipped).
import { mkdirSync } from "node:fs";
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
const shots = process.argv[3] ?? "e2e/screenshots";
mkdirSync(shots, { recursive: true });

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
const gpu = process.env.CHROME !== undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  proxy,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(String(e)));
const cannotDraw = () => problems.some((p) => p.includes("Framebuffer configuration not supported"));
let dataRequests = 0;
page.on("request", (r) => { if (!r.url().startsWith(base)) dataRequests++; });

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
check((await page.locator(".datasets .ds-row").count()) === 1, "Datasets lists the scene's dataset");
await page.locator(".datasets .ds-row").first().click();
await page.waitForTimeout(800);
check((await page.locator(".ngp-layer-controls .neuroglancer-tab-label").count()) > 0, "the Layer tab shows the layer's own controls");

// Hide and show the dataset from its row.
await page.locator(".datasets .ds-row .vis").first().uncheck();
await page.waitForTimeout(500);
check((await layers())[0].visible === false, "the row's checkbox hides the dataset");
await page.locator(".datasets .ds-row .vis").first().check();

// Palette: change the layout, then undo it, with no data requests.
await page.waitForTimeout(1500);
dataRequests = 0;
await page.keyboard.press("Control+k");
await page.locator("#palette-input").fill("layout 3d");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
check(await page.evaluate(() => window.engine.layout() === "3d"), "palette ran Layout: 3D");
await page.screenshot({ path: `${shots}/2-3d.png` });
await page.locator(".brand").click(); // focus the page, not an input
await page.keyboard.press("Control+z");
await page.waitForTimeout(1500);
check(await page.evaluate(() => window.engine.layout() === "xy-3d"), "undo restored the layout");
check(dataRequests === 0, `layout change and undo made no data requests (${dataRequests})`);

// Scenes: a new empty scene, the dataset added from the workspace, and back.
await page.locator(".scene-add").click();
await page.waitForTimeout(800);
check((await page.locator(".scene-tab").count()) === 2, "New scene adds a scene tab");
check((await layers()).length === 0, "the new scene starts empty");
await page.locator(".ds-row.other .btn").first().click();
await page.waitForTimeout(800);
check((await layers()).length === 1, "a workspace dataset adds to the new scene");
await page.locator(".scene-tab").first().click();
await page.waitForTimeout(800);
check((await page.locator('.scene-tab[aria-selected="true"]').innerText()) === "Scene 1", "switching back to Scene 1");

// Plugins: both listed with a switch; the filtering tab reads the attributes.
await page.locator("#tab-plugins").click();
check((await page.locator(".plugin .switch").count()) >= 2, "the Plugins tab lists the plugins with switches");
await page.locator('[id="tab-trackFiltering.panel"]').click();
await page.waitForSelector(".tf-summary", { timeout: 60_000 }).catch(() => {});
check((await page.locator(".tf-summary").count()) === 1, "Filtering shows how many objects pass");

// Open dialog: the bundled excerpt, and a pasted plain Neuroglancer link.
await page.keyboard.press("Control+o");
await page.locator(".example", { hasText: "bundled excerpt" }).getByRole("button", { name: "Open" }).click();
await waitReady("bundled excerpt");
await page.screenshot({ path: `${shots}/3-excerpt.png` });
await page.keyboard.press("Control+o");
await page.locator("#open-input").fill('https://neuroglancer-demo.appspot.com/#!{"layers":[]}');
check((await page.locator(".detected").innerText()).startsWith("Neuroglancer state, 0 layers"), "Open recognises a Neuroglancer link");
await page.keyboard.press("Escape");

// Narrow screen.
await page.setViewportSize({ width: 400, height: 800 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${shots}/4-phone.png` });
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 400 px");

console.log(problems.length ? `console errors:\n  ${[...new Set(problems)].slice(0, 10).join("\n  ")}` : "no console errors");
await browser.close();
