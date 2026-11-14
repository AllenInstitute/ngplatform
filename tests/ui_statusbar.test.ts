// @vitest-environment dom
/**
 * Items on the status line (src/ui/statusbar.ts): drawn in their order
 * (lower first, then the order they came in), each removed by its
 * disposer (once), the line hidden with none, and a tooltip with the
 * whole text, kept as the item changes, for when it is cut short.
 */
import { describe, expect, it } from "vitest";
import { StatusItems } from "../src/ui/statusbar.js";

const span = (text: string) => Object.assign(document.createElement("span"), { textContent: text });

describe("status items", () => {
  it("are drawn in their order, after those of the same order that came first", () => {
    const items = new StatusItems();
    expect(items.element.hidden).toBe(true);
    const level = span("L3");
    const crumb = span("S-21-46 › 20 µm › 6.5 µm");
    const other = span("other");
    items.add(level, { order: 20 });
    items.add(other);
    items.add(crumb, { order: 10 });
    const later = span("later");
    items.add(later, { order: 20 });
    expect(items.list()).toEqual([crumb, level, later, other]);
    expect([...items.element.children].map((c) => c.textContent)).toEqual(["S-21-46 › 20 µm › 6.5 µm", "L3", "later", "other"]);
    expect(items.element.hidden).toBe(false);
    expect(items.element.getAttribute("role")).toBe("group");
  });

  it("are removed by their disposer, once, and the line hides when the last goes", () => {
    const items = new StatusItems();
    const a = span("a");
    const b = span("b");
    const removeA = items.add(a);
    const removeB = items.add(b);
    removeA();
    removeA();
    expect(items.list()).toEqual([b]);
    removeB();
    expect(items.list()).toEqual([]);
    expect(items.element.hidden).toBe(true);
    expect(items.element.childElementCount).toBe(0);
  });

  it("carry their whole text, and their label, in a tooltip that follows the text", async () => {
    const items = new StatusItems();
    const crumb = span("S-21-46");
    items.add(crumb, { label: "Scale" });
    const wrap = items.element.firstElementChild as HTMLElement;
    expect(wrap.className).toBe("status-item");
    expect(wrap.getAttribute("aria-label")).toBe("Scale");
    expect(wrap.title).toBe("Scale: S-21-46");
    crumb.textContent = "S-21-46 › 20 µm";
    await Promise.resolve();
    expect(wrap.title).toBe("Scale: S-21-46 › 20 µm");
  });
});
