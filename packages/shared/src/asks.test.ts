import { describe, expect, it } from "vitest";
import {
  ASK_SEND_FROM, limitsText, CLOSING_SOON_MS, DEFAULT_ASK_TEMPLATE, askDayLabel, askDue, askHandled, askId, askShowLabel, askVars, awaitingReply, closesLabel, draftExpired,
  emojiReply, missedReply, openNow, opensLabel, planAsks, reminderText, renderAsk, spanLabel, spotFromAsk, upcomingGroups, zonedMs,
} from "./asks.ts";
import type { Ask, Curator, MySpot, Room, RoomShow } from "./rooms.ts";
import { BLR_ROSTER } from "./fixtures/blrRooms.ts";

const TZ = "Asia/Kolkata";
const at = (iso: string) => new Date(`${iso}+05:30`);
// 2026-10-27 is a Tuesday.
const NOW = at("2026-10-27T10:00:00");
const RANGE = { from: "2026-10-27", to: "2026-11-02" };

const curators: Curator[] = [
  { id: "adi", name: "Aditya Natrajan", phone: "+91 98765 43210" },
  { id: "sam", name: "Sam" },
];
const mic = (extra: Partial<RoomShow> = {}): RoomShow => ({
  id: "mic", name: "Mic", type: "mic", cadence: "weekly", times: ["20:00"],
  days: [{ weekday: 4, curatorIds: ["adi"] }], askRule: { kind: "weekday", day: 1, morning: true }, ...extra,
});
const room = (extra: Partial<Room> = {}, show: RoomShow = mic()): Room => ({ id: "bloom", name: "Bloom Indiranagar", area: "Indiranagar", city: "Bengaluru", aliases: [], tags: [], notes: [], limits: [], shows: [show], ...extra });
const ask = (p: Partial<Ask>): Ask => ({ id: askId("bloom", "mic", "2026-10-29"), roomId: "bloom", showId: "mic", showDate: "2026-10-29", status: "planned", createdAt: 0, ...p });
const plan = (rooms: Room[], ctx = {}) => planAsks(rooms, curators, RANGE, NOW, TZ, ctx);

describe("the message", () => {
  it("fills the default template", () => {
    const f = { curatorName: "Aditya Natrajan", roomName: "Bloom Indiranagar", show: "Bloom Indiranagar", showDate: "2026-10-29", time: "20:00" };
    expect(renderAsk(undefined, f)).toBe("Hey Aditya! Could I get a spot at Bloom Indiranagar on Thursday 29 Oct? Thanks 🙏");
    expect(renderAsk("  ", f)).toBe(renderAsk(DEFAULT_ASK_TEMPLATE, f));
    expect(renderAsk("{{curator}}: {{time}} {{day}}", f)).toBe("Aditya: 8:00 PM Thursday");
  });
  it("says there when there is no curator name, and leaves time empty", () => {
    expect(askVars({ roomName: "R", show: "R", showDate: "2026-10-29" })).toMatchObject({ curator: "there", time: "" });
  });
  it("names the show only when it tells shows apart", () => {
    const one = room();
    expect(askShowLabel(one, one.shows[0]!)).toBe("Bloom Indiranagar");
    const two = room({}, mic());
    two.shows.push({ ...mic(), id: "late", name: "Late show" });
    expect(askShowLabel(two, two.shows[0]!)).toBe("Bloom Indiranagar Mic");
    expect(askShowLabel(two, two.shows[1]!)).toBe("Bloom Indiranagar Late show");
  });
});

describe("time zones", () => {
  it("turns local wall time into the right instant", () => {
    expect(zonedMs("2026-10-29", "20:00", TZ)).toBe(Date.parse("2026-10-29T20:00:00+05:30"));
    expect(zonedMs("2026-01-15", "09:00", "America/New_York")).toBe(Date.parse("2026-01-15T09:00:00-05:00"));
    // The spring-forward day.
    expect(zonedMs("2026-03-08", "12:00", "America/New_York")).toBe(Date.parse("2026-03-08T12:00:00-04:00"));
  });
});

