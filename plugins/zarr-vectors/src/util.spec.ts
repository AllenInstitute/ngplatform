/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from "vitest";
import { storeCaches } from "./object_reader.js";
import type { ZarrVectorsStoreAccess } from "./store.js";
import { AsyncLru, ByteBudget, DECODED_BUDGET, setDecodedCacheBytes } from "./util.js";

describe("one byte budget over several stores", () => {
  const bytes = (n: number) => async () => new Uint8Array(n);

  it("keeps three caches together within it, letting go of the least recently used of any", async () => {
    const budget = new ByteBudget(1000);
    const stores = [0, 1, 2].map(() => new AsyncLru<Uint8Array>(Infinity, 600, (b) => b.byteLength, budget));
    // Each store alone is within its own 600 bytes; together they would be 1,500.
    for (const [s, lru] of stores.entries()) for (const k of ["a", "b"]) await lru.get(k, bytes(250 + s));
    // 1,506 bytes read; store 0's two and store 1's first, read first, are let go.
    expect(stores.map((l) => l.size)).toEqual([0, 251, 504]);
    expect(budget.size).toBe(755);
    // Store 1's "b", used again, is kept when store 0 reads again; store 2's "a" (now the oldest) goes.
    let reloads = 0;
    await stores[1].get("b", async () => (++reloads, new Uint8Array(251)));
    await stores[0].get("c", bytes(250));
    expect(reloads).toBe(0);
    expect(stores[1].peek("b")).toBeDefined();
    expect(stores[2].peek("a")).toBeUndefined();
    expect(budget.size).toBe(753);
    expect(budget.size).toBe(stores.reduce((n, l) => n + l.size, 0));
  });

  it("charges nothing for a load in flight, and never evicts it", async () => {
    const budget = new ByteBudget(100);
    const one = new AsyncLru<Uint8Array>(Infinity, Infinity, (b) => b.byteLength, budget);
    const two = new AsyncLru<Uint8Array>(Infinity, Infinity, (b) => b.byteLength, budget);
    let release!: () => void;
    const pending = one.get("slow", () => new Promise((resolve) => (release = () => resolve(new Uint8Array(60)))));
    await two.get("x", bytes(80));
    await two.get("y", bytes(80));
    expect(budget.size).toBe(80);
    expect(one.peek("slow")).toBe(pending);
    release();
    await pending;
    // Loaded: charged as the newest, and "y" let go for it.
    expect(budget.size).toBe(60);
    expect(two.peek("y")).toBeUndefined();
    expect(one.size).toBe(60);
  });

  it("is what every store's decoded caches share in a worker", async () => {
    const before = DECODED_BUDGET.limit;
    setDecodedCacheBytes(1000);
    try {
      const accesses = [0, 1, 2].map(() => ({}) as ZarrVectorsStoreAccess);
      const caches = accesses.map(storeCaches);
      expect(storeCaches(accesses[0])).toBe(caches[0]);
      for (const [s, c] of caches.entries()) {
        for (let k = 0; k < 4; ++k) await c.vertexCells.get(`${s}/${k}`, bytes(200));
      }
      // 2,400 bytes read over three stores, 1,000 kept: the five read last.
      expect(DECODED_BUDGET.size).toBe(1000);
      expect(caches.map((c) => c.vertexCells.size)).toEqual([0, 200, 800]);
    } finally {
      setDecodedCacheBytes(before);
    }
  });
});

describe("AsyncLru", () => {
  it("shares a load in flight even past its entry limit", async () => {
    const lru = new AsyncLru<number>(2);
    let loads = 0;
    const releases: (() => void)[] = [];
    const load = (value: number) => () =>
      new Promise<number>((resolve) => {
        ++loads;
        releases.push(() => resolve(value));
      });
    const first = lru.get("a", load(1));
    lru.get("b", load(2));
    lru.get("c", load(3));
    // "a" is still loading, so it must not have been evicted.
    expect(lru.get("a", load(99))).toBe(first);
    expect(loads).toBe(3);
    for (const release of releases) release();
    expect(await first).toBe(1);
  });

  it("evicts settled entries, oldest first, by size", async () => {
    const lru = new AsyncLru<Uint8Array>(Infinity, 10, (b) => b.byteLength);
    await lru.get("a", async () => new Uint8Array(6));
    await lru.get("b", async () => new Uint8Array(6));
    expect(lru.peek("a")).toBeUndefined();
    expect(lru.peek("b")).toBeDefined();
  });

  it("forgets a failed load", async () => {
    const lru = new AsyncLru<number>(4);
    await expect(
      lru.get("a", () => Promise.reject(new Error("x"))),
    ).rejects.toThrow();
    expect(await lru.get("a", async () => 5)).toBe(5);
  });
});
