/**
 * Keeps the history tree in this browser, beside the link that holds the
 * workspace.
 *
 * The address bar (and every link shared) carries only the current state.
 * The tree of changes (up to 400 states, see src/core/history.ts) is kept
 * in this browser's IndexedDB (database `ngplatform-history`), filed under
 * a digest of the link it ended at.  Reloading the page, or opening the
 * same link again later in this browser, finds the tree by that digest and
 * resumes it; another browser, or a link changed by hand, starts afresh.
 * The trees of the 12 workspaces saved last are kept; older ones are
 * deleted.
 */
import type { HistoryData } from "../core/history.js";

export interface KeptHistory {
  /** This page's own record (a new one each time the page loads). */
  id: string;
  /** The digest of the link the tree ended at (`linkDigest`). */
  link: string;
  /** When it was saved, in ms since 1970. */
  saved: number;
  data: HistoryData;
}

/** Where kept trees live: IndexedDB in the browser, a map in tests. */
export interface HistoryBackend {
  /** The records filed under a link digest. */
  byLink(link: string): Promise<KeptHistory[]>;
  put(record: KeptHistory): Promise<void>;
  /** Record ids, the one saved longest ago first. */
  idsOldestFirst(): Promise<string[]>;
  delete(id: string): Promise<void>;
}

/** How many workspaces' trees are kept. */
export const KEPT_TREES = 12;

/** A link with its escapes undone (the address bar escapes some characters), then hashed (53 bits, as hex). */
export function linkDigest(hash: string): string {
  let text = hash;
  try {
    text = decodeURIComponent(hash);
  } catch {
    // Kept as given.
  }
  // cyrb53 (public domain).
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Finds and saves trees by link, keeping the latest `KEPT_TREES`. */
export class HistoryKeep {
  /** This page's record id. */
  readonly id = `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  /** The record this page resumed from, deleted once this page saves its own. */
  private resumedFrom: string | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: HistoryBackend,
    private readonly keep = KEPT_TREES,
  ) {}

  /** The tree saved last for a link (`location.hash`), if this browser kept one. */
  async find(hash: string): Promise<HistoryData | undefined> {
    try {
      const found = (await this.backend.byLink(linkDigest(hash))).sort((a, b) => b.saved - a.saved)[0];
      if (found === undefined) return undefined;
      this.resumedFrom = found.id;
      return found.data;
    } catch {
      return undefined;
    }
  }

  /** Saves this page's tree, filed under the link it now ends at; saves run one after another. */
  save(hash: string, data: HistoryData, now = Date.now()): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await this.backend.put({ id: this.id, link: linkDigest(hash), saved: now, data });
        if (this.resumedFrom !== undefined) {
          const old = this.resumedFrom;
          this.resumedFrom = undefined;
          await this.backend.delete(old);
        }
        const ids = await this.backend.idsOldestFirst();
        for (const id of ids.slice(0, Math.max(0, ids.length - this.keep))) await this.backend.delete(id);
      } catch (e) {
        console.warn("ngplatform: could not keep the history in this browser", e);
      }
    });
    return this.chain;
  }
}

/** Kept trees in memory (tests). */
export class MemoryHistoryBackend implements HistoryBackend {
  readonly records = new Map<string, KeptHistory>();
  async byLink(link: string) {
    return [...this.records.values()].filter((r) => r.link === link).map((r) => structuredClone(r));
  }
  async put(record: KeptHistory) {
    this.records.set(record.id, structuredClone(record));
  }
  async idsOldestFirst() {
    return [...this.records.values()].sort((a, b) => a.saved - b.saved).map((r) => r.id);
  }
  async delete(id: string) {
    this.records.delete(id);
  }
}

const DB = "ngplatform-history";
const STORE = "trees";

/** Kept trees in this browser's IndexedDB. */
export class IndexedDbHistoryBackend implements HistoryBackend {
  private db: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("link", "link");
        store.createIndex("saved", "saved");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  byLink(link: string): Promise<KeptHistory[]> {
    return this.run("readonly", (s) => s.index("link").getAll(link) as IDBRequest<KeptHistory[]>);
  }

  async put(record: KeptHistory): Promise<void> {
    await this.run("readwrite", (s) => s.put(record));
  }

  async idsOldestFirst(): Promise<string[]> {
    return (await this.run("readonly", (s) => s.index("saved").getAllKeys())).map(String);
  }

  async delete(id: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(id));
  }
}
