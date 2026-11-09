/**
 * The parts panels are built from (@ngplatform/sdk/dom): switches and
 * checkboxes, the info control, fields and cards that carry one, the
 * slider with its number, the empty state, the status line and updating a
 * panel in place; against the SDK's stand-in document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { card, checkbox, emptyState, field, info, numberInput, region, select, slider, statusLine, stepText, toggle } from "../src/sdk/dom.js";
import { type FakeDom, fakeDocument } from "../src/sdk/testing.js";

let dom: FakeDom;
beforeEach(() => {
  dom = fakeDocument();
});
afterEach(() => {
  dom.restore();
  vi.useRealTimers();
});

describe("toggle and checkbox", () => {
  it("makes a switch for turning a feature on, and a plain checkbox for picking an option", () => {
    const seen: boolean[] = [];
    const on = toggle("Render", false, (v) => seen.push(v));
    expect(on.input.className).toBe("switch");
    expect(on.input.getAttribute("role")).toBe("switch");
    expect(dom.text(on)).toBe("Render");
    dom.check(on.input, true);
    expect(seen).toEqual([true]);

    const pick = checkbox("Hide the jar", true, (v) => seen.push(v));
    // The audit tells the two apart by class: a checkbox has none.
    expect(pick.input.className).toBe("");
    expect(pick.input.hasAttribute("role")).toBe(false);
    expect(pick.input.checked).toBe(true);
    dom.check(pick.input, false);
    expect(seen).toEqual([true, false]);
  });

  it("names a switch without showing its label, is disabled, carries an info control, and is set in place", () => {
    const t = toggle("Track filtering", true, () => {}, { hideLabel: true, disabled: true });
    expect(t.input.getAttribute("aria-label")).toBe("Track filtering");
    expect(dom.text(t)).toBe("");
    expect(t.input.disabled).toBe(true);
    t.set(false);
    expect(t.input.checked).toBe(false);

    const c = checkbox("Glyphs", false, () => {}, { info: "Drawn over the image" });
    expect(c.querySelector(".info-btn")?.getAttribute("aria-label")).toBe("About Glyphs");
    // The info button is outside the label, so the label names only the checkbox.
    expect(c.querySelector("label")?.querySelector(".info-btn")).toBeNull();
  });
});

describe("info", () => {
  it("is a button described by its text, shown on click and hidden on Escape", () => {
    const i = info("How opaque the tissue is.", "About density");
    dom.host().append(i);
    const b = i.querySelector("button")!;
    const tip = i.querySelector<HTMLElement>(".info-tip")!;
    expect(b.getAttribute("aria-label")).toBe("About density");
    expect(b.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toBe("How opaque the tissue is.");
    expect(tip.hidden).toBe(true);
    expect(b.getAttribute("aria-expanded")).toBe("false");

    b.focus();
    b.click();
    expect(tip.hidden).toBe(false);
    expect(b.getAttribute("aria-expanded")).toBe("true");
    dom.fire(b, "keydown", "Escape");
    expect(tip.hidden).toBe(true);
    expect(b.getAttribute("aria-expanded")).toBe("false");

    // Escape is the tip's before a sheet's (which listens on the document, capturing).
    const sheetEscape = vi.fn();
    dom.document.addEventListener("keydown", sheetEscape, true);
    b.click();
    dom.fire(b, "keydown", "Escape");
    expect(tip.hidden).toBe(true);
    expect(sheetEscape).not.toHaveBeenCalled();
    dom.fire(b, "keydown", "Escape");
    expect(sheetEscape).toHaveBeenCalledTimes(1);

    // Again by click, then away: blur hides it.
    b.click();
    expect(tip.hidden).toBe(false);
    b.blur();
    expect(tip.hidden).toBe(true);
  });

  it("shows on hover until the pointer leaves, unless it was clicked open", () => {
    const i = info("Text");
    dom.host().append(i);
    const b = i.querySelector("button")!;
    const tip = i.querySelector<HTMLElement>(".info-tip")!;
    dom.fire(b, "mouseenter");
    expect(tip.hidden).toBe(false);
    dom.fire(b, "mouseleave");
    expect(tip.hidden).toBe(true);
    dom.fire(b, "mouseenter");
    b.click();
    dom.fire(b, "mouseleave");
    expect(tip.hidden).toBe(false);
  });

  it("gives every control its own id", () => {
    const a = info("A").querySelector<HTMLElement>(".info-tip")!;
    const b = info("B").querySelector<HTMLElement>(".info-tip")!;
    expect(a.id).not.toBe(b.id);
  });

  it("does not toggle the card or the label it sits in", () => {
    const c = card("test.info", "Rules", { open: false, info: "A rule gives data a sign-in." });
    dom.host().append(c);
    const b = c.querySelector<HTMLElement>(".info-btn")!;
    const summaryClicks = vi.fn();
    c.querySelector("summary")!.addEventListener("click", summaryClicks);
    const notPrevented = dom.fire(b, "click");
    expect(notPrevented).toBe(false);
    expect(summaryClicks).not.toHaveBeenCalled();
    expect(c.querySelector<HTMLElement>(".info-tip")!.hidden).toBe(false);
  });
});

describe("field", () => {
  it("is a label around its control, with a hint", () => {
    const f = field("Name", select([["a", "A"]], "a", () => {}), "As in the link");
    expect(f.tagName).toBe("LABEL");
    expect(f.className).toBe("field");
    expect(dom.text(f)).toContain("As in the link");
  });

  it("with an info control, points its label at the control", () => {
    const s = select([["a", "A"]], "a", () => {});
    const f = field("Preset", s, { info: "The colours and opacities" });
    expect(f.tagName).toBe("DIV");
    const label = f.querySelector("label")!;
    expect(s.id).not.toBe("");
    expect(label.getAttribute("for")).toBe(s.id);
    expect(label.textContent).toBe("Preset");
    expect(f.querySelector(".info-btn")?.getAttribute("aria-label")).toBe("About Preset");
  });

  it("points to the first input of a control made of several (a slider)", () => {
    const sl = slider(1, { min: 0, max: 2, label: "Exposure" });
    const f = field("Exposure", sl, { info: "Brighter or darker" });
    expect(f.querySelector("label")!.getAttribute("for")).toBe(sl.range.id);
  });
});

describe("slider", () => {
  it("keeps the range and the number in step, previewing as it moves and settling on release", () => {
    const input = vi.fn();
    const change = vi.fn();
    const s = slider(0.5, { min: 0, max: 2, step: 0.1, unit: "mm", label: "Width", oninput: input, onchange: change });
    expect(s.range.value).toBe("0.5");
    expect(s.number.value).toBe("0.5");
    expect(s.range.getAttribute("min")).toBe("0");
    expect(s.range.getAttribute("max")).toBe("2");
    expect(s.range.getAttribute("step")).toBe("0.1");
    expect(s.number.getAttribute("aria-label")).toBe("Width");
    expect(s.querySelector(".slider-unit")?.textContent).toBe("mm");

    s.range.value = "0.30000000000000004";
    dom.fire(s.range, "input");
    expect(s.number.value).toBe("0.3");
    expect(input).toHaveBeenCalledWith(0.30000000000000004);
    expect(change).not.toHaveBeenCalled();
    dom.fire(s.range, "change");
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("takes a typed number within its ends (or beyond, unbounded), and puts back one that is not a number", () => {
    const change = vi.fn();
    const s = slider(1, { min: 0, max: 5, onchange: change });
    dom.type(s.number, "9");
    expect(s.number.value).toBe("5");
    expect(s.range.value).toBe("5");
    expect(change).toHaveBeenLastCalledWith(5);
    dom.type(s.number, "");
    expect(s.number.value).toBe("5");
    expect(change).toHaveBeenCalledTimes(1);

    const free = slider(0, { min: -10, max: 10, unbounded: true, onchange: change });
    expect(free.number.hasAttribute("max")).toBe(false);
    dom.type(free.number, "25");
    expect(free.number.value).toBe("25");
    expect(free.range.value).toBe("10");
    expect(change).toHaveBeenLastCalledWith(25);
  });

  it("calls oninput when settled, if it has no onchange", () => {
    const input = vi.fn();
    const s = slider(1, { min: 0, max: 5, oninput: input });
    dom.type(s.number, "2");
    expect(input).toHaveBeenLastCalledWith(2);
  });

  it("is set from the state in place, but not while it is typed in or dragged", () => {
    vi.useFakeTimers();
    const s = slider(1, { min: 0, max: 10, step: 1 });
    s.set(4);
    expect([s.range.value, s.number.value]).toEqual(["4", "4"]);

    // Typing: the state's value waits until the box loses the keyboard.
    s.number.focus();
    s.set(6);
    expect(s.number.value).toBe("4");
    s.number.blur();
    expect([s.range.value, s.number.value]).toEqual(["6", "6"]);

    // Dragging: the value the person let go at is reported before a waiting one is shown.
    const settled: number[] = [];
    const t = slider(1, { min: 0, max: 10, onchange: (v) => settled.push(v) });
    dom.fire(t.range, "pointerdown");
    t.set(2);
    t.range.value = "7";
    dom.fire(t.range, "input");
    expect(t.number.value).toBe("7");
    dom.fire(dom.document, "pointerup");
    dom.fire(t.range, "change");
    expect(settled).toEqual([7]);
    expect(t.range.value).toBe("2");
    vi.runAllTimers();
  });

  it("writes numbers to the step's decimals, and others to six figures", () => {
    expect(stepText(0.1 + 0.2, 0.1)).toBe("0.3");
    expect(stepText(40, 1)).toBe("40");
    expect(stepText(0.123456789, 0.1)).toBe("0.123457");
    expect(stepText(2.5, 0.005)).toBe("2.5");
  });
});

describe("select and numberInput", () => {
  it("are set in place; a number box waits while it is typed in", () => {
    const s = select([["a", "A"], ["b", "B"]], "a", () => {});
    s.set("b");
    expect(s.value).toBe("b");
    const n = numberInput(3, () => {});
    n.focus();
    n.set(5);
    expect(n.value).toBe("3");
    n.blur();
    expect(n.value).toBe("5");
  });
});

describe("emptyState", () => {
  it("is one line and its action", () => {
    const run = vi.fn();
    const e = emptyState("No image in this scene.", { label: "Open data…", run });
    expect(e.querySelector(".empty")?.textContent).toBe("No image in this scene.");
    const b = e.querySelector("button")!;
    expect(b.textContent).toBe("Open data…");
    b.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(emptyState("Nothing matches.").querySelector("button")).toBeNull();
  });
});

describe("statusLine", () => {
  it("is hidden with nothing to report, shows progress and errors (with an action), and clears", () => {
    const s = statusLine();
    expect(s.hidden).toBe(true);
    expect(s.getAttribute("role")).toBe("status");
    s.progress("Reading 2 of 5 levels…");
    expect(s.hidden).toBe(false);
    expect(s.className).toBe("status-line progress");
    expect(dom.text(s)).toBe("Reading 2 of 5 levels…");

    const retry = vi.fn();
    s.error("Could not read the store: 404", { label: "Retry", run: retry });
    expect(s.className).toBe("status-line error");
    s.querySelector("button")!.click();
    expect(retry).toHaveBeenCalledTimes(1);

    s.clear();
    expect(s.hidden).toBe(true);
    expect(s.querySelector("button")).toBeNull();
    expect(dom.text(s)).toBe("");
  });
});

describe("region", () => {
  it("draws again only when its key changes, leaving the rest of the panel alone", () => {
    const render = vi.fn((names: string[]) => names.map((n) => n.toUpperCase()));
    const r = region(render, { class: "list" });
    expect(r.className).toBe("list");
    expect(r.update(["a", "b"])).toBe(true);
    expect(dom.text(r)).toBe("A B");
    expect(r.update(["a", "b"])).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
    expect(r.update(["a"])).toBe(true);
    expect(dom.text(r)).toBe("A");
  });

  it("keeps a focused control beside it focused, and its value, across updates", () => {
    const host = dom.host();
    const rows = region((n: number) => Array.from({ length: n }, (_, i) => `row ${i}`));
    const count = numberInput(1, () => {});
    host.append(count, rows);
    const sync = (n: number) => {
      rows.update(n);
      count.set(n);
    };
    sync(2);
    count.focus();
    count.value = "3"; // half typed
    sync(4);
    expect(dom.document.activeElement).toBe(count);
    expect(count.value).toBe("3");
    expect(dom.text(rows)).toBe("row 0 row 1 row 2 row 3");
  });
});
