/** Modal sheets (command palette, Open) and toasts. */
import { type Command, matchCommands } from "../core/commands.js";
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

export function showPalette(commands: () => Command[], run: (command: Command) => void): void {
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
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-label": "Commands" }, input, results);
  let matches: Command[] = [];
  let index = 0;

  const render = () => {
    matches = matchCommands(commands(), input.value);
    index = Math.min(index, Math.max(0, matches.length - 1));
    results.replaceChildren(
      ...(matches.length === 0
        ? [h("li", { class: "result" }, h("span", { class: "hint" }, "No command matches."))]
        : matches.map((command, i) => {
            const available = command.isAvailable?.() ?? true;
            const li = h(
              "li",
              {
                class: available ? "result" : "result unavailable",
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
              command.keys ? h("kbd", {}, keyLabel(command.keys)) : null,
              command.hint ? h("span", { class: "hint" }, command.hint) : null,
            );
            return li;
          })),
    );
    results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };
  const choose = (i: number) => {
    const command = matches[i];
    if (command === undefined || !(command.isAvailable?.() ?? true)) return;
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
  showSheet(sheet);
  input.focus();
}

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
    const sheet = h(
      "div",
      { class: "sheet", role: "dialog", "aria-label": `Copy ${what}` },
      h("div", { class: "sheet-head" }, h("h2", { class: "sheet-title" }, `Copy ${what}`)),
      h(
        "div",
        { class: "sheet-body" },
        h("p", { class: "empty" }, "The clipboard is not available here. The text is selected: copy it with your keyboard."),
        area,
      ),
      h("div", { class: "sheet-foot" }, h("button", { class: "btn outline", onclick: () => closeSheet() }, "Done")),
    );
    showSheet(sheet);
    area.focus();
    area.select();
    return false;
  }
}
