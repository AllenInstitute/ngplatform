/**
 * Warnings a data type plugin finds while reading (Zarr Vectors: a newer
 * format version, tags dropped, columns it cannot read) reach the Activity
 * log as one line each, once per store, rather than only the console.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WARNING_EVENT as ZV_EVENT, setWarningSink, warnOnce } from "../plugins/zarr-vectors/src/util.js";
import { WARNING_EVENT, warningLine } from "../src/ui/panels/activity.js";

afterEach(() => vi.restoreAllMocks());

describe("data warnings in the Activity log", () => {
  it("are one line each, naming the store by its last part", () => {
    expect(warningLine({ source: "Zarr Vectors", store: "https://a.org/data/tracts.zarrvectors/", message: "written by a newer zv_version (0.9.9)" })).toEqual({
      message: "tracts.zarrvectors: written by a newer zv_version (0.9.9)",
      source: "Zarr Vectors",
    });
    expect(warningLine({ store: "gs://b/x.zarrvectors/|zarr-vectors:", message: "m" })?.message).toBe("x.zarrvectors: m");
    expect(warningLine({ message: "no store" })).toEqual({ message: "no store", source: undefined });
    expect(warningLine(undefined)).toBeUndefined();
    expect(warningLine({ message: "" })).toBeUndefined();
  });

  it("come from Zarr Vectors' reader once per store, on the event the shell listens for", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(ZV_EVENT).toBe(WARNING_EVENT);
    const target = new EventTarget();
    const lines: string[] = [];
    target.addEventListener(WARNING_EVENT, (e) => lines.push(warningLine((e as CustomEvent).detail)!.message));
    // As the main thread's sink does, onto a stand-in for window.
    setWarningSink((w) => target.dispatchEvent(new CustomEvent(WARNING_EVENT, { detail: { source: "Zarr Vectors", ...w } })));
    try {
      const message = `tags past 65,535 dropped (${Math.random()})`;
      warnOnce(message, "https://a.org/one.zarrvectors/");
      warnOnce(message, "https://a.org/one.zarrvectors/");
      warnOnce(message, "https://a.org/two.zarrvectors/");
      expect(lines).toEqual([`one.zarrvectors: ${message}`, `two.zarrvectors: ${message}`]);
    } finally {
      setWarningSink(undefined);
    }
  });
});
