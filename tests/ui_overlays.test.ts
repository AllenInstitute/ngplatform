// @vitest-environment dom
/**
 * Sheets, the palette, menus and the small dialogs (src/ui/overlays.ts) in
 * a DOM: a sheet mounts over the page and gives the keyboard back where it
 * was when it closes; Escape and a click outside close the top sheet only;
 * the palette filters as it is typed in and runs the command chosen with
 * the arrow keys and Enter; a menu takes the keyboard and Escape closes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../src/core/commands.js";
import { closeMenu, closeSheet, confirmDialog, promptDialog, sheet, sheetIsOpen, showMenu, showPalette, showSheet } from "../src/ui/overlays.js";

const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
const scrims = () => [...document.querySelectorAll<HTMLElement>(".scrim")];

afterEach(() => {
  while (sheetIsOpen()) closeSheet();
  closeMenu();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("sheets", () => {
  it("mounts a dialog over the page, and closes it with Escape, giving the keyboard back", () => {
    const opener = document.body.appendChild(document.createElement("button"));
    opener.focus();
    const closed = vi.fn();
    showSheet(sheet("Settings", [document.createTextNode("Body")], [document.createElement("button")]), closed);
    expect(sheetIsOpen()).toBe(true);
    const dialog = document.querySelector<HTMLElement>(".scrim > .sheet")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Settings");
    expect(dialog.querySelector(".sheet-title")!.textContent).toBe("Settings");
    dialog.tabIndex = -1;
    dialog.focus();

    key(document, "Escape");
    expect(sheetIsOpen()).toBe(false);
    expect(scrims()).toHaveLength(0);
    expect(closed).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it("puts a second sheet above the first: the first is inert, and Escape closes the top one only", () => {
    const closed: string[] = [];
    showSheet(sheet("Below", [], []), () => closed.push("below"));
    showSheet(sheet("Above", [], []), () => closed.push("above"));
    const [below, above] = scrims();
    expect(below.inert).toBe(true);
    expect(above.inert).toBeFalsy();

    key(document, "Escape");
    expect(closed).toEqual(["above"]);
    expect(scrims()).toEqual([below]);
    expect(below.inert).toBe(false);
    key(document, "Escape");
    expect(closed).toEqual(["above", "below"]);
    // Nothing is open: Escape is the page's again.
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    key(document, "Escape");
    expect(seen).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", seen);
  });

  it("closes on a click outside the dialog, not on one inside it", () => {
    showSheet(sheet("Open", [document.createElement("input")], []));
    const scrim = scrims()[0];
    scrim.querySelector("input")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(sheetIsOpen()).toBe(true);
    scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(sheetIsOpen()).toBe(false);
  });

  it("closes from its own handle wherever it is in the stack", () => {
    const first = showSheet(sheet("First", [], []));
    showSheet(sheet("Second", [], []));
    first();
    expect(scrims().map((s) => s.querySelector(".sheet-title")!.textContent)).toEqual(["Second"]);
    expect(scrims()[0].inert).toBe(false);
  });
});

describe("dialogs", () => {
  it("confirm: its action has the keyboard, and Escape answers no", async () => {
    const answer = confirmDialog("Close the scene?", "Close");
    expect(document.activeElement).toBe(button("Close"));
    key(document, "Escape");
    await expect(answer).resolves.toBe(false);
    expect(sheetIsOpen()).toBe(false);

    const again = confirmDialog("Close the scene?", "Close");
    button("Close").click();
    await expect(again).resolves.toBe(true);
  });

  it("prompt: the field has the keyboard with its text selected, and Enter answers with it", async () => {
    const answer = promptDialog("Rename", "Name", "Scene 1");
    const input = document.activeElement as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("Name");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Scene 1".length]);
    input.value = "Cortex";
    key(input, "Enter");
    await expect(answer).resolves.toBe("Cortex");
    expect(sheetIsOpen()).toBe(false);
  });
});

describe("palette", () => {
  const commands: Command[] = [
    { id: "view.layout3d", title: "Layout: 3D", group: "View", run: () => {} },
    { id: "view.layout4", title: "Layout: four panels", group: "View", run: () => {} },
    { id: "edit.undo", title: "Undo", group: "Edit", run: () => {} },
    { id: "view.hidden", title: "Layout: not now", group: "View", run: () => {} },
  ];
  const open = () => {
    const run = vi.fn();
    showPalette(
      () => commands,
      (c) => c.id !== "view.hidden",
      (c) => (c.id === "edit.undo" ? "Mod+Z" : undefined),
      run,
    );
    return { run, input: document.querySelector<HTMLInputElement>("#palette-input")! };
  };
  const rows = () => [...document.querySelectorAll("#palette-results [role=option]")];
  const type = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input"));
  };

  it("opens with the search field focused and every command listed", () => {
    const { input } = open();
    expect(document.activeElement).toBe(input);
    expect(rows()).toHaveLength(commands.length);
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("filters as it is typed in, and runs the command the arrow keys reach with Enter", () => {
    const { input, run } = open();
    type(input, "layout");
    expect(rows().map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Layout: 3D"), expect.stringContaining("Layout: four panels")]));
    expect(rows().some((r) => r.textContent!.includes("Undo"))).toBe(false);
    key(input, "ArrowDown");
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
    const chosen = rows()[1].textContent!;
    key(input, "Enter");
    expect(run).toHaveBeenCalledOnce();
    expect(chosen).toContain(run.mock.calls[0][0].title);
    expect(sheetIsOpen()).toBe(false);
  });

  it("does not run a command that is not available, and says when nothing matches", () => {
    const { input, run } = open();
    type(input, "not now");
    expect(rows()[0].classList.contains("unavailable")).toBe(true);
    key(input, "Enter");
    expect(run).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
    type(input, "zzzz");
    expect(document.querySelector("#palette-results")!.textContent).toBe("No command matches.");
  });

  it("closes with Escape without running anything", () => {
    const { input, run } = open();
    key(input, "Escape");
    expect(sheetIsOpen()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("menus", () => {
  it("takes the keyboard on its first enabled item, runs an item clicked and closes", () => {
    vi.useFakeTimers();
    const anchor = document.body.appendChild(document.createElement("button"));
    const share = vi.fn();
    showMenu(anchor, [
      { label: "Not here", disabled: true, run: () => {} },
      { label: "Copy workspace link", run: share },
      "-",
      { label: "Save workspace as a file", run: () => {} },
    ]);
    const menu = document.querySelector(".menu")!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.querySelectorAll("[role=menuitem]")).toHaveLength(3);
    expect(menu.querySelectorAll("[role=separator]")).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe("Copy workspace link");
    (document.activeElement as HTMLButtonElement).click();
    expect(share).toHaveBeenCalledOnce();
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("closes with Escape, or a click elsewhere, once the click that opened it is over", () => {
    vi.useFakeTimers();
    const anchor = document.body.appendChild(document.createElement("button"));
    showMenu(anchor, [{ label: "Rename…", run: () => {} }]);
    vi.runAllTimers();
    key(document.querySelector(".menu-item")!, "ArrowDown");
    expect(document.querySelector(".menu")).not.toBeNull();
    key(document, "Escape");
    expect(document.querySelector(".menu")).toBeNull();

    showMenu(anchor, [{ label: "Rename…", run: () => {} }]);
    vi.runAllTimers();
    document.querySelector(".menu-item")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".menu")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("a second menu replaces the first", () => {
    const anchor = document.body.appendChild(document.createElement("button"));
    showMenu(anchor, [{ label: "One", run: () => {} }]);
    showMenu(anchor, [{ label: "Two", run: () => {} }]);
    expect([...document.querySelectorAll(".menu")].map((m) => m.textContent)).toEqual(["Two"]);
  });
});
