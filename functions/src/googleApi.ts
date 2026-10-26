// Google's HTTP side of the contacts link: the OAuth token endpoint and the People API. `fetch` and `sleep` are passed
// in so tests run with fakes. Ported from apps/web/src/lib/googleContacts.ts (same calls, same retries).
import { indexGoogleContact, planContactSync, splitName, type ContactCreate, type ContactPlan, type ContactUpdate, type GoogleIndex, type SyncComic } from "./contactsShared";
import { isInvalidGrant } from "./googleLogic";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; json(): Promise<unknown> }>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://people.googleapis.com/v1";
const BATCH = 200;

/** The refresh token no longer works: access was removed (or never lasted). The link must be marked disconnected. */
export class GrantRevokedError extends Error {
  constructor() {
    super("Google access was removed");
    this.name = "GrantRevokedError";
  }
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface CodeGrant {
  refreshToken?: string;
  accessToken?: string;
  idToken?: string;
  scope?: string;
}

/** The one-time code from the browser (Google Identity Services popup, redirect_uri "postmessage") for tokens. */
export async function exchangeCode(f: Fetch, c: OAuthClient, code: string): Promise<CodeGrant> {
  const res = await f(TOKEN_URL, { method: "POST", headers: FORM, body: form({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: "postmessage", grant_type: "authorization_code" }) });
  const b = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; id_token?: string; scope?: string; error?: string };
  if (!res.ok) throw new GoogleApiError(res.status, b.error ?? `Google said ${res.status}`);
  return { refreshToken: b.refresh_token, accessToken: b.access_token, idToken: b.id_token, scope: b.scope };
}

/** A short-lived access token from the stored refresh token. invalid_grant becomes GrantRevokedError. */
export async function mintAccessToken(f: Fetch, c: OAuthClient, refreshToken: string): Promise<string> {
  const res = await f(TOKEN_URL, { method: "POST", headers: FORM, body: form({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }) });
  const b = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (isInvalidGrant(res.status, b)) throw new GrantRevokedError();
  if (!res.ok || !b.access_token) throw new GoogleApiError(res.status, b.error ?? `Google said ${res.status}`);
  return b.access_token;
}

/** Best effort: true if Google revoked it (or it was already dead). */
export async function revokeToken(f: Fetch, token: string): Promise<boolean> {
  try {
    const res = await f(REVOKE_URL, { method: "POST", headers: FORM, body: form({ token }) });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

interface Person {
  resourceName?: string;
  etag?: string;
  names?: { displayName?: string }[];
  phoneNumbers?: { value?: string; canonicalForm?: string }[];
}

export interface SyncResult {
  created: number;
  updated: number;
  failed: number;
}

const personFor = (c: ContactCreate) => ({ names: [splitName(c.name)], phoneNumbers: [{ value: `+${c.phone}`, type: "mobile" }] });
const isEtagMismatch = (e: unknown) => e instanceof GoogleApiError && e.status === 400 && /etag/i.test(e.message);

/** People API calls for one run, with one access token. Creates and renames only; there is no delete anywhere here. */
export class People {
  constructor(
    private f: Fetch,
    private token: string,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${API}/${path}`, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${this.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      if (res.ok) return (await res.json()) as T;
      if ((res.status === 429 || res.status === 503) && attempt < 4) {
        const retry = Number(res.headers.get("Retry-After"));
        await this.sleep(retry > 0 ? Math.min(retry, 30) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleApiError(res.status, body.error?.message ?? `Google said ${res.status}`);
    }
  }

  /** Every Google contact that has a phone number, keyed by normalised digits. */
  async loadIndex(): Promise<GoogleIndex> {
    const map: GoogleIndex = new Map();
    let pageToken = "";
    do {
      const r = await this.call<{ connections?: Person[]; nextPageToken?: string }>(`people/me/connections?personFields=names,phoneNumbers&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      for (const p of r.connections ?? []) {
        if (!p.resourceName || !p.etag || !p.phoneNumbers?.length) continue;
        indexGoogleContact(map, { resourceName: p.resourceName, etag: p.etag, displayName: p.names?.[0]?.displayName ?? "" }, p.phoneNumbers.map((n) => n.canonicalForm || n.value || ""));
      }
      pageToken = r.nextPageToken ?? "";
    } while (pageToken);
    return map;
  }

  async plan(comics: SyncComic[]): Promise<ContactPlan> {
    return planContactSync(comics, await this.loadIndex());
  }

  /** Names only. A stale etag (400) is refetched once. */
  private async updateName(u: Pick<ContactUpdate, "resourceName" | "etag" | "name">): Promise<Person> {
    const put = (etag: string) => this.call<Person>(`${u.resourceName}:updateContact?updatePersonFields=names&personFields=names,phoneNumbers`, { method: "PATCH", body: { etag, names: [splitName(u.name)] } });
    try {
      return await put(u.etag);
    } catch (e) {
      if (!isEtagMismatch(e)) throw e;
      const fresh = await this.call<Person>(`${u.resourceName}?personFields=names,phoneNumbers`);
      if (!fresh.etag) throw e;
      return put(fresh.etag);
    }
  }

  /** Run a plan in batches of 200. Updates that fail inside a batch (stale etag) are retried one by one. */
  async apply(plan: Pick<ContactPlan, "create" | "update">): Promise<SyncResult> {
    const r: SyncResult = { created: 0, updated: 0, failed: 0 };
    for (let i = 0; i < plan.create.length; i += BATCH) {
      const chunk = plan.create.slice(i, i + BATCH);
      const res = await this.call<{ createdPeople?: { person?: Person }[] }>("people:batchCreateContacts", {
        method: "POST",
        body: { contacts: chunk.map((c) => ({ contactPerson: personFor(c) })), readMask: "names,phoneNumbers" },
      });
      chunk.forEach((_, n) => (res.createdPeople?.[n]?.person ? r.created++ : r.failed++));
    }
    for (let i = 0; i < plan.update.length; i += BATCH) {
      const chunk = plan.update.slice(i, i + BATCH);
      const res = await this.call<{ updateResult?: Record<string, { person?: Person }> }>("people:batchUpdateContacts", {
        method: "POST",
        body: { contacts: Object.fromEntries(chunk.map((u) => [u.resourceName, { etag: u.etag, names: [splitName(u.name)] }])), updateMask: "names", readMask: "names,phoneNumbers" },
      });
      for (const u of chunk) {
        if (res.updateResult?.[u.resourceName]?.person) {
          r.updated++;
          continue;
        }
        try {
          await this.updateName(u);
          r.updated++;
        } catch {
          r.failed++;
        }
      }
    }
    return r;
  }
}
