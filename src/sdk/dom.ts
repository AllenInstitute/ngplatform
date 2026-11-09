/**
 * DOM helpers for plugins (and the shell, which is framework-free like
 * Neuroglancer's own UI): elements, a few controls laid out as the
 * platform's forms are, and files to save.
 *
 *     import { el, button, downloadBlob } from "@ngplatform/sdk/dom";
 */

export type Child = Node | string | null | undefined | false;
export type Attrs = Record<string, unknown>;

/**
 * An element with attributes and children. Attributes that are undefined,
 * null or false are left out and true is an empty attribute; `on…`
 * functions are listeners (`onclick` → "click"); `class` is the class
 * name; `value` is set as the property, last (after `min`, `max` and the
 * children, so a range keeps it and a select or textarea shows it).
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  let value: unknown;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k === "value" && "value" in e) value = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  append(e, children);
  if (value !== undefined) (e as HTMLInputElement).value = String(value);
  return e;
}

export function append(e: Element, children: Child[]): void {
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
}

/** Replaces an element's children. */
export function clear(e: Element, ...children: Child[]): void {
  e.replaceChildren();
  append(e, children);
}

const SVG = "http://www.w3.org/2000/svg";

/** An SVG element with attributes. */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ------------------------------------------------------------ controls

/** A text button (small and outlined unless `cls` says otherwise). */
export function button(label: string, onclick: () => void, title?: string, cls = "btn outline small"): HTMLButtonElement {
  return el("button", { class: cls, type: "button", title, onclick }, label);
}

/** A select of [value, label] pairs. */
export function select(options: [string, string][], value: string, onchange: (value: string) => void, label?: string): HTMLSelectElement {
  const s = el("select", { class: "text-input", "aria-label": label });
  for (const [v, text] of options) s.append(el("option", { value: v }, text));
  s.value = value;
  s.addEventListener("change", () => onchange(s.value));
  return s;
}

/** A small number box (monospace, 64 px) that reports finite values when changed. */
export function numberInput(value: number, onchange: (value: number) => void, attrs: Attrs = {}): HTMLInputElement {
  const input = el("input", { class: "text-input num-input", type: "number", value: String(value), ...attrs });
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onchange(v);
  });
  return input;
}

/** A label above a control, as the platform's forms lay them out. */
export function field(label: string, control: Node, hint?: string): HTMLElement {
  return el("label", { class: "field" }, el("span", {}, label), control, hint ? el("span", { class: "field-hint" }, hint) : null);
}

// --------------------------------------------------------------- files

/** Saves a blob as a download named `name`. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A name as a file name: runs of anything but letters, digits, "." and "-" as "_", none at the ends. */
export function safeFileName(name: string, fallback = "file"): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

/**
 * A collapsible card: a `<details class="card">` whose summary is `title`
 * (and `badge`, a short status, on the right) and whose body is `children`.
 * Whether it is open is kept per browser under `id` (name it after the
 * panel: "registration.landmarks"); until it is first toggled it is open
 * when `open` says.  `attention` opens it whatever was kept (something in
 * it needs doing).
 */
export function card(id: string, title: string, options: { open?: boolean; badge?: Child; attention?: boolean; tooltip?: string }, ...children: Child[]): HTMLDetailsElement {
  const key = `ngplatform.card.${id}`;
  let kept: string | null = null;
  try {
    kept = localStorage.getItem(key);
  } catch {
    // Storage refused: the default stands.
  }
  const d = el(
    "details",
    { class: "card", "data-card": id },
    el("summary", { class: "card-head", title: options.tooltip }, el("span", { class: "card-title" }, title), options.badge ? el("span", { class: "card-badge" }, options.badge) : null),
    el("div", { class: "card-body" }, ...children),
  );
  d.open = options.attention === true || (kept === null ? options.open === true : kept === "1");
  d.addEventListener("toggle", () => {
    try {
      localStorage.setItem(key, d.open ? "1" : "0");
    } catch {
      // Not kept: it opens as before next time.
    }
  });
  return d;
}