describe("planAsks", () => {
  it("plans the Thursday show: Monday morning ping, open on Tuesday, with who to ask and when it closes", () => {
    const [a, ...rest] = plan([room()]);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ id: "2026-10-29_bloom_mic", roomName: "Bloom Indiranagar", showDate: "2026-10-29", askOn: "2026-10-26", state: "open", due: "overdue", curatorName: "Aditya Natrajan", canSend: true, blocked: false, mode: "review", time: "20:00", ruleLabel: "Ping Monday morning" });
    expect(a!.closesAt).toBe(Date.parse("2026-10-29T20:00:00+05:30"));
    expect(a!.sendFrom).toBe(Date.parse("2026-10-26T09:00:00+05:30"));
  });
  it("the next Thursday opens next Monday", () => {
    const next = planAsks([room()], curators, { from: "2026-10-27", to: "2026-11-05" }, NOW, TZ);
    const b = next.find((x) => x.showDate === "2026-11-05")!;
    expect(b).toMatchObject({ state: "upcoming", askOn: "2026-11-02", due: "later" });
  });
  it("matches rooms.asksOpen for what is open", async () => {
    const { asksOpen } = await import("./rooms.ts");
    const rooms = BLR_ROSTER.rooms.map((r) => ({ ...r, shows: r.shows.map((s) => ({ ...s, myRole: undefined })) }));
    const mine = openNow(planAsks(rooms, BLR_ROSTER.curators, RANGE, NOW, TZ)).map((a) => a.id).sort();
    const theirs = asksOpen(rooms, RANGE, NOW, TZ).filter((o) => !rooms.find((r) => r.id === o.roomId)!.shows.find((s) => s.id === o.showId)!.days.find((d) => d.weekday === o.weekday)!.theyReachOut)
      .map((o) => askId(o.roomId, o.showId, o.showDate)).sort();
    expect(mine).toEqual(theirs);
    expect(mine.length).toBeGreaterThan(3);
  });
  it("skips shows I curate, full or paused shows, they'll reach out days and note-only rules", () => {
    expect(plan([room({}, mic({ myRole: "curator" }))])).toEqual([]);
    expect(plan([room({}, mic({ closures: [{ until: "2026-10-30", source: "manual" }] }))])).toEqual([]);
    expect(plan([room({ pausedUntil: "2026-11-30" })])).toEqual([]);
    expect(plan([room({}, mic({ days: [{ weekday: 4, curatorIds: ["adi"], theyReachOut: true }] }))])).toEqual([]);
    expect(plan([room({}, mic({ askRule: { kind: "walk_in" } }))])).toEqual([]);
    expect(plan([room({}, mic({ askRule: { kind: "they_reach_out" } }))])).toEqual([]);
  });
  it("dedupes per show date: sent, answered and skipped asks are not offered again; a draft is kept", () => {
    expect(plan([room()], { asks: [ask({ status: "sent" })] })).toEqual([]);
    expect(plan([room()], { asks: [ask({ status: "got_it" })] })).toEqual([]);
    expect(plan([room()], { asks: [ask({ status: "expired", skipped: true })] })).toEqual([]);
    const [kept] = plan([room()], { asks: [ask({ message: "hi" })] });
    expect(kept!.doc?.message).toBe("hi");
  });
  it("skips a date I already have a spot for", () => {
    const spot: MySpot = { id: "s", date: "2026-10-29", roomId: "bloom", showId: "mic", source: "adhoc", createdAt: 0 };
    expect(plan([room()], { mySpots: [spot] })).toEqual([]);
    expect(plan([room()], { mySpots: [{ ...spot, status: "cancelled" }] })).toHaveLength(1);
  });
  it("flags an ask that would go over a limit, from asks and regulars only", () => {
    const limited = room({ limits: [{ scope: "room", perWeek: 1 }] });
    const spot = (p: Partial<MySpot>): MySpot => ({ id: "x", date: "2026-10-28", roomId: "bloom", source: "ask", createdAt: 0, ...p });
    expect(plan([limited], { mySpots: [spot({})] })[0]).toMatchObject({ blocked: true });
    expect(plan([limited], { mySpots: [spot({ source: "adhoc" })] })[0]).toMatchObject({ blocked: false });
    expect(plan([limited])[0]).toMatchObject({ blocked: false });
    expect(limitsText(plan([limited], { mySpots: [spot({})] })[0]!.hits)).toBe("Over your limit: 1 a week");
    expect(limitsText([])).toBe("");
  });
  it("can't send without a curator number, and says so", () => {
    const noNumber = room({}, mic({ days: [{ weekday: 4, curatorIds: ["sam"] }] }));
    expect(plan([noNumber])[0]).toMatchObject({ canSend: false, curatorName: "Sam" });
    const nobody = room({}, mic({ days: [{ weekday: 4, curatorIds: [] }] }));
    expect(plan([nobody])[0]).toMatchObject({ canSend: false, curatorId: undefined });
  });
  it("uses a stand-in while one is on", () => {
    const s = room({}, mic({ days: [{ weekday: 4, curatorIds: ["adi"], standIn: { curatorId: "sam", until: "2026-10-31" } }] }));
    expect(plan([s])[0]).toMatchObject({ curatorName: "Sam", standIn: true });
  });
  it("reads the room's auto setting", () => {
    expect(plan([room({ askMode: "auto" })])[0]!.mode).toBe("auto");
  });
  it("two time slots: no single time, closes at the later one", () => {
    const two = room({}, mic({ times: ["19:00", "21:00"] }));
    const a = plan([two])[0]!;
    expect(a.time).toBeUndefined();
    expect(a.closesAt).toBe(Date.parse("2026-10-29T21:00:00+05:30"));
  });
  it("a same-day ask for an early show is sendable before the show, not after", () => {
    const early = room({}, mic({ days: [{ weekday: 2, curatorIds: ["adi"] }], times: ["10:30"], askRule: { kind: "same_day" } }));
    const a = plan([early])[0]!;
    expect(a.sendFrom).toBe(Date.parse("2026-10-27T07:30:00+05:30"));
    expect(a.closesAt).toBe(Date.parse("2026-10-27T10:30:00+05:30"));
  });
});

