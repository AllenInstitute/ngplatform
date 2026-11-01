/**
 * The inspector's own controls: platform-styled rows, sliders, checkboxes,
 * selects and colour inputs, each bound two ways to one of Neuroglancer's
 * watchable values (so a change made anywhere, in the views, by undo or
 * by a link, shows here at once, and a change here applies at once).
 */
import { RefCounted, WatchableVisibilityPriority } from "../neuroglancer.js";

/** One of Neuroglancer's watchable values, as far as the inspector needs it. */
export interface Watch<T> {
  value: T;
  readonly changed: { add(listener: () => void): () => void };
}

/**
 * What a section owns while it is shown: listeners to remove, and a
 * Neuroglancer `RefCounted` for any of its widgets the section embeds.
 */
export class Scope {
  private offs: (() => void)[] = [];
  private ng_: RefCounted | undefined;
  /** Visible while the section is shown, so embedded widgets compute what they show. */
  readonly visibility = new WatchableVisibilityPriority(WatchableVisibilityPriority.VISIBLE);

  add(off: () => void): void {
    this.offs.push(off);
  }

  /** A Neuroglancer `RefCounted` that lives as long as this scope. */
  get ng(): RefCounted {
    this.ng_ ??= new RefCounted();
    return this.ng_;
  }

  /** Calls `f` now and whenever any of `watches` changes. */
  watch(watches: Watch<unknown>[] | Watch<unknown>, f: () => void): void {
    for (const w of Array.isArray(watches) ? watches : [watches]) this.add(w.changed.add(f));
    f();
  }

  /** Like `watch`, but at most once a frame, after the changes settle. */
  watchSoon(watches: Watch<unknown>[], f: () => void): void {
    let queued = false;
    const run = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!this.disposed) f();
      });
    };
    for (const w of watches) this.add(w.changed.add(run));
    f();
  }

  /** A scope disposed with this one, or earlier by its owner (to rebuild a part). */
  child(): Scope {
    const child = new Scope();
    this.add(() => child.dispose());
    return child;
  }

  disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visibility.value = WatchableVisibilityPriority.IGNORED;
    for (const off of this.offs.splice(0)) off();
    this.ng_?.dispose();
  }
}

// --------------------------------------------------------------- elements

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** A titled group of rows. */
export function section(title: string, ...children: Child[]): HTMLElement {
  return el("section", { class: "ins-section" }, el("h4", { class: "ins-section-title" }, title), ...children);
}

/** A labelled control: label on the left, control on the right. */
export function row(label: string, control: Node, title?: string): HTMLElement {
  return el("div", { class: "ins-row", title }, el("span", { class: "ins-label" }, label), el("div", { class: "ins-control" }, control));
}

/** Shows `element` only while `valid` is true. */
export function showWhen(scope: Scope, element: HTMLElement, valid: Watch<boolean> | undefined): HTMLElement {
  if (valid !== undefined) scope.watch(valid, () => (element.hidden = !valid.value));
  return element;
}

/** One of Neuroglancer's own components, inside the inspector's layout. */
export function embed(element: HTMLElement, className = ""): HTMLElement {
  return el("div", { class: `ins-embed ${className}`.trim() }, element);
}

export function note(text: string, className = ""): HTMLElement {
  return el("p", { class: `ins-note ${className}`.trim() }, text);
}

export function button(label: string, onclick: (e: MouseEvent) => void, title?: string, className = ""): HTMLButtonElement {
  return el("button", { type: "button", class: `ins-btn ${className}`.trim(), title, onclick }, label);
}

// --------------------------------------------------------------- controls

function decimals(step: number): number {
  const s = String(step);
  return s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
}

/** A slider with a number box, bound to `w`. */
export function slider(scope: Scope, w: Watch<number>, { min = 0, max = 1, step = 0.01 } = {}): HTMLElement {
  const range = el("input", { type: "range", min, max, step, class: "ins-range" }) as HTMLInputElement;
  const box = el("input", { type: "number", min, max, step, class: "ins-number" }) as HTMLInputElement;
  const set = (v: number) => {
    if (Number.isFinite(v) && v !== w.value) w.value = v;
  };
  range.addEventListener("input", () => set(Number(range.value)));
  box.addEventListener("change", () => set(Number(box.value)));
  scope.watch(w, () => {
    range.value = String(w.value);
    if (document.activeElement !== box) box.value = Number(w.value).toFixed(decimals(step));
  });
  return el("div", { class: "ins-slider" }, range, box);
}

export function checkbox(scope: Scope, w: Watch<boolean>): HTMLInputElement {
  const box = el("input", { type: "checkbox", class: "ins-check" }) as HTMLInputElement;
  box.addEventListener("change", () => (w.value = box.checked));
  scope.watch(w, () => (box.checked = w.value));
  return box;
}

