/**
 * The app's IndexedDB database, "ngplatform" (version 1): local plugins
 * (by `key`) and remembered local data (by `id`), one connection for both.
 */

const DB = "ngplatform";
export type AppStore = "localPlugins" | "localData";

let opened: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("localPlugins")) db.createObjectStore("localPlugins", { keyPath: "key" });
      if (!db.objectStoreNames.contains("localData")) db.createObjectStore("localData", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Opened again when the browser closes it (site data cleared, another tab upgrading).
      db.onclose = () => (opened = undefined);
      db.onversionchange = () => {
        db.close();
        opened = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      opened = undefined;
      reject(request.error);
    };
  });
  return opened;
}

/** One request on one of the app's stores, its result when it succeeds. */
export async function idbRequest<T>(store: AppStore, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = work(db.transaction(store, mode).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
