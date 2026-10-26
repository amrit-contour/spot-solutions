import { describe, expect, it } from "vitest";
import { cleanupRemovals, cleanupStep } from "./groupCleanup.ts";

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
  it("asks when the mic didn't happen, or when set to ask", () => {
    expect(cleanupStep(show, { ...lineup, outcome: "canned", status: "canned" }, tue("12:00"), true)).toBe("ask");
    expect(cleanupStep({ ...show, cleanup: { ...show.cleanup, mode: "ask" } }, lineup, tue("12:00"), true)).toBe("ask");
  });
  it("waits for the mic check answer, unless mic checks are off", () => {
    expect(cleanupStep(show, { ...lineup, outcome: null }, tue("12:00"), true)).toBeNull();
    expect(cleanupStep(show, { ...lineup, outcome: null }, tue("12:00"), false)).toBe("run");
  });
  it("runs once, never for a called-off or unlinked show, and gives up after 3 days", () => {
    expect(cleanupStep(show, { ...lineup, cleanup: { status: "done", at: 1 } }, tue("12:00"), true)).toBeNull();
    expect(cleanupStep(show, { ...lineup, status: "cancelled" }, tue("12:00"), true)).toBeNull();
    expect(cleanupStep({ ...show, groupId: null }, lineup, tue("12:00"), true)).toBeNull();
    expect(cleanupStep({ ...show, cleanup: { ...show.cleanup, enabled: false } }, lineup, tue("12:00"), true)).toBeNull();
    expect(cleanupStep(show, lineup, { date: "2026-10-30", time: "12:00" }, true)).toBe("skip");
  });
});

describe("cleanupRemovals", () => {
  it("keeps POCs, regulars, co-hosts, admins, you and next week's lineup", () => {
    const participants = ["poc", "reg", "host", "admin", "me", "next", "a", "b"].map((id) => ({ id: `${id}@c.us`, isAdmin: id === "admin" }));
    const out = cleanupRemovals(participants, { pocs: ["poc@c.us"], regulars: ["reg@c.us"], protected: ["host@c.us"] }, "me@c.us", ["next@c.us"]);
    expect(out.sort()).toEqual(["a@c.us", "b@c.us"]);
  });
});
