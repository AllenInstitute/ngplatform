/**
 * The stack of open sheets (src/core/sheet_stack.ts), as overlays.ts uses
 * it: a dialog opened from a sheet goes above it, Escape closes the top one
 * only, and a dialog answering itself as it closes leaves the sheet below
 * open.
 */
import { describe, expect, it } from "vitest";
import { SheetStack } from "../src/core/sheet_stack.js";

/** A sheet as overlays.ts makes one: its close takes it off the stack, then runs its onClose. */
function opener(stack: SheetStack, closed: string[]) {
  return (name: string, onClose?: () => void) => {
    const sheet = {
      name,
      close: () => {
        if (!stack.remove(sheet)) return;
        closed.push(name);
        stack.closingWhile(() => onClose?.());
      },
    };
    stack.push(sheet);
    return sheet;
  };
}

describe("SheetStack", () => {
  it("puts a sheet opened over another on top, and Escape closes from the top down", () => {
    const stack = new SheetStack();
    const closed: string[] = [];
    const open = opener(stack, closed);
    const settings = open("Settings");
    const confirm = open("Confirm");
    expect(stack.size).toBe(2);
    expect(stack.top()).toBe(confirm);
    expect(stack.below()).toBe(settings);
    stack.closeTop(); // Escape
    expect(closed).toEqual(["Confirm"]);
    expect(stack.top()).toBe(settings);
    stack.closeTop();
    expect(closed).toEqual(["Confirm", "Settings"]);
    expect(stack.size).toBe(0);
    stack.closeTop(); // nothing open: nothing happens
    expect(closed).toEqual(["Confirm", "Settings"]);
  });

  it("a dialog that answers as it closes (and so asks to close the top) leaves the sheet below open", () => {
    const stack = new SheetStack();
    const closed: string[] = [];
    const open = opener(stack, closed);
    open("Settings");
    // confirmDialog before the stack: its onClose answered "no", which called closeSheet().
    open("Confirm", () => stack.closeTop());
    stack.closeTop();
    expect(closed).toEqual(["Confirm"]);
    expect(stack.size).toBe(1);
  });

  it("two confirms one after the other both work", () => {
    const stack = new SheetStack();
    const closed: string[] = [];
    const open = opener(stack, closed);
    open("Settings");
    const first = open("Confirm 1");
    first.close(); // answered
    const second = open("Confirm 2");
    expect(stack.top()).toBe(second);
    second.close();
    expect(closed).toEqual(["Confirm 1", "Confirm 2"]);
    expect(stack.size).toBe(1);
  });

  it("a second confirm opened while the first is open goes above it, and does not cancel it", () => {
    const stack = new SheetStack();
    const closed: string[] = [];
    const open = opener(stack, closed);
    const first = open("Confirm 1");
    const second = open("Confirm 2");
    expect(closed).toEqual([]);
    second.close();
    expect(stack.top()).toBe(first);
    first.close();
    expect(closed).toEqual(["Confirm 2", "Confirm 1"]);
  });

  it("a sheet closed by its own handle comes off wherever it is, once", () => {
    const stack = new SheetStack();
    const closed: string[] = [];
    const open = opener(stack, closed);
    const a = open("A");
    const b = open("B");
    const c = open("C");
    b.close();
    b.close();
    expect(closed).toEqual(["B"]);
    expect(stack.top()).toBe(c);
    expect(stack.below()).toBe(a);
    stack.closeTop();
    expect(stack.top()).toBe(a);
  });
});
