// The Neuroglancer the app is built against.  package.json depends on
// file:../neuroglancer, a checkout beside this one; the commit it should be
// at is pinned in package.json ("neuroglancer": { "commit" }), which the
// deploy workflow checks out.  CI's FORK_SHA (.github/workflows/ci.yml)
// should name the same commit.
//
//   node scripts/neuroglancer_pin.mjs            warns when they differ
//   node scripts/neuroglancer_pin.mjs --strict   fails when they differ
//
// vite.config.ts runs the same check before every build and puts the
// commits in the build's About (Settings › About).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = (cwd, ...args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

/**
 * The pin, CI's pin, and the sibling checkout's commit, with what is wrong
 * (an empty list when the build will be the one CI and the deploy make).
 */
export function neuroglancerCheck(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pin = pkg.neuroglancer?.commit;
  const ci = join(root, ".github/workflows/ci.yml");
  const ciPin = existsSync(ci) ? /FORK_SHA:\s*([0-9a-f]{7,40})/.exec(readFileSync(ci, "utf8"))?.[1] : undefined;
  // Where the build reads it from: node_modules/neuroglancer, a link to the sibling checkout.
  const linked = join(root, "node_modules/neuroglancer");
  const checkout = existsSync(linked) ? realpathSync(linked) : resolve(root, "../neuroglancer");
  const commit = existsSync(checkout) ? git(checkout, "rev-parse", "HEAD") : undefined;
  const dirty = commit !== undefined && (git(checkout, "status", "--porcelain", "--untracked-files=no") ?? "") !== "";
  const problems = [];
  if (pin === undefined) problems.push("package.json pins no Neuroglancer commit (neuroglancer.commit)");
  if (ciPin !== undefined && pin !== undefined && ciPin !== pin) problems.push(`CI's FORK_SHA (${ciPin.slice(0, 12)}) is not package.json's pin (${pin.slice(0, 12)})`);
  if (commit === undefined) problems.push(`no Neuroglancer checkout at ${checkout}`);
  else if (pin !== undefined && commit !== pin) problems.push(`${checkout} is at ${commit.slice(0, 12)}, not the pinned ${pin.slice(0, 12)}: check out the pin (git -C ${checkout} checkout ${pin}) or move the pin deliberately`);
  if (dirty) problems.push(`${checkout} has uncommitted changes`);
  return { pin, ciPin, commit, dirty, checkout, problems };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = neuroglancerCheck(root);
  console.log(`Neuroglancer: pinned ${check.pin ?? "(none)"}, checkout ${check.commit ?? "(none)"}${check.dirty ? " (modified)" : ""}`);
  for (const p of check.problems) console.warn(`warning: ${p}`);
  if (check.problems.length > 0 && process.argv.includes("--strict")) process.exit(1);
}
