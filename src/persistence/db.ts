/**
 * Salvamento local em IndexedDB. Tudo do laboratório fica no navegador:
 * projetos, populações (para retomada exata), pilotos, treinadoras, pistas,
 * replays e preferências. O ranking online é outra coisa (servidor).
 */

export type StoreName = 'projects' | 'pilots' | 'configs' | 'coaches' | 'lineages' | 'replays' | 'tracks' | 'submissions' | 'championships' | 'kv';

const DB_NAME = 'evorace';
const DB_VERSION = 1;
const STORES: StoreName[] = ['projects', 'pilots', 'configs', 'coaches', 'lineages', 'replays', 'tracks', 'submissions', 'championships', 'kv'];

export class StorageError extends Error {
  readonly full: boolean;
  constructor(message: string, full = false) {
    super(message);
    this.full = full;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageError('Este navegador não permite salvar dados localmente.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new StorageError('Não foi possível abrir o armazenamento local.'));
    req.onblocked = () => reject(new StorageError('O armazenamento está bloqueado por outra aba do jogo. Feche-a e tente de novo.'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function wrapError(e: unknown): StorageError {
  const name = (e as DOMException)?.name;
  if (name === 'QuotaExceededError') {
    return new StorageError('Armazenamento cheio. Exporte e exclua laboratórios, replays ou linhagens antigas na Garagem para liberar espaço.', true);
  }
  if (e instanceof StorageError) return e;
  return new StorageError(`Falha ao salvar localmente: ${(e as Error)?.message ?? String(e)}`);
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(store, mode);
    } catch (e) {
      reject(wrapError(e));
      return;
    }
    const s = t.objectStore(store);
    let result: T;
    let req: IDBRequest<T> | void;
    try {
      req = fn(s);
    } catch (e) {
      reject(wrapError(e));
      return;
    }
    if (req) req.onsuccess = () => (result = req!.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(wrapError(t.error));
    t.onabort = () => reject(wrapError(t.error));
  });
}

export const db = {
  getAll<T>(store: StoreName): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  get<T>(store: StoreName, id: string): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
  },
  put<T>(store: StoreName, value: T): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.put(value);
    });
  },
  delete(store: StoreName, id: string): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.delete(id);
    });
  },
  clear(store: StoreName): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.clear();
    });
  },
  async kvGet<T>(key: string): Promise<T | undefined> {
    const r = await tx<{ key: string; value: T } | undefined>('kv', 'readonly', (s) => s.get(key) as IDBRequest<{ key: string; value: T } | undefined>);
    return r?.value;
  },
  kvSet<T>(key: string, value: T): Promise<void> {
    return tx<void>('kv', 'readwrite', (s) => {
      s.put({ key, value });
    });
  },
  async clearAll(): Promise<void> {
    for (const s of STORES) await db.clear(s);
  },
  async estimate(): Promise<{ usage: number; quota: number } | null> {
    try {
      const e = await navigator.storage?.estimate?.();
      return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
    } catch {
      return null;
    }
  },
};
