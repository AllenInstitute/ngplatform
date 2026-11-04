/**
 * The overview cache's budget (src/virtual/images/overview_cache.ts): what
 * an image may keep, which levels that keeps (coarsest first, whole, then
 * the next in part), which chunks stay when it is full, and the in-memory
 * caches' sizes from the device's memory.
 */
import { describe, expect, it } from "vitest";
import { CachePolicy, cacheBudget, cacheName, DEFAULT_SETTINGS, levelsKept, memoryBudgets } from "../src/virtual/images/overview_cache.js";

const GB = 2 ** 30;
const MB = 2 ** 20;

describe("the budget", () => {
  it("is 2 % of the file, at most 2 GB, and at most half the storage left", () => {
    expect(cacheBudget(2 ** 40)).toBe(2 * GB); // 1 TB keeps 2 GB
    expect(cacheBudget(16 * GB)).toBe(Math.floor(0.02 * 16 * GB)); // 16 GB keeps 328 MB
    expect(cacheBudget(512 * MB)).toBe(Math.floor(0.02 * 512 * MB));
    expect(cacheBudget(2 ** 40, DEFAULT_SETTINGS, 1 * GB)).toBe(0.5 * GB);
    expect(cacheBudget(2 ** 40, { percent: 10, maxGB: 50, totalGB: 20 })).toBe(20 * GB);
    expect(cacheBudget(2 ** 40, { percent: 0, maxGB: 2, totalGB: 10 })).toBe(0);
  });

  it("keeps whole levels coarsest first, then the next one in part; never the file's own levels", () => {
    // A 1 TB image halving every axis: each level an eighth of the one before.
    const bytes = [0, 1, 2, 3, 4, 5, 6].map((k) => 2 ** 40 / 8 ** k);
    const computed = bytes.map((_, k) => k > 0);
    const kept = levelsKept(bytes, computed, 2 * GB);
    expect(kept.whole).toEqual([6, 5, 4]);
    expect(kept.partial).toBe(3);
    expect(kept.floor).toBe(3);
    expect(kept.bytes).toBe(bytes[4] + bytes[5] + bytes[6]);
    expect(levelsKept(bytes, computed, 2 ** 40).whole).toEqual([6, 5, 4, 3, 2, 1]);
    expect(levelsKept(bytes, computed, 0)).toEqual({ whole: [], partial: undefined, bytes: 0, floor: Infinity });
    // Levels 1 and 2 from the file (a TIFF's own): skipped, costing nothing.
    const own = levelsKept(bytes, [false, false, false, true, true, true, true], 64 * GB);
    expect(own.whole).toEqual([6, 5, 4, 3]);
    expect(own.partial).toBeUndefined();
  });
});

describe("which chunks stay", () => {
  it("drops finer chunks before coarser ones, least recently used first, and never a coarser one for a finer", () => {
    const p = new CachePolicy(10, 1);
    expect(p.admit("3/a", 3, 3, 1)).toEqual([]);
    expect(p.admit("1/a", 1, 3, 2)).toEqual([]);
    expect(p.admit("1/b", 1, 3, 3)).toEqual([]);
    expect(p.total).toBe(9);
    // Full: a level-2 chunk drops the least recently used level-1 chunk.
    p.touch("1/a", 4);
    expect(p.admit("2/a", 2, 3, 5)).toEqual(["1/b"]);
    // A level-1 chunk may drop another level-1 chunk, not a coarser one.
    expect(p.admit("1/c", 1, 3, 6)).toEqual(["1/a"]);
    expect(p.admit("1/d", 1, 7, 7)).toBeUndefined();
    // Finer than the floor, or larger than the budget: not kept.
    expect(p.admit("0/a", 0, 1, 8)).toBeUndefined();
    expect(p.admit("4/a", 4, 11, 8)).toBeUndefined();
    expect([...p.entries.keys()].sort()).toEqual(["1/c", "2/a", "3/a"]);
    expect(p.byLevel()).toEqual({ 1: { chunks: 1, bytes: 3 }, 2: { chunks: 1, bytes: 3 }, 3: { chunks: 1, bytes: 3 } });
    // A smaller budget and a coarser floor: what no longer fits goes.
    p.budget = 4;
    p.floor = 2;
    expect(p.shrink().sort()).toEqual(["1/c", "2/a"]);
    expect(p.total).toBe(3);
  });

  it("keeps the same chunk once, however often it is kept", () => {
    const p = new CachePolicy(100, 1);
    p.admit("2/x", 2, 10, 1);
    p.admit("2/x", 2, 10, 2);
    expect(p.total).toBe(10);
    p.remove("2/x");
    expect(p.total).toBe(0);
  });
});

describe("memory and names", () => {
  it("sizes the in-memory caches from the device's memory, within bounds", () => {
    expect(memoryBudgets(8)).toEqual({ chunks: 256 * MB, bands: 128 * MB });
    expect(memoryBudgets(0.5)).toEqual({ chunks: 48 * MB, bands: 32 * MB });
    expect(memoryBudgets(undefined)).toEqual({ chunks: 128 * MB, bands: 64 * MB });
    expect(memoryBudgets(64).chunks).toBe(512 * MB);
  });

  it("names a cache by the file's name, size and date", () => {
    expect(cacheName("a.tif|1|2")).toMatch(/^[0-9a-f]{16}$/);
    expect(cacheName("a.tif|1|2")).not.toBe(cacheName("a.tif|1|3"));
  });
});
