import { describe, expect, it } from "vitest";
import { readSlice, SliceError, writeSlice } from "../src/core/app_state.js";
import { CommandError, CommandRegistry } from "../src/core/commands.js";
import { KeybindingTable, keyLabel, normaliseKey, shortcutRows } from "../src/core/keybindings.js";
import { validate, withDefaults } from "../src/core/schema.js";
import { ContextKeys, evaluateWhen, whenKeys } from "../src/core/when.js";

describe("schema", () => {
  const schema = {
    type: "object" as const,
    required: ["center"],
    properties: {
      center: { type: "array" as const, items: { type: "number" as const }, minItems: 3, maxItems: 3 },
      radius: { type: "number" as const, minimum: 0, default: 5 },
      units: { type: "string" as const, enum: ["mm", "voxels"] },
    },
    additionalProperties: false,
  };

  it("accepts valid values and reports each problem with its path", () => {
    expect(validate(schema, { center: [1, 2, 3], radius: 2 })).toEqual([]);
    expect(validate(schema, { radius: -1, units: "km", extra: 1 })).toEqual([
      "center: is required",
      "radius: must be at least 0",
      'units: must be one of "mm", "voxels"',
      "extra: is not allowed",
    ]);
    expect(validate(schema, { center: [1, "2"] })).toEqual(["center: needs at least 3 items", "center[1]: must be a number"]);
    expect(validate({ type: "integer" }, 1.5)).toEqual(["value: must be an integer"]);
  });

  it("fills defaults", () => {
    expect(withDefaults(schema, { center: [0, 0, 0] })).toEqual({ center: [0, 0, 0], radius: 5 });
    expect(withDefaults(schema, undefined)).toEqual({ radius: 5 });
  });
});

describe("when clauses", () => {
  const context = { hasLayers: true, selectedLayerType: "segmentation", sceneCount: 1 };
  it("evaluates keys, negation, comparison, and/or", () => {
    expect(evaluateWhen(undefined, {})).toBe(true);
    expect(evaluateWhen("hasLayers", context)).toBe(true);
    expect(evaluateWhen("!hasLayers", context)).toBe(false);
    expect(evaluateWhen("selectedLayerType == segmentation", context)).toBe(true);
    expect(evaluateWhen("selectedLayerType == 'image'", context)).toBe(false);
    expect(evaluateWhen("sceneCount != 1", context)).toBe(false);
    expect(evaluateWhen("missing || hasLayers && selectedLayerType != image", context)).toBe(true);
    expect(evaluateWhen("missing == x", context)).toBe(false);
  });
  it("lists the keys an expression reads", () => {
    expect(whenKeys("!a && b == 1 || c")).toEqual(["a", "b", "c"]);
  });
});

describe("commands with arguments", () => {
  it("validates arguments, fills defaults, and returns results", async () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "add",
      title: "Add",
      group: "Test",
      args: { type: "object", required: ["a"], properties: { a: { type: "number" }, b: { type: "number", default: 10 } } },
      run: ({ a, b }: { a: number; b: number }) => a + b,
    });
    expect(await registry.invoke("add", { a: 1 })).toBe(11);
    await expect(registry.invoke("add", { a: "x" })).rejects.toThrow(CommandError);
    await expect(registry.invoke("nope")).rejects.toThrow(/no command/);
  });

  it("honours when clauses and removes an owner's commands", async () => {
    const registry = new CommandRegistry();
    const context = new ContextKeys();
    registry.useContext(context);
    let ran = 0;
    registry.register({ id: "x", title: "X", group: "T", when: "hasLayers", owner: "plug", run: () => ran++ });
    expect(registry.available("x")).toBe(false);
    await registry.invoke("x");
    context.set("hasLayers", true);
    await registry.invoke("x");
    expect(ran).toBe(1);
    registry.removeOwner("plug");
    expect(registry.has("x")).toBe(false);
  });
});

describe("key bindings", () => {
  it("lists the keyboard reference one row per action, digit runs as one key", () => {
    const table = new KeybindingTable();
    for (let i = 1; i <= 9; i++) {
      table.add({ key: String(i), command: "dataset.toggle", args: { index: i } });
      table.add({ key: `alt+${i}`, command: "dataset.select", args: { index: i } });
    }
    table.add({ key: "b", command: "seg.tool", args: { tool: "brush" } });
    table.add({ key: "e", command: "seg.tool", args: { tool: "eraser" } });
    table.add({ key: "mod+shift+z", command: "edit.redo" });
    table.add({ key: "mod+y", command: "edit.redo" });
    table.add({ key: "x", command: "unknown" });
    const titles: Record<string, string> = { "dataset.toggle": "Show or hide a dataset", "dataset.select": "Select a dataset", "seg.tool": "Tool", "edit.redo": "Redo" };
    expect(shortcutRows(table.list(), (id) => titles[id])).toEqual([
      { title: "Show or hide a dataset", keys: ["1–9"] },
      { title: "Select a dataset", keys: ["alt+1–9"] },
      { title: "Tool: brush", keys: ["b"] },
      { title: "Tool: eraser", keys: ["e"] },
      { title: "Redo", keys: ["mod+shift+z", "mod+y"] },
    ]);
  });

  it("normalises keys and labels them per platform", () => {
    expect(normaliseKey("Shift+Mod+Z")).toBe("mod+shift+z");
    expect(normaliseKey("ctrl+k")).toBe("mod+k");
    expect(keyLabel("mod+shift+z", true)).toBe("⌘⇧Z");
    expect(keyLabel("mod+k", false)).toBe("Ctrl+K");
  });

  it("resolves the latest binding whose context holds, and reports conflicts", () => {
    const table = new KeybindingTable();
    table.add({ key: "mod+k", command: "palette", inInputs: true });
    table.add({ key: "1", command: "toggle", args: { index: 1 } });
    const off = table.add({ key: "1", command: "other", when: "special" });
    expect(table.resolve("1", {}, false)?.command).toBe("toggle");
    expect(table.resolve("1", { special: true }, false)?.command).toBe("other");
    expect(table.resolve("1", {}, true)).toBeUndefined();
    expect(table.resolve("Mod+K", {}, true)?.command).toBe("palette");
    off();
    table.add({ key: "1", command: "clash" });
    expect(table.conflicts()).toEqual([{ key: "1", when: "", commands: ["toggle", "clash"] }]);
    expect(table.keyFor("palette")).toBe("mod+k");
  });
});

describe("app-state slices", () => {
  const v2 = {
    key: "tracto",
    version: 2,
    initial: () => ({ groups: [] as string[], colour: "red" }),
    migrate: (data: unknown, from: number) => {
      expect(from).toBe(1);
      return { groups: (data as { names: string[] }).names, colour: "red" };
    },
  };
  it("reads the initial value, round-trips, and migrates older versions", () => {
    expect(readSlice({}, v2)).toEqual({ groups: [], colour: "red" });
    const app = writeSlice({}, v2, { groups: ["a"], colour: "blue" });
    expect(app).toEqual({ tracto: { version: 2, data: { groups: ["a"], colour: "blue" } } });
    expect(readSlice(app, v2)).toEqual({ groups: ["a"], colour: "blue" });
    expect(readSlice({ tracto: { version: 1, data: { names: ["x"] } } }, v2)).toEqual({ groups: ["x"], colour: "red" });
    expect(() => readSlice({ tracto: { version: 3, data: {} } }, v2)).toThrow(SliceError);
  });
});
