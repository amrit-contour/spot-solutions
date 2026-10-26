import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASH_BUFFER_MIN, alertClash, askRuleFor, asksOpen, canMaintain, canPublish, clashes, curatorFor, fullClosure, isFull, isPaused, limitsBlock, newRoomId,
  nextAskWindow, pruneClosures, shareable, shareableRoster, showDates, slug,
  type AskRule, type MySpot, type Room, type Roster, type SpotAlert,
} from "./rooms.ts";
import { allChangeIds, applyMerge, diffRosters } from "./rosterMerge.ts";
import { CSV_COLUMNS, RosterFormatError, decodeRule, encodeRule, fromCsv, fromRosterJson, toCsv, toRosterJson, toRows } from "./rosterIO.ts";
import { BLR_ROSTER, buildBlrRoster } from "./fixtures/blrRooms.ts";

// 2026-10-26 is a Monday.
const TZ = "Asia/Kolkata";
const at = (iso: string) => new Date(`${iso}+05:30`); // a moment in IST
const NOW = at("2026-10-27T10:00:00"); // Tuesday morning

const blr = () => buildBlrRoster();
const find = (r: Roster, name: string, area?: string) => r.rooms.find((x) => x.name === name && (!area || x.area === area))!;
const room = (name: string, area?: string) => find(BLR_ROSTER, name, area);
const mic = (r: Room) => r.shows.find((s) => s.id === "mic")!;
const spot = (p: Partial<MySpot>): MySpot => ({ id: Math.random().toString(36).slice(2), date: "2026-10-26", source: "ask", createdAt: 0, ...p });

