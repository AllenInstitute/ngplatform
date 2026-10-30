/** Tiny DOM helpers: the shell is framework-free, like Neuroglancer's own UI. */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

const PATHS: Record<string, string> = {
  open: "M3 6.5h6l2 2h10v10.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  copy: "M8 8h11v12H8zM5 16V4h11",
  undo: "M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3",
  redo: "M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h3",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  "panel-left": "M4 5h16v14H4zM9 5v14",
  "panel-right": "M4 5h16v14H4zM15 5v14",
  "panel-bottom": "M4 5h16v14H4zM4 14h16",
};

export function icon(name: keyof typeof PATHS | string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", PATHS[name] ?? "");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.7");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

/** The platform's mark: three strokes in direction-encoded colour (x, y, z). */
export function mark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 22 22");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  const strokes: [string, string][] = [
    ["M3 15c4-1 8-6 16-8", "var(--dec-x)"],
    ["M3 11c5 0 9 3 16 7", "var(--dec-y)"],
    ["M7 3c0 6 3 11 4 16", "var(--dec-z)"],
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

/** "Mod+K" as this platform writes it. */
export function keyLabel(keys: string): string {
  return isMac() ? keys.replace(/Mod\+/g, "⌘").replace(/Shift\+/g, "⇧") : keys.replace(/Mod\+/g, "Ctrl+");
}
