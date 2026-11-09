/**
 * The app's icons: line drawings on a 24-unit grid, in the text's colour,
 * by name.  Plugins use them as the shell does, in an icon button or beside
 * a button's label.
 *
 *     import { icon, iconButton } from "@ngplatform/sdk/dom";
 *     iconButton("trash", "Remove", () => remove());
 */

const PATHS = {
  open: "M3 6.5h6l2 2h10v10.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  copy: "M8 8h11v12H8zM5 16V4h11",
  undo: "M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3",
  redo: "M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h3",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  "panel-left": "M4 5h16v14H4zM9 5v14",
  "panel-right": "M4 5h16v14H4zM15 5v14",
  "panel-bottom": "M4 5h16v14H4zM4 14h16",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  "eye-off": "M3 3l18 18M10.6 5.6A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.3 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  "chevron-right": "M9 6l6 6-6 6",
  "chevron-down": "M6 9l6 6 6-6",
  "arrow-up": "M12 19V5M6 11l6-6 6 6",
  "arrow-down": "M12 5v14M6 13l6 6 6-6",
  layers: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
  scene: "M4 6h16v12H4zM8 3v3M16 3v3M4 10h16",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 0 1 5 .5c0 1.7-2.5 2.2-2.5 3.5M12 17h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5h.01",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  braces: "M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  zoomin: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M11 8v6M8 11h6",
  zoomout: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6",
  reset: "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4",
  copyplus: "M8 8h11v12H8zM5 16V4h11M13.5 11v6M10.5 14h6",
  // Transport, for playing through time or frames: each its own shape.
  play: "M7 5v14l11-7z",
  pause: "M8 5v14M16 5v14",
  previous: "M7 6v12M18 6v12l-8-6z",
  next: "M17 6v12M6 6v12l8-6z",
  first: "M5 6v12M12 6l-6 6 6 6M19 6l-6 6 6 6",
  last: "M19 6v12M12 6l6 6-6 6M5 6l6 6-6 6",
  stop: "M6 6h12v12H6z",
};

/** An icon's name. */
export type IconName = keyof typeof PATHS | "github";

/** Filled marks, drawn on their own grid (not the line icons' 24-unit one). */
const FILLED: Record<string, { viewBox: string; d: string }> = {
  // GitHub's mark (Octicons, MIT), for linking to GitHub.
  github: {
    viewBox: "-2 -2 20 20",
    d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z",
  },
};

/** The icon `name` (an empty one for a name it does not know), hidden from screen readers. */
export function icon(name: IconName | (string & {})): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-hidden", "true");
  const filled = FILLED[name];
  if (filled !== undefined) {
    svg.setAttribute("viewBox", filled.viewBox);
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", filled.d);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", (PATHS as Record<string, string>)[name] ?? "");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.7");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

