/** Modal sheets (palette, dialogs, generated forms), menus and toasts. */
import { type Command, matchCommands } from "../core/commands.js";
import type { Schema } from "../core/schema.js";
import { validate, withDefaults } from "../core/schema.js";
import { SheetStack, type StackedSheet } from "../core/sheet_stack.js";
import { checkbox, roving } from "../sdk/dom.js";
import { h, keyLabel } from "./dom.js";

interface OpenSheet extends StackedSheet {
  scrim: HTMLElement;
  sheet: HTMLElement;
}

const sheets = new SheetStack<OpenSheet>();

/** Shown (not hidden, by itself or a parent), as far as the page can tell. */
function shown(e: HTMLElement): boolean {
  if (typeof e.checkVisibility === "function") return e.checkVisibility();
  for (let n: HTMLElement | null = e; n !== null; n = n.parentNode as HTMLElement | null) if (n.hidden) return false;
  return true;
}

/** What Tab reaches inside `root`, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], summary, [tabindex], [contenteditable]")].filter(
    (e) => !(e as HTMLButtonElement).disabled && e.getAttribute("tabindex") !== "-1" && !(e.tagName === "INPUT" && (e as HTMLInputElement).type === "hidden") && shown(e),
  );
}

/**
 * The keys of the top sheet, one listener while any sheet is open: Escape
 * closes it (only it), and Tab and Shift+Tab go round its controls without
 * leaving it, as in a modal dialog.
 */
const onSheetKey = (e: KeyboardEvent) => {
  const top = sheets.top();
  if (top === undefined) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    sheets.closeTop();
    return;
  }
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
  const stops = focusables(top.sheet);
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && top.sheet.contains(active);
  const first = stops[0];
  const last = stops[stops.length - 1];
  let to: HTMLElement | undefined;
  if (first === undefined) to = top.sheet;
  else if (!inside) to = e.shiftKey ? last : first;
  else if (e.shiftKey && (active === first || active === top.sheet)) to = last;
  else if (!e.shiftKey && (active === last || active === top.sheet)) to = first;
  if (to === undefined) return;
  e.preventDefault();
  to.focus();
};

/** Puts the keyboard in a sheet just shown: on its first control, or on the sheet itself. */
function focusInto(sheet: HTMLElement): void {
  if (sheet.contains(document.activeElement)) return;
  const first = focusables(sheet)[0];
  if (first !== undefined) return first.focus({ preventScroll: true });
  if (!sheet.hasAttribute("tabindex")) sheet.setAttribute("tabindex", "-1");
  sheet.focus({ preventScroll: true });
}

/**
 * Shows a modal sheet above any sheet already open, which waits below it
 * (inert) until it closes.  It is a modal dialog to a screen reader, the
 * keyboard goes into it (its first control, unless the caller puts it
 * elsewhere) and stays in it, and goes back to whatever had it when the
 * sheet closes.  Escape or a click outside closes the top sheet only.
 * Returns the sheet's own close, which closes it wherever it is.
 */
export function showSheet(sheet: HTMLElement, onClose?: () => void): () => void {
  if (!sheet.hasAttribute("role")) sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const scrim = h("div", { class: "scrim" }, sheet);
  // Focus goes back where it was (a button in the sheet below, say) when this one closes.
  const opener = document.activeElement as HTMLElement | null;
  const entry: OpenSheet = {
    scrim,
    sheet,
    close: () => {
      const wasTop = sheets.top() === entry;
      if (!sheets.remove(entry)) return;
      scrim.remove();
      const top = sheets.top();
      if (top !== undefined) top.scrim.inert = false;
      else document.removeEventListener("keydown", onSheetKey, true);
      sheets.closingWhile(() => onClose?.());
      if (wasTop && opener?.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    },
  };
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim && sheets.top() === entry) sheets.closeTop();
  });
  const below = sheets.top();
  if (below !== undefined) below.scrim.inert = true;
  sheets.push(entry);
  document.addEventListener("keydown", onSheetKey, true);
  document.body.append(scrim);
  focusInto(sheet);
  return entry.close;
}

/** Closes the top sheet. */
export function closeSheet(): void {
  sheets.closeTop();
}

export function sheetIsOpen(): boolean {
  return sheets.size > 0;
}

let titles = 0;

/** A sheet with a title (which names it, unless `label` does), a body and footer buttons. */
export function sheet(title: string, body: Node[], foot: Node[], options: { wide?: boolean; label?: string } = {}): HTMLElement {
  const id = `sheet-title-${++titles}`;
  return h(
    "div",
    { class: options.wide ? "sheet wide" : "sheet", role: "dialog", "aria-labelledby": options.label === undefined ? id : undefined, "aria-label": options.label },
    h("div", { class: "sheet-head" }, h("h2", { class: "sheet-title", id }, title)),
    h("div", { class: "sheet-body" }, ...body),
    h("div", { class: "sheet-foot" }, ...foot),
  );
}

