/**
 * DOM helpers for plugins (and the shell, which is framework-free like
 * Neuroglancer's own UI): elements, the parts every panel is built from,
 * and files to save.
 *
 *     import { el, card, field, slider, toggle } from "@ngplatform/sdk/dom";
 *
 * The parts, and the rules they keep (plugins/README.md, "Building a panel"):
 * - `card()` groups a panel's controls; `field()` gives a control its label.
 * - `toggle()` (a switch) turns a feature on; `checkbox()` picks items or options.
 * - `info()` holds an explanation, behind a small (i) that keyboard and touch reach.
 * - `slider()` is the one slider, with its number beside it.
 * - `emptyState()` is one line and the action that fills it.
 * - `statusLine()` reports progress and errors, nothing else.
 * - `region()` and each control's `set()` update a panel in place, so a
 *   change of state does not draw the whole panel again.
 */
import { icon } from "./icons.js";

export { icon, type IconName } from "./icons.js";

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

// ---------------------------------------------------- update in place

/**
 * A control a panel keeps and updates in place: `set(value)` shows a value
 * from the state.  It leaves alone a control the person is typing in or
 * dragging and shows the latest value when they finish, so a change of
 * state never takes a value from under them, closes a select or ends a drag.
 */
export type Settable<E extends HTMLElement, T> = E & { set(value: T): void };

/**
 * Setting a control from the state, held while the person uses it:
 * `using(now)` says whether they are; while they are, `run` keeps only the
 * latest setting, and runs it when they let go.
 */
function gate(): { using(now: boolean): void; run(apply: () => void): void } {
  let busy = false;
  let pending: (() => void) | undefined;
  return {
    using(now) {
      busy = now;
      if (busy || pending === undefined) return;
      const apply = pending;
      pending = undefined;
      apply();
    },
    run(apply) {
      if (busy) pending = apply;
      else apply();
    },
  };
}

/** Calls `using` with true while `input` has the keyboard (a text or number box being typed in), false when it loses it. */
function whileTyping(input: HTMLElement, using: (now: boolean) => void): void {
  input.addEventListener("focus", () => using(true));
  input.addEventListener("blur", () => using(false));
}

/**
 * Calls `using` with true while `range` is dragged.  The drag ends on the
 * returned function (added as a `change` listener after those that read
 * the value the person chose), or soon after a pointer up that brings no
 * change.
 */
function whileDragged(range: HTMLInputElement, using: (now: boolean) => void): () => void {
  const doc = range.ownerDocument;
  const end = () => using(false);
  range.addEventListener("pointerdown", () => {
    using(true);
    const up = () => {
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", up, true);
      setTimeout(end, 0);
    };
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", up, true);
  });
  return end;
}

/**
 * A part of a panel drawn again only when its key changes (keys are
 * compared as JSON): the rows of a list, a section that depends on what
 * kind of data is chosen.  Everything else in the panel stays as it is.
 * `update(key)` returns whether it drew.
 *
 *     const rows = region((names: string[]) => names.map((n) => el("li", {}, n)), { class: "list" });
 *     const sync = () => rows.update(ctx.viewer.layers().map((l) => l.name));
 */
export function region<K>(render: (key: K) => Child | Child[], attrs: Attrs = {}): HTMLElement & { update(key: K): boolean } {
  const e = el("div", attrs) as HTMLElement as HTMLElement & { update(key: K): boolean };
  let last: string | undefined;
  e.update = (key) => {
    const json = JSON.stringify(key) ?? "undefined";
    if (json === last) return false;
    last = json;
    const drawn = render(key);
    clear(e, ...(Array.isArray(drawn) ? drawn : [drawn]));
    return true;
  };
  return e;
}

// ------------------------------------------------------------ controls

/** A text button (small and outlined unless `cls` says otherwise). */
export function button(label: string, onclick: () => void, title?: string, cls = "btn outline small"): HTMLButtonElement {
  return el("button", { class: cls, type: "button", title, onclick }, label);
}

/** An icon-only button: `label` is its name, read out and shown on hover. */
export function iconButton(name: string, label: string, onClick: (e: MouseEvent) => void, extra: Attrs = {}): HTMLButtonElement {
  return el("button", { class: "btn icon", type: "button", title: label, "aria-label": label, ...extra, onclick: onClick as EventListener }, icon(name));
}

/** A select of [value, label] pairs; `set` shows another value. */
export function select(options: [string, string][], value: string, onchange: (value: string) => void, label?: string): Settable<HTMLSelectElement, string> {
  const s = el("select", { class: "text-input", "aria-label": label }) as Settable<HTMLSelectElement, string>;
  for (const [v, text] of options) s.append(el("option", { value: v }, text));
  s.value = value;
  s.addEventListener("change", () => onchange(s.value));
  s.set = (v) => {
    if (s.value !== v) s.value = v;
  };
  return s;
}

