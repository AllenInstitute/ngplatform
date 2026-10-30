// Smoke test: load the built app in headless Chromium and drive the shell.
//
//   npm run build && npx vite preview --port 4173 &
//   node e2e/smoke.mjs [base-url] [screenshot-dir]
//
// WebGL comes from SwiftShader, so this runs on machines without a GPU.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

// A project install of playwright, or a global one reached through NODE_PATH.
const { chromium } = createRequire(import.meta.url)("playwright");

const base = process.argv[2] ?? "http://localhost:4173/";
const shots = process.argv[3] ?? "e2e/screenshots";
mkdirSync(shots, { recursive: true });

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  proxy,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(String(e)));

const status = () => page.locator(".status").innerText();
async function waitReady(label, timeout = 90_000) {
  await page.waitForFunction(() => /ready/.test(document.querySelector(".status")?.textContent ?? ""), null, { timeout });
  await page.waitForTimeout(4000); // let chunks stream in and draw
  console.log(`${label}: ${await status()}`);
}
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) process.exitCode = 1; };

await page.goto(base);
await waitReady("default example");
await page.screenshot({ path: `${shots}/1-default.png` });
check((await page.evaluate(() => location.hash)).startsWith("#!"), "address bar holds the state");
check((await page.locator(".dock-left .facts").count()) > 0, "workspace dock shows store facts");

// Palette: switch to the 3D layout, then undo it.
await page.keyboard.press("Control+k");
await page.locator("#palette-input").fill("layout 3d");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
check((await page.locator('.segmented button[aria-pressed="true"]').innerText()) === "3D", "palette ran Layout: 3D");
await page.screenshot({ path: `${shots}/2-3d.png` });
await page.mouse.click(10, 10); // focus the page, not an input
await page.keyboard.press("Control+z");
await page.waitForTimeout(800);
check((await page.locator('.segmented button[aria-pressed="true"]').innerText()) === "XY + 3D", "undo restored the layout");

// Hover a view so the inspector shows the pointer.
const engine = await page.locator(".engine").boundingBox();
await page.mouse.move(engine.x + engine.width * 0.25, engine.y + engine.height * 0.5);
await page.waitForTimeout(600);
if ((await page.locator(".coord").count()) >= 3) check(true, "inspector shows pointer coordinates");
else if (problems.some((p) => p.includes("Framebuffer configuration not supported")))
  console.log("skip inspector pointer check: this browser's WebGL cannot draw Neuroglancer's views");
else check(false, "inspector shows pointer coordinates");

// Open dialog: the bundled excerpt.
await page.keyboard.press("Control+o");
await page.locator(".example", { hasText: "bundled excerpt" }).getByRole("button", { name: "Open" }).click();
await waitReady("bundled excerpt");
await page.screenshot({ path: `${shots}/3-excerpt.png` });

// Open dialog: a pasted plain Neuroglancer link is recognised.
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