export function showPalette(
  commands: () => Command[],
  available: (command: Command) => boolean,
  keyFor: (command: Command) => string | undefined,
  run: (command: Command) => void,
): void {
  const input = h("input", {
    class: "palette-input",
    id: "palette-input",
    type: "text",
    placeholder: "Type a command",
    "aria-label": "Search commands",
    autocomplete: "off",
    spellcheck: "false",
    // A combobox: the list below is always open, and the arrows move its highlighted row, not the keyboard.
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-results",
    "aria-autocomplete": "list",
  });
  const results = h("ul", { class: "results", role: "listbox", id: "palette-results", "aria-label": "Commands" });
  const box = h("div", { class: "sheet", role: "dialog", "aria-label": "Commands" }, input, results);
  let matches: Command[] = [];
  let index = 0;

  const render = () => {
    matches = matchCommands(commands(), input.value);
    index = Math.min(index, Math.max(0, matches.length - 1));
    results.replaceChildren(
      ...(matches.length === 0
        ? [h("li", { class: "result", role: "option", "aria-disabled": "true", "aria-selected": "false" }, h("span", { class: "hint" }, "No command matches."))]
        : matches.map((command, i) => {
            const key = keyFor(command);
            return h(
              "li",
              {
                class: available(command) ? "result" : "result unavailable",
                role: "option",
                id: `palette-option-${i}`,
                "aria-selected": String(i === index),
                "aria-disabled": available(command) ? undefined : "true",
                onmousemove: () => {
                  if (index !== i) {
                    index = i;
                    render();
                  }
                },
                onclick: () => choose(i),
              },
              h("span", {}, h("span", { class: "group-name" }, command.group), command.title),
              key ? h("kbd", {}, keyLabel(key)) : null,
              command.hint ? h("span", { class: "hint" }, command.hint) : null,
            );
          })),
    );
    // The highlighted row is the one a screen reader reads, while the keyboard stays in the box.
    if (matches.length === 0) input.removeAttribute("aria-activedescendant");
    else input.setAttribute("aria-activedescendant", `palette-option-${index}`);
    results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i: number) => {
    const command = matches[i];
    if (command === undefined || !available(command)) return;
    closeSheet();
    run(command);
  };
  input.addEventListener("input", () => {
    index = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      index = Math.min(index + 1, matches.length - 1);
      render();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      index = Math.max(index - 1, 0);
      render();
      e.preventDefault();
    } else if (e.key === "Enter") {
      choose(index);
      e.preventDefault();
    } else if ((e.key === "Home" || e.key === "End") && e.ctrlKey) {
      index = e.key === "Home" ? 0 : Math.max(0, matches.length - 1);
      render();
      e.preventDefault();
    }
  });
  render();
  showSheet(box);
  input.focus();
}

/** Asks to confirm; `detail` (code, say) is shown as it is, below the message. */
export function confirmDialog(message: string, action = "Continue", danger = false, detail?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    let close = () => {};
    const answer = (value: boolean) => {
      if (answered) return;
      answered = true;
      close();
      resolve(value);
    };
    const ok = h("button", { class: danger ? "btn danger" : "btn primary", type: "button", onclick: () => answer(true) }, action);
    close = showSheet(
      sheet("Confirm", [h("p", { class: "empty" }, message), ...(detail === undefined ? [] : [h("pre", { class: "confirm-detail" }, detail)])], [
        h("button", { class: "btn", type: "button", onclick: () => answer(false) }, "Cancel"),
        ok,
      ]),
      () => answer(false),
    );
    ok.focus();
  });
}

export function promptDialog(title: string, label: string, value: string, action = "Save"): Promise<string | undefined> {
  return new Promise((resolve) => {
    let answered = false;
    const input = h("input", { class: "text-input", type: "text", "aria-label": label, spellcheck: "false" });
    input.value = value;
    let close = () => {};
    const answer = (result: string | undefined) => {
      if (answered) return;
      answered = true;
      close();
      resolve(result);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") answer(input.value);
    });
    close = showSheet(
      sheet(title, [h("label", { class: "field" }, h("span", {}, label), input)], [
        h("button", { class: "btn", type: "button", onclick: () => answer(undefined) }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: () => answer(input.value) }, action),
      ]),
      () => answer(undefined),
    );
    input.focus();
    input.select();
  });
}

