// @vitest-environment dom
/**
 * The shell's layout (src/ui/shell.ts) in a DOM, before it is attached to
 * an engine: the top bar, the views and the three docks are mounted with
 * their landmarks and names (one left column: the layers above the tools),
 * the docks start as they should, the status line takes items, and the top
 * bar's buttons and menus (Open, Share, Capture, Settings, Help, the
 * command search) run the commands they name.  What attaching wires up
 * (the engine, plugins, keys) is the browser smoke test's
 * (tests/e2e/smoke.mjs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Neuroglancer's modules, which the shell imports, read WebGL's constants as they load.
  const constants = new Proxy(function () {}, { get: (t, k) => (typeof k === "string" && /^[A-Z][A-Z0-9_]*$/.test(k) ? 0x1000 : Reflect.get(t, k)) });
  Object.assign(globalThis, { WebGL2RenderingContext: constants, WebGLRenderingContext: constants });
});

import { closeMenu } from "../src/ui/overlays.js";
import { Shell } from "../src/ui/shell.js";
import { addStatusItem } from "../src/ui/statusbar.js";

let root: HTMLElement;
let run: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  root = document.body.appendChild(document.createElement("div"));
  const shell = new Shell(root);
  // Only what the top bar uses of the workbench: attach() makes the real one.
  run = vi.fn();
  (shell as unknown as { wb: unknown }).wb = { run };
});
afterEach(() => {
  closeMenu();
  document.body.replaceChildren();
});

const labelled = (label: string) => root.querySelector<HTMLButtonElement>(`.topbar button[aria-label="${label}"]`)!;
const byText = (text: string) => [...root.querySelectorAll<HTMLButtonElement>(".topbar button")].find((b) => b.textContent?.trim() === text)!;
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>(".menu .menu-item")];

describe("layout", () => {
  it("mounts the top bar, the views and the docks, with their landmarks", () => {
    expect(root.querySelector("header.topbar")).not.toBeNull();
    expect(root.querySelector("section.engine")!.getAttribute("aria-label")).toBe("Viewer");
    expect(root.querySelector(".engine .engine-host")).not.toBeNull();
    expect([...root.querySelectorAll("aside.dock")].map((d) => d.getAttribute("aria-label"))).toEqual(["Layers", "Tools", "Activity"]);
    expect(root.querySelector(".scene-tabs")!.getAttribute("role")).toBe("tablist");
    expect(root.querySelector(".topbar .status")!.getAttribute("role")).toBe("status");
    // One drag handle a dock.
    expect(root.querySelectorAll(".resizer")).toHaveLength(3);
  });

  it("has the layers on the left, the tools in a column beside them, and the views filling the rest", () => {
    const workspace = root.querySelector(".workspace")!;
    expect([...workspace.children].map((e) => e.className)).toEqual(["side", "resizer resizer-left", "side side-tools", "resizer resizer-tools", "centre"]);
    expect([...workspace.querySelector(".side")!.children].map((e) => e.id)).toEqual(["dock-left"]);
    expect([...workspace.querySelector(".side-tools")!.children].map((e) => e.id)).toEqual(["dock-tools"]);
    // Nothing to the right of the views.
    expect(workspace.lastElementChild!.classList.contains("centre")).toBe(true);
    expect(root.querySelector(".dock-right")).toBeNull();
  });

  it("starts with the left column open, no Tools section (no tool is on), the Activity dock collapsed, and nothing over the views", () => {
    const dock = (slot: string) => root.querySelector<HTMLElement>(`.dock-${slot}`)!;
    expect(dock("left").classList.contains("collapsed")).toBe(false);
    expect(dock("tools").hidden).toBe(true);
    expect(root.classList.contains("tools-empty")).toBe(true);
    expect(dock("bottom").classList.contains("collapsed")).toBe(true);
    expect(root.querySelector(".start-card")).toBeNull();
  });

  it("puts the status items to the right of the activity message, on the status line", () => {
    const head = root.querySelector(".dock-bottom .dock-head")!;
    const parts = [...head.children].map((e) => e.classList[0]);
    expect(parts.indexOf("status-items")).toBe(parts.indexOf("dock-status") + 1);
    const item = Object.assign(document.createElement("span"), { textContent: "S-21-46 › 20 µm" });
    const remove = addStatusItem(item, { order: 10, label: "Scale" });
    expect(head.querySelector(".status-items")!.contains(item)).toBe(true);
    remove();
    expect(head.querySelector(".status-items")!.contains(item)).toBe(false);
  });

  it("names every icon-only button for a screen reader", () => {
    // Its label, its text, or else its title (the Activity line, empty until there is activity).
    const name = (b: HTMLButtonElement) => b.getAttribute("aria-label") || b.textContent?.trim() || b.title;
    const unnamed = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => !name(b));
    expect(unnamed.map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
  });
});

describe("the top bar", () => {
  it("runs Open, Neuroglancer, Settings, undo, redo and the command search", () => {
    byText("Open").click();
    labelled("Open in Neuroglancer").click();
    labelled("Settings").click();
    labelled("Undo").click();
    labelled("Redo").click();
    labelled("Search commands").click();
    expect(run.mock.calls.map((c) => c[0])).toEqual(["workspace.open", "workspace.openInNeuroglancer", "settings.open", "edit.undo", "edit.redo", "help.palette"]);
  });

  it("opens the Share menu, whose items copy, save and open the workspace", () => {
    const share = byText("Share");
    expect(share.getAttribute("aria-haspopup")).toBe("menu");
    share.click();
    expect(menuItems().map((b) => b.textContent?.trim())).toEqual([
      "Copy workspace link",
      "Save workspace as a file",
      "Copy scene as Neuroglancer link",
      "Copy scene as Neuroglancer JSON",
      "Open in Neuroglancer",
      "Open in Neuroglancer with Zarr Vectors",
    ]);
    // The two that open another tab marked so (an icon).
    expect(menuItems().map((b) => b.querySelector("svg") !== null)).toEqual([false, false, false, false, true, true]);
    // The menu has the keyboard on its first item.
    expect(document.activeElement).toBe(menuItems()[0]);
    menuItems()[1].click();
    expect(run).toHaveBeenCalledWith("workspace.saveFile");
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("opens the Capture and Help menus", () => {
    labelled("Capture").click();
    expect(menuItems().map((b) => b.textContent)).toContain("Picture…");
    menuItems()[0].click();
    expect(run).toHaveBeenLastCalledWith("view.capture");
    labelled("Help").click();
    menuItems().find((b) => b.textContent === "Keyboard and mouse")!.click();
    expect(run).toHaveBeenLastCalledWith("help.shortcuts");
  });

  it("toggles a dock from its button", () => {
    const bottom = root.querySelector(".dock-bottom")!;
    bottom.querySelector<HTMLButtonElement>(".dock-toggle")!.click();
    expect(bottom.classList.contains("collapsed")).toBe(false);
    expect(root.classList.contains("bottom-collapsed")).toBe(false);
  });
});
