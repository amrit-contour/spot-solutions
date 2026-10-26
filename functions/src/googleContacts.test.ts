import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "./core";
import { decryptToken, encryptToken } from "./gcrypto";
import type { Fetch } from "./googleApi";
import { connect, disconnect, listContacts, onComicWritten, planContacts, processDue, processUser, runContacts, type Caller, type GcDeps, type GcStore, type LinkRecord } from "./googleContacts";
import { enqueue, nextTaskAt, type QueueDoc } from "./googleLogic";

const key = randomBytes(32);
const res = (status: number, body: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
const me: Caller = { uid: "u1", email: "amrit@gmail.com", verified: true, anonymous: false };
const CONTACTS = "https://www.googleapis.com/auth/contacts";

function fakeStore(over: Partial<GcStore> = {}) {
  const s = {
    link: null as LinkRecord | null,
    notices: [] as string[],
    queue: null as QueueDoc | null,
    comics: [{ id: "a@c.us", name: "Asha", phone: "919876543210" }],
    removed: [] as string[],
    on: true,
    own: [] as string[],
  };
  const store: GcStore = {
    getLink: async () => s.link,
    putLink: async (_u, r) => void (s.link = r),
    removeLink: async (_u, why) => void (s.removed.push(why), (s.link = null), (s.queue = null)),
    autoSyncOn: async () => s.on && !!s.link,
    ownPhones: async () => s.own,
    getComics: async (_u, ids) => s.comics.filter((c) => !ids || ids.includes(c.id)),
    notice: async (_u, _l, t) => void s.notices.push(t),
    enqueue: async (_u, id, now) => void (s.queue = enqueue(s.queue ?? undefined, id, now)),
    claimDue: async () => (s.queue ? [{ uid: "u1", q: s.queue }] : []),
    claimOne: async (_u, now) => (s.queue && s.queue.dueAt <= now && s.queue.leaseUntil <= now ? s.queue : null),
    armTask: async (_u, now, force) => {
      const at = nextTaskAt(s.queue ?? undefined, now, force);
      if (at !== null && s.queue) s.queue = { ...s.queue, taskAt: at };
      return at;
    },
    finish: async () => void (s.queue = null),
    fail: async () => true,
    drop: async () => void (s.queue = null),
    ...over,
  };
  return { s, store };
}

function deps(store: GcStore, f: Fetch, claims: { email?: string; email_verified?: boolean } = { email: "amrit@gmail.com", email_verified: true }): GcDeps {
  return { store, fetch: f, key, oauth: { clientId: "cid", clientSecret: "sec" }, verifyIdToken: async () => claims, now: () => 1_000_000, sleep: async () => {}, log: () => {} };
}

const tokenFetch = (grant: object): Fetch => async (url) => (url.includes("/revoke") ? res(200, {}) : res(200, grant));

describe("connectGoogleContacts", () => {
  const grant = { refresh_token: "1//rt", access_token: "at", id_token: "idt", scope: `openid email ${CONTACTS}` };
  it("stores the refresh token encrypted and returns only the email and date", async () => {
    const { s, store } = fakeStore();
    const out = await connect(deps(store, tokenFetch(grant)), me, { code: "4/0AbCdEfGhIj" });
    expect(out).toEqual({ email: "amrit@gmail.com", since: 1_000_000 });
    expect(JSON.stringify(out)).not.toContain("rt");
    expect(s.link!.enc).not.toContain("1//rt");
    expect(decryptToken(key, "u1", s.link!.enc)).toBe("1//rt");
  });
  it("accepts a different verified Google account and records which one", async () => {
    const { s, store } = fakeStore();
    const f = vi.fn(tokenFetch(grant));
    await expect(connect(deps(store, f, { email: "other@gmail.com", email_verified: true }), me, { code: "4/0AbCdEfGhIj" })).resolves.toMatchObject({ email: "other@gmail.com" });
    expect(s.link?.email).toBe("other@gmail.com");
  });
  it("refuses an unverified Google account and revokes the token it just got", async () => {
    const { s, store } = fakeStore();
    const f = vi.fn(tokenFetch(grant));
    await expect(connect(deps(store, f, { email: "other@gmail.com", email_verified: false }), me, { code: "4/0AbCdEfGhIj" })).rejects.toMatchObject({ code: "permission-denied" });
    expect(s.link).toBeNull();
    expect(f.mock.calls.some((c) => c[0].includes("/revoke"))).toBe(true);
  });
  it("refuses when Contacts access was unticked, or no refresh token came back", async () => {
    const { store } = fakeStore();
    await expect(connect(deps(store, tokenFetch({ ...grant, scope: "openid email" })), me, { code: "4/0AbCdEfGhIj" })).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(connect(deps(store, tokenFetch({ ...grant, refresh_token: undefined })), me, { code: "4/0AbCdEfGhIj" })).rejects.toMatchObject({ code: "failed-precondition" });
  });
  it("needs a real signed-in account and a plausible code", async () => {
    const { store } = fakeStore();
    const d = deps(store, tokenFetch(grant));
    await expect(connect(d, { ...me, anonymous: true }, { code: "4/0AbCdEfGhIj" })).rejects.toBeInstanceOf(AppError);
    await expect(connect(d, { verified: false, anonymous: true }, { code: "4/0AbCdEfGhIj" })).rejects.toBeInstanceOf(AppError);
    await expect(connect(d, me, { code: 5 })).rejects.toBeInstanceOf(AppError);
    await expect(connect(d, me, {})).rejects.toBeInstanceOf(AppError);
  });
});

describe("disconnectGoogleContacts", () => {
  it("revokes at Google and deletes the link", async () => {
    const { s, store } = fakeStore();
    s.link = { enc: encryptToken(key, "u1", "1//rt"), email: "amrit@gmail.com", since: 1 };
    const f = vi.fn<Fetch>(async () => res(200, {}));
    expect(await disconnect(deps(store, f), me)).toEqual({ revoked: true });
    expect(new URLSearchParams(f.mock.calls[0]![1]!.body).get("token")).toBe("1//rt");
    expect(s.removed).toEqual(["user"]);
  });
  it("is fine when nothing is connected", async () => {
    const { store } = fakeStore();
    expect(await disconnect(deps(store, async () => res(200, {})), me)).toEqual({ revoked: false });
  });
});

describe("trigger and scheduled worker", () => {
  const linked = (s: ReturnType<typeof fakeStore>["s"]) => (s.link = { enc: encryptToken(key, "u1", "1//rt"), email: "amrit@gmail.com", since: 1 });
  const api: Fetch = async (url) => {
    if (url.includes("oauth2.googleapis.com/token")) return res(200, { access_token: "at" });
    if (url.includes("/connections")) return res(200, { connections: [] });
    if (url.endsWith("people:batchCreateContacts")) return res(200, { createdPeople: [{ person: { resourceName: "people/n" } }] });
    return res(404, {});
  };

  it("queues only manual comic edits, and only when connected and switched on", async () => {
    const { s, store } = fakeStore();
    const d = deps(store, api);
    const after = { name: "Asha", phone: "919876543210", nameSource: "manual" };
    expect(await onComicWritten(d, "u1", "a@c.us", undefined, after)).toBe(false);
    linked(s);
    expect(await onComicWritten(d, "u1", "a@c.us", undefined, { ...after, nameSource: "whatsapp" })).toBe(false);
    expect(await onComicWritten(d, "u1", "a@c.us", undefined, after)).toBe(true);
    expect(s.queue?.ids).toEqual(["a@c.us"]);
  });
  it("a burst of edits schedules one task, not one per edit", async () => {
    const { s, store } = fakeStore();
    linked(s);
    const schedule = vi.fn(async () => {});
    const d = { ...deps(store, api), schedule };
    const after = { name: "Asha", phone: "919876543210", nameSource: "manual" };
    await onComicWritten(d, "u1", "a@c.us", undefined, after);
    await onComicWritten(d, "u1", "b@c.us", undefined, { ...after, name: "Bina" });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(s.queue?.ids).toEqual(["a@c.us", "b@c.us"]);
  });
  it("the task writes a due batch and schedules nothing more", async () => {
    const { s, store } = fakeStore();
    linked(s);
    s.queue = { ...enqueue(undefined, "a@c.us", 0), taskAt: 45_000 };
    const schedule = vi.fn(async () => {});
    expect(await processUser({ ...deps(store, api), schedule }, "u1")).toEqual({ saved: 1 });
    expect(s.queue).toBeNull();
    expect(schedule).not.toHaveBeenCalled();
  });
  it("a task that fires early (a later edit pushed the batch back) re-arms for the new time", async () => {
    const { s, store } = fakeStore();
    linked(s);
    s.queue = { ...enqueue(undefined, "a@c.us", 1_000_000), taskAt: 1_000_000 };
    const schedule = vi.fn(async () => {});
    expect(await processUser({ ...deps(store, api), schedule }, "u1")).toEqual({ saved: 0 });
    expect(schedule).toHaveBeenCalledWith("u1", 1_045_000);
  });
  it("writes a due batch and clears it", async () => {
    const { s, store } = fakeStore();
    linked(s);
    s.queue = enqueue(undefined, "a@c.us", 0);
    expect(await processDue(deps(store, api))).toEqual({ users: 1, saved: 1 });
    expect(s.queue).toBeNull();
  });
  it("a revoked grant disconnects, leaves a warning notice, and drops the queue", async () => {
    const { s, store } = fakeStore();
    linked(s);
    s.queue = enqueue(undefined, "a@c.us", 0);
    const revoked: Fetch = async (url) => (url.includes("oauth2.googleapis.com/token") ? res(400, { error: "invalid_grant" }) : res(200, {}));
    await processDue(deps(store, revoked));
    expect(s.removed).toEqual(["revoked"]);
    expect(s.notices[0]).toMatch(/Keep connected/);
    expect(s.queue).toBeNull();
  });
  it("an import-sized batch is not written; the curator is told to review it", async () => {
    const { s, store } = fakeStore();
    linked(s);
    let q = enqueue(undefined, "c0", 0);
    for (let i = 1; i < 30; i++) q = enqueue(q, `c${i}`, 0);
    s.queue = q;
    const f = vi.fn(api);
    await processDue(deps(store, f));
    expect(f).not.toHaveBeenCalled();
    expect(s.notices[0]).toMatch(/Sync all comics now/);
  });
  it("a Google outage retries later and only notices when it gives up", async () => {
    const { s, store } = fakeStore({ fail: async () => false });
    linked(s);
    s.queue = enqueue(undefined, "a@c.us", 0);
    await processDue(deps(store, async (url) => (url.includes("oauth2.googleapis.com/token") ? res(500, {}) : res(200, {}))));
    expect(s.notices).toEqual([]);
  });
});

describe("own numbers", () => {
  it("never writes the curator's own number to Google, even with a different name there", async () => {
    const { s, store } = fakeStore();
    s.link = { enc: encryptToken(key, "u1", "1//rt"), email: "amrit@gmail.com", since: 1 };
    s.comics = [{ id: "919876543210@c.us", name: "Amrit Dash", phone: "919876543210" }];
    s.own = ["919876543210"];
    const f = vi.fn<Fetch>(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) return res(200, { access_token: "at" });
      if (url.includes("/connections")) return res(200, { connections: [{ resourceName: "people/c1", etag: "e", names: [{ displayName: "Me (work)" }], phoneNumbers: [{ canonicalForm: "+919876543210" }] }] });
      return res(500, {});
    });
    const plan = await planContacts(deps(store, f), me, {});
    expect(plan.update).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.skipped).toMatchObject([{ reason: "yours" }]);
  });
});

