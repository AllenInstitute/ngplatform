/**
 * The service worker's parts that need no worker (src/sw_parts.ts): its
 * jobs answered only under the app's folder, Range headers, the caches of
 * older versions dropped, and a page's answer awaited with nothing left
 * running once it comes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ask, cacheName, parseRange, prefixesOf, routeOf, staleCaches } from "../src/sw_parts.js";

afterEach(() => vi.useRealTimers());

describe("the service worker's routes", () => {
  it("answers /virtual/, /local/ and /gcs-google/ only under the app's folder", () => {
    const prefixes = prefixesOf("https://example.org/app/");
    expect(prefixes).toEqual({ local: "/app/local/", google: "/app/gcs-google/", virtual: "/app/virtual/" });
    expect(routeOf("/app/virtual/ngp/v1/zarr.json", prefixes)).toBe("virtual");
    expect(routeOf("/app/local/abc/brain.nii.gz", prefixes)).toBe("local");
    expect(routeOf("/app/gcs-google/bucket/a/b", prefixes)).toBe("google");
    // Elsewhere on the site, or deeper in a dataset's path: not the app's.
    expect(routeOf("/other/virtual/ngp/v1/zarr.json", prefixes)).toBeUndefined();
    expect(routeOf("/app/data/virtual/chunk", prefixes)).toBeUndefined();
    expect(routeOf("/virtual/ngp/v1/", prefixes)).toBeUndefined();
    expect(routeOf("/app/index.html", prefixes)).toBeUndefined();
  });

  it("reads one range of bytes", () => {
    expect(parseRange(null)).toBeUndefined();
    expect(parseRange("bytes=10-19")).toEqual({ start: 10, end: 20 });
    expect(parseRange("bytes=10-")).toEqual({ start: 10, end: undefined });
    expect(parseRange("bytes=-500")).toEqual({ suffix: 500 });
    expect(parseRange("bytes=0-1,5-6")).toBeUndefined();
  });
});

describe("the service worker's versions", () => {
  it("drops the caches of its other versions, and no one else's", () => {
    const names = [cacheName("0.2.0-a"), cacheName("0.2.0-b"), "some-other-cache", cacheName("0.1.0-z")];
    expect(staleCaches(names, "0.2.0-b")).toEqual([cacheName("0.2.0-a"), cacheName("0.1.0-z")]);
    expect(staleCaches([cacheName("0.2.0-b")], "0.2.0-b")).toEqual([]);
  });
});

describe("asking a page", () => {
  it("clears its timer and closes the channel once the page answers", async () => {
    vi.useFakeTimers();
    const page = { postMessage: (_: unknown, [port]: Transferable[]) => (port as MessagePort).postMessage(true) };
    const answer = ask<boolean>(page, { type: "local-has", id: "a" }, 10_000);
    await vi.waitFor(async () => expect(await Promise.race([answer, Promise.resolve("waiting")])).toBe(true));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up when the page does not answer in time", async () => {
    vi.useFakeTimers();
    const silent = { postMessage: () => {} };
    const answer = ask<boolean>(silent, { type: "local-has", id: "a" }, 5_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await answer).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
