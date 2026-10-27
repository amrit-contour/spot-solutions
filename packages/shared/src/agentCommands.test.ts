import { describe, expect, it } from "vitest";
import { planAction, parseIntentByRules, normalizeRawIntent, stepPending, type AgentIntent, type PlanWorld } from "./agent.ts";
import { NOT_ADMIN, formatMembersWaiting, offerPayload, pastShowReason, planMember, type AccessRow } from "./agentCommands.ts";
import { DEFAULT_SETTINGS } from "./defaults.ts";

const shows = [
  { id: "mon", name: "Monday Mic", weekday: 1 as const, venueId: "v1", active: true, startTime: "20:30", slotCount: 2, includeSlotTime: false, regulars: [], protected: [] },
  { id: "tue", name: "Tuesday Mic", weekday: 2 as const, venueId: "v2", active: true, startTime: "20:00", slotCount: 6, includeSlotTime: false, regulars: [], protected: [] },
];
const venues = [{ id: "v1", name: "Bloom" }, { id: "v2", name: "Indie Hub" }];
const WEEK = "2026-10-26"; // a Monday
const people = [
  { id: "r@c.us", name: "Rahul Mehta", phone: "919811111111" },
  { id: "s@c.us", name: "Sana Khan", phone: "919822222222", banned: true },
  { id: "p@c.us", name: "Priyanka Rao", phone: "919833333333" },
];
const world = (over: Partial<PlanWorld> = {}): PlanWorld => ({ shows: shows as never, venues, week: WEEK, todayWeekday: 1, lineups: [], today: "2026-10-26", ...over });
const o = { primaryReady: true, now: 1000 };
const lineup = (showId: string, ids: string[], extra: Record<string, unknown> = {}) => ({ id: `${WEEK}_${showId}`, showId, status: "draft" as const, slots: ids.map((comicId) => ({ comicId })), ...extra }) as never;

describe("reading offers by rules", () => {
  const read = (t: string) => parseIntentByRules(t);
  it("offer: a plain offer, not direct", () => {
    expect(read("offer Rahul a spot on Monday")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: false });
    expect(read("Offer the Monday spot to Rahul")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: false });
    expect(read("give Rahul a spot on Monday")).toMatchObject({ name: "offer", direct: false });
  });
  it("give Rahul Monday ad hoc is a plain offer too", () => {
    expect(read("give Rahul Monday ad hoc")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: false });
    expect(read("give Rahul an ad hoc spot on Monday")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: false });
  });
  it("directly / already agreed go the direct way", () => {
    expect(read("add Rahul to Monday directly")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: true });
    expect(read("add Rahul directly to Monday")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: true });
    expect(read("Rahul already agreed for Monday")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: true });
    expect(read("Rahul agreed to Monday")).toMatchObject({ direct: true });
  });
  it("a plain add is still the old add", () => {
    expect(read("add Rahul to Monday")).toEqual({ name: "add", person: "rahul", day: "monday" });
  });
  it("a question never becomes an offer", () => {
    expect(read("did Rahul already agree for Monday?")).not.toMatchObject({ name: "offer" });
  });
});

describe("reading member commands by rules", () => {
  const read = (t: string) => parseIntentByRules(t);
  it("who's waiting to join is a member question; who's waiting stays the spot list", () => {
    expect(read("who's waiting to join?")).toEqual({ name: "members_waiting" });
    expect(read("any access requests")).toEqual({ name: "members_waiting" });
    expect(read("who asked to join nothing bot")).toEqual({ name: "members_waiting" });
    expect(read("who's waiting")).toEqual({ name: "waiting" });
    expect(read("who asked for Tuesday")).toMatchObject({ name: "asked" });
    expect(read("who asked to join Monday")).not.toEqual({ name: "members_waiting" });
  });
  it("approve / decline", () => {
    expect(read("approve Priya")).toEqual({ name: "approve_member", person: "priya" });
    expect(read("Approve Priya's request")).toEqual({ name: "approve_member", person: "priya" });
    expect(read("let priya in")).toEqual({ name: "approve_member", person: "priya" });
    expect(read("decline priya@x.com")).toEqual({ name: "decline_member", person: "priya@x.com" });
    expect(read("reject Priya")).toMatchObject({ name: "decline_member" });
  });
  it("the model's answer is checked too", () => {
    expect(normalizeRawIntent({ intent: "offer", person: "Rahul", day: "Monday", direct: true })).toEqual({ name: "offer", person: "Rahul", day: "Monday", direct: true });
    expect(normalizeRawIntent({ intent: "offer", person: "Rahul" })).toEqual({ name: "unknown" });
    expect(normalizeRawIntent({ intent: "approve_member" })).toEqual({ name: "unknown" });
  });
});