describe("runGoogleContacts", () => {
  it("re-plans from the stored comics, not from anything the browser sends", async () => {
    const { s, store } = fakeStore();
    s.link = { enc: encryptToken(key, "u1", "1//rt"), email: "amrit@gmail.com", since: 1 };
    const f = vi.fn<Fetch>(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) return res(200, { access_token: "at" });
      if (url.includes("/connections")) return res(200, { connections: [] });
      return res(200, { createdPeople: [{ person: {} }] });
    });
    const r = await runContacts(deps(store, f), me, { ids: ["a@c.us"] });
    expect(r.created).toBe(1);
    const create = f.mock.calls.find((c) => c[0].endsWith("batchCreateContacts"))!;
    expect(JSON.parse(create[1]!.body!).contacts[0].contactPerson.phoneNumbers[0].value).toBe("+919876543210");
    await expect(runContacts(deps(store, f), me, { ids: "all" })).rejects.toBeInstanceOf(AppError);
  });
});

describe("listGoogleContacts", () => {
  const linked = (s: ReturnType<typeof fakeStore>["s"]) => (s.link = { enc: encryptToken(key, "u1", "1//rt"), email: "amrit@gmail.com", since: 1 });
  it("pages through every connection and returns only names and numbers, skipping contacts without a phone", async () => {
    const { s, store } = fakeStore();
    linked(s);
    const f = vi.fn<Fetch>(async (url) => {
      if (url.includes("oauth2.googleapis.com/token")) return res(200, { access_token: "at" });
      if (url.includes("pageToken=p2")) return res(200, { connections: [{ resourceName: "people/c3", etag: "e3", names: [{ displayName: "Cy" }], phoneNumbers: [{ value: "98765 00003" }] }] });
      return res(200, { nextPageToken: "p2", connections: [{ resourceName: "people/c1", etag: "e1", names: [{ displayName: "Asha" }], phoneNumbers: [{ canonicalForm: "+919876500001" }, { value: "+65 9123 4567" }] }, { resourceName: "people/c2", etag: "e2", names: [{ displayName: "No phone" }] }] });
    });
    const out = await listContacts(deps(store, f), me);
    expect(out).toEqual({ contacts: [{ name: "Asha", numbers: ["+919876500001", "+65 9123 4567"] }, { name: "Cy", numbers: ["98765 00003"] }] });
    expect(JSON.stringify(out)).not.toMatch(/etag|resourceName/);
    expect(f.mock.calls.every((c) => !c[1]?.method || c[1].method === "GET" || c[0].includes("oauth2"))).toBe(true);
  });
  it("needs a signed-in curator with Google connected", async () => {
    const { store } = fakeStore();
    await expect(listContacts(deps(store, async () => res(200, {})), { ...me, anonymous: true })).rejects.toBeInstanceOf(AppError);
    await expect(listContacts(deps(store, async () => res(200, {})), me)).rejects.toMatchObject({ code: "failed-precondition" });
  });
  it("a removed grant disconnects the link and tells the curator", async () => {
    const { s, store } = fakeStore();
    linked(s);
    const f: Fetch = async (url) => (url.includes("oauth2.googleapis.com/token") ? res(400, { error: "invalid_grant" }) : res(200, {}));
    await expect(listContacts(deps(store, f), me)).rejects.toMatchObject({ code: "failed-precondition" });
    expect(s.removed).toEqual(["revoked"]);
  });
});
