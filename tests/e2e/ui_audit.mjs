// UI audit: screenshots of every scene, dock, tool and sheet with all the
// plugins on, and the computed styles of each panel, measured and compared
// with the baseline in plans/ui-audit-baseline.json (see plans/README.md).
//
//   npm run build && (cd dist && python3 -m http.server 4174 &)
//   npm run ui:audit -- [base-url] [out-dir]
//
// Writes <out-dir>/report.json (per panel), <out-dir>/report.md (the
// measures against the baseline) and the screenshots; exits 1 when a
// measure is worse than the baseline.  UI_AUDIT_BASELINE=1 records this run
// as the baseline instead.  NGP_RUNNER="<address> <token>" pairs a runner,
// so the tools that need one show their full panels.  CHROME and
// SWIFTSHADER as for smoke.mjs.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
const out = process.argv[3] ?? "tests/e2e/ui-audit";
const baselineFile = new URL("../../plans/ui-audit-baseline.json", import.meta.url);
mkdirSync(out, { recursive: true });

const gpu = process.env.CHROME !== undefined && !process.env.SWIFTSHADER;
// (Beside the real binary: /usr/bin/google-chrome is a link.)
const icd = join(dirname(realpathSync(process.env.CHROME ?? chromium.executablePath())), "vk_swiftshader_icd.json");
const env = !gpu && existsSync(icd) ? { ...process.env, VK_ICD_FILENAMES: icd, VK_DRIVER_FILES: icd } : undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: gpu
    ? ["--ignore-gpu-blocklist", "--enable-gpu"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan"],
  env,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on("pageerror", (e) => problems.push(String(e)));

// Every plugin on, and a runner when one is given, from a clean browser.
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.workbench !== undefined, null, { timeout: 60_000 });
const plugins = await page.evaluate(() => window.workbench.pluginSwitches.manifests.map((m) => m.id));
const runner = process.env.NGP_RUNNER?.split(/\s+/);
await page.evaluate(
  ({ plugins, runner }) => {
    localStorage.clear();
    localStorage.setItem("ngplatform.plugins.enabled", JSON.stringify(Object.fromEntries(plugins.map((id) => [id, true]))));
    if (runner) localStorage.setItem("ngplatform.runner", JSON.stringify({ address: runner[0], token: runner[1] }));
  },
  { plugins, runner },
);

const shots = [];
async function shot(name, locator) {
  const path = `${out}/${name}.png`;
  if (locator) await locator.screenshot({ path }).catch(() => page.screenshot({ path }));
  else await page.screenshot({ path });
  shots.push(name);
}

/** The computed styles of the visible elements under `sel`, tallied by kind. */
const measure = (sel) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
    };
    const all = [...root.querySelectorAll("*")].filter(visible);
    const sig = (e, keys) => {
      const c = getComputedStyle(e);
      return keys.map((k) => c[k]).join(" | ");
    };
    const tally = (els, keys) => {
      const m = {};
      for (const e of els) m[sig(e, keys)] = (m[sig(e, keys)] || 0) + 1;
      return m;
    };
    const text = all.filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    const buttons = all.filter((e) => e.tagName === "BUTTON");
    const inputs = all.filter((e) => (e.tagName === "INPUT" && !["checkbox", "radio", "range", "file"].includes(e.type)) || e.tagName === "SELECT" || e.tagName === "TEXTAREA");
    const checks = all.filter((e) => e.tagName === "INPUT" && e.type === "checkbox");
    const heads = all.filter((e) => /^H[1-6]$/.test(e.tagName) || e.matches(".section-title,.card-title,summary,legend"));
    return {
      fontSizes: tally(text, ["fontSize"]),
      fonts: tally(text, ["fontFamily"]),
      colors: tally(text, ["color"]),
      buttons: tally(buttons, ["fontSize", "height", "borderRadius", "backgroundColor", "borderTopColor"]),
      inputs: tally(inputs, ["fontSize", "height", "borderRadius", "backgroundColor"]),
      checkboxes: checks.reduce((m, c) => ((m[c.className || "plain"] = (m[c.className || "plain"] || 0) + 1), m), {}),
      headings: tally(heads, ["fontSize", "fontWeight", "textTransform", "color", "letterSpacing"]),
      radii: tally(all.filter((e) => getComputedStyle(e).borderRadius !== "0px"), ["borderRadius"]),
      inlineStyled: all.filter((e) => e.getAttribute("style")).length,
      words: (root.innerText.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length,
      controls: buttons.length + inputs.length + checks.length,
    };
  }, sel);

const panels = {};
async function open(hash) {
  await page.goto(base + hash, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.workbench !== undefined, null, { timeout: 60_000 });
  await page.waitForTimeout(8000);
}
const enabledPanels = () =>
  page.evaluate(() => {
    const s = window.workbench.pluginSwitches;
    return s.manifests.filter((m) => s.enabled.has(m.id)).flatMap((m) => (m.contributes?.panels ?? []).map((p) => ({ id: p.id, plugin: m.name })));
  });
const show = (id) => page.evaluate((id) => window.workbench.docks.show(id), id);
const pane = (id) => `.dock-pane[data-tab="${id}"]`;
const safe = (s) => s.replace(/\W+/g, "_");

