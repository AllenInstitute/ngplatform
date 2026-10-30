/**
 * Boot: build the shell, mount Neuroglancer inside it, wire them together.
 *
 * These imports are the platform's whole dependency on Neuroglancer's
 * internals; the fork's planned `src/embed.ts` will re-export exactly them.
 */
import "neuroglancer";
import { setDefaultInputEventBindings } from "neuroglancer/unstable/ui/default_input_event_bindings.js";
import { makeDefaultViewer } from "neuroglancer/unstable/ui/default_viewer.js";
import { urlSafeParse } from "neuroglancer/unstable/util/json.js";
import { ViewerBridge } from "./core/viewer_bridge.js";
import { Shell } from "./ui/shell.js";
import "./ui/styles.css";

const shell = new Shell(document.getElementById("app")!);
const viewer = makeDefaultViewer({
  target: shell.engineHost,
  // The shell owns opening, sharing and editing the state.
  showEditStateButton: false,
});
setDefaultInputEventBindings(viewer.inputEventBindings);
// For debugging from the console, as Neuroglancer's own page does.
(window as unknown as { viewer: unknown }).viewer = viewer;

shell.attach(new ViewerBridge(viewer), urlSafeParse, import.meta.env.VITE_DEFAULT_EXAMPLE ?? "hip-ct");