/** A labelled checkbox, as one row. */
export function checkRow(scope: Scope, label: string, w: Watch<boolean>, title?: string): HTMLElement {
  return el("label", { class: "ins-row ins-check-row", title }, checkbox(scope, w), el("span", { class: "ins-label" }, label));
}

export interface Option<T> {
  value: T;
  label: string;
}

export function select<T>(scope: Scope, options: Option<T>[] | (() => Option<T>[]), get: () => T, set: (v: T) => void, changed: Watch<unknown>[]): HTMLSelectElement {
  const sel = el("select", { class: "ins-select" }) as HTMLSelectElement;
  let current: Option<T>[] = [];
  const render = () => {
    const list = typeof options === "function" ? options() : options;
    if (list.length !== current.length || list.some((o, i) => o.label !== current[i].label || o.value !== current[i].value)) {
      current = list;
      sel.replaceChildren(...list.map((o, i) => el("option", { value: String(i) }, o.label)));
    }
    const index = current.findIndex((o) => o.value === get());
    sel.value = String(index);
  };
  sel.addEventListener("change", () => {
    const o = current[Number(sel.value)];
    if (o !== undefined) set(o.value);
  });
  scope.watch(changed, render);
  return sel;
}

/** A select over one of Neuroglancer's `TrackableEnum`s. */
export function enumSelect(scope: Scope, w: Watch<number> & { enumType: Record<string, string | number> }): HTMLSelectElement {
  const options = Object.entries(w.enumType)
    .filter(([key, value]) => Number.isNaN(Number(key)) && typeof value === "number")
    .map(([key, value]) => ({ value: value as number, label: key.toLowerCase().replace(/_/g, " ") }));
  return select(
    scope,
    options,
    () => w.value,
    (v) => (w.value = v),
    [w],
  );
}

export function toHex(rgb: ArrayLike<number>): string {
  return `#${[0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, rgb[i])) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(hex: string): Float32Array {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return Float32Array.from(m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 1, 1]);
}

/** A colour input bound to an RGB value (0..1); `undefined` shows as white. */
export function colour(scope: Scope, w: Watch<ArrayLike<number> | undefined>): HTMLInputElement {
  const input = el("input", { type: "color", class: "ins-colour" }) as HTMLInputElement;
  const set = () => (w.value = fromHex(input.value));
  input.addEventListener("input", set);
  input.addEventListener("change", set);
  scope.watch(w, () => (input.value = toHex(w.value ?? [1, 1, 1])));
  return input;
}

/** A text box that commits on Enter or when it loses focus. */
export function textInput(value: string, commit: (v: string) => void, attrs: Attrs = {}): HTMLInputElement {
  const input = el("input", { type: "text", class: "ins-text", spellcheck: "false", ...attrs }) as HTMLInputElement;
  input.value = value;
  let committed = value;
  const done = () => {
    if (input.value === committed) return;
    committed = input.value;
    commit(input.value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      done();
      input.blur();
    } else if (e.key === "Escape") {
      input.value = committed;
      input.blur();
    }
  });
  input.addEventListener("blur", done);
  return input;
}

/**
 * A one-line box that grows to show all of a long value (a URL) instead of
 * scrolling within itself.  Enter commits; Escape reverts.
 */
export function growingInput(value: string, commit: (v: string) => void, attrs: Attrs = {}): HTMLTextAreaElement {
  const input = el("textarea", { class: "ins-text ins-grow", rows: 1, spellcheck: "false", wrap: "soft", ...attrs }) as HTMLTextAreaElement;
  let committed = value;
  const fit = () => {
    input.style.height = "auto";
    if (input.scrollHeight > 0) input.style.height = `${input.scrollHeight + 2}px`;
  };
  const set = (v: string) => {
    input.value = v;
    requestAnimationFrame(fit);
  };
  set(value);
  const done = () => {
    if (input.value === committed) return;
    committed = input.value;
    commit(input.value);
  };
  input.addEventListener("input", () => {
    // Pasted line breaks are not part of a URL.
    if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, "");
    fit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      done();
      input.blur();
    } else if (e.key === "Escape") {
      set(committed);
      input.blur();
    }
  });
  input.addEventListener("blur", done);
  new ResizeObserver(fit).observe(input);
  (input as HTMLTextAreaElement & { setValue(v: string): void }).setValue = (v: string) => {
    committed = v;
    set(v);
  };
  return input;
}

/** The text of a list of Neuroglancer messages (errors first). */
export function messagesView(scope: Scope, list: Iterable<{ severity: number; message: string }> & { changed: { add(f: () => void): () => void } }): HTMLElement {
  const host = el("div", { class: "ins-messages" });
  scope.watch({ value: undefined, changed: list.changed }, () => {
    const messages = [...list].sort((a, b) => b.severity - a.severity);
    host.hidden = messages.length === 0;
    host.replaceChildren(...messages.map((m) => el("p", { class: `ins-message sev-${m.severity}` }, m.message)));
  });
  return host;
}
