/**
 * Errors kept locally: which are reported and how often, the stale chunk
 * after a redeploy and its one reload, failed plugin imports, and the log
 * as a file.
 */
import { describe, expect, it } from "vitest";
import {
  describeError,
  errorKey,
  ErrorThrottle,
  isIgnoredError,
  isStaleChunkError,
  logFileName,
  logText,
  reloadOnceForStaleChunk,
  STALE_RELOAD_KEY,
} from "../src/core/errors.js";
import { ErrorReporting, type ReportedError, reported } from "../src/ui/error_reporting.js";

describe("ErrorThrottle", () => {
  it("reports an error once per window, and how often it came between", () => {
    const t = new ErrorThrottle({ repeatMs: 1000, max: 100, windowMs: 1000 });
    expect(t.admit("a", 0)).toEqual({ report: true, repeats: 0, dropped: 0 });
    expect(t.admit("a", 10).report).toBe(false);
    expect(t.admit("a", 500).report).toBe(false);
    expect(t.admit("a", 999).report).toBe(false);
    // Past the window: reported again, with the three in between.
    expect(t.admit("a", 1000)).toEqual({ report: true, repeats: 3, dropped: 0 });
    expect(t.admit("a", 1001).report).toBe(false);
  });

  it("keeps different errors apart", () => {
    const t = new ErrorThrottle({ repeatMs: 1000 });
    expect(t.admit("a", 0).report).toBe(true);
    expect(t.admit("b", 1).report).toBe(true);
    expect(t.admit("a", 2).report).toBe(false);
  });

  it("reports at most `max` errors per window, and counts the rest", () => {
    const t = new ErrorThrottle({ repeatMs: 0, max: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) expect(t.admit(`e${i}`, i).report).toBe(true);
    expect(t.admit("e3", 10)).toEqual({ report: false, repeats: 0, dropped: 1 });
    expect(t.admit("e4", 20)).toEqual({ report: false, repeats: 0, dropped: 2 });
    // The window moves on: the next one says how many were left out.
    expect(t.admit("e5", 1000)).toEqual({ report: true, repeats: 0, dropped: 2 });
    expect(t.admit("e6", 1001)).toEqual({ report: true, repeats: 0, dropped: 0 });
  });

  it("does not flood: an error thrown every frame for a minute is reported a few times", () => {
    const t = new ErrorThrottle();
    let reports = 0;
    for (let ms = 0; ms < 60_000; ms += 16) if (t.admit("draw", ms).report) reports++;
    expect(reports).toBe(2);
  });
});

describe("the key, the description and what is ignored", () => {
  it("one error thrown from the same place has one key; from elsewhere, another", () => {
    const here = "Error: boom\n    at draw (main.js:10:5)\n    at frame (main.js:20:1)";
    const there = "Error: boom\n    at load (main.js:99:5)";
    expect(errorKey("boom", here)).toBe(errorKey("boom", here.replace("frame", "tick")));
    expect(errorKey("boom", here)).not.toBe(errorKey("boom", there));
    // Firefox and Safari: function@file:line:column.
    expect(errorKey("boom", "draw@main.js:10:5\nframe@main.js:20:1")).toContain("draw@main.js:10:5");
  });

  it("describes errors, strings and other values", () => {
    expect(describeError(new TypeError("x is undefined")).message).toBe("TypeError: x is undefined");
    expect(describeError(new Error("plain")).message).toBe("plain");
    expect(describeError(new Error("plain")).stack).toContain("plain");
    expect(describeError("a string")).toEqual({ message: "a string" });
    expect(describeError({ code: 3 })).toEqual({ message: '{"code":3}' });
    expect(describeError(undefined).message).toBe("undefined");
  });

  it("ignores cancelled requests and the resize observer's note", () => {
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(isIgnoredError(abort, abort.message)).toBe(true);
    expect(isIgnoredError(undefined, "ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isIgnoredError(new Error("real"), "real")).toBe(false);
  });
});

describe("stale chunks", () => {
  it("knows each browser's wording", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/plugin-abc.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("error loading dynamically imported module: https://x/assets/plugin-abc.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("Unable to preload CSS for /assets/main-abc.css"))).toBe(true);
    expect(isStaleChunkError("Failed to fetch dynamically imported module: x.js")).toBe(true);
    expect(isStaleChunkError(new Error("Failed to fetch"))).toBe(false);
    expect(isStaleChunkError(new SyntaxError("Unexpected token"))).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });

  const storage = () => {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
  };

  it("reloads once per build, so a file missing for good cannot loop", () => {
    const s = storage();
    let reloads = 0;
    const reload = () => reloads++;
    expect(reloadOnceForStaleChunk(s, "main-old.js", reload)).toBe(true);
    expect(s.map.get(STALE_RELOAD_KEY)).toBe("main-old.js");
    // The reload brought the same build back (a cached page): no second reload.
    expect(reloadOnceForStaleChunk(s, "main-old.js", reload)).toBe(false);
    expect(reloads).toBe(1);
    // A later redeploy, under the new build: one reload again.
    expect(reloadOnceForStaleChunk(s, "main-new.js", reload)).toBe(true);
    expect(reloadOnceForStaleChunk(s, "main-new.js", reload)).toBe(false);
    expect(reloads).toBe(2);
  });

  it("never reloads without storage", () => {
    let reloads = 0;
    expect(reloadOnceForStaleChunk(undefined, "main.js", () => reloads++)).toBe(false);
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(reloadOnceForStaleChunk(refusing, "main.js", () => reloads++)).toBe(false);
    expect(reloads).toBe(0);
  });
});

describe("ErrorReporting", () => {
  /** A window enough for unhandled rejections and Vite's preload event. */
  const fakeWindow = () => new EventTarget() as unknown as Window;
  const rejection = (reason: unknown) => Object.assign(new Event("unhandledrejection"), { reason });

  it("reports an unhandled rejection with its stack, once per repeat window", () => {
    const target = fakeWindow();
    const out: ReportedError[] = [];
    const errors = new ErrorReporting(target, () => false);
    errors.attach((e) => out.push(e));
    const error = new Error("nothing here");
    target.dispatchEvent(rejection(error));
    target.dispatchEvent(rejection(error));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ message: "nothing here", source: "Unhandled" });
    expect(out[0].stack).toContain("nothing here");
  });

  it("keeps what came before the shell, and gives it once attached", () => {
    const target = fakeWindow();
    const errors = new ErrorReporting(target, () => false);
    target.dispatchEvent(rejection(new Error("early")));
    const out: ReportedError[] = [];
    errors.attach((e) => out.push(e));
    expect(out.map((e) => e.message)).toEqual(["early"]);
  });

  it("reloads for a stale chunk instead of reporting it", () => {
    const target = fakeWindow();
    const out: ReportedError[] = [];
    const asked: unknown[] = [];
    const errors = new ErrorReporting(target, (e) => (asked.push(e), true));
    errors.attach((e) => out.push(e));
    target.dispatchEvent(rejection(new TypeError("Failed to fetch dynamically imported module: x.js")));
    expect(out).toHaveLength(0);
    expect(asked).toHaveLength(1);
    // Vite's preload error: prevented while reloading, so it does not throw.
    const preload = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: new Error("Unable to preload CSS for a.css") });
    target.dispatchEvent(preload);
    expect(preload.defaultPrevented).toBe(true);
  });

  it("reports a stale chunk it may not reload for (reloaded once already)", () => {
    const target = fakeWindow();
    const out: ReportedError[] = [];
    const errors = new ErrorReporting(target, () => false);
    errors.attach((e) => out.push(e));
    target.dispatchEvent(rejection(new TypeError("Failed to fetch dynamically imported module: x.js")));
    expect(out).toHaveLength(1);
  });

  it("ignores cancelled requests", () => {
    const target = fakeWindow();
    const out: ReportedError[] = [];
    new ErrorReporting(target, () => false).attach((e) => out.push(e));
    target.dispatchEvent(rejection(Object.assign(new Error("aborted"), { name: "AbortError" })));
    expect(out).toHaveLength(0);
  });

  it("says how often an error repeated, and how many were left out", () => {
    const error = { message: "boom", source: "Uncaught" };
    expect(reported({ report: true, repeats: 0, dropped: 0 }, error)).toEqual([error]);
    expect(reported({ report: true, repeats: 4, dropped: 0 }, error)[0].message).toBe("boom (4 more times since)");
    expect(reported({ report: true, repeats: 1, dropped: 2 }, error).map((e) => e.message)).toEqual(["2 more errors were not logged.", "boom (1 more time since)"]);
  });
});

