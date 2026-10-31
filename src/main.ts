/**
 * Boot: build the shell, mount the Neuroglancer engine inside it with none of
 * Neuroglancer's own interface, and wire them together.
 */
import { Engine } from "./engine/engine.js";
import { urlSafeParse } from "./engine/neuroglancer.js";
import { Shell } from "./ui/shell.js";
import "./ui/styles.css";

const shell = new Shell(document.getElementById("app")!);
const engine = new Engine(shell.engineHost);
// For debugging from the console, as Neuroglancer's own page does.
(window as unknown as { viewer: unknown; engine: unknown }).viewer = engine.viewer;
(window as unknown as { engine: unknown }).engine = engine;

shell.attach(engine, urlSafeParse, import.meta.env.VITE_DEFAULT_EXAMPLE ?? "hip-ct");