async function toolPanels(scene, prefix, only) {
  for (const p of await enabledPanels()) {
    if (only && !only.test(p.id)) continue;
    await show(p.id);
    await page.waitForTimeout(1500);
    if (!(await page.locator(pane(p.id)).count())) continue;
    panels[`${p.plugin} (${scene})`] = await measure(pane(p.id));
    await shot(`${prefix}_${safe(p.id)}`, page.locator(pane(p.id)).locator(".."));
  }
}

async function sheet(name, run) {
  await run();
  await page.waitForTimeout(900);
  panels[`Sheet: ${name}`] = await measure(".scrim .sheet");
  await shot(`3_sheet_${safe(name)}`, page.locator(".scrim .sheet"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

// An empty workspace: the start card.
await open("");
await shot("00_start");
panels["Start card"] = await measure(".start-card");

// Images (SRB): the docks, every tool, the sheets and menus.
await open("#example=srb-2026a");
await shot("01_srb");
panels["Layers (image)"] = await measure(pane("layers"));
await shot("10_layers_image", page.locator(".dock-left"));
await show("plugins");
await page.waitForTimeout(500);
panels["Plugins"] = await measure(pane("plugins"));
await shot("11_plugins", page.locator(".dock-left"));
await toolPanels("SRB", "2_srb");
await show("activity");
await page.waitForTimeout(600);
await shot("12_bottom_open");
panels["Activity"] = await measure(pane("activity"));
await sheet("Open", () => page.locator(".topbar button", { hasText: "Open" }).first().click());
for (const section of ["view", "sign-in", "compute", "storage", "developer"]) {
  await sheet(`Settings ${section}`, () => page.evaluate((s) => window.workbench.run("settings.open", { section: s }), section));
}
await sheet("Keyboard", () => page.evaluate(() => window.workbench.run("help.shortcuts")));
await sheet("Capture", () => page.evaluate(() => window.workbench.run("view.capture")));
await sheet("Add dataset", () => page.evaluate(() => window.workbench.run("dataset.add")));
await sheet("Add collection", () => page.evaluate(() => window.workbench.run("collections.add")));
await page.locator(".topbar button", { hasText: "Share" }).first().click();
await page.waitForTimeout(400);
await shot("4_menu_Share");
await page.keyboard.press("Escape");

// Tractograms (S-21-46): the vector tools.
await open("#example=s2146-mni");
await shot("05_tracts");
panels["Layers (tracts)"] = await measure(pane("layers"));
await toolPanels("tracts", "6_tracts", /filtering|luxar|orientation|vectors/i);

// EM (MICrONS): the label tools; then a laptop's window.
await open("#example=microns");
await shot("07_microns");
panels["Layers (EM)"] = await measure(pane("layers"));
await toolPanels("EM", "8_em", /segment|atlas|annot|luxar/i);
await page.setViewportSize({ width: 1280, height: 760 });
await page.waitForTimeout(800);
await shot("09_laptop_em");
await browser.close();

// The measures across every panel and sheet (as in plans/README.md).
const kinds = (cat) => new Set(Object.values(panels).flatMap((p) => (p ? Object.keys(p[cat]) : []))).size;
const measured = Object.values(panels).filter(Boolean);
const summary = {
  "Font sizes": kinds("fontSizes"),
  "Button styles": kinds("buttons"),
  "Input and select styles": kinds("inputs"),
  "Heading styles": kinds("headings"),
  "Corner radii": kinds("radii"),
  // Text in the browser's own font, not the app's (mostly controls).
  "Text in the browser's default font": measured.reduce((n, p) => n + (p.fonts["sans-serif"] ?? 0), 0),
  "Elements with inline styles": measured.reduce((n, p) => n + p.inlineStyled, 0),
  "Panels mixing switches and checkboxes": measured.filter((p) => p.checkboxes.switch && p.checkboxes.plain).length,
};

if (process.env.UI_AUDIT_BASELINE) writeFileSync(baselineFile, JSON.stringify({ summary, panels }, null, 1) + "\n");
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : undefined;
const worse = Object.keys(summary).filter((k) => baseline && summary[k] > (baseline.summary[k] ?? Infinity));
const row = (cells) => `| ${cells.join(" | ")} |`;
const md = [
  "# UI audit",
  "",
  row(["Measure", "Baseline", "Now"]),
  row(["---", "---", "---"]),
  ...Object.entries(summary).map(([k, v]) => row([k, baseline?.summary[k] ?? "", worse.includes(k) ? `**${v}** (worse)` : v])),
  "",
  row(["Panel", "Words", "Controls", "Font sizes", "Buttons", "Inputs", "Headings", "Radii", "Inline"]),
  row(Array(9).fill("---")),
  ...Object.entries(panels)
    .filter(([, p]) => p)
    .map(([k, p]) => row([k, p.words, p.controls, Object.keys(p.fontSizes).length, Object.keys(p.buttons).length, Object.keys(p.inputs).length, Object.keys(p.headings).length, Object.keys(p.radii).length, p.inlineStyled])),
  "",
  `${shots.length} screenshots; ${problems.length} page errors${problems.length ? ": " + problems.slice(0, 5).join("; ") : ""}.`,
];
writeFileSync(`${out}/report.json`, JSON.stringify({ summary, panels, shots, problems }, null, 1));
writeFileSync(`${out}/report.md`, md.join("\n") + "\n");
console.log(md.slice(0, Object.keys(summary).length + 4).join("\n"));
console.log(`\n${shots.length} screenshots in ${out}; ${problems.length} page errors.`);
if (worse.length) {
  console.log(`Worse than the baseline: ${worse.join(", ")}.`);
  process.exitCode = 1;
}
