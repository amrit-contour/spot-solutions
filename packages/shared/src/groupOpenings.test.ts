import { describe, expect, it } from "vitest";
import { BLR_ROSTER, buildBlrRoster } from "./fixtures/blrRooms.ts";
import { heuristicRead, interpret, zonedToMs, type GroupMsg, type GroupUpdate, type ParsedOpening } from "./groupAlerts.ts";
import { applyOpeningToRoom, askedShows, howToBook, openingKey, openingsDue, openingsExpired, planOpening, reconcileOpening } from "./groupOpenings.ts";
import { planAsks, zonedMs } from "./asks.ts";
import { openingFor, pruneOpenings, shareable, type Room } from "./rooms.ts";

const TZ = "Asia/Kolkata";
const NOON = zonedToMs("2026-10-27", "12:00", TZ); // Tuesday
const room = (name: string) => BLR_ROSTER.rooms.find((r) => r.name === name)!;
const msg = (text: string): GroupMsg => ({ id: "m1", groupId: "g1@g.us", text, at: NOON, sender: { id: "919800000001@c.us", name: "Dhruv" }, mentioned: [] });
const read = (text: string, now = NOON) => {
  const m = msg(text);
  const r = interpret(heuristicRead(m.text, m.mentioned), m, { rooms: BLR_ROSTER.rooms, curators: BLR_ROSTER.curators, tz: TZ, now });
  if (r.kind !== "opening_notice") throw new Error(`expected an opening notice, got ${r.kind}`);
  return r.opening;
};

describe("reading the notice", () => {
  it("room, time, day", () => {
    expect(read("ministry spots will open by 3:15pm")).toMatchObject({ roomId: room("Ministry of Comedy").id, openAt: "15:15", date: "2026-10-27" });
    expect(read("ministry website is open")).toMatchObject({ website: true, openAt: undefined, date: "2026-10-27" });
    expect(read("ministry spots will open by 3:15pm tomorrow").date).toBe("2026-10-28");
  });
});

describe("planOpening", () => {
  const o = (extra: Partial<ParsedOpening> = {}): ParsedOpening => ({ ...read("ministry spots will open by 3:15pm"), ...extra });
  it("a room the comic asks: push at the opening time, with how to book from the room's notes", () => {
    const p = planOpening(o(), room("Ministry of Comedy"), TZ, NOON)!;
    expect(p).toMatchObject({ asks: true, pushAt: zonedToMs("2026-10-27", "15:15", TZ), openAt: "15:15", expiresAt: zonedToMs("2026-10-27", "23:59", TZ) });
    expect(p.push).toEqual({ title: "Ministry of Comedy spots are open now", body: "Book on the website (ministryofcomedy.in/mics). Needs the site password: ask a regular." });
    expect(p.showIds).toEqual(room("Ministry of Comedy").shows.map((s) => s.id));
  });
  it("a time that has passed, or no time at all, pushes at once", () => {
    const late = zonedToMs("2026-10-27", "16:00", TZ);
    expect(planOpening(o(), room("Ministry of Comedy"), TZ, late)?.pushAt).toBe(late);
    const none = planOpening(o({ openAt: undefined, website: true }), room("Ministry of Comedy"), TZ, NOON)!;
    expect(none.pushAt).toBe(NOON);
    expect(none.openAt).toBe("12:00");
  });
  it("no push and no roster change for a room the comic doesn't have, or one they curate; a day that is over does nothing", () => {
    expect(planOpening(o({ roomId: undefined, roomName: "Somewhere" }), undefined, TZ, NOON)).toMatchObject({ asks: false });
    expect(planOpening(o({ roomId: undefined, roomName: "Somewhere" }), undefined, TZ, NOON)?.pushAt).toBeUndefined();
    const bloom = room("Bloom Indiranagar");
    expect(planOpening(o({ roomId: bloom.id }), bloom, TZ, NOON)).toMatchObject({ asks: false });
    expect(planOpening(o({ date: "2026-10-26" }), room("Ministry of Comedy"), TZ, NOON)).toBeNull();
  });
  it("a website notice with no note on the room still says to book on the website", () => {
    expect(howToBook({ notes: [] }, true)).toBe("Book on the website");
    expect(howToBook({ notes: [] }, false)).toBe("");
    expect(howToBook({ notes: [{ kind: "instagram", handle: "comedybandar" }] }, false)).toBe("Ask on Instagram @comedybandar.");
    expect(askedShows(room("Ministry of Comedy"), "2026-10-27")).toHaveLength(1);
  });
});

