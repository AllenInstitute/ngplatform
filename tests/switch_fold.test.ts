// @vitest-environment dom
/**
 * The 3-D view's switches folded on a narrow panel (src/engine/switch_fold.ts):
 * below 560 px the plugins' switches go into one View menu before Sections.
 */
import { describe, expect, it } from "vitest";
import { FOLD_BELOW, folds, syncGroup } from "../src/engine/switch_fold.js";

/** Neuroglancer's group as it makes it: a label per plugin's switch, Sections last. */
function group(labels: string[]): HTMLElement {
  const g = document.createElement("div");
  g.className = "perspective-panel-show-slice-views";
  for (const text of [...labels, "Sections"]) {
    const label = document.createElement("label");
    label.className = "perspective-panel-toggle";
    label.append(text, Object.assign(document.createElement("input"), { type: "checkbox" }));
    g.append(label);
  }
  document.body.append(g);
  return g;
}

describe("folding the 3-D view's switches", () => {
  it("folds below 560 px with a plugin's switch to fold, never with Sections alone", () => {
    expect(FOLD_BELOW).toBe(560);
    expect(folds(559, 1)).toBe(true);
    expect(folds(560, 4)).toBe(false);
    expect(folds(300, 0)).toBe(false);
    expect(folds(0, 3)).toBe(false);
  });

  it("puts one View button first, marks the group, and its menu sets the switches", () => {
    const values: Record<string, boolean> = { Cube: true, Labels: false };
    const switches = () => Object.keys(values).map((label) => ({ label, get: () => values[label], set: (on: boolean) => void (values[label] = on) }));
    const g = group(["Cube", "Labels"]);
    syncGroup(g, 900, switches);
    const button = g.firstElementChild as HTMLButtonElement;
    expect(button.className).toBe("view-switches-more");
    expect(g.hasAttribute("data-folded")).toBe(false);
    syncGroup(g, 400, switches);
    syncGroup(g, 400, switches);
    expect(g.querySelectorAll("button.view-switches-more")).toHaveLength(1);
    expect(g.hasAttribute("data-folded")).toBe(true);

    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const boxes = Array.from(g.querySelectorAll<HTMLInputElement>(".view-switches-menu input"));
    expect(Array.from(g.querySelectorAll(".view-switches-menu label"), (l) => l.textContent)).toEqual(["Cube", "Labels"]);
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    boxes[1].click();
    expect(values.Labels).toBe(true);
    // Escape closes it; so does widening the panel.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(g.querySelector(".view-switches-menu")).toBeNull();
    button.click();
    syncGroup(g, 800, switches);
    expect(g.querySelector(".view-switches-menu")).toBeNull();
    expect(g.hasAttribute("data-folded")).toBe(false);

    // Neuroglancer fills the group anew: the button goes back in.
    g.replaceChildren(...group(["Cube"]).childNodes);
    syncGroup(g, 400, switches);
    expect(g.firstElementChild!.className).toBe("view-switches-more");
  });
});
