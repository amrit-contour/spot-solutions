import { describe, expect, it } from "vitest";
import {
  alertExpiry, alertIdFor, alertPush, alertState, alertToClose, alertsClosedByRanges, applyClosureToRoom, applyScheduleToRoom, clashNote, closureRanges, heuristicRead, interpret, localParts,
  matchCurator, mentionsAsNames, namedContact, parseClosureScope, parseOfferTimes, parseReachBy, parseSchedule, parseTimes, parseWeekdays, renderAlertAsk, resolveContact, resolveDate,
  resolveRoom, scheduleSummary, timeLeft, timesShort, worthReading, zonedToMs,
  type GroupMsg, type ReadCtx, type Reading,
} from "./groupAlerts.ts";
import { fullClosure, isFull, type MySpot, type SpotAlert } from "./rooms.ts";
import { BLR_ROSTER, buildBlrRoster } from "./fixtures/blrRooms.ts";

const TZ = "Asia/Kolkata";
// Tuesday 27 Oct 2026, 5 PM in Bangalore.
const NOW = zonedToMs("2026-10-27", "17:00", TZ);
const TODAY = "2026-10-27";

const ctx = (extra: Partial<ReadCtx> = {}): ReadCtx => ({ rooms: BLR_ROSTER.rooms, curators: BLR_ROSTER.curators, tz: TZ, now: NOW, ...extra });
const msg = (text: string, extra: Partial<GroupMsg> = {}): GroupMsg => ({ id: "m1", groupId: "g1@g.us", text, at: NOW, sender: { id: "919800000001@c.us", name: "Dhruv" }, mentioned: [], ...extra });
/** The whole pipeline without a model: rules decide the kind, then interpret. */
const read = (text: string, extra: Partial<GroupMsg> = {}, c: ReadCtx = ctx()): Reading => {
  const m = msg(text, extra);
  return interpret(heuristicRead(m.text, m.mentioned), m, c);
};
const offer = (r: Reading) => {
  if (r.kind !== "spot_offer") throw new Error(`expected an offer, got ${r.kind}`);
  return r.offer;
};
const roomName = (id: string | undefined) => BLR_ROSTER.rooms.find((r) => r.id === id)?.name;

describe("times", () => {
  it("reads lists with one am/pm for the lot", () => {
    expect(parseTimes("Spots available for both 9:30 and 11 pm today at TAG. DM")).toEqual(["21:30", "23:00"]);
    expect(parseTimes("Spots available at 7 and 9pm today")).toEqual(["19:00", "21:00"]);
  });
  it("reads a single time with or without am/pm and with a dot", () => {
    expect(parseTimes("Busking spot at 6pm today")).toEqual(["18:00"]);
    expect(parseTimes("One spot available at 10.30 at UGC today, DM")).toEqual(["22:30"]);
    expect(parseTimes("show at 9:15 am")).toEqual(["09:15"]);
    expect(parseTimes("slot at 21:30")).toEqual(["21:30"]);
    expect(parseTimes("mic at 12 pm")).toEqual(["12:00"]);
  });
  it("takes the start of each range", () => {
    expect(parseTimes("Spots at the entertainment store: 3-5pm 5-7pm 7-9pm Dm me")).toEqual(["15:00", "17:00", "19:00"]);
    expect(parseTimes("11-1pm")).toEqual(["11:00"]);
  });
  it("ignores numbers that aren't times", () => {
    expect(parseTimes("DM if you can make it in 20 mins Max")).toEqual([]);
    expect(parseTimes("2 spots, 3 comics, 10 minutes each")).toEqual([]);
    expect(parseTimes("call 98765 43210")).toEqual([]);
    expect(parseTimes("on 27/10 spots")).toEqual([]);
    expect(parseTimes("Long spots available. DM.")).toEqual([]);
  });
  it("splits the reach-by time from the show times", () => {
    expect(parseOfferTimes("Busking spot available at 6pm today at comedy theatre. DM if you can reach by 5.40pm.", "17:00")).toEqual({ times: ["18:00"], reachBy: "17:40" });
    expect(parseReachBy("be there by 6:15 pm", "17:00").reachBy).toBe("18:15");
  });
  it("reads \"in 20 mins\" from the time the message came", () => {
    expect(parseOfferTimes("One busking spot available at church street. DM if you can make it in 20 mins Max.", "17:00")).toEqual({ times: [], reachBy: "17:20" });
    expect(parseReachBy("reach in 45 minutes", "17:30").reachBy).toBe("18:15");
  });
  it("converts wall-clock time in a zone", () => {
    expect(zonedToMs("2026-10-27", "17:00", TZ)).toBe(Date.UTC(2026, 9, 27, 11, 30));
    expect(localParts(NOW, TZ)).toEqual({ date: TODAY, time: "17:00", weekday: 2 });
    expect(zonedToMs("2026-01-15", "09:00", "America/New_York")).toBe(Date.UTC(2026, 0, 15, 14, 0));
  });
});