/** One input per schema property, typed from the schema. */
function fieldFor(key: string, schema: Schema, value: unknown, required: boolean): { el: HTMLElement; read: () => unknown } {
  const label = schema.title ?? key;
  const hint = schema.description ? h("span", { class: "field-hint" }, schema.description) : null;
  if (schema.enum !== undefined) {
    const select = h("select", { class: "text-input", "aria-label": label });
    for (const option of schema.enum) select.append(h("option", { value: JSON.stringify(option) }, String(option)));
    if (value !== undefined) select.value = JSON.stringify(value);
    return { el: h("label", { class: "field" }, h("span", {}, label), select, hint), read: () => JSON.parse(select.value) };
  }
  if (schema.type === "boolean") {
    const box = checkbox(label, value === true, () => {});
    return { el: h("div", { class: "field" }, box, hint), read: () => box.input.checked };
  }
  const numeric = schema.type === "number" || schema.type === "integer";
  const structured = schema.type === "object" || schema.type === "array";
  const input = structured
    ? h("textarea", { class: "text-input mono", rows: 3, "aria-label": label, spellcheck: "false" })
    : h("input", { class: "text-input", type: numeric ? "number" : "text", "aria-label": label, spellcheck: "false" });
  if (numeric && schema.type === "integer") input.setAttribute("step", "1");
  if (value !== undefined) input.value = structured ? JSON.stringify(value) : String(value);
  const read = () => {
    const text = input.value.trim();
    if (text === "") return required ? (numeric ? NaN : "") : undefined;
    if (numeric) return Number(text);
    if (structured) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  };
  return { el: h("label", { class: "field" }, h("span", {}, label + (required ? "" : " (optional)")), input, hint), read };
}

/** A dialog generated from an object schema; resolves to the validated value, or undefined. */
export function formDialog<T>(title: string, schema: Schema, initial: Partial<T> = {}, action = "Run"): Promise<T | undefined> {
  return new Promise((resolve) => {
    let answered = false;
    const filled = withDefaults(schema, { ...initial }) as Record<string, unknown>;
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties ?? {}).map(([key, sub]) => ({ key, ...fieldFor(key, sub, filled[key], required.has(key)) }));
    const errors = h("p", { class: "form-errors", role: "alert" });
    let close = () => {};
    const answer = (result: T | undefined) => {
      if (answered) return;
      answered = true;
      close();
      resolve(result);
    };
    const submit = () => {
      const value: Record<string, unknown> = {};
      for (const f of fields) {
        const v = f.read();
        if (v !== undefined) value[f.key] = v;
      }
      const problems = validate(schema, value);
      if (problems.length > 0) {
        errors.textContent = problems.join(". ");
        return;
      }
      answer(value as T);
    };
    close = showSheet(
      sheet(title, [...fields.map((f) => f.el), errors], [
        h("button", { class: "btn", type: "button", onclick: () => answer(undefined) }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: submit }, action),
      ]),
      () => answer(undefined),
    );
    (fields[0]?.el.querySelector("input,select,textarea") as HTMLElement | null)?.focus();
  });
}

// ------------------------------------------------------------------ menus

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Shown at the right of the row (a time, a shortcut). */
  detail?: string;
  /** Greyed, though still clickable: an undone change, say. */
  muted?: boolean;
  /** Marked as where things stand; the menu opens scrolled to it. */
  current?: boolean;
  run: () => void;
}

let openMenu: HTMLElement | null = null;

/** Removes the open menu's document listeners. */
let menuListeners: (() => void) | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
  menuListeners?.();
  menuListeners = null;
}

/**
 * A small menu below `anchor` (or at the pointer).  The keyboard goes to
 * its current or first item; Up and Down (round at the ends), Home and End
 * and a letter move within it, Enter or Space chooses, and Escape or Tab
 * closes it.  The keyboard goes back to whatever had it (the button that
 * opened it) when the menu is closed by a key or an item is chosen, so a
 * sheet an item opens hands it back there too.
 */
