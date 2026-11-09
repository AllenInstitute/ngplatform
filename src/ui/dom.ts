/** Tiny DOM helpers: the shell is framework-free, like Neuroglancer's own UI. */
import { keyLabel as platformKeyLabel } from "../core/keybindings.js";

/** `h` is the shell's name for the SDK's `el`. */
export { type Attrs, append, clear, el as h, icon, iconButton } from "../sdk/dom.js";

/** The platform's mark: three axes in direction-encoded colour (x, y, z). */
export function mark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 22 22");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  const strokes: [string, string][] = [
    ["M3 15L19 7", "var(--dec-x)"],
    ["M3 11L19 18", "var(--dec-y)"],
    ["M7 3L11 19", "var(--dec-z)"],
  ];
  for (const [d, color] of strokes) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2.2");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
  }
  return svg;
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** "Mod+K" (or "mod+k") as this platform writes it. */
export function keyLabel(keys: string): string {
  return platformKeyLabel(keys, isMac());
}
