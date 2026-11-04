/** Modal sheets (palette, dialogs, generated forms), menus and toasts. */
import { type Command, matchCommands } from "../core/commands.js";
import type { Schema } from "../core/schema.js";
import { validate, withDefaults } from "../core/schema.js";
import { h, keyLabel } from "./dom.js";

let openScrim: HTMLElement | null = null;

/** Shows a modal sheet; Escape or a click outside closes it. */
export function showSheet(sheet: HTMLElement, onClose?: () => void): () => void {
  closeSheet();
  const scrim = h("div", { class: "scrim" }, sheet);
  const close = () => {
    if (openScrim !== scrim) return;
    scrim.remove();
    openScrim = null;
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  document.addEventListener("keydown", onKey, true);
  (scrim as any).close = close;
  document.body.append(scrim);
  openScrim = scrim;
  return close;
}

export function closeSheet(): void {
  (openScrim as any)?.close?.();
}

export function sheetIsOpen(): boolean {
  return openScrim !== null;
}

/** A sheet with a title, a body and footer buttons. */
export function sheet(title: string, body: Node[], foot: Node[], options: { wide?: boolean; label?: string } = {}): HTMLElement {
  return h(
    "div",
    { class: options.wide ? "sheet wide" : "sheet", role: "dialog", "aria-label": options.label ?? title },
    h("div", { class: "sheet-head" }, h("h2", { class: "sheet-title" }, title)),
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
  });
  const results = h("ul", { class: "results", role: "listbox", id: "palette-results" });
  const box = h("div", { class: "sheet", role: "dialog", "aria-label": "Commands" }, input, results);
  let matches: Command[] = [];
  let index = 0;

  const render = () => {
    matches = matchCommands(commands(), input.value);
    index = Math.min(index, Math.max(0, matches.length - 1));
    results.replaceChildren(
      ...(matches.length === 0
        ? [h("li", { class: "result" }, h("span", { class: "hint" }, "No command matches."))]
        : matches.map((command, i) => {
            const key = keyFor(command);
            return h(
              "li",
              {
                class: available(command) ? "result" : "result unavailable",
                role: "option",
                "aria-selected": String(i === index),
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
    const answer = (value: boolean) => {
      if (answered) return;
      answered = true;
      closeSheet();
      resolve(value);
    };
    const ok = h("button", { class: danger ? "btn danger" : "btn primary", type: "button", onclick: () => answer(true) }, action);
    showSheet(
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
    const answer = (result: string | undefined) => {
      if (answered) return;
      answered = true;
      closeSheet();
      resolve(result);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") answer(input.value);
    });
    showSheet(
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
    const box = h("input", { type: "checkbox", "aria-label": label });
    box.checked = value === true;
    return { el: h("label", { class: "field check" }, box, h("span", {}, label), hint), read: () => box.checked };
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
    const answer = (result: T | undefined) => {
      if (answered) return;
      answered = true;
      closeSheet();
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
    showSheet(
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

/** A small menu below `anchor` (or at the pointer). */
export function showMenu(anchor: HTMLElement | { x: number; y: number }, items: (MenuItem | "-")[]): void {
  closeMenu();
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
          disabled: item.disabled,
          onclick: () => {
            closeMenu();
            item.run();
          },
        },
        ...(item.detail === undefined ? [item.label] : [h("span", { class: "menu-label" }, item.label), h("span", { class: "menu-detail" }, item.detail)]),
      ),
    );
  }
  document.body.append(menu);
  menu.querySelector<HTMLElement>(".menu-item.current")?.scrollIntoView({ block: "center" });
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, right: anchor.x };
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(rect.left, window.innerWidth - width - 8);
  const top = Math.min(rect.bottom + 4, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenu = menu;
  ((menu.querySelector(".menu-item.current") ?? menu.querySelector("button:not([disabled])")) as HTMLElement | null)?.focus({ preventScroll: true });
  const dismiss = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== "Escape") return;
    if (e.target instanceof Node && menu.contains(e.target) && !(e instanceof KeyboardEvent)) return;
    if (openMenu === menu) closeMenu();
  };
  // Added once this click is over; removed by closeMenu however the menu
  // closes (an item chosen, another menu opened), so a menu opened from an
  // item is not closed by its parent's listener.
  const timer = setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
  });
  menuListeners = () => {
    clearTimeout(timer);
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", dismiss, true);
  };
}

// ------------------------------------------------------------------ toasts

const toastHost = () => {
  let host = document.querySelector<HTMLElement>(".toasts");
  if (host === null) {
    host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  return host;
};

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const el = h("div", { class: kind === "error" ? "toast error" : "toast" }, message);
  toastHost().append(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3200);
}

/** A toast asking a question, with a button for each answer; gone after a choice, or after `timeout` ms. */
export function offer(message: string, actions: { label: string; primary?: boolean; run?: () => void }[], timeout = 30000): () => void {
  const el = h(
    "div",
    { class: "toast offer" },
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
  setTimeout(() => el.remove(), timeout);
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
