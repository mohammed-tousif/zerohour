/**
 * The student's own encrypted result, kept on their phone in IndexedDB so it
 * survives reloads and works offline. One student per device.
 */

export interface SavedResult {
  usn: string;
  dob: string;
  fileName: string;
  /** Batch the saved file belongs to (absent in files saved by older app versions). */
  batchId?: string;
  file: Uint8Array;
  fetchedAt: string;
  /** Kept after release so the result still opens offline later. */
  release?: { batchId: string; key: string; releasedAt: string };
}

const DB = 'zerohour';
const STORE = 'kv';
const KEY = 'me';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const loadSaved = () => tx<SavedResult | undefined>('readonly', (s) => s.get(KEY));
export const saveResult = (value: SavedResult) => tx<IDBValidKey>('readwrite', (s) => s.put(value, KEY));
export const forgetSaved = () => tx<undefined>('readwrite', (s) => s.delete(KEY));
