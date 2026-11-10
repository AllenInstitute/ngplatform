/**
 * Boot: work out which plugins are on, load the data type plugins'
 * Neuroglancer modules (before any viewer exists, so their formats and
 * worker code are there from the start), then build the shell and mount the
 * engine inside it.  A plugin that fails to load is left out and marked in
 * the Plugins panel; errors nothing caught go to Activity from the start.
 */
import { describeError, isStaleChunkError, reloadOnceForStaleChunk } from "./core/errors.js";
import { Engine } from "./engine/engine.js";
import { registerGoogleCredentials } from "./engine/google_credentials.js";
import { urlSafeParse } from "./engine/neuroglancer.js";
import { loadDataTypePlugins } from "./engine/plugins.js";
import { revalidateFetches } from "./engine/workers/plugins.js";
import { exposeForDebugging } from "./platform/debug.js";
import { browserGoogleEnvironment, GoogleSignIn, googleTokens } from "./platform/google_auth.js";
import { SignInRules } from "./platform/sign_in_rules.js";
import { loadChoices, loadThisTab, resolveEnabled, returningVisitor } from "./platform/plugin_switches.js";
import { CATALOGUE } from "../plugins/index.js";
import { ErrorReporting } from "./ui/error_reporting.js";
import { toast } from "./ui/overlays.js";
import { Shell } from "./ui/shell.js";
import "./ui/styles.css";

let tabStorage: Storage | undefined;
try {
  tabStorage = sessionStorage;
} catch {
  // No storage: no reload for a stale chunk either, since nothing could stop a loop.
}

// After a redeploy, a page loaded before it asks for files the new build
// replaced: reloaded once, it is the new build.  This module's address
// names the build (a hash per build).
let reloading = false;
const reloadForStaleChunk = (error: unknown): boolean => {
  if (reloading) return true;
  reloading = isStaleChunkError(error) && reloadOnceForStaleChunk(tabStorage, import.meta.url, () => location.reload());
  return reloading;
};
const errors = new ErrorReporting(window, reloadForStaleChunk);

// A hard reset (View → Hard reset) asked for every file to be checked with
// its server on this load, here and in Neuroglancer's workers.
let revalidate = false;
try {
  revalidate = sessionStorage.getItem("ngplatform.revalidate") === "1";
  sessionStorage.removeItem("ngplatform.revalidate");
} catch {
  // No storage: an ordinary load.
}
if (revalidate) revalidateFetches(window);

async function boot(): Promise<void> {
  const choices = loadChoices();
  // Plugins an example switched on for this tab (kept over a reload of it).
  const thisTab = loadThisTab();
  const resolution = resolveEnabled(
    CATALOGUE.map((e) => e.manifest),
    choices,
    thisTab,
  );
  // Before the docks remember their tabs: whether this browser used the app before.
  const returning = returningVisitor();
  const failed = await loadDataTypePlugins(
    CATALOGUE.filter((e) => e.neuroglancer !== undefined && resolution.enabled.has(e.manifest.id)).map((e) => ({
      id: e.manifest.id,
      neuroglancer: e.neuroglancer!,
    })),
    { revalidate },
  );
  // Reloading for a stale chunk: nothing more to build.
  if ([...failed.values()].some(reloadForStaleChunk)) return;

  // Google sign-in for the browser (its accounts, and the rules saying which
  // reads which bucket), behind gs+google:// data: its credentials must be
  // registered before the viewer exists.
  const googleEnvironment = browserGoogleEnvironment();
  const google = new GoogleSignIn(googleEnvironment, import.meta.env.VITE_GOOGLE_CLIENT_ID);
  const rules = new SignInRules(localStorage, googleEnvironment.onStorage);
  registerGoogleCredentials(googleTokens(google, rules));

  const shell = new Shell(document.getElementById("app")!);
  const engine = new Engine(shell.engineHost);
  // For debugging from the console, as Neuroglancer's own page does (in production only with ?debug: src/platform/debug.ts).
  exposeForDebugging("viewer", engine.viewer);
  exposeForDebugging("engine", engine);

  shell.attach(
    engine,
    urlSafeParse,
    import.meta.env.VITE_DEFAULT_EXAMPLE ?? "",
    { catalogue: CATALOGUE, choices, resolution, thisTab, returning, failed },
    google,
    rules,
  );
  const log = shell.activity;
  errors.attach((error) => {
    log.add(error.message, "error", error.source, error.stack);
    const line = error.message.split("\n")[0];
    const short = line.length > 140 ? `${line.slice(0, 137)}…` : line;
    toast(/^\w*Error\b/.test(short) ? short : `Error: ${short}`, "error");
  });
  bootDone();
}

/** The loading screen (index.html) goes once the shell is built, or the app could not start. */
function bootDone(): void {
  document.getElementById("boot")?.remove();
}

/** When the app cannot start at all: the reason, and a reload, in place of a blank page. */
function bootFailed(error: unknown): void {
  console.error(error);
  if (reloading) return;
  bootDone();
  const app = document.getElementById("app");
  if (app === null) return;
  const box = document.createElement("div");
  box.className = "boot-failed";
  const text = document.createElement("p");
  text.textContent = `The app could not start: ${describeError(error).message}`;
  const reload = document.createElement("button");
  reload.className = "btn primary";
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => location.reload());
  box.append(text, reload);
  app.replaceChildren(box);
}

await boot().catch(bootFailed);
