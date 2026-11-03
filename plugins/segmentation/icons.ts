/**
 * The tool bar's and segment list's icons: 24 × 24 outlines, drawn with
 * the text's colour.
 */

const PATHS: Record<string, string> = {
  move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
  brush: "M9.5 14.5 19 5a1.6 1.6 0 0 1 2.3 2.3l-9.5 9.5M9.5 14.5c-2.5-.6-4.6 1-4.9 3.4-.2 1.4-.9 2.3-2.1 2.7 3.8 1.3 8.4.5 9.3-3.8",
  erase: "M7 21 3.4 17.4a1.6 1.6 0 0 1 0-2.3L14.1 4.4a1.6 1.6 0 0 1 2.3 0l4.2 4.2a1.6 1.6 0 0 1 0 2.3L10.8 21zM21 21H7M8.5 10l6.5 6.5",
  fill: "M11 3 3 11l7 7a1.4 1.4 0 0 0 2 0l7-7zM3 11h16M20 15.5s1.8 2.1 1.8 3.4a1.8 1.8 0 0 1-3.6 0c0-1.3 1.8-3.4 1.8-3.4z",
  pick: "m3 21 1.5-1.5h2.5l8-8M4.5 19.5V17l8-8M13 6.5 16.4 3a2.1 2.1 0 0 1 3 0l1.6 1.6a2.1 2.1 0 0 1 0 3l-3.5 3.4M11.5 5l7.5 7.5",
  quick: "M4 4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M4 7V4M12 9v6M9 12h6",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  interpolate: "M4 5h16M4 19h16M7 9.7h10M7 14.3h10",
  save: "M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v5h8V3M7 21v-7h10v7",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  close: "M18 6 6 18M6 6l12 12",
  check: "M4 12.5 9.5 18 20 6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.6 3.4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  goto: "M12 2v4M12 18v4M2 12h4M18 12h4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  merge: "M6 3v6a6 6 0 0 0 6 6h6M15 12l3 3-3 3M6 21v-6",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15",
};

const NS = "http://www.w3.org/2000/svg";

export function icon(name: keyof typeof PATHS | string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", PATHS[name] ?? "");
  svg.append(path);
  return svg;
}

/** A button showing an icon, its title the tooltip and accessible name. */
export function iconButton(name: string, title: string, onclick: () => void, pressed?: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sg-icon";
  b.title = title;
  b.setAttribute("aria-label", title.replace(/ \(.*\)$/, ""));
  if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
  b.append(icon(name));
  b.addEventListener("click", onclick);
  return b;
}