describe("lanes and labels", () => {
  const rooms = BLR_ROSTER.rooms.map((r) => ({ ...r, shows: r.shows.map((s) => ({ ...s, myRole: undefined })) }));
  const p = planAsks(rooms, BLR_ROSTER.curators, RANGE, NOW, TZ);
  it("splits open now from what's coming, grouped by the day it opens", () => {
    const open = openNow(p);
    expect(open.every((a) => a.state === "open")).toBe(true);
    expect(open.map((a) => a.closesAt)).toEqual([...open.map((a) => a.closesAt)].sort((a, b) => a - b));
    const groups = upcomingGroups(p, "2026-10-27", 7);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.map((g) => g.date)).toEqual([...groups.map((g) => g.date)].sort());
    expect(groups.every((g) => g.date > "2026-10-27" && g.asks.every((a) => a.askOn === g.date))).toBe(true);
    expect(upcomingGroups(p, "2026-10-27", 0)).toEqual([]);
  });
  it("labels", () => {
    expect(askDayLabel("2026-10-27", "2026-10-27")).toBe("Today");
    expect(askDayLabel("2026-10-28", "2026-10-27")).toBe("Tomorrow");
    expect(askDayLabel("2026-10-30", "2026-10-27")).toBe("Friday");
    expect(askDayLabel("2026-11-10", "2026-10-27")).toBe("Tue 10 Nov");
    expect(spanLabel(20 * 60_000)).toBe("20 min");
    expect(spanLabel(6 * 3_600_000)).toBe("6 h");
    expect(spanLabel(3 * 86_400_000)).toBe("3 days");
    expect(closesLabel(NOW.getTime() + 6 * 3_600_000, NOW.getTime())).toBe("Closes in 6 h");
    expect(closesLabel(NOW.getTime() - 1, NOW.getTime())).toBe("Closed");
    expect(opensLabel({ askOn: "2026-10-28", sendFrom: Date.parse("2026-10-28T09:00:00+05:30") }, "2026-10-27", TZ)).toBe("Opens tomorrow at 9 AM");
  });
});

