/**
 * The core app with the keyboard and a screen reader: sheets that are modal
 * dialogs (the keyboard kept in them, given back when they close), arrow
 * keys in menus and rows of tabs, dock resizers moved with the keys and
 * never stuck to the pointer, the command palette as a combobox, toasts
 * that stay while read, and a 3-D fling that stops when the system asks
 * for less motion; against the SDK's stand-in document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../src/core/commands.js";
import type { ContextKeys } from "../src/core/when.js";
import { roving } from "../src/sdk/dom.js";
import { type FakeDom, FakeEvent, fakeDocument } from "../src/sdk/testing.js";
import { DockManager, followDrag } from "../src/ui/docks.js";
import { closeMenu, closeSheet, offer, sheet, sheetIsOpen, showMenu, showPalette, showSheet, toast } from "../src/ui/overlays.js";
import { h } from "../src/ui/dom.js";

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
});
afterEach(() => {
  while (sheetIsOpen()) closeSheet();
  closeMenu();
  dom.restore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const active = () => dom.document.activeElement as HTMLElement | null;
const key = (target: Element, k: string, init?: { shiftKey?: boolean }) => dom.fire(target, "keydown", k, init);
const button = (label: string, onclick = () => {}) => h("button", { type: "button", onclick }, label);
/** A button on the page, outside any sheet: what opens one. */
const placed = (label: string) => {
  const b = button(label);
  dom.host().append(b);
  return b;
};
const all = <E extends Element>(root: ParentNode, selector: string) => [...root.querySelectorAll<E & HTMLElement>(selector)];

describe("sheets are modal dialogs", () => {
  it("is named by its title and modal, and the keyboard goes to its first control", () => {
    const opener = placed("Open");
    opener.focus();
    const s = sheet("Rename", [h("input", { "aria-label": "Name" })], [button("Cancel"), button("Save")]);
    showSheet(s);
    expect(s.getAttribute("role")).toBe("dialog");
    expect(s.getAttribute("aria-modal")).toBe("true");
    const title = s.querySelector("h2")!;
    expect(s.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.id).not.toBe("");
    expect(active()?.tagName).toBe("INPUT");
  });

  it("keeps Tab and Shift+Tab inside, going round at the ends", () => {
    const s = sheet("Confirm", [h("p", {}, "Sure?")], [button("Cancel"), button("Continue")]);
    showSheet(s);
    const [cancel, go] = all(s, "button");
    expect(active()).toBe(cancel);
    // From the last control, Tab goes to the first; from the first, Shift+Tab to the last.
    go.focus();
    expect(key(go, "Tab")).toBe(false);
    expect(active()).toBe(cancel);
    expect(key(cancel, "Tab", { shiftKey: true })).toBe(false);
    expect(active()).toBe(go);
    // In between, Tab is left to the browser.
    cancel.focus();
    expect(key(cancel, "Tab")).toBe(true);
  });

  it("passes over hidden and disabled controls, and takes the keyboard itself when it has none", () => {
    const hidden = button("Hidden");
    hidden.hidden = true;
    const off = button("Off");
    off.disabled = true;
    const s = sheet("Busy", [h("div", { hidden: true }, button("In a hidden part")), hidden, off, button("Only")], []);
    showSheet(s);
    expect(dom.text(active()!)).toBe("Only");
    closeSheet();
    const bare = sheet("Note", [h("p", {}, "Nothing to do.")], []);
    showSheet(bare);
    expect(active()).toBe(bare);
    expect(bare.getAttribute("tabindex")).toBe("-1");
    expect(key(bare, "Tab")).toBe(false);
    expect(active()).toBe(bare);
  });

  it("closes the top sheet only on Escape, giving the keyboard back to what opened each", () => {
    const opener = placed("Settings");
    opener.focus();
    const lower = sheet("Settings", [button("Forget")], [button("Done")]);
    const onLower = vi.fn();
    showSheet(lower, onLower);
    const forget = lower.querySelector<HTMLElement>("button")!;
    expect(active()).toBe(forget);
    const upper = sheet("Confirm", [], [button("Cancel"), button("Forget")]);
    showSheet(upper);
    expect(upper.contains(active())).toBe(true);
    key(active()!, "Escape");
    expect(upper.isConnected).toBe(false);
    expect(lower.isConnected).toBe(true);
    expect(active()).toBe(forget);
    key(forget, "Escape");
    expect(onLower).toHaveBeenCalledOnce();
    expect(sheetIsOpen()).toBe(false);
    expect(active()).toBe(opener);
  });
});

