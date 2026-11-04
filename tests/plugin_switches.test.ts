import { describe, expect, it } from "vitest";
import { CATALOGUE } from "../plugins/index.js";
import { FORMERLY_ON, formerlyOnNowOff, needsReload, resolveEnabled, toggle } from "../src/platform/plugin_switches.js";
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
    expect(on.switchedOn.sort()).toEqual(["org.x.filter", "org.x.format", "org.x.report"]);
    const off = toggle(all, { "org.x.report": true }, "org.x.format", false);
    expect([...resolveEnabled(all, off.choices).enabled]).toEqual([]);
    expect(off.also.sort()).toEqual(["org.x.filter", "org.x.report"]);
    expect(off.switchedOn).toEqual([]);
  });

  it("switches a tool on without a reload, a data type only with one", () => {
    expect(needsReload(all, ["org.x.report"])).toBe(false);
    expect(needsReload(all, ["org.x.report", "org.x.format"])).toBe(true);
    expect(needsReload(all, [])).toBe(false);
  });

  it("keeps a plugin on for this tab unless this browser chose it off", () => {
    const tab = new Set(["org.x.report"]);
    expect(resolveEnabled(all, {}, tab).enabled.has("org.x.report")).toBe(true);
    expect(resolveEnabled(all, { "org.x.report": false }, tab).enabled.has("org.x.report")).toBe(false);
    // Off for this tab means off: switching it off keeps it off whatever the tab says.
    const off = toggle(all, {}, "org.x.report", false, tab);
    expect(resolveEnabled(all, off.choices, tab).enabled.has("org.x.report")).toBe(false);
  });
});

describe("the app's defaults", () => {
  const manifests = CATALOGUE.map((e) => e.manifest);

  it("has only Zarr Vectors on in a browser that chose nothing", () => {
    expect([...resolveEnabled(manifests, {}).enabled]).toEqual(["org.ngplatform.zarr-vectors"]);
  });

  it("keeps what a browser chose: on stays on, off stays off", () => {
    const choices = { "org.ngplatform.track-filtering": true, "org.ngplatform.annotations": false, "org.ngplatform.filters": true };
    expect([...resolveEnabled(manifests, choices).enabled].sort()).toEqual(["org.ngplatform.filters", "org.ngplatform.track-filtering", "org.ngplatform.zarr-vectors"]);
    // Zarr Vectors chosen off takes Track filtering and Luxar with it.
    const off = resolveEnabled(manifests, { "org.ngplatform.zarr-vectors": false, "org.ngplatform.track-filtering": true });
    expect(off.enabled.size).toBe(0);
    expect(off.blocked.get("org.ngplatform.track-filtering")).toEqual(["org.ngplatform.zarr-vectors"]);
  });

  it("tells a returning browser, once, which plugins it had on by default are off now", () => {
    const enabled = resolveEnabled(manifests, {}).enabled;
    expect(formerlyOnNowOff(manifests, {}, enabled, true, false)).toEqual(FORMERLY_ON);
    // Not on a first visit, not twice, and not of a plugin chosen either way or on for this tab.
    expect(formerlyOnNowOff(manifests, {}, enabled, false, false)).toEqual([]);
    expect(formerlyOnNowOff(manifests, {}, enabled, true, true)).toEqual([]);
    const chosen = { "org.ngplatform.annotations": false, "org.ngplatform.segmentation": true };
    const withTab = resolveEnabled(manifests, chosen, new Set(["org.ngplatform.track-filtering"])).enabled;
    expect(formerlyOnNowOff(manifests, chosen, withTab, true, false)).toEqual([]);
  });
});
