import { describe, expect, it } from "vitest";
import { canClearNow, cleanupNotice, cleanupStep, nextRetryAt, planCleanup, removeFailureReason, type CleanupMember } from "./groupCleanup.ts";

// Monday 26 Oct show; cleanup the next day at 11:00.
const show = { groupId: "g@g.us", active: true, cleanup: { enabled: true, mode: "auto" as const, time: "11:00" } };
const lineup = { date: "2026-10-26", status: "confirmed" as const, outcome: "happened" as const, cleanup: null };
const tue = (time: string) => ({ date: "2026-10-27", time });

describe("cleanupStep", () => {
  it("waits for the day after and the time", () => {
    expect(cleanupStep(show, lineup, { date: "2026-10-26", time: "23:00" }, true)).toBeNull();
    expect(cleanupStep(show, lineup, tue("10:59"), true)).toBeNull();
    expect(cleanupStep(show, lineup, tue("11:00"), true)).toBe("run");
  });
  it("a show that didn't happen (old auto setting) is decided by repeat next week; the old ask setting asks", () => {
    expect(cleanupStep(show, { ...lineup, outcome: "canned", status: "canned" }, tue("12:00"), true)).toBe("askRepeat");
    expect(cleanupStep({ ...show, cleanup: { ...show.cleanup, mode: "ask" } }, lineup, tue("12:00"), true)).toBe("ask");
    expect(cleanupStep({ ...show, cleanup: { ...show.cleanup, mode: "ask" } }, { ...lineup, outcome: "canned", status: "canned" }, tue("12:00"), true)).toBe("ask");
  });
  it("waits for the mic check answer, unless mic checks are off", () => {
    expect(cleanupStep(show, { ...lineup, outcome: null }, tue("12:00"), true)).toBeNull();
    expect(cleanupStep(show, { ...lineup, outcome: null }, tue("12:00"), false)).toBe("run");
  });
  it("runs once, never for an unlinked show, and gives up after 3 days", () => {
    expect(cleanupStep(show, { ...lineup, cleanup: { status: "done", at: 1 } }, tue("12:00"), true)).toBeNull();
    expect(cleanupStep(show, { ...lineup, status: "cancelled" }, tue("12:00"), true)).toBe("askRepeat"); // called off: the same rules apply
    expect(cleanupStep({ ...show, groupId: null }, lineup, tue("12:00"), true)).toBeNull();
    expect(cleanupStep({ ...show, cleanup: { ...show.cleanup, enabled: false } }, lineup, tue("12:00"), true)).toBeNull();
    expect(cleanupStep(show, lineup, { date: "2026-10-30", time: "12:00" }, true)).toBe("skip");
  });
});

describe("cleanupStep retries", () => {
  const partial = (retryAt: number | null) => ({ ...lineup, cleanup: { status: "partial" as const, at: 1, retryAt } });
  it("retries a partial cleanup once retryAt has passed, never before, never when given up", () => {
    expect(cleanupStep(show, partial(5_000), tue("12:00"), true, 4_999)).toBeNull();
    expect(cleanupStep(show, partial(5_000), tue("12:00"), true, 5_000)).toBe("retry");
    expect(cleanupStep(show, partial(null), tue("12:00"), true, 9e12)).toBeNull();
  });
});

describe("retry schedule", () => {
  it("2 min, 10 min, then hourly, and stops at the deadline", () => {
    expect(nextRetryAt(1, 0, 1e9)).toBe(120_000);
    expect(nextRetryAt(2, 0, 1e9)).toBe(600_000);
    expect(nextRetryAt(3, 0, 1e9)).toBe(3_600_000);
    expect(nextRetryAt(9, 0, 1e9)).toBe(3_600_000);
    expect(nextRetryAt(3, 0, 3_000_000)).toBeNull();
  });
  it("waits for a healthy, settled WhatsApp", () => {
    expect(canClearNow({ healthy: true, stableMs: 3 * 60_000 })).toBe(true);
    expect(canClearNow({ healthy: true, stableMs: 30_000 })).toBe(false);
    expect(canClearNow({ healthy: false, stableMs: 10 * 60_000 })).toBe(false);
  });
});

const mem = (phone: string | null, over: Partial<CleanupMember> = {}): CleanupMember => ({ ids: [phone ? `${phone}@c.us` : "999@lid"], phone, isAdmin: false, ...over });
const comic = (phone: string, chatId?: string) => ({ id: `${phone}@c.us`, phone: `+${phone}`, chatId });