/** A small number box (monospace, 64 px) that reports finite values when changed; `set` waits while it is typed in. */
export function numberInput(value: number, onchange: (value: number) => void, attrs: Attrs = {}): Settable<HTMLInputElement, number> {
  const input = el("input", { class: "text-input num-input", type: "number", value: String(value), ...attrs }) as Settable<HTMLInputElement, number>;
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onchange(v);
  });
  const g = gate();
  whileTyping(input, g.using);
  input.set = (v) =>
    g.run(() => {
      if (input.value === "" || Number(input.value) !== v) input.value = String(v);
    });
  return input;
}

/** An on/off control (a switch or a checkbox) and its label. */
export type OnOff = Settable<HTMLElement, boolean> & { readonly input: HTMLInputElement };

/** What a toggle or a checkbox may have besides its label. */
export interface OnOffOptions {
  disabled?: boolean;
  /** The label is the control's name only, not shown (a list row that names it already). */
  hideLabel?: boolean;
  /** An explanation, behind an info control after the label. */
  info?: string;
}

function onOff(kind: "switch" | "checkbox", label: string, value: boolean, onchange: (value: boolean) => void, options: OnOffOptions): OnOff {
  const input = el("input", {
    type: "checkbox",
    class: kind === "switch" ? "switch" : undefined,
    role: kind === "switch" ? "switch" : undefined,
    disabled: options.disabled,
    "aria-label": options.hideLabel ? label : undefined,
  });
  input.checked = value;
  input.addEventListener("change", () => onchange(input.checked));
  const labelled = el("label", { class: "choice" }, input, options.hideLabel ? null : el("span", {}, label));
  const e = (options.info === undefined ? labelled : el("span", { class: "choice-row" }, labelled, info(options.info, `About ${label}`))) as OnOff;
  Object.defineProperty(e, "input", { value: input });
  e.set = (v) => void (input.checked = v);
  return e;
}

/**
 * A switch: turns a feature on or off (Render, a plugin, a layer's
 * drawing).  To pick items or options, use `checkbox()`: a switch is for
 * something that starts or stops.
 *
 *     toggle("Render", saved.on, (on) => setOn(on))
 */
export function toggle(label: string, on: boolean, onchange: (on: boolean) => void, options: OnOffOptions = {}): OnOff {
  return onOff("switch", label, on, onchange, options);
}

/**
 * A checkbox: picks an item or an option (which axes to cut, "Hide the
 * jar").  To turn a feature on, use `toggle()`.
 *
 *     checkbox("Hide the jar", saved.jar, (v) => save({ jar: v }))
 */
export function checkbox(label: string, checked: boolean, onchange: (checked: boolean) => void, options: OnOffOptions = {}): OnOff {
  return onOff("checkbox", label, checked, onchange, options);
}

let infos = 0;

/**
 * An info control: a small (i) button whose explanation shows beside it on
 * click, Enter or Space (Escape or leaving hides it) and while the pointer
 * is over it.  The button is described by the text, so a screen reader
 * reads it too.  Use it for explanations, rather than `title`, which
 * keyboard and touch cannot reach.  `label` names the button ("About
 * density").
 */
export function info(text: string, label = "More information"): HTMLSpanElement {
  const id = `ngp-info-${++infos}`;
  const tip = el("span", { class: "info-tip", id, role: "tooltip", hidden: true }, text);
  const b = el("button", { class: "btn icon info-btn", type: "button", "aria-label": label, "aria-describedby": id, "aria-controls": id, "aria-expanded": "false" }, icon("info"));
  let pinned = false;
  const doc = b.ownerDocument;
  const view = doc.defaultView;
  // While it shows: Escape hides it (first, from the window: not the sheet it may sit in), and a scroll hides it.
  const onKey = (e: Event) => {
    if (!b.isConnected) return hide();
    if ((e as KeyboardEvent).key !== "Escape") return;
    e.stopPropagation();
    hide();
  };
  const onScroll = () => hide();
  const show = (pin: boolean) => {
    pinned = pin || pinned;
    b.setAttribute("aria-expanded", "true");
    if (!tip.hidden) return;
    tip.hidden = false;
    view?.addEventListener("keydown", onKey, true);
    doc.addEventListener("scroll", onScroll, true);
    // Fixed, below the button and within the window: a dock's scrolling or clipping does not cut it off.
    if (view === null) return;
    const r = b.getBoundingClientRect();
    const width = Math.min(tip.offsetWidth || 260, view.innerWidth - 16);
    tip.style.left = `${Math.max(8, Math.min(r.left, view.innerWidth - width - 8))}px`;
    tip.style.top = `${r.bottom + 4}px`;
  };
  const hide = () => {
    pinned = false;
    b.setAttribute("aria-expanded", "false");
    tip.hidden = true;
    tip.removeAttribute("style");
    view?.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("scroll", onScroll, true);
  };
  b.addEventListener("click", (e) => {
    // Not the card it sits in (a summary) or the label: only the tip.
    e.preventDefault();
    e.stopPropagation();
    if (pinned) hide();
    else show(true);
  });
  b.addEventListener("blur", hide);
  b.addEventListener("mouseenter", () => show(false));
  b.addEventListener("mouseleave", () => void (pinned || hide()));
  tip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  return el("span", { class: "info" }, b, tip);
}