describe("askDue (what the worker does)", () => {
  const base = plan([room()])[0]!; // open since Monday 9 AM, closes Thursday 8 PM
  const t = (iso: string) => Date.parse(`${iso}+05:30`);
  it("review: reminds once on opening, once about 2 h before it closes", () => {
    expect(askDue(base, t("2026-10-27T10:00:00"))).toBe("remind_open");
    const opened = { ...base, doc: ask({ remindedOpenAt: t("2026-10-27T10:00:00") }) };
    expect(askDue(opened, t("2026-10-28T10:00:00"))).toBeNull();
    expect(askDue(opened, t("2026-10-29T17:59:00"))).toBeNull();
    expect(askDue(opened, t("2026-10-29T18:00:00"))).toBe("remind_closing");
    expect(askDue({ ...opened, doc: ask({ remindedOpenAt: t("2026-10-27T10:00:00"), remindedCloseAt: 1 }) }, t("2026-10-29T18:30:00"))).toBeNull();
    expect(askDue(opened, t("2026-10-29T20:00:00"))).toBeNull();
  });
  it("review: no closing reminder on top of an opening one when the window is short", () => {
    const short = { ...base, sendFrom: t("2026-10-29T17:30:00"), doc: ask({ remindedOpenAt: t("2026-10-29T17:30:00") }) };
    expect(askDue(short, t("2026-10-29T18:30:00"))).toBeNull();
  });
  it("auto: sends once, never when blocked, without a number, after a failure or once sent", () => {
    const auto = { ...base, mode: "auto" as const };
    expect(askDue(auto, t("2026-10-27T10:00:00"))).toBe("send");
    expect(askDue({ ...auto, blocked: true }, t("2026-10-27T10:00:00"))).toBeNull();
    expect(askDue({ ...auto, canSend: false }, t("2026-10-27T10:00:00"))).toBeNull();
    expect(askDue({ ...auto, doc: ask({ error: "x" }) }, t("2026-10-27T10:00:00"))).toBeNull();
    expect(askDue({ ...auto, doc: ask({ status: "sent", sentAt: 1 }) }, t("2026-10-27T10:00:00"))).toBeNull();
  });
  it("waits for 9 AM and stops at the show", () => {
    const upcoming = plan([room({ askMode: "auto" })]).map((a) => ({ ...a, sendFrom: t("2026-10-27T11:00:00") }))[0]!;
    expect(askDue(upcoming, t("2026-10-27T10:00:00"))).toBeNull();
    expect(askDue(upcoming, t("2026-10-27T11:00:00"))).toBe("send");
    expect(askDue(upcoming, t("2026-10-29T20:00:00"))).toBeNull();
    expect(ASK_SEND_FROM).toBe("09:00");
    expect(CLOSING_SOON_MS).toBe(7_200_000);
  });
  it("reminder text", () => {
    const a = { ...base };
    expect(reminderText(a, "open", "2026-10-27", t("2026-10-27T10:00:00"))).toBe("Time to ask for a spot at Bloom Indiranagar Thursday 29 Oct. Ask Aditya.");
    expect(reminderText(a, "closing", "2026-10-29", t("2026-10-29T18:00:00"))).toBe("Bloom Indiranagar tonight: the ask closes in 2 h. Ask Aditya.");
  });
});

describe("replies and spots", () => {
  it("reads emoji-only replies", () => {
    expect(emojiReply("👍")).toBe("got_it");
    expect(emojiReply(" 🙌🙏 ")).toBe("got_it");
    expect(emojiReply("👎")).toBe("declined");
    expect(emojiReply("done 👍")).toBeNull();
    expect(emojiReply("")).toBeNull();
  });
  it("which asks to read and which drop off", () => {
    expect(awaitingReply({ status: "sent", showDate: "2026-10-29" }, "2026-10-27")).toBe(true);
    expect(awaitingReply({ status: "sent", showDate: "2026-10-20" }, "2026-10-27")).toBe(false);
    expect(awaitingReply({ status: "got_it", showDate: "2026-10-29" }, "2026-10-27")).toBe(false);
    expect(missedReply({ status: "sent", showDate: "2026-10-26" }, "2026-10-27")).toBe(true);
    expect(missedReply({ status: "sent", showDate: "2026-10-27" }, "2026-10-27")).toBe(false);
    expect(draftExpired({ status: "planned", showDate: "2026-10-26" }, "2026-10-27")).toBe(true);
    expect(askHandled({ status: "planned" })).toBe(false);
    expect(askHandled({ status: "expired", skipped: true })).toBe(true);
  });
  it("a got-it ask becomes a spot with a stable id", () => {
    const s = spotFromAsk(ask({ status: "got_it", time: "20:00" }), room(), undefined, 5);
    expect(s).toMatchObject({ id: "ask_2026-10-29_bloom_mic", date: "2026-10-29", time: "20:00", roomName: "Bloom Indiranagar", source: "ask", askId: "2026-10-29_bloom_mic", happened: null, status: "booked" });
    expect(spotFromAsk(ask({}), undefined, "21:00", 5)).toMatchObject({ time: "21:00", roomName: "" });
  });
});
