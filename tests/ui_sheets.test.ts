// @vitest-environment dom
/**
 * The platform's sheets (src/ui/sheets.ts) in a DOM: Settings opens on a
 * section, makes each section when it is chosen and disposes of the one it
 * replaces, and closes with Done or Escape; Open says what pasted text is
 * and opens it with Ctrl+Enter; Keyboard and mouse lists the keys; Edit
 * state refuses JSON that does not parse.  The sections' own panels are
 * stood in for here: the Compute section's is tests/ui_panels.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The sections' panels as made, in order, and those disposed of. */
const panels = vi.hoisted(() => ({ made: [] as string[], disposed: [] as string[] }));
vi.mock("../src/ui/panels/auth.js", () => ({ renderAuthPanel: stub("sign-in") }));
vi.mock("../src/ui/panels/remote.js", () => ({ renderRemotePanel: stub("compute") }));
vi.mock("../src/ui/panels/misc.js", () => ({ renderStatisticsPanel: stub("statistics") }));
vi.mock("../src/ui/overview.js", () => ({ renderOverviewSettings: (host: HTMLElement) => void host.append(Object.assign(document.createElement("p"), { textContent: "overviews" })) }));
function stub(name: string) {
  return (host: HTMLElement) => {
    panels.made.push(name);
    host.append(Object.assign(document.createElement("p"), { className: `stub-${name}`, textContent: name }));
    return () => panels.disposed.push(name);
  };
}

import { closeSheet, sheetIsOpen } from "../src/ui/overlays.js";
import { SETTINGS_SECTIONS, showEditStateSheet, showOpenSheet, showSettingsSheet, showShortcutsSheet } from "../src/ui/sheets.js";
import type { Workbench } from "../src/ui/workbench.js";

const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".sheet button")].find((b) => b.textContent?.trim() === text)!;

let wb: Workbench;
let viewDisposed: ReturnType<typeof vi.fn>;

beforeEach(() => {
  panels.made.length = 0;
  panels.disposed.length = 0;
  viewDisposed = vi.fn();
  wb = {
    engine: {
      mountSettings: (host: HTMLElement) => {
        host.append(Object.assign(document.createElement("p"), { className: "ng-settings", textContent: "Neuroglancer's settings" }));
        return viewDisposed;
      },
      mountBindingsHelp: () => () => {},
    },
    offers: { enabled: true, setEnabled: vi.fn() },
    openHandlers: { match: () => undefined },
    parseFragment: (s: string) => JSON.parse(s),
    examples: { list: () => [{ id: "demo", title: "A demo", description: "Something to look at", listed: true }] },
    store: { datasetsNotInScene: () => [], workspace: () => ({ ng: {}, app: {} }) },
    keybindings: { list: () => [{ key: "mod+k", command: "help.palette" }] },
    commands: { get: (id: string) => (id === "help.palette" ? { title: "Search commands" } : undefined) },
    log: { text: () => "" },
    run: vi.fn(),
  } as unknown as Workbench;
});
afterEach(() => {
  while (sheetIsOpen()) closeSheet();
  document.body.replaceChildren();
});

describe("Settings", () => {
  const nav = () => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")];
  const pressed = () => nav().find((b) => b.getAttribute("aria-selected") === "true")?.textContent;

  it("opens on View, with a button for every section", () => {
    showSettingsSheet(wb);
    const dialog = document.querySelector(".sheet")!;
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Settings");
    expect(nav().map((b) => b.textContent)).toEqual(Object.values(SETTINGS_SECTIONS));
    expect(nav().every((b) => b.getAttribute("role") === "tab")).toBe(true);
    expect(pressed()).toBe("View");
    // The keyboard starts on the section shown, the panel named by it.
    expect(document.activeElement?.textContent).toBe("View");
    const panel = document.querySelector(".settings-body")!;
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent).toBe("View");
    expect(document.querySelector(".settings-body .ng-settings")).not.toBeNull();
  });

  it("opens each section when chosen, disposing of the one before", () => {
    showSettingsSheet(wb);
    const body = () => document.querySelector(".settings-body")!;
    for (const b of nav().slice(1)) {
      b.click();
      expect(pressed()).toBe(b.textContent);
      expect(body().childElementCount).toBeGreaterThan(0);
    }
    expect(body().querySelector(".stub-statistics")).not.toBeNull();
    expect(panels.made).toEqual(["sign-in", "compute", "statistics"]);
    expect(viewDisposed).toHaveBeenCalledOnce();
    expect(panels.disposed).toEqual(["sign-in", "compute"]);
    expect(body().textContent).toContain("Reload the scene's layers");
  });

  it("goes from section to section with the arrow keys", () => {
    showSettingsSheet(wb);
    key(document.activeElement!, "ArrowRight");
    expect(pressed()).toBe("Sign-in");
    expect(document.activeElement?.textContent).toBe("Sign-in");
    key(document.activeElement!, "ArrowLeft");
    expect(pressed()).toBe("View");
  });

  it("opens on the section asked for, or View for one it does not have", () => {
    showSettingsSheet(wb, "compute");
    expect(pressed()).toBe("Compute");
    closeSheet();
    showSettingsSheet(wb, "nowhere" as never);
    expect(pressed()).toBe("View");
  });

  it("closes with Done, or with Escape, disposing of the section shown", () => {
    showSettingsSheet(wb, "sign-in");
    button("Done").click();
    expect(sheetIsOpen()).toBe(false);
    expect(panels.disposed).toEqual(["sign-in"]);
    showSettingsSheet(wb, "compute");
    key(document, "Escape");
    expect(sheetIsOpen()).toBe(false);
    expect(panels.disposed).toEqual(["sign-in", "compute"]);
  });

  it("keeps the offers choice in the View section", () => {
    showSettingsSheet(wb);
    const box = document.querySelector<HTMLInputElement>("#show-offers")!;
    expect(box.checked).toBe(true);
    box.click();
    expect(wb.offers.setEnabled).toHaveBeenCalledWith(false);
  });
});