/** What `field()` may have besides its label and control. */
export interface FieldOptions {
  /** A short note under the control (a unit, a range): not an explanation, which goes in `info`. */
  hint?: string;
  /** An explanation, behind an info control beside the label. */
  info?: string;
}

const LABELLED = new Set(["INPUT", "SELECT", "TEXTAREA"]);
let fields = 0;

/**
 * A label above a control, as the platform's forms lay them out.  The third
 * argument is a hint (a string), or `{ hint, info }`.
 *
 *     field("Density", slider(40, { min: 0, max: 200, label: "Density" }), { info: "How opaque the tissue is" })
 */
export function field(label: string, control: Node, options?: string | FieldOptions): HTMLElement {
  const o: FieldOptions = typeof options === "string" ? { hint: options } : (options ?? {});
  const hint = o.hint ? el("span", { class: "field-hint" }, o.hint) : null;
  if (o.info === undefined) return el("label", { class: "field" }, el("span", {}, label), control, hint);
  // With an info control the label cannot hold the control (its button would be what the label names): it points to it.
  const box = (control as Element).querySelector === undefined ? null : (control as Element);
  const target = box === null ? null : LABELLED.has(box.tagName) ? box : box.querySelector("input, select, textarea");
  if (target !== null && !target.id) target.id = `ngp-field-${++fields}`;
  const name = target !== null ? el("label", { for: target.id }, label) : el("span", { id: `ngp-field-${++fields}` }, label);
  const e = el("div", { class: "field" }, el("span", { class: "field-label" }, name, info(o.info, `About ${label}`)), control, hint);
  if (target === null) {
    e.setAttribute("role", "group");
    e.setAttribute("aria-labelledby", name.id);
  }
  return e;
}

/** What `slider()` takes besides its value. */
export interface SliderOptions {
  min: number;
  max: number;
  /** The slider's step (1 unless given); the number box takes the same. */
  step?: number;
  /** Shown after the number ("mm", "°", "%"). */
  unit?: string;
  /** The name of the slider and its number box, for a screen reader (`field()` labels only the slider). */
  label?: string;
  /** Called as the slider moves: draw a preview. */
  oninput?: (value: number) => void;
  /** Called when a value is settled: the slider let go, a key pressed on it, or a number typed. Without it, `oninput` is called then too. */
  onchange?: (value: number) => void;
  /** The number box takes values beyond min and max (the slider then rests at its end). */
  unbounded?: boolean;
  disabled?: boolean;
}

/** The slider-with-number control. */
export type Slider = Settable<HTMLElement, number> & { readonly range: HTMLInputElement; readonly number: HTMLInputElement };

/** A value as its number box shows it: to the step's decimals when it falls on a step, else to 6 significant figures. */
export function stepText(v: number, step: number): string {
  const decimals = step > 0 ? Math.min(10, Math.max(0, -Math.floor(Math.log10(step) + 1e-9))) : 6;
  const tidy = Number(v.toFixed(decimals));
  return String(Math.abs(tidy - v) <= 1e-9 * Math.max(1, Math.abs(v)) ? tidy : Number(v.toPrecision(6)));
}

/**
 * The one slider: a range and a number box kept in step, between `min`
 * and `max`, with an optional unit.  `oninput` follows the drag (a
 * preview); `onchange` gets the value once settled.  `set` shows a value
 * from the state, waiting while the slider is dragged or the number typed.
 *
 *     slider(saved.exposure, { min: 0, max: 5, step: 0.05, label: "Exposure", onchange: (v) => save({ exposure: v }) })
 */
