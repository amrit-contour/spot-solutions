// The Messages page's copy of your chats, kept in this browser only (IndexedDB), so the list and each chat open at once and
// the page then syncs in the background. It is per user, capped, and wiped on sign-out. It is NEVER written to Firestore or
// any server: chat text still only travels as short-lived command results (docs/architecture.md "Messages").
import { CACHE_MAX_THREADS, cacheEvictions, cacheKey, trimThreadForCache, type GetThreadResult, type ListThreadsResult } from "@spot/shared";

const DB = "spot-chats";
const STORE = "kv";
const MARKS_PREFIX = "spot.chatMarks.";

interface Entry<T> {
  key: string;
  savedAt: number;
  data: T;
}

let opened: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opened ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve) => {
        if (!d) return resolve(undefined);
        try {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

async function get<T>(key: string): Promise<Entry<T> | null> {
  return ((await run<Entry<T> | undefined>("readonly", (s) => s.get(key))) as Entry<T> | undefined) ?? null;
}
async function put<T>(key: string, data: T) {
  await run("readwrite", (s) => s.put({ key, savedAt: Date.now(), data } satisfies Entry<T>));
}
async function keysWithPrefix(prefix: string): Promise<{ key: string; savedAt: number }[]> {
  const all = (await run<Entry<unknown>[]>("readonly", (s) => s.getAll() as IDBRequest<Entry<unknown>[]>)) ?? [];
  return all.filter((e) => e.key.startsWith(prefix)).map((e) => ({ key: e.key, savedAt: e.savedAt }));
}

export const listKey = (uid: string) => cacheKey(uid, "list");
export const threadKey = (uid: string, id: string) => cacheKey(uid, `t:${id}`);

export const readCached = <T>(key: string) => get<T>(key);

export async function saveList(uid: string, list: ListThreadsResult) {
  await put(listKey(uid), list);
}

/** Keeps the newest messages of a chat, and forgets the least recently saved chats beyond the cap. */
export async function saveThread(uid: string, id: string, r: GetThreadResult) {
  if (!r.messages.length) return; // nothing worth showing before the next read
  await put(threadKey(uid, id), trimThreadForCache(r));
  const extra = cacheEvictions(await keysWithPrefix(cacheKey(uid, "t:")), CACHE_MAX_THREADS);
  for (const k of extra) await run("readwrite", (s) => s.delete(k));
}

/** Sign-out: everything saved for every user on this device, and the on-device marks. */
export async function clearChatCache() {
  try {
    await run("readwrite", (s) => s.clear());
    for (const k of Object.keys(localStorage)) if (k.startsWith(MARKS_PREFIX)) localStorage.removeItem(k);
  } catch {
    /* storage blocked: nothing was saved */
  }
}

export const marksKey = (uid: string) => `${MARKS_PREFIX}${uid}`;
