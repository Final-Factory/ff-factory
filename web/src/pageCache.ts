// IndexedDB for the page's saved copy of its last state (w6763, shared/pageCache.ts). Every call fails soft: a browser
// without IndexedDB (or a private window that refuses it) loads as before, from the socket's whole first state.
import type { PageCacheRecord } from '../../shared/pageCache';

const DB = 'ff-page';
const STORE = 'cache';
const KEY = 'last';

let db: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
  db.catch(() => (db = undefined));
  return db;
}

/** The saved copy, or undefined (none, unreadable, or not read within `waitMs`). */
export async function readPageCache(waitMs: number): Promise<unknown> {
  try {
    const read = open().then(
      (d) =>
        new Promise<unknown>((resolve, reject) => {
          const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
    return await Promise.race([read, new Promise<undefined>((r) => setTimeout(() => r(undefined), waitMs))]);
  } catch {
    return undefined;
  }
}

export function writePageCache(rec: PageCacheRecord) {
  void open()
    .then((d) => d.transaction(STORE, 'readwrite').objectStore(STORE).put(rec, KEY))
    .catch(() => {});
}

/** Signed out (or refused): the copy goes, so the next person on this browser never sees it. */
export function clearPageCache() {
  void open()
    .then((d) => d.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY))
    .catch(() => {});
}
