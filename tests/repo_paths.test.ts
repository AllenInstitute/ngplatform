/**
 * The repository's files can be cloned (and forked) on every system: no two paths that differ only in case
 * (macOS and Windows file systems are case-insensitive, and a clone there loses one of them), no names Windows
 * refuses, paths short enough for Windows' 260 characters with room for the clone's own folder, and no file over
 * GitHub's 100 MB. Skipped outside a git checkout.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";

function tracked(): string[] | undefined {
  try {
    return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

const files = tracked();
// Reserved device names, with or without an extension; characters Windows does not allow; a trailing dot or space.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/;
const MAX_PATH = 180;

describe.skipIf(files === undefined)("the repository's paths", () => {
  const paths = files ?? [];

  it("has no two that differ only in case", () => {
    const seen = new Map<string, Set<string>>();
    for (const p of paths) {
      const parts = p.split("/");
      for (let i = 1; i <= parts.length; ++i) {
        const prefix = parts.slice(0, i).join("/");
        const key = prefix.toLowerCase();
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)!.add(prefix);
      }
    }
    const clashes = [...seen.values()].filter((s) => s.size > 1).map((s) => [...s].join(" vs "));
    expect(clashes).toEqual([]);
  });

  it("has no names Windows refuses", () => {
    const bad = paths.filter((p) => p.split("/").some((c) => FORBIDDEN.test(c) || RESERVED.test(c) || /[. ]$/.test(c)));
    expect(bad).toEqual([]);
  });

  it(`is no longer than ${MAX_PATH} characters`, () => {
    expect(paths.filter((p) => p.length > MAX_PATH)).toEqual([]);
  });

  it("has no file over GitHub's 100 MB", () => {
    const big = paths.filter((p) => {
      try {
        return statSync(p).size > 100e6;
      } catch {
        return false; // Deleted in the working tree.
      }
    });
    expect(big).toEqual([]);
  });
});
