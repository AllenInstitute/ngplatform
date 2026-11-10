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

/** @file Small helpers shared by the zarr-vectors frontend and worker. */

const warned = new Set<string>();

/** A warning about a store, for the user: what the reader could not read or show. */
export interface StoreWarning {
  /** The store's URL, when the warning is about one. */
  store?: string;
  message: string;
}

/**
 * The event the main thread's warnings are dispatched as on `window`
 * (`detail`: {@link StoreWarning} with `source: "Zarr Vectors"`), for the
 * application to show them (ngplatform puts them in the Activity log).
 */
export const WARNING_EVENT = "ngplatform:warning";

let sink: ((warning: StoreWarning) => void) | undefined =
  typeof window !== "undefined" && typeof CustomEvent !== "undefined"
    ? (warning) =>
        window.dispatchEvent(
          new CustomEvent(WARNING_EVENT, {
            detail: { source: "Zarr Vectors", ...warning },
          }),
        )
    : undefined;

/**
 * Where warnings go besides the console: on the main thread an event on
 * `window` (above); a worker sends them to the main thread (backend.ts).
 */
export function setWarningSink(
  next: ((warning: StoreWarning) => void) | undefined,
) {
  sink = next;
}

/**
 * Logs a diagnostic once per store and session, and passes it on to the
 * user (the sink).  `store` is the store's URL, when it is about one.
 */
export function warnOnce(message: string, store?: string) {
  const key = store === undefined ? message : `${store}\u0000${message}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`zarr-vectors: ${store === undefined ? "" : `${store}: `}${message}`);
  sink?.(store === undefined ? { message } : { store, message });
}

/**
 * Whether a failed read may work when tried again (the network, a server
 * error, too many requests), rather than saying the data is not there or
 * cannot be listed: Neuroglancer's HttpError has status 0 for the network.
 */
export function retryable(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" && (status === 0 || status === 429 || status >= 500);
}

/**
 * A byte budget shared by several caches (one per store, per level, per
 * kind), so that however many stores are open their caches together stay
 * within it: the entry used least recently among all of them is let go
 * first.  Only loaded entries are charged; loads in flight are not, and
 * are never evicted.
 */
export class ByteBudget {
  /** Charged entries, least recently used first. */
  private entries = new Map<string, { lru: AsyncLru<any>; key: string; size: number }>();
  private ids = new WeakMap<AsyncLru<any>, number>();
  private next = 0;
  private total = 0;

  constructor(private maxBytes: number) {}

  /** The bytes charged, over every cache sharing it. */
  get size(): number {
    return this.total;
  }

  get limit(): number {
    return this.maxBytes;
  }

  /** Changes the limit, evicting the least recently used until it holds. */
  setMaxBytes(maxBytes: number): void {
    this.maxBytes = maxBytes;
    this.evict(undefined);
  }

  private id(lru: AsyncLru<any>, key: string): string {
    let n = this.ids.get(lru);
    if (n === undefined) this.ids.set(lru, (n = this.next++));
    return `${n}|${key}`;
  }

  /** @internal An entry of `lru` loaded: charged, as the most recent, and others evicted past the limit. */
  charge(lru: AsyncLru<any>, key: string, size: number): void {
    const id = this.id(lru, key);
    this.release(lru, key);
    this.entries.set(id, { lru, key, size });
    this.total += size;
    this.evict(id);
  }

  /** @internal An entry used again: the most recent. */
  touch(lru: AsyncLru<any>, key: string): void {
    const id = this.id(lru, key);
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  /** @internal An entry gone from its cache. */
  release(lru: AsyncLru<any>, key: string): void {
    const id = this.id(lru, key);
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.entries.delete(id);
    this.total -= entry.size;
  }

  private evict(keep: string | undefined): void {
    for (const [id, entry] of this.entries) {
      if (this.total <= this.maxBytes) return;
      if (id === keep) continue;
      this.entries.delete(id);
      this.total -= entry.size;
      entry.lru.forget(entry.key);
    }
  }
}

/**
 * Decoded data a worker keeps, over every store it reads: the object
 * reader's decoded chunks and vertex cells and the cross-chunk links'
 * records, each also within its own limit.  Three whole-brain stores
 * share it rather than each taking its own.
 */
export const DECODED_BUDGET = new ByteBudget(768 * 1024 * 1024);

/** Sets the bytes of decoded data a worker keeps over every store (768 MB by default). */
export function setDecodedCacheBytes(bytes: number): void {
  DECODED_BUDGET.setMaxBytes(bytes);
}

/**
 * Least-recently-used cache of promises.  Concurrent requests for one key
 * share a load; a load that fails is forgotten so the next request retries.
 * Bounded by entry count and, when `sizeOf` is given, by total size; loads
 * still in flight are never evicted, so they stay shared.  With a `budget`,
 * its loaded entries are also charged to that budget, which several caches
 * share and which evicts across them.
 */
export class AsyncLru<T> {
  private entries = new Map<string, Promise<T>>();
  private sizes = new Map<string, number>();
  private totalSize = 0;

  constructor(
    private maxEntries: number,
    private maxSize = Infinity,
    private sizeOf?: (value: T) => number,
    private budget?: ByteBudget,
  ) {}

  /** Changes the size limit (evicting from the oldest until it holds). */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    for (const key of [...this.entries.keys()]) {
      if (this.totalSize <= this.maxSize) break;
      this.delete(key);
    }
  }

  /** The total size of the loaded entries kept. */
  get size(): number {
    return this.totalSize;
  }

  /** The cached entry, without loading. */
  peek(key: string): Promise<T> | undefined {
    return this.entries.get(key);
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      if (this.sizes.has(key)) this.budget?.touch(this, key);
      return existing;
    }
    const promise = load();
    this.entries.set(key, promise);
    promise.then(
      (value) => {
        if (this.entries.get(key) !== promise) return;
        const size = this.sizeOf?.(value) ?? 0;
        this.sizes.set(key, size);
        this.totalSize += size;
        this.evict();
        if (this.entries.get(key) === promise) this.budget?.charge(this, key, size);
      },
      () => {
        if (this.entries.get(key) === promise) this.delete(key);
      },
    );
    this.evict();
    return promise;
  }

  /** Records a value that was computed elsewhere. */
  put(key: string, value: T) {
    if (!this.entries.has(key)) this.get(key, () => Promise.resolve(value));
  }

  /** Drops an entry, loaded or still loading (a load dropped is no longer shared). */
  remove(key: string): void {
    if (this.entries.has(key)) this.delete(key);
  }

  /** @internal Lets an entry go for the budget, which has already stopped charging it. */
  forget(key: string): void {
    if (!this.sizes.has(key)) return;
    this.entries.delete(key);
    this.totalSize -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
  }

  private delete(key: string) {
    this.entries.delete(key);
    this.totalSize -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    this.budget?.release(this, key);
  }

  private evict() {
    // Oldest first; `sizes` holds exactly the settled entries.
    for (const key of this.entries.keys()) {
      if (
        this.entries.size <= 1 ||
        (this.entries.size <= this.maxEntries && this.totalSize <= this.maxSize)
      ) {
        return;
      }
      if (this.sizes.has(key)) this.delete(key);
    }
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** A signal that never aborts, for loads shared between requests. */
export const SHARED_SIGNAL = new AbortController().signal;
