import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNNER_API } from "../src/platform/runner_api.js";

describe("the runner and the app", () => {
  it("is the same number in the app and the runner", () => {
    const py = readFileSync(new URL("../runner/ngplatform_runner/__init__.py", import.meta.url), "utf8");
    const m = /^RUNNER_API = (\d+)$/m.exec(py);
    expect(m, "RUNNER_API in runner/ngplatform_runner/__init__.py").not.toBeNull();
    expect(Number(m![1])).toBe(RUNNER_API);
  });

  it("is versioned with the app: the Python package's version is package.json's", () => {
    const py = readFileSync(new URL("../runner/ngplatform_runner/__init__.py", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(/^__version__ = "([^"]+)"$/m.exec(py)?.[1]).toBe(pkg.version);
  });
});