describe("days", () => {
  it("expands ranges and lists", () => {
    expect(parseWeekdays("Wednesday, Thursday, Friday, and Saturday spots are over")).toEqual([3, 4, 5, 6]);
    expect(parseWeekdays("Mon-Thu")).toEqual([1, 2, 3, 4]);
    expect(parseWeekdays("Fri to Mon")).toEqual([1, 5, 6, 0]);
    expect(parseWeekdays("no days here, sunshine")).toEqual([]);
  });
  it("resolves today, tomorrow and named days", () => {
    expect(resolveDate("today", TODAY)).toBe(TODAY);
    expect(resolveDate("tomorrow", TODAY)).toBe("2026-10-28");
    expect(resolveDate("friday", TODAY)).toBe("2026-10-30");
    expect(resolveDate("tuesday", TODAY)).toBe(TODAY);
    expect(resolveDate("2026-11-02", TODAY)).toBe("2026-11-02");
    expect(resolveDate("", TODAY)).toBe(TODAY);
  });
});

describe("rooms", () => {
  const rooms = BLR_ROSTER.rooms;
  it("matches names, aliases and a distinctive word", () => {
    expect(resolveRoom(rooms, "TAG").room?.name).toBe("TAG");
    expect(resolveRoom(rooms, "UGC").room?.name).toBe("Underground Comedy Club");
    expect(resolveRoom(rooms, "Banter comedy club").room?.name).toBe("Banter Comedy Club");
    expect(resolveRoom(rooms, "square").room?.name).toBe("Comedy Square");
    expect(resolveRoom(rooms, "ministry").room?.name).toBe("Ministry of Comedy");
    expect(resolveRoom(rooms, "church street").room?.area).toBe("Church Street");
  });
  it("doesn't guess between two locations of a chain", () => {
    const m = resolveRoom(rooms, "comedy theatre");
    expect(m.room).toBeNull();
    expect(m.candidates.map((r) => r.area).sort()).toEqual(["Church Street", "Indiranagar"]);
    expect(resolveRoom(rooms, "bloom").room).toBeNull();
    expect(resolveRoom(rooms, "Comedy Theatre Church Street").room?.area).toBe("Church Street");
  });
  it("knows nothing about a room that isn't there", () => {
    expect(resolveRoom(rooms, "entertainment store")).toEqual({ room: null, candidates: [] });
    expect(resolveRoom(rooms, "comedy")).toEqual({ room: null, candidates: [] });
    expect(resolveRoom(rooms, "")).toEqual({ room: null, candidates: [] });
  });
});

