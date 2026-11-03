/** The Python console's prelude (ngp) is valid Python once the TypeScript string is read: a slip there leaves the console unusable. */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PRELUDE } from "../src/ui/panels/python.js";

const python = spawnSync("python3", ["--version"]).status === 0;

describe("the Python prelude", () => {
  it.skipIf(!python)("parses as Python", () => {
    const r = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: PRELUDE, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
