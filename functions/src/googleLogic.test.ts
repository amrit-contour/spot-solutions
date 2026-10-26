import { describe, expect, it } from "vitest";
import { AUTO_MAX, COLLECT_CAP, DEBOUNCE_MS, MAX_ATTEMPTS, MAX_WAIT_MS, afterFailure, afterRun, checkAccountEmail, enqueue, hasContactsScope, isBulk, isDue, isInvalidGrant, retryDelayMs, shouldQueueComic } from "./googleLogic";

describe("checkAccountEmail", () => {
  it("accepts the same verified address, ignoring case", () => {
    expect(checkAccountEmail({ email: "Amrit@Gmail.com", verified: true }, { email: "amrit@gmail.com", verified: true })).toEqual({ ok: true, email: "amrit@gmail.com" });
  });
  it("allows a different Google account for contacts (often the curator's main one)", () => {
    expect(checkAccountEmail({ email: "Main@Gmail.com", verified: true }, { email: "amrit@gmail.com", verified: true })).toEqual({ ok: true, email: "main@gmail.com" });
  });
  it("refuses unverified emails on either side", () => {
    expect(checkAccountEmail({ email: "a@x.com", verified: false }, { email: "a@x.com", verified: true }).ok).toBe(false);
    expect(checkAccountEmail({ email: "a@x.com", verified: true }, { email: "a@x.com", verified: false }).ok).toBe(false);
    expect(checkAccountEmail({ verified: true }, { email: "a@x.com", verified: true }).ok).toBe(false);
  });
});

describe("scope and grant checks", () => {
  it("needs the contacts scope among the granted ones", () => {
    expect(hasContactsScope("openid email https://www.googleapis.com/auth/contacts")).toBe(true);
    expect(hasContactsScope("openid email")).toBe(false);
    expect(hasContactsScope("https://www.googleapis.com/auth/contacts.readonly")).toBe(false);
  });
  it("spots a dead refresh token", () => {
    expect(isInvalidGrant(400, { error: "invalid_grant" })).toBe(true);
    expect(isInvalidGrant(500, { error: "invalid_grant" })).toBe(false);
    expect(isInvalidGrant(400, { error: "invalid_client" })).toBe(false);
  });
});

describe("shouldQueueComic", () => {
  const c = { name: "Priya", phone: "919876543210", nameSource: "manual" };
  it("queues a new manual comic and a rename or new number", () => {
    expect(shouldQueueComic(undefined, c)).toBe(true);
    expect(shouldQueueComic(c, { ...c, name: "Priya N" })).toBe(true);
    expect(shouldQueueComic(c, { ...c, phone: "919876543211" })).toBe(true);
  });
  it("ignores other edits, deletes, no phone, and names WhatsApp filled in", () => {
    expect(shouldQueueComic(c, { ...c, name: c.name })).toBe(false);
    expect(shouldQueueComic(c, undefined)).toBe(false);
    expect(shouldQueueComic(undefined, { ...c, phone: "" })).toBe(false);
    expect(shouldQueueComic(undefined, { ...c, nameSource: "whatsapp" })).toBe(false);
    expect(shouldQueueComic(undefined, { ...c, nameSource: "contact" })).toBe(false);
    expect(shouldQueueComic(undefined, { ...c, name: "  " })).toBe(false);
  });
});

describe("queue", () => {
  it("debounces: each edit pushes the due time, up to the max wait", () => {
    let q = enqueue(undefined, "a", 1000);
    expect(q.dueAt).toBe(1000 + DEBOUNCE_MS);
    q = enqueue(q, "b", 1000 + 30_000);
    expect(q.ids).toEqual(["a", "b"]);
    expect(q.dueAt).toBe(1000 + 30_000 + DEBOUNCE_MS);
    q = enqueue(q, "c", 1000 + MAX_WAIT_MS - 1000);
    expect(q.dueAt).toBe(1000 + MAX_WAIT_MS);
  });
  it("collects each comic once and stops collecting past the cap", () => {
    let q = enqueue(undefined, "a", 0);
    q = enqueue(q, "a", 1);
    expect(q.ids).toEqual(["a"]);
    for (let i = 0; i <= COLLECT_CAP; i++) q = enqueue(q, `c${i}`, 2);
    expect(q.ids.length).toBe(COLLECT_CAP);
    expect(q.overflow).toBe(true);
    expect(isBulk(q)).toBe(true);
  });
  it("a batch over AUTO_MAX is bulk (left for the reviewed sync)", () => {
    expect(isBulk({ ids: Array.from({ length: AUTO_MAX }, String), overflow: false })).toBe(false);
    expect(isBulk({ ids: Array.from({ length: AUTO_MAX + 1 }, String), overflow: false })).toBe(true);
  });
  it("is due only when quiet long enough and not leased", () => {
    const q = enqueue(undefined, "a", 0);
    expect(isDue(q, DEBOUNCE_MS - 1)).toBe(false);
    expect(isDue(q, DEBOUNCE_MS)).toBe(true);
    expect(isDue({ ...q, leaseUntil: DEBOUNCE_MS + 1 }, DEBOUNCE_MS)).toBe(false);
  });
  it("after a run: drops what was written, keeps edits that arrived meanwhile", () => {
    let q = enqueue(undefined, "a", 0);
    q = { ...q, leaseUntil: 500_000 };
    q = enqueue(q, "b", 10);
    expect(afterRun(q, ["a"], 100_000)?.ids).toEqual(["b"]);
    expect(afterRun(q, ["a"], 100_000)?.leaseUntil).toBe(0);
    expect(afterRun(q, ["a", "b"], 100_000)).toBeNull();
    expect(afterRun(undefined, ["a"], 1)).toBeNull();
  });
  it("overflow survives a normal run but is cleared by the bulk run", () => {
    const q = { ...enqueue(undefined, "a", 0), overflow: true };
    expect(afterRun(q, ["a"], 1)?.overflow).toBe(true);
    expect(afterRun(q, ["a"], 1, true)).toBeNull();
  });
  it("backs off after a failure, then gives up", () => {
    let q: ReturnType<typeof enqueue> | null = enqueue(undefined, "a", 0);
    q = afterFailure(q, 1000)!;
    expect(q.attempts).toBe(1);
    expect(q.dueAt).toBe(1000 + retryDelayMs(1));
    // A new edit during back-off does not bring the retry forward.
    expect(enqueue(q, "b", 2000).dueAt).toBe(q.dueAt);
    for (let i = 1; i < MAX_ATTEMPTS - 1; i++) q = afterFailure(q, 5000)!;
    expect(afterFailure(q, 5000)).toBeNull();
    expect(retryDelayMs(30)).toBe(3_600_000);
  });
});
