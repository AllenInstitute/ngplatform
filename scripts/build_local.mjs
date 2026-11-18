// Copies the built app (dist/, after `vite build`) into the Python package (runner/ngplatform_local/app/),
// source maps left out as the deploy leaves them out, so a wheel made next carries the app of this commit:
//
//   npm run build:local                 the app built and copied in
//   npm run package:local               …and the wheel made, in dist-wheel/
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const app = fileURLToPath(new URL("../runner/ngplatform_local/app/", import.meta.url));
if (!existsSync(`${dist}index.html`) || !existsSync(`${dist}build.json`)) {
  console.error("dist/ has no build with a build.json: run `npm run build` first");
  process.exit(1);
}
rmSync(app, { recursive: true, force: true });
cpSync(dist, app, { recursive: true, filter: (src) => !src.endsWith(".map") });
const build = JSON.parse(readFileSync(`${app}build.json`, "utf8"));
if (String(build.commit).endsWith("+changes")) console.warn(`warning: the app was built from a tree with uncommitted changes (${build.commit}); a release wheel should be built from a clean commit, as the deploy is`);
console.log(`runner/ngplatform_local/app/: the app ${build.version} (${build.commit}), runner API ${build.runnerApi}`);
