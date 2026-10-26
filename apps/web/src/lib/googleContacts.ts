// Save comic names to the curator's Google Contacts (People API v1), straight from the browser.
// The Google token lives in memory only. Nothing here ever prompts on its own: popups open from a click.
import { GoogleAuthProvider, reauthenticateWithPopup } from "firebase/auth";
import { toast } from "sonner";
import { indexGoogleContact, normalizePhone, planContactSync, splitName, type Comic, type ContactCreate, type ContactPlan, type ContactUpdate, type GoogleIndex } from "@spot/shared";
import { auth } from "./firebase";
import { isDemoUser } from "./demo";

const SCOPE = "https://www.googleapis.com/auth/contacts";
const API = "https://people.googleapis.com/v1";
const TOKEN_MS = 55 * 60_000;
const INDEX_MS = 10 * 60_000;
const BATCH = 200;

/** The token is missing or expired: the curator has to tap Reconnect. */
export class ReconnectGoogleError extends Error {
  constructor(message = "Reconnect Google") {
    super(message);
    this.name = "ReconnectGoogleError";
  }
}

let token: { value: string; expires: number } | null = null;
let index: { map: GoogleIndex; at: number } | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

const valid = () => (token && token.expires > Date.now() ? token.value : null);
const clearToken = () => {
  token = null;
  index = null;
  changed();
};

/** True while we hold an unexpired token. */
export const hasGoogleToken = () => Boolean(valid());

/** Subscribe to connect/expire changes (for useSyncExternalStore). The token's expiry is also checked on read. */
export function onGoogleToken(cb: () => void) {
  listeners.add(cb);
  const t = setInterval(cb, 30_000);
  return () => (listeners.delete(cb), clearInterval(t));
}

/** Ask Google for contacts access. Call this from a click handler only. */
export async function connectGoogleContacts(): Promise<void> {
  const user = auth.currentUser;
  if (!user || user.isAnonymous) throw new Error("Sign in with Google first");
  if (!user.providerData.some((p) => p.providerId === "google.com")) throw new Error("This account didn't sign in with Google");
  const provider = new GoogleAuthProvider();
  provider.addScope(SCOPE);
  provider.setCustomParameters({ login_hint: user.email ?? "" });
  const result = await reauthenticateWithPopup(user, provider);
  const accessToken = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (!accessToken) throw new Error("Google didn't return access");
  token = { value: accessToken, expires: Date.now() + TOKEN_MS };
  index = null;
  changed();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GoogleError {
  error?: { code?: number; status?: string; message?: string };
}

/** One People API call: auth header, 401 means reconnect, 429/503 back off and retry. */
async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const t = valid();
    if (!t) {
      clearToken();
      throw new ReconnectGoogleError();
    }
    const res = await fetch(`${API}/${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${t}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401) {
      clearToken();
      throw new ReconnectGoogleError();
    }
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      const retry = Number(res.headers.get("Retry-After"));
      await sleep(retry > 0 ? Math.min(retry, 30) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as GoogleError;
    throw new GoogleApiError(res.status, body.error?.message ?? `Google said ${res.status}`);
  }
}

class GoogleApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isEtagMismatch = (e: unknown) => e instanceof GoogleApiError && e.status === 400 && /etag/i.test(e.message);

interface Person {
  resourceName?: string;
  etag?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  phoneNumbers?: { value?: string; canonicalForm?: string; type?: string }[];
}

/** Every Google contact with a phone number, keyed by normalised digits. Cached for a few minutes. */
export async function loadGoogleIndex(force = false): Promise<GoogleIndex> {
  if (!force && index && Date.now() - index.at < INDEX_MS) return index.map;
  const map: GoogleIndex = new Map();
  let pageToken = "";
  do {
    const r = await call<{ connections?: Person[]; nextPageToken?: string }>(`people/me/connections?personFields=names,phoneNumbers&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    for (const p of r.connections ?? []) {
      if (!p.resourceName || !p.etag || !p.phoneNumbers?.length) continue;
      const displayName = p.names?.[0]?.displayName ?? "";
      indexGoogleContact(map, { resourceName: p.resourceName, etag: p.etag, displayName }, p.phoneNumbers.map((n) => n.canonicalForm || n.value || ""));
    }
    pageToken = r.nextPageToken ?? "";
  } while (pageToken);
  index = { map, at: Date.now() };
  return map;
}

const personFor = (c: ContactCreate): Person => ({ names: [splitName(c.name)], phoneNumbers: [{ value: `+${c.phone}`, type: "mobile" }] });

/** Names only. The body carries the etag, and a stale etag (400) is refetched once. */
async function updateName(u: Pick<ContactUpdate, "resourceName" | "etag" | "name">): Promise<Person> {
  const put = (etag: string) => call<Person>(`${u.resourceName}:updateContact?updatePersonFields=names&personFields=names,phoneNumbers`, { method: "PATCH", body: { etag, names: [splitName(u.name)] } });
  try {
    return await put(u.etag);
  } catch (e) {
    if (!isEtagMismatch(e)) throw e;
    const fresh = await call<Person>(`${u.resourceName}?personFields=names,phoneNumbers`);
    if (!fresh.etag) throw e;
    return put(fresh.etag);
  }
}