describe("planCleanup", () => {
  it("keeps POCs, regulars, co-hosts, admins, you and next week's lineup; removes the rest", () => {
    const members = [mem("1"), mem("2"), mem("3"), mem("4", { isAdmin: true }), mem("5"), mem("6"), mem("7"), mem("8")];
    const stay = ["1@c.us", "2@c.us", "3@c.us", "6@c.us"]; // poc, regular, co-host, next week
    const p = planCleanup({ members, stay, comics: [], self: ["5@c.us"] });
    expect(p.remove.map((m) => m.phone)).toEqual(["7", "8"]);
    expect(p.kept).toBe(6);
  });
  it("matches a regular by phone digits when the group shows an @lid and the roster has a phone id (and the reverse)", () => {
    const viaLid: CleanupMember = { ids: ["555@lid", "919@c.us"], phone: "919", isAdmin: false };
    const p1 = planCleanup({ members: [viaLid], stay: ["919@c.us"], comics: [], self: [] });
    expect(p1.remove).toEqual([]);
    // roster stored the lid digits (older records) as a c.us id; group shows the same person by phone + lid
    const p2 = planCleanup({ members: [viaLid], stay: ["555@c.us"], comics: [], self: [] });
    expect(p2.remove).toEqual([]);
    // roster knows only the comic's chat id (an @lid) and phone, the stay list has the comic id
    const p3 = planCleanup({ members: [{ ids: ["777@lid"], phone: "919", isAdmin: false }], stay: ["old-id"], comics: [{ id: "old-id", chatId: "777@lid", phone: "+919" }], self: [] });
    expect(p3.remove).toEqual([]);
  });
  it("never removes someone it can't identify, but does report them", () => {
    const p = planCleanup({ members: [mem(null), mem("9")], stay: [], comics: [], self: [] });
    expect(p.remove.map((m) => m.phone)).toEqual(["9"]);
    expect(p.unknown).toHaveLength(1);
  });
  it("an @lid that matches a stayer's chat id stays even with no phone", () => {
    const p = planCleanup({ members: [{ ids: ["777@lid"], phone: null, isAdmin: false }], stay: ["a@c.us"], comics: [{ id: "a@c.us", chatId: "777@lid", phone: "" }], self: [] });
    expect(p.remove).toEqual([]);
    expect(p.unknown).toEqual([]);
    expect(p.kept).toBe(1);
  });
  it("admins stay even when unidentified; your own @lid stays", () => {
    const p = planCleanup({ members: [mem(null, { isAdmin: true }), { ids: ["42@lid"], phone: "5", isAdmin: false }], stay: [], comics: [], self: ["5@c.us", "42@lid"] });
    expect(p.remove).toEqual([]);
    expect(p.unknown).toEqual([]);
  });
});

describe("removeFailureReason", () => {
  it("turns WhatsApp codes and errors into words", () => {
    expect(removeFailureReason(new Error("failed with 403"))).toMatch(/admin/);
    expect(removeFailureReason(new Error("code 404"))).toMatch(/not found/);
    expect(removeFailureReason(new Error("409 conflict"))).toMatch(/conflict/);
    expect(removeFailureReason(Object.assign(new Error("x"), { name: "ProtocolError", message: "Runtime.callFunctionOn timed out ProtocolError" }))).toMatch(/in time/);
  });
});

describe("cleanupNotice", () => {
  const base = { show: "Open Mic - Monday", removed: 12, skipped: 0, retry: false };
  it("names who is left and why, and says a retry is coming", () => {
    const t = cleanupNotice({ ...base, pending: [{ id: "611@c.us", name: "Ravi", reason: "not found in the group" }, { id: "612@c.us", reason: "WhatsApp doesn't allow it" }], retryInMs: 120_000 });
    expect(t).toContain("12 removed");
    expect(t).toContain("Ravi: not found in the group");
    expect(t).toContain("+612: WhatsApp doesn't allow it");
    expect(t).toMatch(/Trying again in about 2 min|in a minute/);
  });
  it("says so when retries are over, and when all is done", () => {
    expect(cleanupNotice({ ...base, pending: [{ id: "1@c.us", reason: "r" }], retryInMs: null })).toContain("remove them by hand");
    expect(cleanupNotice({ ...base, pending: [], retryInMs: null, retry: true })).toContain("the rest are out now");
    expect(cleanupNotice({ ...base, pending: [], retryInMs: null, skipped: 2 })).toContain("2 members I couldn't identify were left alone");
  });
});