describe("contact", () => {
  const sender = { id: "919800000001@c.us", name: "Dhruv" };
  it("is the sender for DM me and when nobody else is named", () => {
    expect(resolveContact({ sender, mentioned: [], text: "Spots at 7 DM me" })).toEqual({ id: sender.id, name: "Dhruv", kind: "sender" });
    expect(resolveContact({ sender, mentioned: [], text: "Spots at 7. DM." })).toMatchObject({ kind: "sender" });
  });
  it("is the tagged person for PM @x", () => {
    const tagged = { id: "919800000002@c.us", name: "Akhil" };
    expect(resolveContact({ sender, mentioned: [tagged], text: "Spot at 9 today, PM @Akhil" })).toEqual({ id: tagged.id, name: "Akhil", kind: "mentioned" });
  });
  it("skips the comic themself and the sender among the tags, and still says DM me", () => {
    const me = { id: "919800000009@c.us", name: "Me" };
    expect(resolveContact({ sender, mentioned: [me], text: "spots, PM @Me", selfId: me.id })).toMatchObject({ kind: "sender" });
    expect(resolveContact({ sender, mentioned: [{ id: "919800000002@c.us", name: "Akhil" }], text: "DM me for spots" })).toMatchObject({ kind: "sender" });
  });
  it("finds a named person in the directory, else falls back to the sender", () => {
    const directory = [{ id: "919800000003@c.us", name: "Dhruv Rathi" }];
    expect(namedContact("Spots at 9 today. DM Dhruv")).toBe("Dhruv");
    expect(namedContact("DM me for spots")).toBeUndefined();
    expect(namedContact("DM for spots at UGC")).toBeUndefined();
    expect(resolveContact({ sender: { id: "x@c.us", name: "Admin" }, mentioned: [], text: "spots, DM Dhruv", directory })).toEqual({ id: "919800000003@c.us", name: "Dhruv Rathi", kind: "mentioned" });
    expect(resolveContact({ sender: { id: "x@c.us", name: "Admin" }, mentioned: [], text: "spots, DM Priya", directory })).toMatchObject({ kind: "sender" });
  });
  it("writes tagged names into the text", () => {
    expect(mentionsAsNames("Spots, PM @919800000002 now", [{ id: "919800000002@lid", name: "Akhil" }])).toBe("Spots, PM @Akhil now");
  });
});

describe("closures", () => {
  it("covers this week from today, contiguous days as one range", () => {
    expect(closureRanges("week", [3, 4, 5, 6], TODAY)).toEqual([{ from: "2026-10-28", until: "2026-10-31" }]);
    // Thursday: Wednesday has gone, so the closure starts today.
    expect(closureRanges("week", [3, 4, 5, 6], "2026-10-29")).toEqual([{ from: "2026-10-29", until: "2026-10-31" }]);
    expect(closureRanges("week", [], TODAY)).toEqual([{ from: TODAY, until: "2026-11-01" }]);
  });
  it("covers the next time a named day comes round", () => {
    expect(closureRanges("days", [0], TODAY)).toEqual([{ from: "2026-11-01", until: "2026-11-01" }]);
    expect(closureRanges("days", [2, 5], TODAY)).toEqual([{ from: TODAY, until: TODAY }, { from: "2026-10-30", until: "2026-10-30" }]);
    expect(closureRanges("today", [], TODAY)).toEqual([{ from: TODAY, until: TODAY }]);
    expect(closureRanges("none", [], TODAY)).toEqual([]);
    expect(closureRanges("next_week", [1, 2], TODAY)).toEqual([{ from: "2026-11-02", until: "2026-11-03" }]);
  });
  it("reads the scope from the words", () => {
    expect(parseClosureScope("Closed Thank you")).toEqual({ scope: "none", days: [] });
    expect(parseClosureScope("Spots full Square Sunday")).toEqual({ scope: "days", days: [0] });
    expect(parseClosureScope("Wednesday to Saturday spots are over for this week")).toEqual({ scope: "week", days: [3, 4, 5, 6] });
    expect(parseClosureScope("all full today")).toEqual({ scope: "today", days: [] });
  });
  it("closes the poster's latest open alert, or the one replied to", () => {
    const mk = (id: string, p: Partial<SpotAlert>): SpotAlert => ({ id, groupId: "g1@g.us", messageId: `msg-${id}`, poster: { id: "919800000001@c.us" }, date: TODAY, times: ["21:30"], contact: { id: "919800000001@c.us", kind: "sender" }, expiresAt: NOW + 3_600_000, status: "new", receivedAt: NOW - 600_000, ...p });
    const a = mk("a", { receivedAt: NOW - 900_000, roomId: "tag-koramangala" });
    const b = mk("b", { receivedAt: NOW - 300_000, roomId: "underground-comedy-club-koramangala" });
    const other = mk("c", { poster: { id: "919800000007@c.us" }, receivedAt: NOW - 60_000 });
    const q = { groupId: "g1@g.us", posterId: "919800000001@lid", now: NOW };
    expect(alertToClose([a, b, other], q)?.id).toBe("b");
    expect(alertToClose([a, b, other], { ...q, roomId: "tag-koramangala" })?.id).toBe("a");
    expect(alertToClose([a, b, other], { ...q, quotedMessageId: "msg-a" })?.id).toBe("a");
    expect(alertToClose([a, b, other], { ...q, posterId: "919800000055@c.us" })).toBeNull();
    expect(alertToClose([mk("d", { status: "dismissed" }), mk("e", { expiresAt: NOW - 1 })], q)).toBeNull();
    expect(alertToClose([a], { ...q, groupId: "other@g.us" })).toBeNull();
  });
  it("closes everyone's alerts for the room on the days covered", () => {
    const al = (id: string, date: string, roomId: string) => ({ id, groupId: "g", messageId: id, poster: { id: "p" }, roomId, date, times: [], contact: { id: "p", kind: "sender" as const }, expiresAt: NOW + 1e6, status: "new" as const, receivedAt: NOW });
    const hit = alertsClosedByRanges([al("1", "2026-10-29", "r"), al("2", "2026-11-02", "r"), al("3", "2026-10-29", "x")], "r", [{ from: "2026-10-28", until: "2026-10-31" }], NOW);
    expect(hit.map((a) => a.id)).toEqual(["1"]);
  });
  it("marks the show full for those dates, once", () => {
    const sq = BLR_ROSTER.rooms.find((r) => r.name === "Comedy Square")!;
    const ranges = [{ from: "2026-10-28", until: "2026-10-31" }];
    const closed = applyClosureToRoom(sq, ranges, { groupId: "g", messageId: "m", at: NOW });
    const show = closed.shows[0]!;
    expect(isFull(show, "2026-10-29")).toBe(true);
    expect(isFull(show, "2026-11-01")).toBe(false);
    expect(fullClosure(show, "2026-10-29")).toMatchObject({ source: "group_message", groupId: "g", messageId: "m" });
    expect(applyClosureToRoom(closed, ranges).shows[0]!.closures).toHaveLength(1);
    // the original isn't touched
    expect(sq.shows[0]!.closures).toBeUndefined();
  });
});