describe("planning an offer", () => {
  const offer = (person: string, day: string, direct: boolean): AgentIntent => ({ name: "offer", person, day, direct });
  it("a plain offer asks for a yes, then runs as an offer", () => {
    const r = planAction(offer("rahul", "monday", false), world(), people, o);
    expect(r.pending?.stage).toBe("confirm");
    if (r.pending?.stage !== "confirm") return;
    expect(r.pending.plan).toEqual({ type: "offer", showId: "mon", comicId: "r@c.us", comicName: "Rahul Mehta", phone: "919811111111", direct: false });
    expect(r.pending.summary).toMatch(/^Offer Rahul Mehta/);
    expect(stepPending(r.pending, "yes", 1500).type).toBe("execute");
  });
  it("direct says there is no offer", () => {
    const r = planAction(offer("rahul", "monday", true), world(), people, o);
    if (r.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(r.pending.plan).toMatchObject({ type: "offer", direct: true });
    expect(r.pending.summary).toContain("No offer is sent");
  });
  it("a full show is a soft limit: the offer and the direct add both warn that they go over, and the yes is the confirmation", () => {
    const w = world({ lineups: [lineup("mon", ["x@c.us", "y@c.us"])] });
    const p = planAction(offer("rahul", "monday", false), w, people, o);
    if (p.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(p.pending.summary).toContain("a yes puts it 1 over (3 of 2)");
    const d = planAction(offer("rahul", "monday", true), w, people, o);
    if (d.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(d.pending.summary).toContain("puts it 1 over");
  });
  it("warns when they are already on another show this week", () => {
    const r = planAction(offer("rahul", "monday", true), world({ lineups: [lineup("tue", ["r@c.us"])] }), people, o);
    if (r.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(r.pending.summary).toContain("Rahul is also on Tuesday Mic this week");
  });
  it("refuses someone already on it, a called-off show, a banned comic (plain offer) and a disconnected WhatsApp", () => {
    expect(planAction(offer("rahul", "monday", false), world({ lineups: [lineup("mon", ["r@c.us"])] }), people, o).reply).toBe("Rahul Mehta is already on Monday Mic.");
    expect(planAction(offer("rahul", "monday", false), world({ lineups: [lineup("mon", [], { status: "cancelled" })] }), people, o).reply).toBe("Monday Mic is called off this week.");
    expect(planAction(offer("sana", "monday", false), world(), people, o).reply).toContain("Banned");
    expect(planAction(offer("sana", "monday", true), world(), people, o).pending?.stage).toBe("confirm");
    expect(planAction(offer("rahul", "monday", false), world(), people, { ...o, primaryReady: false }).reply).toContain("isn't connected");
  });
  it("two matching people become a numbered list", () => {
    const r = planAction(offer("pri", "monday", false), world(), [...people, { id: "q@c.us", name: "Priya Nair", phone: "919844444444" }], o);
    expect(r.pending?.stage).toBe("choose");
  });
  it("builds the app's offer message for one comic", () => {
    const m = offerPayload(DEFAULT_SETTINGS, shows[0]! as never, WEEK, "Bloom", "Rahul Mehta");
    expect(m.rich.kind).toBe("poll");
    expect(m.rich.poll?.question).toContain("Rahul");
    expect(m.rich.poll?.question).toContain("Monday Mic");
    expect(m.rich.poll?.options).toEqual(["Yes, I'll take it", "Pass"]);
  });
});

describe("the past-show guard", () => {
  const add: AgentIntent = { name: "add", person: "rahul", day: "monday" };
  const remove: AgentIntent = { name: "remove", person: "rahul", day: "monday" };
  const past = world({ today: "2026-10-28", lineups: [lineup("mon", ["r@c.us"])] });
  it("add, remove and offer refuse a show whose date has passed, pointing at Record who performed", () => {
    for (const intent of [add, remove, { name: "offer", person: "rahul", day: "monday", direct: true } as AgentIntent, { name: "offer", person: "rahul", day: "monday", direct: false } as AgentIntent]) {
      const r = planAction(intent, past, people, o);
      expect(r.pending).toBeUndefined();
      expect(r.reply).toMatch(/past show/);
      expect(r.reply).toContain("Record who performed");
    }
  });
  it("a backfilled lineup is refused even when its date is not before today", () => {
    const w = world({ lineups: [lineup("mon", ["r@c.us"], { backfilled: true })] });
    expect(planAction(remove, w, people, o).reply).toContain("Record who performed");
  });
  it("today's show and later ones are fine", () => {
    expect(planAction(add, world({ today: "2026-10-26" }), people, o).pending?.stage).toBe("confirm");
    expect(pastShowReason({ showName: "X", date: "2026-10-26", today: "2026-10-26", what: "add" })).toBeNull();
  });
  it("one past show of several is refused, the others still planned", () => {
    const r = planAction({ name: "add", person: "rahul", day: "tue" }, world({ today: "2026-10-27" }), people, o);
    expect(r.pending?.stage).toBe("confirm"); // Tuesday is today
    const r2 = planAction({ name: "add", person: "rahul", day: "monday tuesday" }, world({ today: "2026-10-27" }), people, o);
    expect(r2.pending?.stage).toBe("confirm");
  });
});

describe("members", () => {
  const rows: AccessRow[] = [
    { uid: "u1", name: "Priya Shah", email: "priya@x.com", status: "pending", requestedAt: 1 },
    { uid: "u2", name: "Sam Lee", email: "sam@x.com", status: "approved", requestedAt: 0 },
    { uid: "u3", name: "Old Timer", email: "old@x.com", status: "removed", requestedAt: 0 },
  ];
  const ok = { admin: true, approved: 1, max: 6, now: 1000 };
  const approve: AgentIntent = { name: "approve_member", person: "priya" };
  it("only admins", () => {
    expect(planMember(approve, rows, { ...ok, admin: false }).reply).toBe(NOT_ADMIN);
  });
  it("approve asks for a yes and carries the uid", () => {
    const r = planMember(approve, rows, ok);
    if (r.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(r.pending.plan).toEqual({ type: "member", uid: "u1", name: "Priya Shah", email: "priya@x.com", decision: "approved" });
    expect(r.pending.summary).toContain("Approve Priya Shah (priya@x.com)?");
    expect(r.pending.summary).toContain("2 of 6 places");
  });
  it("matches by email too, and declines", () => {
    const r = planMember({ name: "decline_member", person: "priya@x.com" }, rows, ok);
    if (r.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(r.pending.plan).toMatchObject({ uid: "u1", decision: "removed" });
  });
  it("respects the curator limit", () => {
    expect(planMember(approve, rows, { ...ok, approved: 6 }).reply).toContain("limit of 6 curators");
  });
  it("says so for someone already in, unknown people, and a removed one can be restored", () => {
    expect(planMember({ name: "approve_member", person: "sam" }, rows, ok).reply).toContain("already a member");
    expect(planMember({ name: "decline_member", person: "sam" }, rows, ok).reply).toContain("already a member");
    expect(planMember({ name: "approve_member", person: "nobody" }, rows, ok).reply).toContain("couldn't find");
    expect(planMember({ name: "approve_member", person: "old" }, rows, ok).pending?.stage).toBe("confirm");
  });
  it("two Priyas become a list; a waiting one beats a member with the same name", () => {
    const two = [...rows, { uid: "u4", name: "Priya Nair", email: "pn@x.com", status: "pending" as const, requestedAt: 2 }];
    expect(planMember(approve, two, ok).pending?.stage).toBe("choose");
    const same = [{ uid: "m", name: "Priya Old", email: "o@x.com", status: "approved" as const, requestedAt: 0 }, rows[0]!];
    const r = planMember(approve, same, ok);
    if (r.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(r.pending.plan).toMatchObject({ uid: "u1" });
  });
  it("lists who is waiting", () => {
    expect(formatMembersWaiting(rows)).toBe("1 waiting to join:\n• Priya Shah (priya@x.com)\nReply *approve Priya* or *decline Priya*.");
    expect(formatMembersWaiting([])).toBe("Nobody is waiting to join.");
  });
});

describe("direct add switches (confirmation message, group)", () => {
  const read = (t: string) => parseIntentByRules(t);
  it("reads 'no message' and 'don't add to the group' on a direct add", () => {
    expect(read("add Rahul to Monday directly, no message")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: true, confirm: false });
    expect(read("add Rahul to Monday directly without adding them to the group")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: true, addToGroup: false });
    expect(read("add Rahul to Monday directly, no message and no group")).toEqual({ name: "offer", person: "rahul", day: "monday", direct: true, confirm: false, addToGroup: false });
  });
  it("the question says what will happen", () => {
    const on = planAction({ name: "offer", person: "rahul", day: "monday", direct: true }, world(), people, o);
    if (on.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(on.reply ?? on.pending.question ?? JSON.stringify(on.pending)).toMatch(/get your confirmation message, they join the show's group/);
    const off = planAction({ name: "offer", person: "rahul", day: "monday", direct: true, confirm: false, addToGroup: false }, world(), people, o);
    if (off.pending?.stage !== "confirm") throw new Error("expected confirm");
    expect(off.pending.plan).toMatchObject({ type: "offer", direct: true, confirm: false, addToGroup: false });
    expect(JSON.stringify(off.pending)).toMatch(/no message is sent, they aren't added to the group/);
  });
});