/** Same content, canonical order, so two rosters that differ only in array order compare equal. */
const canon = (r: Roster | ReturnType<typeof shareableRoster>) => {
  const s = shareableRoster(r);
  return {
    rooms: s.rooms.map((x) => ({ ...x, shows: [...x.shows].map((sh) => ({ ...sh, days: [...sh.days].sort((a, b) => a.weekday - b.weekday) })).sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.id.localeCompare(b.id)),
    curators: [...s.curators].sort((a, b) => a.id.localeCompare(b.id)),
  };
};

describe("ids", () => {
  it("slugs names and skips an area the name already has", () => {
    expect(slug("Glen's Bakehouse")).toBe("glen-s-bakehouse");
    expect(slug("Mic & Co")).toBe("mic-and-co");
    expect(newRoomId("Comedy Theatre", "Church Street")).toBe("comedy-theatre-church-street");
    expect(newRoomId("Bloom Indiranagar", "Indiranagar")).toBe("bloom-indiranagar");
  });
});

describe("the Bangalore seed", () => {
  it("has unique room ids, shows and curators that resolve", () => {
    const ids = BLR_ROSTER.rooms.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(BLR_ROSTER.curators.map((c) => c.id));
    for (const r of BLR_ROSTER.rooms) for (const s of r.shows) for (const d of s.days) for (const c of d.curatorIds) expect(known.has(c)).toBe(true);
  });
  it("two locations of one brand are two rooms", () => {
    const ct = BLR_ROSTER.rooms.filter((r) => r.brand === "Comedy Theatre");
    expect(ct.map((r) => r.area).sort()).toEqual(["Church Street", "Indiranagar"]);
    expect(BLR_ROSTER.rooms.filter((r) => r.brand === "Glen's Bakehouse").map((r) => r.area).sort()).toEqual(["Kalyan Nagar", "Koramangala"]);
    expect(BLR_ROSTER.rooms.filter((r) => r.brand === "Bloom")).toHaveLength(3);
  });
  it("keeps non-DM channels as notes and tags", () => {
    expect(room("Humble Pie").notes).toEqual([{ kind: "instagram", handle: "comedybandar" }]);
    expect(room("Ministry of Comedy").notes[0]).toMatchObject({ kind: "website", url: "https://ministryofcomedy.in/mics" });
    expect(mic(room("Jagriti Theatre")).askRule).toEqual({ kind: "walk_in" });
    expect(room("Cafe Muziris").tags).toContain("english-only");
  });
});

describe("nextAskWindow", () => {
  it("same day: the show day, relative to now", () => {
    const rule: AskRule = { kind: "same_day" };
    expect(nextAskWindow(rule, "2026-10-29", NOW, TZ)).toMatchObject({ kind: "ask", date: "2026-10-29", state: "upcoming", label: "Ping same day" });
    expect(nextAskWindow(rule, "2026-10-27", NOW, TZ)).toMatchObject({ date: "2026-10-27", state: "open" });
    expect(nextAskWindow(rule, "2026-10-26", NOW, TZ).state).toBe("passed");
  });
  it("day before, morning", () => {
    expect(nextAskWindow({ kind: "day_before", morning: true }, "2026-10-29", NOW, TZ)).toMatchObject({ date: "2026-10-28", morning: true, label: "Ping previous day morning" });
  });
  it("a weekday: the latest one on or before the show", () => {
    const rule: AskRule = { kind: "weekday", day: 1, morning: true };
    expect(nextAskWindow(rule, "2026-10-29", NOW, TZ)).toMatchObject({ date: "2026-10-26", label: "Ping Monday morning", state: "open" });
    expect(nextAskWindow(rule, "2026-11-01", NOW, TZ).date).toBe("2026-10-26"); // Sunday: same Monday-to-Sunday week
    expect(nextAskWindow(rule, "2026-10-26", NOW, TZ).date).toBe("2026-10-26");
    expect(nextAskWindow(rule, "2026-11-05", NOW, TZ)).toMatchObject({ date: "2026-11-02", state: "upcoming" });
  });
  it("start of week: Monday by default, or Sunday before the week", () => {
    expect(nextAskWindow({ kind: "start_of_week" }, "2026-10-29", NOW, TZ).date).toBe("2026-10-26");
    const sun: AskRule = { kind: "start_of_week", day: 0 };
    expect(nextAskWindow(sun, "2026-10-29", NOW, TZ)).toMatchObject({ date: "2026-10-25", state: "open" });
    expect(nextAskWindow(sun, "2026-11-01", NOW, TZ).date).toBe("2026-10-25");
    expect(nextAskWindow(sun, "2026-11-02", NOW, TZ)).toMatchObject({ date: "2026-11-01", state: "upcoming" });
    expect(nextAskWindow({ kind: "start_of_week", day: 3 }, "2026-10-27", NOW, TZ).date).toBe("2026-10-27"); // never after the show
  });
  it("start of month", () => {
    expect(nextAskWindow({ kind: "start_of_month" }, "2026-11-07", NOW, TZ)).toMatchObject({ date: "2026-11-01", state: "upcoming", label: "Ping at the start of the month" });
  });
  it("they reach out, notes and no rule are not pings", () => {
    expect(nextAskWindow({ kind: "they_reach_out" }, "2026-10-29", NOW, TZ)).toMatchObject({ kind: "wait", date: null });
    for (const kind of ["walk_in", "website", "instagram", "fcfs"] as const) expect(nextAskWindow({ kind }, "2026-10-29", NOW, TZ)).toMatchObject({ kind: "note", date: null });
    expect(nextAskWindow(undefined, "2026-10-29", NOW, TZ).kind).toBe("none");
  });
  it("uses the time zone for today", () => {
    const late = new Date("2026-10-26T20:00:00Z"); // 27 Oct 01:30 in Kolkata, still 26 Oct in UTC
    expect(nextAskWindow({ kind: "same_day" }, "2026-10-27", late, TZ).state).toBe("open");
    expect(nextAskWindow({ kind: "same_day" }, "2026-10-27", late, "UTC").state).toBe("upcoming");
  });
});

describe("showDates", () => {
  it("lists the days a show runs in a range", () => {
    expect(showDates(mic(room("Zostel")), "2026-10-26", "2026-11-08")).toEqual(["2026-11-01", "2026-11-08"]);
  });
  it("monthly shows can be the first or last weekday of the month", () => {
    const monthly = (monthlyWeeks: number[]) => ({ cadence: "monthly" as const, monthlyWeeks, days: [{ weekday: 6 as const, curatorIds: [] }] });
    expect(showDates(monthly([1]), "2026-10-01", "2026-10-31")).toEqual(["2026-10-03"]);
    expect(showDates(monthly([-1]), "2026-10-01", "2026-10-31")).toEqual(["2026-10-31"]);
    expect(showDates(monthly([]), "2026-10-01", "2026-10-31")).toHaveLength(5);
  });
  it("a day's own ask rule beats the show's", () => {
    const tag = mic(room("TAG"));
    expect(askRuleFor(tag, 1)).toEqual({ kind: "same_day" });
    expect(askRuleFor(tag, 6)).toMatchObject({ kind: "they_reach_out" });
  });
});

describe("asksOpen (the morning list)", () => {
  const range = { from: "2026-10-27", to: "2026-10-29" };
  const open = (rooms = BLR_ROSTER.rooms, ctx = {}) => asksOpen(rooms, range, NOW, TZ, ctx);
  const of = (list: ReturnType<typeof open>, name: string, area?: string) => list.filter((a) => a.roomId === room(name, area).id);

  it("lists same-day asks due today, and missed pings as overdue", () => {
    const list = open();
    expect(of(list, "TAG")).toEqual([expect.objectContaining({ showDate: "2026-10-27", due: "today", curatorIds: ["rohit"] })]); // the other days are not open yet
    expect(of(list, "Klayworkz").map((a) => [a.showDate, a.due])).toEqual([["2026-10-27", "overdue"], ["2026-10-28", "overdue"], ["2026-10-29", "overdue"]]);
  });
  it("only lists a window once it has opened", () => {
    const justBlr = of(open(), "Just BLR").map((a) => [a.showDate, a.due]);
    expect(justBlr).toEqual([["2026-10-27", "overdue"], ["2026-10-28", "today"]]); // Thursday's ping is tomorrow
  });
  it("skips they-reach-out, notes and shows with no rule", () => {
    const list = open();
    expect(of(list, "Ministry of Comedy")).toEqual([]);
    expect(of(list, "Jagriti Theatre")).toEqual([]);
    expect(of(list, "Comedy Square")).toEqual([]);
    expect(asksOpen([room("TAG")], { from: "2026-10-31", to: "2026-11-01" }, at("2026-10-31T09:00:00"), TZ)).toEqual([]); // weekend: Tarun reaches out
  });
  it("skips full and paused shows and dates already asked", () => {
    const kl = room("Klayworkz");
    const full: Room = { ...kl, shows: kl.shows.map((s) => ({ ...s, closures: [{ until: "2026-10-27", source: "group_message" }] })) };
    expect(of(open([full]), "Klayworkz").map((a) => a.showDate)).toEqual(["2026-10-28", "2026-10-29"]);
    expect(open([{ ...kl, pausedUntil: "2026-10-30" }])).toEqual([]);
    const asked = open([kl], { asks: [{ roomId: kl.id, showId: "mic", showDate: "2026-10-27", status: "sent" }, { roomId: kl.id, showId: "mic", showDate: "2026-10-28", status: "expired" }] });
    expect(asked.map((a) => a.showDate)).toEqual(["2026-10-28", "2026-10-29"]);
  });
  it("flags asks that are over a limit", () => {
    const reset = room("Cafe Reset");
    const spots = [spot({ roomId: reset.id, showId: "show", date: "2026-10-03" })];
    const list = asksOpen([reset], { from: "2026-10-30", to: "2026-10-30" }, NOW, TZ, { mySpots: spots });
    expect(list).toEqual([expect.objectContaining({ showDate: "2026-10-30", blocked: true })]);
    expect(asksOpen([reset], { from: "2026-10-30", to: "2026-10-30" }, NOW, TZ)[0]!.blocked).toBe(false);
  });
});

describe("limitsBlock", () => {
  const reset = room("Cafe Reset");
  const glens = room("Glen's Bakehouse", "Koramangala");
  const theatre = room("Comedy Theatre", "Church Street");

  it("1 a month: blocks a second one in the same month, not the next", () => {
    const spots = [spot({ roomId: reset.id, showId: "show", date: "2026-10-03" })];
    const r = limitsBlock(reset, spots, { date: "2026-10-30", showId: "show" });
    expect(r.blocked).toBe(true);
    expect(r.hits[0]).toMatchObject({ per: "month", max: 1, count: 1 });
    expect(limitsBlock(reset, spots, { date: "2026-11-01", showId: "show" }).blocked).toBe(false);
  });
  it("2 a week on one show: counted per Monday-to-Sunday week, only that show", () => {
    const spots = [spot({ roomId: glens.id, showId: "mic", date: "2026-10-26" }), spot({ roomId: glens.id, showId: "mic", date: "2026-10-28" })];
    expect(limitsBlock(glens, spots, { date: "2026-10-30", showId: "mic" })).toMatchObject({ blocked: true, hits: [{ per: "week", max: 2, count: 2 }] });
    expect(limitsBlock(glens, spots, { date: "2026-11-02", showId: "mic" }).blocked).toBe(false); // next week
    expect(limitsBlock(glens, spots, { date: "2026-10-31", showId: "show" }).blocked).toBe(false); // the monthly show has no limit
    expect(limitsBlock(glens, [spots[0]!], { date: "2026-10-30", showId: "mic" }).blocked).toBe(false);
  });
  it("2 a day at a multi-show room", () => {
    const spots = [spot({ roomId: theatre.id, date: "2026-10-30", time: "12:00" }), spot({ roomId: theatre.id, date: "2026-10-30", time: "18:00" })];
    expect(limitsBlock(theatre, spots, { date: "2026-10-30", showId: "mic" })).toMatchObject({ blocked: true, hits: [{ per: "day" }] });
    expect(limitsBlock(theatre, spots, { date: "2026-10-31", showId: "mic" }).blocked).toBe(false);
  });
  it("unlimited and no limits never block", () => {
    const justBlr = room("Just BLR");
    const lots = Array.from({ length: 9 }, () => spot({ roomId: justBlr.id, date: "2026-10-30" }));
    expect(limitsBlock(justBlr, lots, { date: "2026-10-30", showId: "mic" }).blocked).toBe(false);
    expect(limitsBlock(room("TAG"), lots, { date: "2026-10-30" }).blocked).toBe(false);
  });
  it("group offers and ad hoc spots ignore limits, and don't count towards them", () => {
    const spots = [spot({ roomId: reset.id, showId: "show", date: "2026-10-03" })];
    expect(limitsBlock(reset, spots, { date: "2026-10-30", showId: "show", source: "group_offer" }).blocked).toBe(false);
    expect(limitsBlock(reset, spots, { date: "2026-10-30", showId: "show", source: "adhoc" }).blocked).toBe(false);
    const adhoc = [spot({ roomId: reset.id, showId: "show", date: "2026-10-03", source: "adhoc" })];
    expect(limitsBlock(reset, adhoc, { date: "2026-10-30", showId: "show" }).blocked).toBe(false);
  });
  it("cancelled spots and spots that didn't happen don't count", () => {
    const gone = [spot({ roomId: reset.id, date: "2026-10-03", status: "cancelled" }), spot({ roomId: reset.id, date: "2026-10-10", happened: false })];
    expect(limitsBlock(reset, gone, { date: "2026-10-30", showId: "show" }).blocked).toBe(false);
  });
});

describe("clashes", () => {
  const booked = [spot({ date: "2026-10-26", time: "20:00" })];
  it("is a clash when closer than the buffer", () => {
    expect(clashes(booked, { date: "2026-10-26", time: "20:00" })).toHaveLength(1);
    expect(clashes(booked, { date: "2026-10-26", time: "21:29" })).toHaveLength(1);
    expect(clashes(booked, { date: "2026-10-26", time: "21:30" })).toEqual([]);
    expect(clashes(booked, { date: "2026-10-26", time: "18:31" })).toHaveLength(1);
    expect(clashes(booked, { date: "2026-10-26", time: "18:30" })).toEqual([]);
    expect(DEFAULT_CLASH_BUFFER_MIN).toBe(90);
  });
  it("takes the buffer as a parameter", () => {
    expect(clashes(booked, { date: "2026-10-26", time: "21:00" }, 30)).toEqual([]);
    expect(clashes(booked, { date: "2026-10-26", time: "20:25" }, 30)).toHaveLength(1);
  });
  it("works across midnight and ignores other days", () => {
    const late = [spot({ date: "2026-10-26", time: "23:30" })];
    expect(clashes(late, { date: "2026-10-27", time: "00:30" })).toHaveLength(1);
    expect(clashes(late, { date: "2026-10-27", time: "20:00" })).toEqual([]);
  });
  it("can't place a spot or candidate with no time, and skips cancelled or missed spots", () => {
    expect(clashes([spot({ date: "2026-10-26" })], { date: "2026-10-26", time: "20:00" })).toEqual([]);
    expect(clashes(booked, { date: "2026-10-26" })).toEqual([]);
    expect(clashes([spot({ date: "2026-10-26", time: "20:00", status: "cancelled" }), spot({ date: "2026-10-26", time: "20:00", happened: false })], { date: "2026-10-26", time: "20:00" })).toEqual([]);
  });
  it("an alert clashes only if every time it offers does", () => {
    const alert = (times: string[]): Pick<SpotAlert, "date" | "times"> => ({ date: "2026-10-26", times });
    expect(alertClash(alert(["19:00", "21:00"]), booked)).toEqual({ clash: true, clashing: ["19:00", "21:00"], free: [] });
    expect(alertClash(alert(["18:00", "21:00"]), booked)).toMatchObject({ clash: false, clashing: ["21:00"], free: ["18:00"] });
    expect(alertClash(alert([]), booked).clash).toBe(false);
  });
});

describe("curatorFor", () => {
  const who = (name: string, wd: 0 | 1 | 2 | 3 | 4 | 5 | 6, on?: string) => curatorFor(find(BLR_ROSTER, name).shows[0]!, wd, BLR_ROSTER.curators, on);
  it("a curator per day (Comedy Square)", () => {
    expect(who("Comedy Square", 1).primary?.name).toBe("Vishal KG");
    expect(who("Comedy Square", 2).primary?.name).toBe("Varun Sachdev");
    expect(who("Comedy Square", 4).primary?.name).toBe("Akhil");
    expect(who("Comedy Square", 0).primary?.name).toBe("Varun Sachdev");
    expect(who("Comedy Square", 1).theyReachOut).toBe(false);
  });
  it("they reach out: with a curator (TAG weekends) or without (UGC Fri-Sun)", () => {
    expect(who("TAG", 6)).toMatchObject({ primary: { name: "Tarun" }, theyReachOut: true });
    expect(who("Underground Comedy Club", 5)).toMatchObject({ primary: null, theyReachOut: true });
  });
  it("co-curators", () => {
    const r = who("Bloom HSR", 5);
    expect(r.primary?.name).toBe("Sharan");
    expect(r.others.map((c) => c.name)).toEqual(["Minahaj"]);
  });
  it("a day with no plan has nobody", () => {
    expect(who("Comedy Square", 3 as const).primary?.name).toBe("Akhil");
    expect(curatorFor({ days: [] }, 1, BLR_ROSTER.curators)).toMatchObject({ primary: null, others: [], theyReachOut: false });
  });
  it("a stand-in takes over until their date", () => {
    const sq = find(BLR_ROSTER, "Comedy Square").shows[0]!;
    const show = { ...sq, days: sq.days.map((d) => (d.weekday === 1 ? { ...d, standIn: { curatorId: "akhil", until: "2026-11-01" } } : d)) };
    const at30 = curatorFor(show, 1, BLR_ROSTER.curators, "2026-10-26");
    expect(at30).toMatchObject({ primary: { name: "Akhil" }, standInActive: true });
    expect(at30.others.map((c) => c.name)).toEqual(["Vishal KG"]);
    expect(curatorFor(show, 1, BLR_ROSTER.curators, "2026-11-02").primary?.name).toBe("Vishal KG");
    expect(curatorFor(show, 1, BLR_ROSTER.curators).standInActive).toBe(false);
  });
});

describe("closures and pauses", () => {
  it("isFull covers from..until inclusive, from now when no start", () => {
    const show = { closures: [{ until: "2026-10-29", source: "group_message" as const }, { from: "2026-11-05", until: "2026-11-06", source: "manual" as const }] };
    expect(isFull(show, "2026-10-27")).toBe(true);
    expect(isFull(show, "2026-10-29")).toBe(true);
    expect(isFull(show, "2026-10-30")).toBe(false);
    expect(isFull(show, "2026-11-05")).toBe(true);
    expect(isFull(show, "2026-11-07")).toBe(false);
    expect(isFull({}, "2026-10-27")).toBe(false);
    expect(fullClosure(show, "2026-11-06")?.source).toBe("manual");
  });
  it("prunes closures that are over", () => {
    const s = { ...mic(room("TAG")), closures: [{ until: "2026-10-20", source: "manual" as const }] };
    expect(pruneClosures(s, "2026-10-27").closures).toBeUndefined();
    expect(pruneClosures({ ...s, closures: [{ until: "2026-10-27", source: "manual" }] }, "2026-10-27").closures).toHaveLength(1);
  });
  it("a seasonal break on the room or the show", () => {
    expect(isPaused({ pausedUntil: "2026-12-01" }, {}, "2026-11-30")).toBe(true);
    expect(isPaused({}, { pausedUntil: "2026-12-01" }, "2026-12-02")).toBe(false);
    expect(isPaused({}, {}, "2026-12-02")).toBe(false);
  });
});

describe("publishing rights", () => {
  it("the admin or a listed publisher can publish; the owner and co-maintainers can maintain", () => {
    expect(canPublish("a", [], true)).toBe(true);
    expect(canPublish("a", [{ uid: "a", addedBy: "x", addedAt: 0 }], false)).toBe(true);
    expect(canPublish("a", [{ uid: "b", addedBy: "x", addedAt: 0 }], false)).toBe(false);
    expect(canMaintain({ ownerUid: "o", coMaintainers: ["c"] }, "c")).toBe(true);
    expect(canMaintain({ ownerUid: "o", coMaintainers: ["c"] }, "z")).toBe(false);
  });
});

describe("shareable", () => {
  const dirty = () => {
    const r = blr();
    const bloom = find(r, "Bloom Indiranagar");
    const s = mic(bloom);
    s.closures = [{ until: "2026-11-01", source: "group_message" }];
    s.pausedUntil = "2026-12-01";
    s.myNotes = "private show note";
    s.days[0]!.standIn = { curatorId: "sharan", until: "2026-11-01" };
    (s as unknown as Record<string, unknown>).secret = "future private field";
    bloom.pausedUntil = "2026-12-01";
    r.curators.find((c) => c.id === "sharan")!.notes = "owes me a favour";
    r.curators.find((c) => c.id === "sharan")!.comicId = "comic-1";
    return r;
  };
  it("strips my role, notes, closures, pauses and stand-ins, and keeps what describes the room", () => {
    const r = dirty();
    const out = shareable(find(r, "Bloom Indiranagar"));
    const text = JSON.stringify(out);
    for (const secret of ["Good sound", "private show note", "future private field", "myRole", "closures", "pausedUntil", "standIn", "myNotes"]) expect(text).not.toContain(secret);
    expect(out.shows[0]!.days.map((d) => d.weekday)).toEqual(find(r, "Bloom Indiranagar").shows[0]!.days.map((d) => d.weekday));
    expect(out.brand).toBe("Bloom");
    expect(shareable(find(r, "Cafe Reset")).limits).toEqual([{ scope: "room", perMonth: 1 }]);
    const roster = JSON.stringify(shareableRoster(r));
    expect(roster).not.toContain("owes me a favour");
    expect(roster).not.toContain("comic-1");
    expect(roster).toContain("Sharan");
  });
  it("doesn't change what it was given", () => {
    const r = dirty();
    shareableRoster(r);
    expect(find(r, "Bloom Indiranagar").myNotes).toBe("Good sound, tough crowd on Thursdays.");
    expect(mic(find(r, "Bloom Indiranagar")).myRole).toBe("curator");
  });
  it("only keeps curators the rooms use", () => {
    const r = blr();
    r.curators.push({ id: "nobody", name: "Nobody", phone: "1" });
    expect(shareableRoster(r).curators.map((c) => c.id)).not.toContain("nobody");
  });
});

describe("diffRosters and applyMerge", () => {
  /** A published roster that differs from BLR in a handful of ways. */
  const published = () => {
    const p = shareableRoster(blr());
    const tag = p.rooms.find((r) => r.name === "TAG")!;
    tag.shows[0]!.times = ["21:00", "23:30"]; // changed field
    const zostel = p.rooms.find((r) => r.name === "Zostel")!;
    zostel.shows[0]!.askRule = { kind: "same_day" }; // morning dropped
    const kl = p.rooms.find((r) => r.name === "Klayworkz")!;
    kl.shows[0]!.days = kl.shows[0]!.days.filter((d) => d.weekday !== 4); // Thursday gone
    const sq = p.rooms.find((r) => r.name === "Comedy Square")!;
    sq.shows[0]!.days.find((d) => d.weekday === 1)!.curatorIds = ["dhruv"]; // Monday: a curator that mine has under TAG
    p.rooms = p.rooms.filter((r) => r.name !== "Laugh Junction"); // missing from the published one
    p.rooms.push({ id: "new-mic", name: "New Mic", area: "Indiranagar", city: "Bengaluru", aliases: [], tags: [], notes: [], limits: [], shows: [{ id: "mic", name: "Mic", type: "mic", cadence: "weekly", times: ["20:00"], days: [{ weekday: 2, curatorIds: ["newbie"] }] }] });
    p.curators.push({ id: "newbie", name: "Newbie", phone: "+91 90000 00099" });
    p.curators.find((c) => c.id === "tarun")!.phone = "+91 90000 11111"; // changed number
    return p;
  };

  it("nothing differs from itself, nor when ids differ but names match", () => {
    expect(diffRosters(blr(), shareableRoster(blr()))).toEqual([]);
    const renamed = shareableRoster(blr());
    const cmap = new Map(renamed.curators.map((c) => [c.id, `c-${c.id}`]));
    renamed.curators = renamed.curators.map((c) => ({ ...c, id: cmap.get(c.id)! }));
    renamed.rooms = renamed.rooms.map((r) => ({
      ...r, id: `x-${r.id}`,
      limits: r.limits.map((l) => (l.showId ? { ...l, showId: `x-${l.showId}` } : l)),
      shows: r.shows.map((s) => ({ ...s, id: `x-${s.id}`, days: s.days.map((d) => ({ ...d, curatorIds: d.curatorIds.map((c) => cmap.get(c)!) })) })),
    }));
    expect(diffRosters(blr(), renamed)).toEqual([]);
  });

  it("lists added, changed and removed per room, show and field", () => {
    const changes = diffRosters(blr(), published());
    const by = (id: string) => changes.find((c) => c.id === id);
    expect(by("room:new-mic|indiranagar")).toMatchObject({ op: "added", level: "room", label: "New Mic" });
    expect(by("room:laugh-junction|hsr-layout")).toMatchObject({ op: "removed", level: "room" });
    expect(by("show:tag|koramangala/mic#times")).toMatchObject({ op: "changed", level: "show", field: "times", before: ["21:30", "23:00"], after: ["21:00", "23:30"] });
    expect(by("show:zostel|koramangala/mic#askRule")).toMatchObject({ op: "changed", before: { kind: "same_day", morning: true }, after: { kind: "same_day" } });
    expect(by("show:klayworkz|jp-nagar/mic#days.4")).toMatchObject({ op: "removed", field: "days.4", label: "Klayworkz · Mic · Thu" });
    expect(by("show:comedy-square|hsr-layout/mic#days.1")).toMatchObject({ op: "changed", before: { curators: ["Vishal KG"] }, after: { curators: ["Dhruv"] } });
    expect(by("curator:tarun#phone")).toMatchObject({ op: "changed", level: "curator", after: "+91 90000 11111" });
    expect(changes).toHaveLength(7);
    expect(diffRosters(blr(), published()).map((c) => c.id)).toEqual(changes.map((c) => c.id)); // stable
  });

  it("takes only the picked changes", () => {
    const mine = blr();
    const out = applyMerge(mine, published(), ["show:tag|koramangala/mic#times", "show:klayworkz|jp-nagar/mic#days.4"]);
    expect(mic(find(out, "TAG")).times).toEqual(["21:00", "23:30"]);
    expect(mic(find(out, "Klayworkz")).days.map((d) => d.weekday)).toEqual([2, 3]);
    expect(mic(find(out, "Zostel")).askRule).toEqual({ kind: "same_day", morning: true }); // not picked
    expect(find(out, "Laugh Junction")).toBeDefined();
    expect(out.rooms.find((r) => r.name === "New Mic")).toBeUndefined();
    expect(mic(find(mine, "TAG")).times).toEqual(["21:30", "23:00"]); // input untouched
  });

  it("adds a new room with its curators, and removes a missing one", () => {
    const out = applyMerge(blr(), published(), ["room:new-mic|indiranagar", "room:laugh-junction|hsr-layout"]);
    const added = find(out, "New Mic");
    expect(added.shows[0]!.days[0]!.curatorIds).toEqual(["newbie"]);
    expect(out.curators.find((c) => c.id === "newbie")?.phone).toBe("+91 90000 00099");
    expect(out.rooms.find((r) => r.name === "Laugh Junction")).toBeUndefined();
  });

  it("a day change maps published curators onto mine, adding one I don't have", () => {
    const p = published();
    p.rooms.find((r) => r.name === "Comedy Square")!.shows[0]!.days.find((d) => d.weekday === 1)!.curatorIds = ["brand-new"];
    p.curators.push({ id: "brand-new", name: "Brand New" });
    const out = applyMerge(blr(), p, ["show:comedy-square|hsr-layout/mic#days.1"]);
    const day = mic(find(out, "Comedy Square")).days.find((d) => d.weekday === 1)!;
    expect(day.curatorIds).toEqual(["brand-new"]);
    expect(out.curators.map((c) => c.id)).toContain("brand-new");
  });

  it("never touches my private data, and a published curator without a number doesn't wipe mine", () => {
    const mine = blr();
    const p = published();
    p.rooms.find((r) => r.name === "Bloom Indiranagar")!.tags = ["new-comics"];
    p.curators.find((c) => c.id === "akhil")!.phone = undefined;
    const changes = diffRosters(mine, p);
    expect(changes.find((c) => c.id === "curator:akhil#phone")).toBeUndefined();
    const out = applyMerge(mine, p, allChangeIds(changes));
    const bloom = find(out, "Bloom Indiranagar");
    expect(bloom.tags).toEqual(["new-comics"]);
    expect(bloom.myNotes).toBe("Good sound, tough crowd on Thursdays.");
    expect(mic(bloom).myRole).toBe("curator");
    expect(out.curators.find((c) => c.id === "akhil")?.phone).toBe("+91 90000 00003");
  });

  it("replace all makes my shareable roster the published one", () => {
    const mine = blr();
    const p = published();
    const out = applyMerge(mine, p, allChangeIds(diffRosters(mine, p)));
    expect(canon(out)).toEqual(canon(p));
    expect(diffRosters(out, p)).toEqual([]);
  });

  it("changed limits keep pointing at the right show", () => {
    const mine = blr();
    const p = shareableRoster(blr());
    const g = p.rooms.find((r) => r.name === "Glen's Bakehouse" && r.area === "Koramangala")!;
    g.limits = [{ scope: "show", showId: "mic", perWeek: 3 }];
    const changes = diffRosters(mine, p);
    expect(changes.map((c) => c.id)).toEqual(["room:glen-s-bakehouse|koramangala#limits"]);
    const out = applyMerge(mine, p, allChangeIds(changes));
    expect(find(out, "Glen's Bakehouse", "Koramangala").limits).toEqual([{ scope: "show", showId: "mic", perWeek: 3 }]);
  });
});

describe("export and import", () => {
  const priv = blr;
  it("JSON round-trips the shareable roster and says its version", () => {
    const text = toRosterJson(BLR_ROSTER, { title: "Bangalore Scene", city: "Bengaluru", exportedAt: 1 });
    expect(JSON.parse(text)).toMatchObject({ format: "nbc-roster", version: 1, title: "Bangalore Scene" });
    const { roster, meta } = fromRosterJson(text);
    expect(meta).toMatchObject({ title: "Bangalore Scene", city: "Bengaluru", exportedAt: 1, version: 1 });
    expect(canon(roster)).toEqual(canon(BLR_ROSTER));
  });
  it("an export leaves out private fields; a full backup keeps them", () => {
    expect(toRosterJson(priv())).not.toContain("Good sound");
    expect(toRosterJson(priv())).not.toContain("myRole");
    const back = fromRosterJson(toRosterJson(priv(), { full: true })).roster;
    expect(find(back, "Bloom Indiranagar").myNotes).toContain("Good sound");
    expect(mic(find(back, "Bloom Indiranagar")).myRole).toBe("curator");
  });
  it("refuses what it can't read", () => {
    expect(() => fromRosterJson("nope")).toThrow(RosterFormatError);
    expect(() => fromRosterJson(JSON.stringify({ rooms: [] }))).toThrow(/isn't a Nothing BOT roster/);
    expect(() => fromRosterJson(JSON.stringify({ format: "nbc-roster", version: 2, rooms: [] }))).toThrow(/newer app/);
    expect(() => fromRosterJson(JSON.stringify({ format: "nbc-roster", version: 1, rooms: [{ name: "x" }] }))).toThrow(/missing its id/);
  });
  it("drops what it doesn't know, and bad rules", () => {
    const text = JSON.stringify({ format: "nbc-roster", version: 1, rooms: [{ id: "a", name: "A", evil: 1, shows: [{ id: "m", name: "Mic", times: ["20:00"], days: [{ weekday: 9, curatorIds: [] }, { weekday: 2, curatorIds: [], askRule: { kind: "nonsense" } }] }] }], curators: [] });
    const r = fromRosterJson(text).roster;
    expect(JSON.stringify(r)).not.toContain("evil");
    expect(r.rooms[0]!.shows[0]!.days).toEqual([{ weekday: 2, curatorIds: [] }]);
  });

  it("ask rules encode and decode", () => {
    const rules: AskRule[] = [
      { kind: "same_day" }, { kind: "same_day", morning: true }, { kind: "day_before", morning: true }, { kind: "weekday", day: 1, morning: true }, { kind: "weekday", day: 0 },
      { kind: "start_of_week" }, { kind: "start_of_week", day: 0 }, { kind: "start_of_month" }, { kind: "they_reach_out", note: "Tarun | himself" }, { kind: "walk_in" },
      { kind: "website", note: "register at x.in" }, { kind: "instagram" }, { kind: "fcfs" },
    ];
    for (const r of rules) expect(decodeRule(encodeRule(r))).toEqual(r);
    expect(encodeRule({ kind: "weekday", day: 1, morning: true })).toBe("weekday mon morning");
    expect(decodeRule("")).toBeUndefined();
    expect(decodeRule("weekday")).toBeUndefined();
  });

  it("CSV: one row per show-day, and it round-trips", () => {
    const rows = toRows(BLR_ROSTER);
    const dayRows = BLR_ROSTER.rooms.flatMap((r) => r.shows.flatMap((s) => (s.days.length ? s.days : [null])));
    expect(rows).toHaveLength(dayRows.length);
    const tagSat = rows.find((r) => r.room === "TAG" && r.day === "Sat")!;
    expect(tagSat).toMatchObject({ curators: "Tarun", they_reach_out: "yes", curator_phones: "+91 90000 00001", ask_rule: "they_reach_out | Tarun himself will reach out" });
    const text = toCsv(BLR_ROSTER);
    expect(text.split("\n")[0]).toBe(CSV_COLUMNS.join(","));
    expect(canon(fromCsv(text))).toEqual(canon(BLR_ROSTER));
  });
  it("CSV handles quotes, commas, newlines, CRLF and a BOM", () => {
    const r: Roster = {
      rooms: [{ id: "r", name: 'The "Odd", Room', area: "A", city: "C", aliases: ["x, y"], tags: ["t"], notes: [{ kind: "other", text: 'line1\nline2, "q"' }], limits: [{ scope: "room", perWeek: 2 }], shows: [{ id: "m", name: "Mic", type: "mic", cadence: "weekly", times: ["20:00"], days: [{ weekday: 1, curatorIds: ["a-b"], note: "note, with comma" }] }] }],
      curators: [{ id: "a-b", name: "A B", phone: "+91 1" }],
    };
    expect(canon(fromCsv(toCsv(r)))).toEqual(canon(r));
    expect(canon(fromCsv("﻿" + toCsv(r).replace(/\n/g, "\r\n")))).toEqual(canon(r));
  });
  it("CSV from a hand-made sheet: headers by name, ids made up, rooms and shows grouped", () => {
    const csv = ["Room,Area,City,Show,Day,Times,Curators,Ask rule", "Bloom,HSR,Bengaluru,Mic,Fri,20:00; 22:00,Sharan,weekday mon morning", "Bloom,HSR,Bengaluru,Mic,Sat,20:30,Sharan; Minahaj,", ",,,,,,,"].join("\r\n");
    const r = fromCsv(csv);
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]).toMatchObject({ id: "bloom-hsr", name: "Bloom" });
    const m = r.rooms[0]!.shows[0]!;
    expect(m.days.map((d) => [d.weekday, d.times, d.curatorIds])).toEqual([[5, ["20:00", "22:00"], ["sharan"]], [6, ["20:30"], ["sharan", "minahaj"]]]);
    expect(m.days[0]!.askRule).toEqual({ kind: "weekday", day: 1, morning: true });
    expect(r.curators.map((c) => c.name)).toEqual(["Sharan", "Minahaj"]);
    expect(() => fromCsv("Name,Area\nx,y")).toThrow(RosterFormatError);
  });
  it("rooms with no shows and shows with no days survive the CSV", () => {
    const r: Roster = {
      rooms: [
        { id: "empty", name: "Empty", area: "A", city: "C", aliases: [], tags: [], notes: [], limits: [], shows: [] },
        { id: "nodays", name: "No Days", area: "A", city: "C", aliases: [], tags: [], notes: [], limits: [], shows: [{ id: "show", name: "Show", type: "show", cadence: "monthly", monthlyWeeks: [1, -1], times: ["19:00"], days: [], tags: ["check-bms"] }] },
      ],
      curators: [],
    };
    expect(canon(fromCsv(toCsv(r)))).toEqual(canon(r));
  });
});