describe("the saved log", () => {
  it("has time, level, source and message on a line, the stack indented below", () => {
    const time = new Date(Date.UTC(2026, 10, 9, 20, 15, 3));
    const text = logText([
      { time, level: "info", message: "Opened the example." },
      { time, level: "error", source: "Uncaught", message: "boom", stack: "Error: boom\n  at draw (main.js:10:5)" },
    ]);
    expect(text).toBe(
      "2026-11-09T20:15:03.000Z  info   -  Opened the example.\n" +
        "2026-11-09T20:15:03.000Z  error  Uncaught  boom\n" +
        "    Error: boom\n" +
        "    at draw (main.js:10:5)\n",
    );
    expect(logText([])).toBe("");
  });

  it("is named by when it was saved", () => {
    expect(logFileName(new Date(2026, 10, 9, 8, 5))).toBe("ngplatform-log-20261109-0805.txt");
  });
});

describe("loadDataTypePlugins", () => {
  it("loads each plugin on its own and returns the failures", async () => {
    // Neuroglancer's worker factories are module state: stubbed, as the test only needs the failures.
    const { vi } = await import("vitest");
    let chunkWorker: (() => { name: string }) | undefined;
    vi.doMock("../src/engine/neuroglancer.js", () => ({ setChunkWorkerFactory: (f: () => { name: string }) => (chunkWorker = f), setAsyncComputationWorkerFactory: () => {} }));
    vi.stubGlobal(
      "Worker",
      class {
        name: string;
        constructor(_url: URL, options: { name: string }) {
          this.name = options.name;
        }
      },
    );
    const { loadDataTypePlugins } = await import("../src/engine/plugins.js");
    const loaded: string[] = [];
    const failed = await loadDataTypePlugins([
      { id: "a", neuroglancer: async () => void loaded.push("a") },
      { id: "b", neuroglancer: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: b.js")) },
      { id: "c", neuroglancer: async () => void loaded.push("c") },
    ]);
    expect(loaded).toEqual(["a", "c"]);
    expect([...failed.keys()]).toEqual(["b"]);
    expect(isStaleChunkError(failed.get("b"))).toBe(true);
    // The workers load the worker modules of those that loaded only.
    expect(JSON.parse(chunkWorker!().name)).toEqual({ plugins: ["a", "c"] });
    vi.doUnmock("../src/engine/neuroglancer.js");
    vi.unstubAllGlobals();
  });
});
