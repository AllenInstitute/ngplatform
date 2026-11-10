// The casts into Neuroglancer's internals in src/engine/inspector (the
// Layers panel's controls, built on Neuroglancer's own widgets and
// state): each type assertion, sorted by kind.  docs/dev/neuroglancer-casts.md
// says what each kind means and what to do when Neuroglancer changes.
//
//   node scripts/neuroglancer_casts.mjs           counts by kind and file
//   node scripts/neuroglancer_casts.mjs --list    every cast, file:line
//   node scripts/neuroglancer_casts.mjs --list any   one kind
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(root, "package.json"))("typescript");
const DIR = "src/engine/inspector";

/** What a cast does, by its target type. */
export const KINDS = {
  any: "`as any`: a member Neuroglancer has but does not declare (or declares private)",
  never: "`as never`: a value handed to a Neuroglancer function whose parameter type is internal or too narrow",
  watchable: "`as Watch<…>`: a Neuroglancer property read as a watchable value (value + changed)",
  shape: "`as { … }` or `as unknown as …`: a structural view of a Neuroglancer object",
  named: "`as <Neuroglancer type>`: a layer, source or query taken as a more specific Neuroglancer class",
  dom: "`as HTML…Element`: the app's own elements (not into Neuroglancer)",
  value: "Errors, tuples and literals (not into Neuroglancer)",
};
const INTO_NEUROGLANCER = ["any", "never", "watchable", "shape", "named"];

function kindOf(type, double) {
  if (double || type.startsWith("{")) return "shape";
  if (type === "any" || type === "any[]") return "any";
  if (type === "never") return "never";
  if (type.startsWith("Watch<")) return "watchable";
  if (/^(HTML\w*Element|Element|Node)\b/.test(type)) return "dom";
  if (/^(Error|number|bigint\[\]|\[number, number\]|"[^"]*"( \| "[^"]*")*)$/.test(type)) return "value";
  return "named";
}

export function neuroglancerCasts(dir = join(root, DIR)) {
  const casts = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const source = ts.createSourceFile(name, readFileSync(join(dir, name), "utf8"), ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const type = node.type.getText(source).replace(/\s+/g, " ");
        // `x as unknown as T` is one cast (to T); `as const` is none.
        const inner = type === "unknown" && ts.isAsExpression(node.parent);
        if (type !== "const" && !inner) {
          const double = ts.isAsExpression(node.expression) && node.expression.type.getText(source) === "unknown";
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          casts.push({ file: `${DIR}/${name}`, line, type, kind: kindOf(type, double) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return casts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const casts = neuroglancerCasts();
  const list = process.argv.indexOf("--list");
  if (list !== -1) {
    const only = process.argv[list + 1];
    for (const c of casts.filter((c) => only === undefined || c.kind === only)) console.log(`${c.file}:${c.line}  ${c.kind.padEnd(9)} ${c.type}`);
  } else {
    const into = casts.filter((c) => INTO_NEUROGLANCER.includes(c.kind));
    console.log(`${casts.length} casts in ${DIR}, ${into.length} into Neuroglancer's internals`);
    for (const [kind, what] of Object.entries(KINDS)) console.log(`${String(casts.filter((c) => c.kind === kind).length).padStart(4)}  ${kind.padEnd(9)} ${what}`);
    const files = [...new Set(casts.map((c) => c.file))];
    console.log("\nInto Neuroglancer, by file:");
    for (const f of files) console.log(`${String(into.filter((c) => c.file === f).length).padStart(4)}  ${f}`);
  }
}