export function slider(value: number, options: SliderOptions): Slider {
  const { min, max, step = 1, unit, label, oninput, onchange, unbounded, disabled } = options;
  const settled = onchange ?? oninput;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const range = el("input", { type: "range", min, max, step, disabled, "aria-label": label, value: clamp(value) });
  const number = el("input", {
    class: "text-input num-input",
    type: "number",
    min: unbounded ? undefined : min,
    max: unbounded ? undefined : max,
    step,
    disabled,
    "aria-label": label,
    value: stepText(value, step),
  });
  range.addEventListener("input", () => {
    const v = Number(range.value);
    number.value = stepText(v, step);
    oninput?.(v);
  });
  range.addEventListener("change", () => settled?.(Number(range.value)));
  number.addEventListener("change", () => {
    let v = Number(number.value);
    if (number.value.trim() === "" || !Number.isFinite(v)) {
      number.value = stepText(Number(range.value), step);
      return;
    }
    if (!unbounded) v = clamp(v);
    number.value = stepText(v, step);
    range.value = String(clamp(v));
    settled?.(v);
  });
  // Set from the state only once the person lets go of both parts.
  const g = gate();
  let typing = false;
  let dragging = false;
  whileTyping(number, (now) => g.using((typing = now) || dragging));
  const letGo = whileDragged(range, (now) => g.using((dragging = now) || typing));
  // After the change listener above, so the value the person chose is read before a waiting one is shown.
  range.addEventListener("change", letGo);
  const e = el("div", { class: "slider" }, range, number, unit ? el("span", { class: "slider-unit" }, unit) : null) as HTMLElement as Slider;
  Object.defineProperties(e, { range: { value: range }, number: { value: number } });
  e.set = (v) =>
    g.run(() => {
      range.value = String(clamp(v));
      number.value = stepText(v, step);
    });
  return e;
}

/** An action a person can take from an empty state or an error: a button's label and what it runs. */
export interface Action {
  label: string;
  run: () => void;
}

/**
 * An empty state: one line saying what is missing, and the action that
 * supplies it.  Give an action wherever there is one; leave explanations
 * to the guide.
 *
 *     emptyState("No image in this scene.", { label: "Open data…", run: () => ctx.commands.invoke("dataset.add") })
 */
export function emptyState(text: string, action?: Action): HTMLElement {
  return el("div", { class: "empty-state" }, el("p", { class: "empty" }, text), action ? button(action.label, action.run, undefined, "btn outline") : null);
}

/** A status line (see `statusLine()`). */
export type StatusLine = HTMLElement & {
  /** Work under way: "Reading level 2 of 5…". */
  progress(text: string): void;
  /** Something failed: what, and an action that may mend it (Retry). */
  error(text: string, action?: Action): void;
  /** Nothing to report: the line is hidden. */
  clear(): void;
};

/**
 * A status line for progress and errors only: hidden when there is nothing
 * to report.  Not for narration ("Ready", "3 layers", what a panel already
 * shows): when the work is done, `clear()` it.
 *
 *     const status = statusLine();
 *     status.progress("Reading…");
 *     try { await read(); status.clear(); } catch (e) { status.error(`Could not read it: ${e.message}`, { label: "Retry", run: read }); }
 */
export function statusLine(): StatusLine {
  const text = el("span", { class: "status-text" });
  const e = el("div", { class: "status-line", role: "status", hidden: true }, text) as HTMLElement as StatusLine;
  const show = (message: string, kind: "progress" | "error", action?: Action) => {
    e.className = `status-line ${kind}`;
    text.textContent = message;
    e.replaceChildren(text, ...(action ? [button(action.label, action.run, undefined, "btn outline small")] : []));
    e.hidden = false;
  };
  e.progress = (message) => show(message, "progress");
  e.error = (message, action) => show(message, "error", action);
  e.clear = () => {
    e.hidden = true;
    e.className = "status-line";
    text.textContent = "";
    e.replaceChildren(text);
  };
  return e;
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

/** What `card()` may have besides its title and children. */
export interface CardOptions {
  /** Open until the person first opens or closes it (the first card of a panel is). */
  open?: boolean;
  /** A short status on the right of its title ("3 pairs"). */
  badge?: Child;
  /** Open it whatever was kept: something in it needs doing. */
  attention?: boolean;
  /** An explanation, behind an info control beside the title. */
  info?: string;
}

/**
 * A collapsible card, for a group of a panel's controls: a
 * `<details class="card">` whose summary is `title` and whose body is
 * `children`.  Whether it is open is kept per browser under `id` (name it
 * after the panel: "registration.landmarks").
 *
 *     card("starter.layers", "Layers", { open: true, badge: "3" }, list)
 */
export function card(id: string, title: string, options: CardOptions, ...children: Child[]): HTMLDetailsElement {
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
    el(
      "summary",
      { class: "card-head" },
      el("span", { class: "card-title" }, title),
      options.info !== undefined ? info(options.info, `About ${title}`) : null,
      options.badge ? el("span", { class: "card-badge" }, options.badge) : null,
    ),
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