describe("Open", () => {
  const input = () => document.querySelector<HTMLTextAreaElement>("#open-input")!;
  const paste = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event("input"));
  };
  const detected = () => document.querySelector(".sheet .detected")!;

  it("has the keyboard in its field, and Open waits for something to open", () => {
    showOpenSheet(wb, { openText: vi.fn(), openExample: vi.fn() });
    expect(document.activeElement).toBe(input());
    expect(document.querySelector<HTMLButtonElement>(".sheet-foot .btn.primary")!.disabled).toBe(true);
    expect(document.querySelector(".examples")!.textContent).toContain("A demo");
  });

  it("says what pasted text is: a Neuroglancer link, a data source, or something it cannot read", () => {
    showOpenSheet(wb, { openText: vi.fn(), openExample: vi.fn() });
    paste('https://neuroglancer-demo.appspot.com/#!{"layers":[]}');
    expect(detected().textContent).toMatch(/^Neuroglancer state, 0 layers/);
    paste("zarr://http://127.0.0.1:9/brain.ome.zarr");
    expect(detected().textContent).toMatch(/^A data source\. Adds the dataset “brain/);
    expect(button("Add dataset").disabled).toBe(false);
    paste("{not json");
    expect(detected().classList.contains("bad")).toBe(true);
    expect(document.querySelector<HTMLButtonElement>(".sheet-foot .btn.primary")!.disabled).toBe(true);
  });

  it("opens with Ctrl+Enter, closing once it has opened", async () => {
    const openText = vi.fn(async () => true);
    showOpenSheet(wb, { openText, openExample: vi.fn() });
    paste("zarr://http://127.0.0.1:9/brain.ome.zarr");
    key(input(), "Enter", { ctrlKey: true });
    await vi.waitFor(() => expect(sheetIsOpen()).toBe(false));
    expect(openText).toHaveBeenCalledWith("zarr://http://127.0.0.1:9/brain.ome.zarr", "pasted text", false);
  });

  it("opens an example from its button", () => {
    const openExample = vi.fn();
    showOpenSheet(wb, { openText: vi.fn(), openExample });
    document.querySelector<HTMLButtonElement>(".example button")!.click();
    expect(openExample).toHaveBeenCalledWith("demo");
    expect(sheetIsOpen()).toBe(false);
  });
});

describe("Keyboard and mouse", () => {
  it("lists the common keys and every bound command", () => {
    showShortcutsSheet(wb);
    const text = document.querySelector(".sheet")!.textContent!;
    expect(text).toContain("All commands");
    expect(text).toContain("Search commands");
    key(document, "Escape");
    expect(sheetIsOpen()).toBe(false);
  });
});

describe("Edit state", () => {
  it("refuses JSON that does not parse, and applies what does", async () => {
    const apply = vi.fn(async () => true);
    showEditStateSheet(wb, apply);
    const area = document.querySelector<HTMLTextAreaElement>("#state-editor")!;
    expect(document.activeElement).toBe(area);
    expect(JSON.parse(area.value)).toEqual({ ng: {}, app: {} });
    area.value = "{";
    button("Apply").click();
    await vi.waitFor(() => expect(document.querySelector(".sheet .detected")!.textContent).toMatch(/^Does not parse/));
    expect(apply).not.toHaveBeenCalled();
    area.value = '{"ng":{},"app":{}}';
    button("Apply").click();
    await vi.waitFor(() => expect(sheetIsOpen()).toBe(false));
    expect(apply).toHaveBeenCalledWith('{"ng":{},"app":{}}');
  });
});
