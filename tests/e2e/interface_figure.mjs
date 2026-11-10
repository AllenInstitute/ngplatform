// The interface figures in docs/images: the SRB example at 1440 × 900 with
// a tool open (Filters, in the Tools dock) and the Activity dock open, once
// plain and once with the numbers docs/guide/interface.md uses drawn over
// it (1 top bar, 2 left dock, 3 views, 4 Tools dock, 5 Activity dock).
//
//   npm run build && (cd dist && python3 -m http.server 4174 &)
//   node tests/e2e/interface_figure.mjs [base-url] [out-dir]
//
// CHROME and SWIFTSHADER as for smoke.mjs.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const base = process.argv[2] ?? "http://localhost:4174/";
const out = process.argv[3] ?? "docs/images";

const gpu = process.env.CHROME !== undefined && !process.env.SWIFTSHADER;
const icd = join(dirname(realpathSync(process.env.CHROME ?? chromium.executablePath())), "vk_swiftshader_icd.json");
const env = !gpu && existsSync(icd) ? { ...process.env, VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd } : undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  env,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// From a clean browser, with Filters on (a tool, so the Tools dock shows).
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.workbench !== undefined, null, { timeout: 60_000 });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("ngplatform.plugins.enabled", JSON.stringify({ "org.ngplatform.filters": true }));
});
await page.goto(base + "#example=srb-2026a", { waitUntil: "domcontentloaded" });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.workbench !== undefined, null, { timeout: 60_000 });
await page.waitForTimeout(8000);
await page.evaluate(() => {
  window.workbench.docks.show("layers");
  window.workbench.docks.show("filters.panel");
  window.workbench.docks.show("activity");
});
await page.waitForTimeout(4000);
// No toasts or offers over the figure.
await page.evaluate(() => document.querySelectorAll(".toast, .toasts > *, .offer").forEach((e) => e.remove()));
await page.mouse.move(1, 899);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/interface.png` });

// The numbers, centred on each part, drawn over the page.
await page.evaluate(() => {
  const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const top = rect(".topbar");
  const left = rect(".dock-left");
  const right = rect(".dock-right");
  const bottom = rect(".dock-bottom");
  const views = { left: left.right, right: right.left, top: top.bottom, bottom: bottom.top };
  const marks = [
    [1, (top.left + top.right) / 2 + 120, (top.top + top.bottom) / 2],
    [2, left.left + left.width * 0.8, left.top + left.height * 0.825],
    [3, (views.left + views.right) / 2, views.top + (views.bottom - views.top) * 0.5],
    [4, (right.left + right.right) / 2, right.top + right.height * 0.62],
    [5, (bottom.left + bottom.right) / 2, (bottom.top + bottom.bottom) / 2],
  ];
  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:100000";
  for (const [n, x, y] of marks) {
    const m = document.createElement("div");
    m.textContent = String(n);
    m.style.cssText = `position:absolute;left:${x - 18}px;top:${y - 18}px;width:36px;height:36px;border-radius:50%;background:#2ecc71;color:#000;border:2px solid #000;box-shadow:0 0 0 2px #2ecc71;font:700 22px/32px "IBM Plex Sans",sans-serif;text-align:center`;
    layer.append(m);
  }
  document.body.append(layer);
});
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/interface-numbered.png` });
await browser.close();
