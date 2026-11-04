// What a built page fetches before its code runs (docs/dev/speed.md): the
// scripts, module preloads and stylesheets index.html lists, raw and gzipped.
//
//   node tests/e2e/bundle.mjs [dist] [page.html]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const [dist = "dist", pageName = "index.html"] = process.argv.slice(2);
const html = readFileSync(join(dist, pageName), "utf8");
const files = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\.\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const kib = (n) => (n / 1024).toFixed(1).padStart(8);
const total = { js: [0, 0], css: [0, 0] };
const rows = files.map((f) => {
  const bytes = readFileSync(join(dist, f));
  const gz = gzipSync(bytes, { level: 9 }).length;
  const kind = f.endsWith(".css") ? "css" : "js";
  total[kind][0] += bytes.length;
  total[kind][1] += gz;
  return [f, bytes.length, gz];
});
rows.sort((a, b) => b[1] - a[1]);
console.log(`${"file".padEnd(48)}  raw KiB gzip KiB`);
for (const [f, raw, gz] of rows) console.log(`${f.padEnd(48)} ${kib(raw)} ${kib(gz)}`);
for (const kind of ["js", "css"]) console.log(`${`${kind}, ${rows.filter((r) => r[0].endsWith(`.${kind}`)).length} files`.padEnd(48)} ${kib(total[kind][0])} ${kib(total[kind][1])}`);
