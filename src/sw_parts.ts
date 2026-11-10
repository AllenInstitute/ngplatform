/**
 * The service worker's parts that need no worker (src/sw.ts), kept apart so
 * they are tested in Node: which of its jobs a request is for, a Range
 * header read, the caches of other versions, and a question put to a page
 * that is given up after a while, its timer cleared once answered.
 */

/** The paths under the app (its scope) that the worker answers. */
export interface Prefixes {
  local: string;
  google: string;
  virtual: string;
}

/** The worker's paths under the app at `scope` (the page's folder). */
export function prefixesOf(scope: string): Prefixes {
  const path = (sub: string) => new URL(sub, scope).pathname;
  return { local: path("./local/"), google: path("./gcs-google/"), virtual: path("./virtual/") };
}

/** Which of the worker's jobs a path is for, if any: each only under the app's own folder. */
export function routeOf(pathname: string, prefixes: Prefixes): keyof Prefixes | undefined {
  if (pathname.startsWith(prefixes.google)) return "google";
  if (pathname.startsWith(prefixes.local)) return "local";
  if (pathname.startsWith(prefixes.virtual)) return "virtual";
  return undefined;
}

export interface Range {
  start?: number;
  end?: number;
  suffix?: number;
}

/** A Range header of one range (`bytes=a-b`, `bytes=a-`, `bytes=-n`); undefined for none or any other. */
export function parseRange(header: string | null): Range | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  if (m[1] === "") return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === "" ? undefined : Number(m[2]) + 1 };
}

/** What the worker's caches are named by: this, then its version. */
export const CACHE_PREFIX = "ngplatform-sw-";

/** The cache this version of the worker keeps. */
export const cacheName = (version: string): string => `${CACHE_PREFIX}${version}`;

/** The caches of other versions of the worker, to drop once this one is active (others' caches are left alone). */
export function staleCaches(names: string[], version: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== cacheName(version));
}

/**
 * Asks a page over a channel of its own; undefined when it does not answer
 * in `timeout` ms.  The timer is cleared and the channel closed once it
 * answers or the time is up, so nothing is left running.
 */
export function ask<T>(client: { postMessage(message: unknown, transfer: Transferable[]): void }, request: Record<string, unknown>, timeout: number): Promise<T | undefined> {
  const channel = new MessageChannel();
  const answer = new Promise<T | undefined>((resolve) => {
    const done = (value: T | undefined) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeout);
    channel.port1.onmessage = (e) => done(e.data as T);
  });
  client.postMessage(request, [channel.port2]);
  return answer;
}
