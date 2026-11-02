/**
 * Boot: work out which plugins are on, load the data type plugins'
 * Neuroglancer modules (before any viewer exists, so their formats and
 * worker code are there from the start), then build the shell and mount the
 * engine inside it.
 */
import { Engine } from "./engine/engine.js";
import { urlSafeParse } from "./engine/neuroglancer.js";
import { loadDataTypePlugins } from "./engine/plugins.js";
import { revalidateFetches } from "./engine/workers/plugins.js";
import { loadChoices, resolveEnabled } from "./platform/plugin_switches.js";
import { CATALOGUE } from "../plugins/index.js";
import { Shell } from "./ui/shell.js";
import "./ui/styles.css";

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

const choices = loadChoices();
const resolution = resolveEnabled(
  CATALOGUE.map((e) => e.manifest),
  choices,
);
await loadDataTypePlugins(
  CATALOGUE.filter((e) => e.neuroglancer !== undefined && resolution.enabled.has(e.manifest.id)).map((e) => ({
    id: e.manifest.id,
    neuroglancer: e.neuroglancer!,
  })),
  { revalidate },
);

const shell = new Shell(document.getElementById("app")!);
const engine = new Engine(shell.engineHost);
// For debugging from the console, as Neuroglancer's own page does.
(window as unknown as { viewer: unknown; engine: unknown }).viewer = engine.viewer;
(window as unknown as { engine: unknown }).engine = engine;

shell.attach(engine, urlSafeParse, import.meta.env.VITE_DEFAULT_EXAMPLE ?? "s2146-mni", { catalogue: CATALOGUE, choices, resolution });