const remember = (c: ContactCreate, p: Person) => {
  if (index && p.resourceName && p.etag) indexGoogleContact(index.map, { resourceName: p.resourceName, etag: p.etag, displayName: p.names?.[0]?.displayName ?? c.name }, [c.phone]);
};
const replace = (c: ContactCreate, p: Person) => {
  if (!index || !p.etag) return;
  for (const [k, v] of index.map) if (v.resourceName === p.resourceName) index.map.set(k, { ...v, etag: p.etag, displayName: p.names?.[0]?.displayName ?? c.name });
};

async function createOne(c: ContactCreate) {
  const p = await call<Person>("people:createContact?personFields=names,phoneNumbers", { method: "POST", body: personFor(c) });
  remember(c, p);
}

type SyncComic = Pick<Comic, "id" | "name" | "phone">;

export type UpsertResult = "created" | "updated" | "unchanged" | "skipped";

/** Add or rename one comic's contact. Never deletes, never touches other numbers or fields. */
export async function upsertGoogleContact(comic: SyncComic): Promise<UpsertResult> {
  const plan = planContactSync([comic], await loadGoogleIndex());
  const [c] = plan.create;
  if (c) return (await createOne(c), "created");
  const [u] = plan.update;
  if (u) {
    const p = await updateName(u);
    replace(u, p);
    return "updated";
  }
  return plan.unchanged.length ? "unchanged" : "skipped";
}

/** Plan a sync against a fresh read of Google Contacts. */
export async function planGoogleSync(comics: SyncComic[]): Promise<ContactPlan> {
  return planContactSync(comics, await loadGoogleIndex(true));
}

export interface SyncResult {
  created: number;
  updated: number;
  failed: number;
}

/** Run a plan in batches of 200. Batch writes that fail one by one (stale etag) are retried individually. */
export async function runGoogleSync(plan: ContactPlan, onProgress: (done: number, total: number) => void): Promise<SyncResult> {
  const total = plan.create.length + plan.update.length;
  const r: SyncResult = { created: 0, updated: 0, failed: 0 };
  let done = 0;
  const tick = (n: number) => onProgress((done += n), total);
  onProgress(0, total);

  for (let i = 0; i < plan.create.length; i += BATCH) {
    const chunk = plan.create.slice(i, i + BATCH);
    const res = await call<{ createdPeople?: { httpStatusCode?: number; person?: Person }[] }>("people:batchCreateContacts", {
      method: "POST",
      body: { contacts: chunk.map((c) => ({ contactPerson: personFor(c) })), readMask: "names,phoneNumbers" },
    });
    chunk.forEach((c, n) => {
      const ok = res.createdPeople?.[n]?.person;
      if (ok) (r.created++, remember(c, ok));
      else r.failed++;
    });
    tick(chunk.length);
  }

  for (let i = 0; i < plan.update.length; i += BATCH) {
    const chunk = plan.update.slice(i, i + BATCH);
    const res = await call<{ updateResult?: Record<string, { person?: Person }> }>("people:batchUpdateContacts", {
      method: "POST",
      body: { contacts: Object.fromEntries(chunk.map((u) => [u.resourceName, { etag: u.etag, names: [splitName(u.name)] }])), updateMask: "names", readMask: "names,phoneNumbers" },
    });
    for (const u of chunk) {
      const ok = res.updateResult?.[u.resourceName]?.person;
      if (ok) {
        r.updated++;
        replace(u, ok);
        continue;
      }
      try {
        replace(u, await updateName(u));
        r.updated++;
      } catch (e) {
        if (e instanceof ReconnectGoogleError) throw e;
        r.failed++;
      }
    }
    tick(chunk.length);
  }
  return r;
}

/** Tell the curator a Google write failed. A missing or expired token gets one toast with a Reconnect button, never a popup. */
export function reportGoogleError(e: unknown, what = "Couldn't save to Google Contacts") {
  if (e instanceof ReconnectGoogleError) {
    toast.error("Google Contacts needs you to reconnect", {
      id: "google-reconnect",
      action: { label: "Reconnect", onClick: () => void connectGoogleContacts().then(() => toast.success("Google Contacts is connected")).catch((err: Error) => toast.error(err.message)) },
    });
  } else toast.error(what, { description: (e as Error).message });
}

/**
 * After a comic is saved: if the curator turned this on, write the name to Google Contacts. Fire and forget.
 * Not connected yet (a reload forgets the token) means the Reconnect toast, not a popup.
 */
export function saveComicToGoogle(comic: SyncComic, enabled: boolean) {
  if (!enabled || isDemoUser() || !comic.phone || !normalizePhone(comic.phone)) return;
  void upsertGoogleContact(comic).catch((e) => reportGoogleError(e));
}