describe("roving focus", () => {
  it("moves round a row with the arrows, Home and End, keeping one tab stop", () => {
    const row = dom.host();
    const items = ["One", "Two", "Three"].map((t) => button(t));
    row.append(...items);
    items[1].disabled = true;
    const moved: string[] = [];
    roving(row, { items: () => items, orientation: "horizontal", tabStop: true, onMove: (b) => moved.push(dom.text(b)) });
    expect(items.map((b) => b.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    items[0].focus();
    key(items[0], "ArrowRight");
    expect(active()).toBe(items[2]);
    expect(items.map((b) => b.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
    key(items[2], "ArrowRight");
    expect(active()).toBe(items[0]);
    key(items[0], "End");
    expect(active()).toBe(items[2]);
    key(items[2], "Home");
    expect(active()).toBe(items[0]);
    // Up and Down are not this row's.
    expect(key(items[0], "ArrowDown")).toBe(true);
    expect(moved).toEqual(["Three", "One", "Three", "One"]);
  });
});

describe("dock tabs", () => {
  const context = { onChange: () => () => {}, matches: () => true } as unknown as ContextKeys;

  it("are a tab list whose arrows choose the next tab, with the selected one the tab stop", () => {
    const root = dom.host();
    const docks = new DockManager(root, context);
    for (const [id, title] of [["layers", "Layers"], ["plugins", "Plugins"], ["files", "Files"]]) docks.addTab({ id, title, slot: "left", render: () => {} });
    const dock = docks.element("left");
    const list = dock.querySelector('[role="tablist"]')!;
    const tabs = all(list, '[role="tab"]');
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(tabs[0].getAttribute("aria-controls")).toBe(dock.querySelector('[role="tabpanel"]')!.id);
    tabs[0].focus();
    key(tabs[0], "ArrowRight");
    expect(docks.selected("left")).toBe("plugins");
    expect(active()).toBe(tabs[1]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    key(tabs[1], "End");
    expect(docks.selected("left")).toBe("files");
    // Shown from elsewhere (a command), the tab stop follows.
    docks.show("layers");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("opens the Tools picker's menu with Down", async () => {
    const root = dom.host();
    const docks = new DockManager(root, context);
    root.append(docks.element("right"));
    docks.addTab({ id: "display", title: "Display", slot: "right", group: "Images", render: () => {} });
    docks.addTab({ id: "filters", title: "Filters", slot: "right", group: "Images", render: () => {} });
    const picker = docks.element("right").querySelector<HTMLElement>(".dock-picker")!;
    expect(picker.hasAttribute("aria-selected")).toBe(false);
    picker.focus();
    key(picker, "ArrowDown");
    const menu = dom.document.querySelector('[role="menu"]')!;
    expect(dom.text(active()!)).toBe("Display");
    key(active()!, "ArrowDown");
    expect(dom.text(active()!)).toBe("Filters");
    // Escape closes the menu and gives the keyboard back to the picker.
    await new Promise((r) => setTimeout(r));
    key(active()!, "Escape");
    expect(menu.isConnected).toBe(false);
    expect(active()).toBe(picker);
  });

  describe("resizers", () => {
    it("are separators the arrows move (Shift for more), saying their size", () => {
      const root = dom.host();
      const docks = new DockManager(root, context);
      const left = docks.resizer("left");
      expect(left.getAttribute("role")).toBe("separator");
      expect(left.getAttribute("tabindex")).toBe("0");
      expect(left.getAttribute("aria-orientation")).toBe("vertical");
      expect(left.getAttribute("aria-valuenow")).toBe("300");
      key(left, "ArrowRight");
      expect(root.style.getPropertyValue("--left")).toBe("310px");
      key(left, "ArrowRight", { shiftKey: true });
      expect(root.style.getPropertyValue("--left")).toBe("350px");
      expect(left.getAttribute("aria-valuenow")).toBe("350");
      key(left, "Home");
      expect(root.style.getPropertyValue("--left")).toBe("160px");
      // The right dock grows to the left; the bottom one, up.
      const right = docks.resizer("right");
      key(right, "ArrowLeft");
      expect(root.style.getPropertyValue("--right")).toBe("370px");
      const bottom = docks.resizer("bottom");
      expect(bottom.getAttribute("aria-orientation")).toBe("horizontal");
      key(bottom, "ArrowUp");
      expect(root.style.getPropertyValue("--bottom")).toBe("200px");
    });

    it("let go of the pointer when the browser cancels the drag, keeping the size once", () => {
      const store = new Map<string, string>();
      const setItem = vi.fn((k: string, v: string) => void store.set(k, v));
      vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem });
      const root = dom.host();
      const docks = new DockManager(root, context);
      const left = docks.resizer("left");
      const pointer = (type: string, clientX: number) => left.dispatchEvent(Object.assign(new FakeEvent(type), { clientX, pointerId: 1 }) as unknown as Event);
      pointer("pointerdown", 100);
      expect(left.classList.contains("dragging")).toBe(true);
      pointer("pointermove", 150);
      pointer("pointermove", 160);
      expect(root.style.getPropertyValue("--left")).toBe("360px");
      expect(setItem).not.toHaveBeenCalledWith("ngplatform.left.size", expect.anything());
      pointer("pointercancel", 160);
      expect(left.classList.contains("dragging")).toBe(false);
      expect(setItem.mock.calls.filter(([k]) => k === "ngplatform.left.size")).toEqual([["ngplatform.left.size", "360px"]]);
      // No longer following the pointer.
      pointer("pointermove", 400);
      expect(root.style.getPropertyValue("--left")).toBe("360px");
    });
  });

  it("follows a drag until it ends however it ends, ending once", () => {
    const target = dom.host();
    const moves: number[] = [];
    const end = vi.fn();
    followDrag(target, (e) => moves.push(e.clientX), end);
    const fire = (type: string, clientX = 0) => target.dispatchEvent(Object.assign(new FakeEvent(type), { clientX }) as unknown as Event);
    fire("pointermove", 1);
    fire("lostpointercapture");
    fire("pointermove", 2);
    fire("pointerup");
    expect(moves).toEqual([1]);
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("menus", () => {
  const items = (ran: string[]) =>
    ["Picture…", "Movie: sweep slices or time…", "Movie: turn the 3-D view…", "Screenshot (Neuroglancer)…"].map((label, i) => ({
      label,
      disabled: i === 2,
      run: () => ran.push(label),
    }));

  it("moves with Up, Down, Home, End and a letter, passing over what is off", async () => {
    const anchor = placed("Capture");
    anchor.focus();
    const ran: string[] = [];
    showMenu(anchor, [...items(ran).slice(0, 3), "-", items(ran)[3]]);
    const menu = dom.document.querySelector('[role="menu"]')!;
    const rows = all(menu, '[role="menuitem"]');
    expect(rows.every((r) => r.getAttribute("tabindex") === "-1")).toBe(true);
    expect(active()).toBe(rows[0]);
    key(rows[0], "ArrowDown");
    expect(active()).toBe(rows[1]);
    key(rows[1], "ArrowDown");
    expect(active()).toBe(rows[3]);
    key(rows[3], "ArrowDown");
    expect(active()).toBe(rows[0]);
    key(rows[0], "ArrowUp");
    expect(active()).toBe(rows[3]);
    key(rows[3], "Home");
    expect(active()).toBe(rows[0]);
    key(rows[0], "End");
    expect(active()).toBe(rows[3]);
    key(rows[3], "m");
    expect(active()).toBe(rows[1]);
    key(rows[1], "s");
    expect(active()).toBe(rows[3]);
    // Choosing gives the keyboard back to the button first (a sheet the item opens returns it there).
    rows[3].click();
    expect(ran).toEqual(["Screenshot (Neuroglancer)…"]);
    expect(menu.isConnected).toBe(false);
    expect(active()).toBe(anchor);
  });

  it("closes on Escape without closing the sheet it was opened from", async () => {
    const s = sheet("Settings", [button("More")], []);
    showSheet(s);
    const more = s.querySelector<HTMLElement>("button")!;
    showMenu(more, items([]));
    await new Promise((r) => setTimeout(r));
    const menu = dom.document.querySelector('[role="menu"]')!;
    key(active()!, "Escape");
    expect(menu.isConnected).toBe(false);
    expect(sheetIsOpen()).toBe(true);
    expect(active()).toBe(more);
  });
});

describe("the command palette", () => {
  it("is a combobox whose highlighted row is its active descendant", () => {
    const ran: string[] = [];
    const commands: Command[] = ["Open", "Share", "Settings"].map((title) => ({ id: title.toLowerCase(), title, group: "Workspace", run: () => ran.push(title) }));
    showPalette(
      () => commands,
      () => true,
      () => undefined,
      (c) => ran.push(c.title),
    );
    const input = dom.document.querySelector<HTMLInputElement>("#palette-input")!;
    const list = dom.document.querySelector("#palette-results")!;
    expect(active()).toBe(input);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(list.getAttribute("role")).toBe("listbox");
    const options = () => all(list, '[role="option"]');
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0].id);
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1].id);
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    dom.type(input, "zzz");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(options()[0].getAttribute("aria-disabled")).toBe("true");
  });
});

describe("toasts", () => {
  it("are alerts when errors, status otherwise, and stay while the pointer or keyboard is on them", () => {
    vi.useFakeTimers();
    toast("Saved.");
    toast("The link could not be read.", "error");
    const [info, error] = all(dom.document, ".toast");
    expect(info.getAttribute("role")).toBe("status");
    expect(error.getAttribute("role")).toBe("alert");
    dom.fire(error, "mouseenter");
    vi.advanceTimersByTime(20_000);
    expect(info.isConnected).toBe(false);
    expect(error.isConnected).toBe(true);
    dom.fire(error, "mouseleave");
    vi.advanceTimersByTime(6_000);
    expect(error.isConnected).toBe(true);
    vi.advanceTimersByTime(1_500);
    expect(error.isConnected).toBe(false);
  });

  it("keeps an offer while the keyboard is in it", () => {
    vi.useFakeTimers();
    offer("Turn on Display?", [{ label: "Turn on", primary: true }], 1000);
    const el = dom.document.querySelector<HTMLElement>(".toast.offer")!;
    dom.fire(el.querySelector("button")!, "focusin");
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);
    dom.fire(el.querySelector("button")!, "focusout");
    vi.advanceTimersByTime(1000);
    expect(el.isConnected).toBe(false);
  });
});

describe("reduced motion", () => {
  /** A fling of the 3-D view: turned a little each 10 ms, then let go; returns whether it kept turning. */
  async function fling(reduce: boolean): Promise<boolean> {
    const { quat } = await import("neuroglancer/unstable/util/geom.js");
    const { addMomentum } = await import("../src/engine/momentum.js");
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const frames = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", frames);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce") }));
    const listeners: (() => void)[] = [];
    const orientation = { orientation: quat.create(), changed: { add: (l: () => void) => (listeners.push(l), () => {}), dispatch: () => listeners.forEach((l) => l()) } };
    const host = dom.host();
    const off = addMomentum(host, orientation, () => true);
    dom.fire(host, "pointerdown");
    for (let i = 0; i < 5; i++) {
      now += 10;
      quat.rotateY(orientation.orientation, orientation.orientation, 0.05);
      orientation.changed.dispatch();
    }
    dom.fire(host, "pointerup");
    const turned = frames.mock.calls.length > 0;
    off();
    vi.restoreAllMocks();
    return turned;
  }

  it("lets a fling of the 3-D view keep turning, unless the system asks for less motion", async () => {
    expect(await fling(false)).toBe(true);
    expect(await fling(true)).toBe(false);
  });
});