describe("curator schedule", () => {
  const post = "Comedy Square – Curation Schedule:\nMonday: @Vishal KG Comic BLR, Tuesday: @Varun Sachdev Comic BLR, Wednesday to Saturday: Akhil, Sunday: @Varun Sachdev Comic BLR";
  it("reads who curates which days", () => {
    expect(parseSchedule(post)).toEqual([
      { days: [1], people: ["Vishal KG"] },
      { days: [2], people: ["Varun Sachdev"] },
      { days: [3, 4, 5, 6], people: ["Akhil"] },
      { days: [0], people: ["Varun Sachdev"] },
    ]);
    expect(scheduleSummary(parseSchedule(post))).toBe("Mon Vishal KG, Tue Varun Sachdev, Wed to Sat Akhil, Sun Varun Sachdev");
    expect(parseSchedule("Spots at 7 today, DM")).toEqual([]);
    expect(parseSchedule("Fri: Akhil and Rahul")).toEqual([{ days: [5], people: ["Akhil", "Rahul"] }]);
  });
  it("matches people to curators already known", () => {
    expect(matchCurator(BLR_ROSTER.curators, "Vishal KG Comic BLR")?.name).toBe("Vishal KG");
    expect(matchCurator(BLR_ROSTER.curators, "Akhil")?.name).toBe("Akhil");
    expect(matchCurator(BLR_ROSTER.curators, "Somebody New")).toBeNull();
  });
  it("sets the curator per day, adds people it doesn't know, leaves the rest", () => {
    const { rooms, curators } = buildBlrRoster();
    const sq = rooms.find((r) => r.name === "Comedy Square")!;
    const entries = parseSchedule("Comedy Square Curation Schedule: Monday: Newbie Nair, Wednesday to Saturday: Akhil");
    const out = applyScheduleToRoom(sq, curators, entries);
    const days = out.room.shows[0]!.days;
    const nn = out.curators.find((c) => c.name === "Newbie Nair")!;
    expect(nn).toBeTruthy();
    expect(days.find((d) => d.weekday === 1)!.curatorIds).toEqual([nn.id]);
    expect(days.find((d) => d.weekday === 5)!.curatorIds).toEqual([out.curators.find((c) => c.name === "Akhil")!.id]);
    expect(days.find((d) => d.weekday === 2)!.curatorIds).toEqual(sq.shows[0]!.days.find((d) => d.weekday === 2)!.curatorIds);
    expect(out.changes.filter((c) => c.created)).toHaveLength(1);
    // pure: inputs unchanged
    expect(curators.some((c) => c.name === "Newbie Nair")).toBe(false);
  });
  it("reports a day the show doesn't run on", () => {
    const tag = BLR_ROSTER.rooms.find((r) => r.name === "Jagriti Theatre")!;
    const out = applyScheduleToRoom(tag, BLR_ROSTER.curators, [{ days: [1], people: ["Akhil"] }]);
    expect(out.changes[0]!.skipped).toMatch(/doesn't run/);
    expect(out.room.shows[0]!.days).toHaveLength(tag.shows[0]!.days.length);
  });
});

describe("the owner's group messages", () => {
  it("TAG: both times today, DM the sender; then 'Closed Thank you' closes it", () => {
    const o = offer(read("Spots available for both 9:30 and 11 pm today at TAG. DM"));
    expect(roomName(o.roomId)).toBe("TAG");
    expect(o).toMatchObject({ date: TODAY, times: ["21:30", "23:00"], busking: false, long: false, contact: { kind: "sender", name: "Dhruv" } });
    expect(o.showId).toBe("mic");
    const closed = read("Closed Thank you");
    expect(closed.kind).toBe("closure");
    if (closed.kind === "closure") expect(closed.closure).toMatchObject({ scope: "none", ranges: [] });
  });
  it("Comedy Theatre busking: reach by 5:40, the chain's two rooms aren't guessed", () => {
    const o = offer(read("Busking spot available at 6pm today at comedy theatre. DM if you can reach by 5.40pm."));
    expect(o).toMatchObject({ busking: true, times: ["18:00"], reachBy: "17:40", roomId: undefined, roomName: "Comedy Theatre" });
    expect(o.ambiguousRooms).toHaveLength(2);
  });
  it("Comedy Square closed for the rest of the week", () => {
    const r = read("Wednesday, Thursday, Friday, and Saturday spots are over for this week at Comedy Square.");
    expect(r.kind).toBe("closure");
    if (r.kind !== "closure") return;
    expect(roomName(r.closure.roomId)).toBe("Comedy Square");
    expect(r.closure).toMatchObject({ scope: "week", days: [3, 4, 5, 6], ranges: [{ from: "2026-10-28", until: "2026-10-31" }] });
  });
  it("UGC at 10.30, then 'Over, thanks!'", () => {
    const o = offer(read("One spot available at 10.30 at UGC today, DM"));
    expect(roomName(o.roomId)).toBe("Underground Comedy Club");
    expect(o.times).toEqual(["22:30"]);
    expect(read("Over, thanks!").kind).toBe("closure");
  });
  it("'Spots full Square Sunday' closes Comedy Square next Sunday", () => {
    const r = read("Spots full Square Sunday");
    expect(r.kind).toBe("closure");
    if (r.kind !== "closure") return;
    expect(roomName(r.closure.roomId)).toBe("Comedy Square");
    expect(r.closure.ranges).toEqual([{ from: "2026-11-01", until: "2026-11-01" }]);
  });
  it("Banter at 7 and 9", () => {
    const o = offer(read("Spots available at 7 and 9pm today at Banter comedy club. DM."));
    expect(roomName(o.roomId)).toBe("Banter Comedy Club");
    expect(o.times).toEqual(["19:00", "21:00"]);
  });
  it("DM for spots at UGC, no times", () => {
    const o = offer(read("DM for spots at UGC today : )"));
    expect(roomName(o.roomId)).toBe("Underground Comedy Club");
    expect(o.times).toEqual([]);
  });
  it("long spots, no room", () => {
    const o = offer(read("Long spots available. DM."));
    expect(o).toMatchObject({ long: true, times: [], roomId: undefined, roomName: undefined });
  });
  it("Ministry: spots open by 3:15, and the website is open", () => {
    const a = read("ministry spots will open by 3:15pm");
    expect(a.kind).toBe("opening_notice");
    if (a.kind === "opening_notice") {
      expect(roomName(a.opening.roomId)).toBe("Ministry of Comedy");
      expect(a.opening.openAt).toBe("15:15");
      expect(a.opening.summary).toBe("Ministry of Comedy: spots open by 3:15 PM");
    }
    const b = read("website is open for spots now. ministryofcomedy.in/mics");
    expect(b.kind).toBe("opening_notice");
    if (b.kind === "opening_notice") {
      expect(roomName(b.opening.roomId)).toBe("Ministry of Comedy");
      expect(b.opening.website).toBe(true);
    }
  });
  it("busking on Church Street, in 20 minutes", () => {
    const o = offer(read("One busking spot available at church street. DM if you can make it in 20 mins Max."));
    expect(o).toMatchObject({ busking: true, reachBy: "17:20", times: [] });
    expect(o.roomId).toBe("comedy-theatre-church-street");
  });
  it("the entertainment store isn't one of the comic's rooms, but the offer still counts", () => {
    const o = offer(read("Spots at the entertainment store: 3-5pm 5-7pm 7-9pm Dm me"));
    expect(o.roomId).toBeUndefined();
    expect(o.times).toEqual(["15:00", "17:00", "19:00"]);
    expect(o.contact.kind).toBe("sender");
  });
  it("the curation schedule post", () => {
    const r = read("Comedy Square – Curation Schedule:\nMonday: @Vishal KG Comic BLR, Tuesday: @Varun Sachdev Comic BLR, Wednesday to Saturday: Akhil, Sunday: @Varun Sachdev Comic BLR");
    expect(r.kind).toBe("schedule_update");
    if (r.kind !== "schedule_update") return;
    expect(roomName(r.schedule.roomId)).toBe("Comedy Square");
    expect(r.schedule.entries).toHaveLength(4);
  });
  it("tags the named person: PM @x", () => {
    const o = offer(read("Spot at TAG tonight at 9, PM @Akhil", { mentioned: [{ id: "919800000002@c.us", name: "Akhil" }] }));
    expect(o.contact).toEqual({ id: "919800000002@c.us", name: "Akhil", kind: "mentioned" });
  });
  it("chat that isn't any of this is dropped before and after the model", () => {
    for (const t of ["Anyone going to the show tonight?", "Great set last night!", "Thank you", "lol", "see you at 9"]) expect(worthReading(t) && heuristicRead(t).kind !== "other").toBe(false);
    // A model that says "offer" about a message with no spot in it is not believed.
    expect(interpret({ kind: "spot_offer" }, msg("Reach the venue by 6pm please"), ctx()).kind).toBe("other");
    expect(interpret({ kind: "closure" }, msg("Great set!"), ctx()).kind).toBe("other");
    expect(interpret({ kind: "schedule_update" }, msg("Spots at 7"), ctx()).kind).toBe("other");
  });
  it("uses the model's room name when the text alone is vague", () => {
    const m = msg("Spots tonight at 9. DM");
    const o = offer(interpret({ kind: "spot_offer", room: "The Local", contactKind: "sender" }, m, ctx()));
    expect(roomName(o.roomId)).toBe("The Local");
  });
});

describe("alerts", () => {
  const base = (p: Partial<SpotAlert> = {}): SpotAlert => ({
    id: "a1", groupId: "g", messageId: "m", poster: { id: "p", name: "Dhruv" }, roomId: "tag-koramangala", roomName: "TAG", date: TODAY, times: ["21:30", "23:00"],
    contact: { id: "p", name: "Dhruv Rathi", kind: "sender" }, expiresAt: NOW + 3_600_000, status: "new", receivedAt: NOW, ...p,
  });
  const spot = (p: Partial<MySpot>): MySpot => ({ id: "s", date: TODAY, source: "ask", createdAt: 0, ...p });

  it("expires at the reach-by time, else the last start, else the end of the day", () => {
    expect(alertExpiry({ date: TODAY, times: ["18:00"], reachBy: "17:40" }, TZ, NOW)).toBe(zonedToMs(TODAY, "17:40", TZ));
    expect(alertExpiry({ date: TODAY, times: ["21:30", "23:00"] }, TZ, NOW)).toBe(zonedToMs(TODAY, "23:00", TZ));
    expect(alertExpiry({ date: TODAY, times: [] }, TZ, NOW)).toBe(zonedToMs(TODAY, "23:59", TZ));
  });
  it("makes a stable id for a message", () => {
    expect(alertIdFor("120363@g.us", "false_120363@g.us_3EB0A/B_1@lid")).toBe("120363@g.us__false_120363@g.us_3EB0A_B_1@lid");
    expect(alertIdFor("g", "m")).toBe(alertIdFor("g", "m"));
  });
  it("says what the push says, with the first name", () => {
    expect(alertPush(base(), [], TODAY)).toEqual({ title: "Spot at TAG today 9:30 / 11 PM", body: "DM Dhruv" });
    expect(alertPush(base({ times: ["18:00"], reachBy: "17:40", busking: true, roomName: "Comedy Theatre" }), [], TODAY)).toEqual({ title: "Busking spot at Comedy Theatre today 6 PM", body: "DM Dhruv · reach by 5:40 PM" });
    expect(alertPush(base({ date: "2026-10-30" }), [], TODAY).title).toBe("Spot at TAG Fri 30 Oct 9:30 / 11 PM");
    expect(alertPush(base({ roomName: undefined, times: [] }), [], TODAY).title).toBe("Spot at a room today");
  });
  it("leaves clashing times out of the push", () => {
    expect(alertPush(base(), [spot({ time: "21:30", roomName: "Zostel" })], TODAY).title).toBe("Spot at TAG today 11 PM");
  });
  it("flags a clash only when every time clashes, and names the spot", () => {
    expect(clashNote(base(), [spot({ time: "21:00", roomName: "Zostel" })])).toBeNull();
    expect(clashNote(base({ times: ["21:30"] }), [spot({ time: "21:00", roomName: "Zostel" })])).toEqual({ with: "Zostel 9:00 PM", times: ["21:30"] });
    expect(clashNote(base({ times: ["21:30"] }), [spot({ time: "21:00", status: "cancelled" })])).toBeNull();
    expect(clashNote(base({ times: [] }), [spot({ time: "21:00" })])).toBeNull();
  });
  it("writes the ask", () => {
    expect(renderAlertAsk({ name: "Dhruv Rathi", time: "21:30", room: "TAG", day: "today" })).toBe("Hi Dhruv, I can do the 9:30 PM spot at TAG today!");
    expect(renderAlertAsk({ name: "", room: "TAG", day: "Fri 30 Oct" })).toBe("Hi there, I can do a spot at TAG on Fri 30 Oct!");
  });
  it("tells open from asked, closed and over, and counts the time left", () => {
    expect(alertState(base(), NOW)).toBe("open");
    expect(alertState(base({ status: "asked" }), NOW)).toBe("asked");
    expect(alertState(base({ status: "closed" }), NOW)).toBe("closed");
    expect(alertState(base({ status: "new", expiresAt: NOW - 1 }), NOW)).toBe("expired");
    expect(alertState(base({ status: "dismissed" }), NOW)).toBe("dismissed");
    expect(timeLeft(NOW + 34 * 60_000, NOW)).toBe("34 min left");
    expect(timeLeft(NOW + 90 * 60_000, NOW)).toBe("1 h 30 min left");
    expect(timeLeft(NOW - 1, NOW)).toBe("ended");
  });
  it("shortens times", () => {
    expect(timesShort(["21:30", "23:00"])).toBe("9:30 / 11 PM");
    expect(timesShort(["11:00", "21:00"])).toBe("11 AM / 9 PM");
    expect(timesShort(["15:00", "17:00", "19:00"])).toBe("3 / 5 / 7 PM");
  });
});