export function showMenu(anchor: HTMLElement | { x: number; y: number }, items: (MenuItem | "-")[]): void {
  closeMenu();
  const opener = document.activeElement as HTMLElement | null;
  const giveBack = () => {
    if (opener?.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
  };
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item === "-") {
      menu.append(h("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    menu.append(
      h(
        "button",
        {
          class: ["menu-item", item.danger && "danger", item.muted && "muted", item.current && "current", item.detail !== undefined && "with-detail"].filter(Boolean).join(" "),
          "aria-current": item.current ? "true" : undefined,
          type: "button",
          role: "menuitem",
          tabindex: -1,
          disabled: item.disabled,
          onclick: () => {
            const inMenu = menu.contains(document.activeElement);
            closeMenu();
            if (inMenu) giveBack();
            item.run();
          },
        },
        ...(item.detail === undefined ? [item.label] : [h("span", { class: "menu-label" }, item.label), h("span", { class: "menu-detail" }, item.detail)]),
      ),
    );
  }
  roving(menu, { items: () => [...menu.querySelectorAll<HTMLElement>(".menu-item")], orientation: "vertical", typeahead: true });
  document.body.append(menu);
  menu.querySelector<HTMLElement>(".menu-item.current")?.scrollIntoView({ block: "center" });
  const rect = "getBoundingClientRect" in anchor ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, right: anchor.x };
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  const top = Math.min(rect.bottom + 4, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenu = menu;
  const first = menu.querySelector<HTMLElement>(".menu-item.current") ?? [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => !b.disabled);
  first?.focus({ preventScroll: true });
  const dismiss = (e: Event) => {
    const key = e.type === "keydown" ? (e as KeyboardEvent).key : undefined;
    if (e.type === "keydown" && key !== "Escape" && key !== "Tab") return;
    if (key === undefined && menu.contains(e.target as Node)) return;
    if (openMenu !== menu) return;
    if (key !== undefined) {
      // Escape closes only the menu (not a sheet below it); Tab closes it and goes on from the button.
      e.stopPropagation();
      if (key === "Escape") e.preventDefault();
      closeMenu();
      giveBack();
      return;
    }
    closeMenu();
  };
  // Keys at once, so an Escape pressed as soon as the menu shows closes it;
  // on the window, ahead of a sheet's on the document, so Escape closes the
  // menu and not the sheet too.  Clicks once this click is over, so the
  // click that opened the menu does not close it.  Both are removed by
  // closeMenu however the menu closes (an item chosen, another menu
  // opened), so a menu opened from an item is not closed by its parent's.
  window.addEventListener("keydown", dismiss, true);
  const timer = setTimeout(() => document.addEventListener("mousedown", dismiss, true));
  menuListeners = () => {
    clearTimeout(timer);
    document.removeEventListener("mousedown", dismiss, true);
    window.removeEventListener("keydown", dismiss, true);
  };
}

// ------------------------------------------------------------------ toasts

const toastHost = () => {
  let host = document.querySelector<HTMLElement>(".toasts");
  if (host === null) {
    host = h("div", { class: "toasts" });
    document.body.append(host);
  }
  return host;
};

/**
 * Takes a toast away after `ms`, though not while the pointer is over it or
 * the keyboard is in it: it waits the whole time again once they leave.
 */
function dismissAfter(el: HTMLElement, ms: number): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovered = false;
  let focused = false;
  const wait = () => {
    clearTimeout(timer);
    timer = hovered || focused ? undefined : setTimeout(() => el.remove(), ms);
  };
  el.addEventListener("mouseenter", () => ((hovered = true), wait()));
  el.addEventListener("mouseleave", () => ((hovered = false), wait()));
  el.addEventListener("focusin", () => ((focused = true), wait()));
  el.addEventListener("focusout", (e) => {
    focused = el.contains(((e as FocusEvent).relatedTarget as Node | null) ?? null);
    wait();
  });
  wait();
}

/** A passing message; an error is an alert, read out at once, and stays longer. */
export function toast(message: string, kind: "info" | "error" = "info"): void {
  const error = kind === "error";
  const el = h("div", { class: error ? "toast error" : "toast", role: error ? "alert" : "status" }, message);
  toastHost().append(el);
  dismissAfter(el, error ? 7000 : 3200);
}

/** A toast asking a question, with a button for each answer; gone after a choice, or after `timeout` ms. */
export function offer(message: string, actions: { label: string; primary?: boolean; run?: () => void }[], timeout = 30000): () => void {
  const el = h(
    "div",
    { class: "toast offer", role: "status" },
    h("span", {}, message),
    h(
      "div",
      { class: "row-actions" },
      ...actions.map((a) =>
        h("button", { class: a.primary ? "btn primary small" : "btn outline small", type: "button", onclick: () => (el.remove(), a.run?.()) }, a.label),
      ),
    ),
  );
  toastHost().append(el);
  dismissAfter(el, timeout);
  return () => el.remove();
}

/**
 * Copies text from inside a user gesture; when the clipboard refuses, shows
 * the text selected in a sheet so it can be copied by hand.
 */
export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { class: "state-input", id: "copy-fallback", readonly: true });
    area.value = text;
    showSheet(
      sheet(
        `Copy ${what}`,
        [h("p", { class: "empty" }, "The clipboard is not available here. The text is selected: copy it with your keyboard."), area],
        [h("button", { class: "btn outline", type: "button", onclick: () => closeSheet() }, "Done")],
      ),
    );
    area.focus();
    area.select();
    return false;
  }
}