describe("the roster's ask window for that date", () => {
  const laugh = (): Room => buildBlrRoster().rooms.find((r) => r.name === "Laugh Junction")!;
  it("an applied opening moves that one date's send time, nothing else, and goes when the day does", () => {
    const base = laugh();
    const now = new Date(zonedToMs("2026-10-28", "08:00", TZ)); // Wednesday morning: a same-day-morning room
    const curators = buildBlrRoster().curators;
    const plan = (r: Room) => planAsks([r], curators, { from: "2026-10-28", to: "2026-10-30" }, now, TZ);
    const before = plan(base).find((a) => a.showDate === "2026-10-28")!;
    const edited = applyOpeningToRoom(base, { date: "2026-10-28", openAt: "15:15", showIds: base.shows.map((s) => s.id), groupId: "g1", messageId: "m1" }, now.getTime(), TZ);
    expect(openingFor(edited.shows[0]!, "2026-10-28")).toMatchObject({ at: "15:15", source: "group_message", messageId: "m1" });
    const after = plan(edited).find((a) => a.showDate === "2026-10-28")!;
    expect(after.sendFrom).toBe(zonedMs("2026-10-28", "15:15", TZ));
    expect(after.sendFrom).not.toBe(before.sendFrom);
    // other dates untouched; the shareable roster never carries it
    expect(plan(edited).find((a) => a.showDate === "2026-10-29")?.sendFrom).toBe(plan(base).find((a) => a.showDate === "2026-10-29")?.sendFrom);
    expect(JSON.stringify(shareable(edited))).not.toContain("openings");
    // a new time for the same date replaces; old dates are dropped
    const again = applyOpeningToRoom(edited, { date: "2026-10-28", openAt: "16:00", showIds: base.shows.map((s) => s.id) }, now.getTime(), TZ);
    expect(again.shows[0]!.openings).toHaveLength(1);
    expect(openingFor(again.shows[0]!, "2026-10-28")?.at).toBe("16:00");
    expect(pruneOpenings(again.shows[0]!, "2026-10-29").openings).toBeUndefined();
  });
});

describe("dedupe, schedule, expiry", () => {
  const upd = (id: string, openAt: string | undefined, extra: Partial<GroupUpdate> = {}): GroupUpdate => ({
    id, kind: "opening", groupId: "g1", messageId: id, poster: { id: "p" }, roomId: "ministry", summary: "s", status: "info", receivedAt: 1, opening: { openAt, website: false, date: "2026-10-27" }, ...extra,
  });
  it("the same notice again is a duplicate; a new time supersedes the old one", () => {
    expect(openingKey(upd("a", "15:15"))).toBe("ministry|2026-10-27|15:15");
    expect(reconcileOpening(upd("b", "15:15"), [upd("a", "15:15")])).toEqual({ duplicate: true, supersede: [] });
    expect(reconcileOpening(upd("b", "15:30"), [upd("a", "15:15")])).toEqual({ duplicate: false, supersede: ["a"] });
    expect(reconcileOpening(upd("b", "15:30"), [upd("a", "15:15", { roomId: "other" })])).toEqual({ duplicate: false, supersede: [] });
    expect(reconcileOpening(upd("b", "15:15"), [upd("a", "15:15", { status: "dismissed" })]).duplicate).toBe(false);
  });
  it("pushes fire once, at their time, not when the moment is long gone, and not when cancelled", () => {
    const t = zonedToMs("2026-10-27", "15:15", TZ);
    const a = upd("a", "15:15", { pushAt: t, expiresAt: t + 8 * 3600_000 });
    expect(openingsDue([a], t - 1).fire).toEqual([]);
    expect(openingsDue([a], t + 1000).fire.map((u) => u.id)).toEqual(["a"]);
    expect(openingsDue([{ ...a, pushedAt: t }], t + 1000).fire).toEqual([]);
    expect(openingsDue([a], t + 60 * 60_000)).toMatchObject({ fire: [], missed: [expect.objectContaining({ id: "a" })] });
    expect(openingsDue([{ ...a, pushAt: undefined }], t + 1000).fire).toEqual([]);
  });
  it("heads-ups clear after their day; applied ones stay in the log", () => {
    const end = zonedToMs("2026-10-27", "23:59", TZ);
    const list = [upd("a", "15:15", { expiresAt: end }), upd("b", "15:15", { expiresAt: end, status: "applied" }), upd("c", "15:15", { expiresAt: end, status: "pending" })];
    expect(openingsExpired(list, end - 1)).toEqual([]);
    expect(openingsExpired(list, end + 1).map((u) => u.id)).toEqual(["a", "c"]);
  });
});
