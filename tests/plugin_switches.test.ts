import { describe, expect, it } from "vitest";
import { resolveEnabled, toggle } from "../src/platform/plugin_switches.js";
import type { Manifest } from "../src/sdk/types.js";

const entry = (id: string, extra: Partial<Manifest> = {}): Manifest => ({ id, name: id, version: "1.0.0", kind: "tool", ...extra });
const format = entry("org.x.format", { kind: "datatype", enabledByDefault: true });
const filter = entry("org.x.filter", { enabledByDefault: true, requires: { plugins: ["org.x.format"] } });
const report = entry("org.x.report", { requires: { plugins: ["org.x.filter"] } });
const all = [format, filter, report];

describe("which plugins are on", () => {
  it("follows defaults, then choices", () => {
    expect([...resolveEnabled(all, {}).enabled]).toEqual(["org.x.format", "org.x.filter"]);
    expect([...resolveEnabled(all, { "org.x.report": true }).enabled]).toEqual(["org.x.format", "org.x.filter", "org.x.report"]);
  });

  it("switches off a plugin whose requirement is off, through a chain", () => {
    const { enabled, blocked } = resolveEnabled(all, { "org.x.format": false, "org.x.report": true });
    expect([...enabled]).toEqual([]);
    expect(blocked.get("org.x.filter")).toEqual(["org.x.format"]);
    expect(blocked.get("org.x.report")).toEqual(["org.x.filter"]);
  });

  it("treats a requirement the app does not ship as off", () => {
    const orphan = entry("org.x.orphan", { enabledByDefault: true, requires: { plugins: ["org.x.missing"] } });
    expect(resolveEnabled([orphan], {}).blocked.get("org.x.orphan")).toEqual(["org.x.missing"]);
  });

  it("switching on brings what it requires; switching off takes what requires it", () => {
    const on = toggle(all, { "org.x.format": false, "org.x.filter": false }, "org.x.report", true);
    expect(resolveEnabled(all, on.choices).enabled.has("org.x.report")).toBe(true);
    expect(on.also.sort()).toEqual(["org.x.filter", "org.x.format"]);
    const off = toggle(all, { "org.x.report": true }, "org.x.format", false);
    expect([...resolveEnabled(all, off.choices).enabled]).toEqual([]);
    expect(off.also.sort()).toEqual(["org.x.filter", "org.x.report"]);
  });
});
