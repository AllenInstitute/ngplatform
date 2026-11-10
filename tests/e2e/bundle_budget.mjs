// The bundle-size budget, which CI checks after the build: it fails when
// the JavaScript the app's page fetches before its code runs (the scripts
// and module preloads index.html lists; see tests/e2e/bundle.mjs) or the
// largest JavaScript file the build makes grows past its limit.
//
//   npm run build && npm run budget [-- dist]
//
// The limits sit a little above the sizes of 2026-11-10 (raw startup JS
// 2,088 KiB, 636 KiB gzipped; largest file 932 KiB, Neuroglancer's
// default_provider chunk).  Raise one deliberately, in the commit that
// needs it, saying why.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const KiB = 1024;
const LIMITS = {
  startupRaw: 2200 * KiB,
  startupGzip: 670 * KiB,
  largestChunk: 980 * KiB,
};

const dist = process.argv[2] ?? "dist";
const html = readFileSync(join(dist, "index.html"), "utf8");
const startup = [...new Set([...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\.\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]))];
if (startup.length === 0) throw new Error(`${dist}/index.html lists no scripts: is it a build?`);
let startupRaw = 0;
let startupGzip = 0;
for (const file of startup) {
  const bytes = readFileSync(join(dist, file));
  startupRaw += bytes.length;
  startupGzip += gzipSync(bytes, { level: 9 }).length;
}
const chunks = readdirSync(join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ file: `assets/${f}`, size: statSync(join(dist, "assets", f)).size }))
  .sort((a, b) => b.size - a.size);
const largest = chunks[0];

const kib = (n) => `${(n / KiB).toFixed(1)} KiB`;
const rows = [
  ["startup JS", `${startup.length} files`, startupRaw, LIMITS.startupRaw],
  ["startup JS, gzipped", `${startup.length} files`, startupGzip, LIMITS.startupGzip],
  ["largest JS file", largest.file, largest.size, LIMITS.largestChunk],
];
let over = 0;
for (const [what, detail, size, limit] of rows) {
  const ok = size <= limit;
  if (!ok) over++;
  console.log(`${ok ? "ok  " : "OVER"} ${what.padEnd(20)} ${kib(size).padStart(12)} of ${kib(limit).padStart(12)}  (${detail})`);
}
if (over > 0) {
  console.error(`\n${over} bundle budget${over === 1 ? "" : "s"} exceeded. Find what grew with tests/e2e/bundle.mjs; raise a limit in ${import.meta.url.split("/").pop()} only on purpose.`);
  process.exitCode = 1;
}
