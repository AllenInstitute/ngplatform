import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, extname } from "node:path";
const require = createRequire("/home/andrew/neuroglancer/package.json");
const { chromium } = require("playwright-core");
const root = process.argv[2];
const types = { ".html": "text/html", ".json": "application/json", ".mjs": "text/javascript" };
const srv = createServer((q, r) => {
  const p = join(root, decodeURIComponent(q.url.split("?")[0]));
  r.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  r.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (!existsSync(p) || statSync(p).isDirectory()) { r.statusCode = 404; return r.end(); }
  r.setHeader("Content-Type", types[extname(p)] ?? "application/octet-stream");
  r.end(readFileSync(realpathSync(p)));
}).listen(5198);
// SwiftShader only (no GPU), as for every automated check here.
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("pageerror", e.message));
await p.goto("http://localhost:5198/index.html");
await p.waitForFunction(() => document.title === "done", null, { timeout: 600000 });
console.log(JSON.stringify(await p.evaluate(() => window.__report), null, 1));
await b.close(); srv.close();
