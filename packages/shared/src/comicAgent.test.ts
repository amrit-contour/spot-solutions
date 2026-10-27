import { describe, expect, it } from "vitest";
import {
  applyRoomEdit, comicAskText, executeComic, needsConfirm, normalizeComicIntent, parseAskRuleWords, parseComicIntentByRules, parseDateWords, parseDayWord, pickCurator, planComic, spotCountText, stepComicPending,
  type ComicIntent, type ComicPending, type ComicPlan, type ComicPlanned, type ComicWorld,
} from "./comicAgent.ts";
import { BLR_ROSTER, buildBlrRoster } from "./fixtures/blrRooms.ts";
import { zonedToMs } from "./groupAlerts.ts";
import type { Ask, MySpot, SpotAlert } from "./rooms.ts";

const TZ = "Asia/Kolkata";
const TODAY = "2026-10-27"; // Tuesday
const NOW = zonedToMs(TODAY, "17:00", TZ);

const world = (o: Partial<ComicWorld> = {}): ComicWorld => {
  const r = buildBlrRoster();
  return { rooms: r.rooms, curators: r.curators, asks: [], spots: [], alerts: [], today: TODAY, nowMs: NOW, tz: TZ, auto: false, ...o };
};
const parse = (text: string) => parseComicIntentByRules(text, { today: TODAY, nowHHMM: "17:00" });
const plan = (text: string, w = world()): ComicPlanned => {
  const i = parse(text);
  if (!i) throw new Error(`rules didn't read: ${text}`);
  return planComic(i, w);
};
const planOf = (p: ComicPlanned): ComicPlan => {
  const pl = p.run ?? (p.pending?.stage === "confirm" ? p.pending.plan : undefined);
  if (!pl) throw new Error(`no plan: ${JSON.stringify(p)}`);
  return pl;
};
const spot = (o: Partial<MySpot>): MySpot => ({ id: "s", date: TODAY, source: "adhoc", happened: null, status: "booked", createdAt: 0, ...o });
const alert = (o: Partial<SpotAlert> = {}): SpotAlert => ({
  id: "a1", groupId: "g", messageId: "m", poster: { id: "p@c.us", name: "Dhruv" }, roomName: "Banter Comedy Club", date: TODAY, times: ["21:00"], contact: { id: "919800000001@c.us", name: "Dhruv", kind: "sender" },
  expiresAt: NOW + 3_600_000, status: "new", receivedAt: NOW, ...o,
});

describe("dates and words", () => {
  it("reads date words and rolls a past date to next year", () => {
    expect(parseDateWords("till Nov 10", TODAY)).toBe("2026-11-10");
    expect(parseDateWords("10th november", TODAY)).toBe("2026-11-10");
    expect(parseDateWords("until Oct 1", TODAY)).toBe("2027-10-01");
    expect(parseDateWords("on 2026-12-01", TODAY)).toBe("2026-12-01");
    expect(parseDateWords("nothing", TODAY)).toBeUndefined();
  });
  it("reads day words, looking back for a question about the past", () => {
    expect(parseDayWord("yesterday", TODAY)).toBe("2026-10-26");
    expect(parseDayWord("tonight", TODAY)).toBe("2026-10-27");
    expect(parseDayWord("monday", TODAY)).toBe("2026-11-02");
    expect(parseDayWord("monday", TODAY, true)).toBe("2026-10-26");
  });
  it("reads ask rules", () => {
    expect(parseAskRuleWords("on Mondays now")).toEqual({ kind: "weekday", day: 1 });
    expect(parseAskRuleWords("the day before in the morning")).toEqual({ kind: "day_before", morning: true });
    expect(parseAskRuleWords("same day")).toEqual({ kind: "same_day" });
    expect(parseAskRuleWords("the start of the month")).toEqual({ kind: "start_of_month" });
    expect(parseAskRuleWords("banana")).toBeUndefined();
  });
});

describe("parseComicIntentByRules", () => {
  const name = (s: string) => parse(s)?.name;
  it("reads the roster phrases", () => {
    expect(parse("update TAG Monday to Dhruv")).toMatchObject({ name: "set_curator", room: "TAG", days: [1], person: "Dhruv" });
    expect(parse("Comedy Square closed this week")).toMatchObject({ name: "close_room", room: "comedy square", scope: "week" });
    expect(parse("pause Bloom till Nov 10")).toMatchObject({ name: "pause_room", room: "bloom", until: "2026-11-10" });
    expect(parse("add a 9:30 slot at Banter on Fridays")).toMatchObject({ name: "add_slot", time: "21:30", room: "banter", days: [5] });
    expect(parse("Humble Pie asks on Mondays now")).toMatchObject({ name: "set_ask_rule", room: "Humble Pie", rule: { kind: "weekday", day: 1 } });
    expect(parse("add Dhruv's number 9811122233")).toMatchObject({ name: "set_curator_phone", person: "Dhruv", phone: "9811122233" });
    expect(parse("I'm a regular at Bloom Monday")).toMatchObject({ name: "set_role", role: "regular", room: "bloom", days: [1] });
    expect(parse("resume Bloom")).toMatchObject({ name: "pause_room", resume: true });
  });
  it("reads spots and questions", () => {
    expect(parse("I got a spot at Banter tonight 9pm")).toMatchObject({ name: "add_spot", room: "banter", date: TODAY, time: "21:00" });
    expect(parse("add regular Monday 9 PM at Bloom")).toMatchObject({ name: "add_regular", days: [1], time: "21:00" });
    expect(parse("did I do a mic yesterday?")).toMatchObject({ name: "spots_on_day", date: "2026-10-26" });
    expect(parse("how many spots this month?")).toMatchObject({ name: "spot_count", range: "month" });
    expect(parse("how many spots did I do last month")).toMatchObject({ name: "spot_count", range: "last_month" });
  });
  it("reads asks and alerts", () => {
    expect(parse("ask TAG for Monday")).toMatchObject({ name: "ask_room", room: "tag", date: "2026-11-02" });
    expect(name("what asks are open today?")).toBe("open_asks");
    expect(parse("skip Banter this week")).toMatchObject({ name: "skip_ask", room: "banter", scope: "week" });
    expect(name("any open spots now?")).toBe("open_alerts");
    expect(name("ask for it")).toBe("ask_alert");
    expect(name("help")).toBe("help");
  });
  it("leaves the rest to the model", () => {
    expect(parse("what's the weather")).toBeNull();
    expect(parse("tag was fun last night")).toBeNull();
  });
});

describe("normalizeComicIntent (the model's output)", () => {
  it("checks every field", () => {
    const i = normalizeComicIntent({ name: "set_curator", room: "TAG", days: "monday, Friday", person: "Dhruv", date: "next banana", time: "9pm", rule_kind: "weekday", rule_day: "mon" }, "x", TODAY);
    expect(i).toMatchObject({ name: "set_curator", room: "TAG", days: [1, 5], person: "Dhruv", time: "21:00", rule: { kind: "weekday", day: 1 } });
    expect(i.date).toBeUndefined(); // an unreadable date is dropped, never guessed
  });
  it("turns junk into unknown", () => {
    expect(normalizeComicIntent("not json", "x", TODAY).name).toBe("unknown");
    expect(normalizeComicIntent({ name: "delete_everything" }, "x", TODAY).name).toBe("unknown");
    expect(normalizeComicIntent('Sure! {"name":"help"}', "x", TODAY).name).toBe("help");
  });
});

describe("curators", () => {
  const w = world();
  it("finds one by first name, asks when two fit, makes a new one otherwise", () => {
    expect(pickCurator(w.curators, "Dhruv")).toMatchObject({ kind: "ok" });
    expect(pickCurator(w.curators, "Aditya").kind).toBe("many"); // Aditya Natrajan and Aditya Ojha
    expect(pickCurator(w.curators, "Zubin").kind).toBe("new");
  });
});

describe("room edits", () => {
  it("sets a curator and adds a new one without a number", () => {
    const w = world();
    const room = w.rooms.find((r) => r.name === "TAG")!;
    const r = applyRoomEdit(room, w.curators, { kind: "set_curator", showId: "mic", weekdays: [1], curatorName: "Zubin Shah" }, NOW);
    expect(r.ok && r.curators.some((c) => c.name === "Zubin Shah" && !c.phone)).toBe(true);
    expect(r.ok && r.done).toContain("new, no number");
  });
  it("closes, pauses and resumes", () => {
    const w = world();
    const room = w.rooms.find((r) => r.name === "Comedy Square")!;
    const c = applyRoomEdit(room, w.curators, { kind: "close", ranges: [{ from: "2026-10-27", until: "2026-11-01" }] }, NOW);
    expect(c.ok && c.room.shows[0]!.closures?.length).toBe(1);
    const p = applyRoomEdit(room, w.curators, { kind: "pause", until: "2026-11-10" }, NOW);
    expect(p.ok && p.room.pausedUntil).toBe("2026-11-10");
    const back = applyRoomEdit(p.ok ? p.room : room, w.curators, { kind: "pause", until: null }, NOW);
    expect(back.ok && back.room.pausedUntil).toBeUndefined();
  });
  it("adds a slot only where it is missing", () => {
    const w = world();
    const room = w.rooms.find((r) => r.name === "Banter Comedy Club")!;
    const r = applyRoomEdit(room, w.curators, { kind: "add_slot", showId: "mic", weekdays: [5], time: "21:30" }, NOW);
    expect(r.ok && r.room.shows[0]!.days.find((d) => d.weekday === 5)!.times).toEqual(["19:00", "21:00", "21:30"]);
    expect(applyRoomEdit(room, w.curators, { kind: "add_slot", showId: "mic", weekdays: [5], time: "21:00" }, NOW).ok).toBe(false);
  });
});

describe("planning roster changes", () => {
  it('"update TAG Monday to Dhruv" repeats back and waits for a yes', () => {
    const p = plan("update TAG Monday to Zubin");
    expect(p.pending?.stage).toBe("confirm");
    expect(comicAskText(p.pending!)).toContain("I'll set TAG Monday to Zubin (new curator, no number yet). Now: Mon: Dhruv.");
  });
  it("does it straight away when the setting says auto", () => {
    expect(plan("update TAG Monday to Dhruv", world({ auto: true })).run?.type).toBe("edit_room");
  });
  it("asks which Aditya", () => {
    const p = plan("update Bloom Indiranagar Thursday to Aditya");
    expect(p.pending?.stage).toBe("choose");
    expect(comicAskText(p.pending!)).toContain("1. Aditya Natrajan");
  });
  it("narrows an ambiguous room by the day, and asks when it can't", () => {
    // Bloom Indiranagar runs Monday; Whitefield and HSR don't.
    expect(plan("I'm a regular at Bloom Monday").run?.type).toBe("edit_room");
    const p = plan("pause Bloom till Nov 10");
    expect(p.pending?.stage).toBe("choose");
    expect((p.pending as Extract<ComicPending, { stage: "choose" }>).choices.length).toBe(3);
  });
  it("says so when it can't find the room or the day", () => {
    expect(plan("pause Nowhere till Nov 10").reply).toContain('couldn\'t find a room called "nowhere"');
    expect(plan("update TAG Saturday to Dhruv").pending?.stage).toBe("confirm"); // TAG runs daily
    expect(plan("Comedy Square closed on Monday").pending?.stage).toBe("confirm");
  });
  it("closing the week marks the days from today", () => {
    const pl = planOf(plan("Comedy Square closed this week"));
    expect(pl).toMatchObject({ type: "edit_room", edit: { kind: "close", ranges: [{ from: "2026-10-27", until: "2026-11-01" }] } });
    expect(pl.summary).toContain("full for");
  });
  it("a closed show isn't closed twice", () => {
    const w = world();
    const first = executeComic(planOf(plan("Comedy Square closed this week", w)), w);
    const w2 = world({ rooms: w.rooms.map((r) => first.writes.rooms.find((x) => x.id === r.id) ?? r) });
    expect(plan("Comedy Square closed this week", w2).reply).toContain("already marked full");
  });
  it("sets the ask rule and a role", () => {
    const pl = planOf(plan("Humble Pie asks on Mondays now"));
    expect(pl).toMatchObject({ edit: { kind: "ask_rule", rule: { kind: "weekday", day: 1 } } });
    expect(plan("Humble Pie asks on Mondays now").pending?.stage).toBe("confirm");
    expect(plan("I'm a regular at Bloom Monday").run).toBeTruthy(); // a role changes nothing outward
  });
  it("adds a curator's number, masked in the question", () => {
    const p = plan("add Dhruv's number 9811122233");
    expect(comicAskText(p.pending!)).toContain("+91 98•••33");
    expect(comicAskText(p.pending!)).not.toContain("9811122233");
    expect(plan("add Dhruv's number 12345678").reply).toContain("doesn't look like a phone number");
  });
});

describe("spots", () => {
  it("adds a spot right away with the room, day and time, and warns about a clash", () => {
    const w = world({ spots: [spot({ id: "x", time: "20:00", roomName: "TAG" })] });
    const p = plan("I got a spot at Banter tonight 9pm", w);
    expect(p.run).toMatchObject({ type: "add_spot", date: TODAY, time: "21:00", roomName: "Banter Comedy Club" });
    const r = executeComic(p.run!, w);
    expect(r.writes.spots[0]).toMatchObject({ source: "adhoc", happened: null, status: "booked", roomName: "Banter Comedy Club", time: "21:00" });
    expect(r.reply).toContain("Heads up: it's close to TAG");
  });
  it("keeps a room it doesn't know as typed, and won't add the same spot twice", () => {
    const w = world();
    const p = plan("I got a spot at Some Cafe tomorrow 8pm", w);
    expect(p.run).toMatchObject({ roomName: "Some Cafe", date: "2026-10-28" });
    const first = executeComic(p.run!, w);
    const again = executeComic(p.run!, world({ spots: first.writes.spots }));
    expect(again.reply).toContain("already in My spots");
  });
  it("answers did I do a mic yesterday from My spots", () => {
    const w = world({ spots: [spot({ date: "2026-10-26", time: "20:00", roomName: "Bloom Indiranagar", happened: true })] });
    expect(plan("did I do a mic yesterday?", w).reply).toBe("Yes: Bloom Indiranagar at 8:00 PM (done)");
    expect(plan("did I do a mic yesterday?", world()).reply).toContain("don't have a spot logged yesterday");
  });
  it("counts spots", () => {
    const spots = [spot({ id: "1", date: "2026-10-05", happened: true, roomName: "TAG" }), spot({ id: "2", date: "2026-10-12", happened: true, roomName: "TAG" }), spot({ id: "3", date: "2026-10-26", happened: null, roomName: "Banter" }), spot({ id: "4", date: "2026-10-30", roomName: "Banter" }), spot({ id: "5", date: "2026-09-30", happened: true, roomName: "X" })];
    expect(spotCountText(spots, TODAY, "month")).toBe("This month (Oct): 2 done, 1 booked ahead, 1 to mark. Most at: TAG 2, Banter 1.");
    expect(spotCountText(spots, TODAY, "last_month")).toBe("Last month: 1 done. Most at: X 1.");
    expect(plan("how many spots this month?", world({ spots })).reply).toContain("2 done");
  });
  it("adds a regular spot (the same rule the app writes) and the next date", () => {
    const w = world();
    const p = plan("add regular Monday 9 PM at Bloom", w);
    expect(p.run).toMatchObject({ type: "add_regular", roomName: "Bloom Indiranagar", weekdays: [1], time: "21:00", startDate: "2026-11-02" });
    const r = executeComic(p.run!, w);
    expect(r.writes.regulars[0]).toMatchObject({ cadence: "weekly", weekdays: [1], time: "21:00", roomId: "bloom-indiranagar", startDate: "2026-11-02" });
    expect(r.reply).toContain("The next one is Monday 2 Nov");
    expect(executeComic(p.run!, { ...w, regulars: r.writes.regulars }).reply).toContain("already there");
  });
  it("needs the day and the room", () => {
    expect(plan("add regular at Bloom").reply).toContain("Which day?");
  });
});

describe("asks", () => {
  it('"ask Comedy Square for Monday" in a review room drafts and waits for yes; auto sends at once', () => {
    const w = world();
    const p = plan("ask Comedy Square for Wednesday", w);
    expect(p.pending?.stage).toBe("confirm");
    const text = comicAskText(p.pending!);
    expect(text).toContain("Akhil");
    expect(text).toContain("this room is on review");
    expect(text).toContain("Could I get a spot at Comedy Square");
    const auto = world({ rooms: w.rooms.map((r) => (r.name === "Comedy Square" ? { ...r, askMode: "auto" as const } : r)) });
    expect(plan("ask Comedy Square for Wednesday", auto).run?.type).toBe("ask");
    expect(plan("ask Comedy Square for Wednesday", world({ auto: true })).run?.type).toBe("ask");
  });
  it("executing an ask writes the draft and says what to send", () => {
    const w = world();
    const r = executeComic(planOf(plan("ask Comedy Square for Wednesday", w)), w);
    expect(r.send).toMatchObject({ kind: "ask", to: "Akhil", askId: "2026-10-28_comedy-square-hsr-layout_mic" });
    expect(r.writes.asks[0]).toMatchObject({ status: "planned", curatorName: "Akhil", showDate: "2026-10-28" });
    expect(r.writes.asks[0]!.message).toContain("Hey Akhil!");
  });
  it("says why it didn't ask: no number, they reach out, already asked, full", () => {
    expect(plan("ask TAG for Monday").reply).toContain("Dhruv has no WhatsApp number yet");
    expect(plan("ask TAG for Saturday").reply).toContain("reaches out themselves");
    const w = world();
    const sent: Ask = { id: "2026-10-28_comedy-square-hsr-layout_mic", roomId: "comedy-square-hsr-layout", showId: "mic", showDate: "2026-10-28", status: "sent", createdAt: 1 };
    expect(plan("ask Comedy Square for Wednesday", world({ asks: [sent] })).reply).toContain("you already asked");
    const closed = executeComic(planOf(plan("Comedy Square closed this week", w)), w);
    const w2 = world({ rooms: w.rooms.map((r) => closed.writes.rooms.find((x) => x.id === r.id) ?? r) });
    expect(plan("ask Comedy Square for Wednesday", w2).reply).toContain("marked full");
  });
  it("asks which of two shows or rooms", () => {
    const w = world();
    for (const c of w.curators) if (["navneeth", "kush"].includes(c.id)) c.phone = "+91 90000 10000";
    const p = plan("ask Comedy Theatre for Monday", w);
    expect(p.pending?.stage).toBe("choose");
    expect(comicAskText(p.pending!)).toContain("Comedy Theatre Church Street");
  });
  it("lists the open asks", () => {
    const r = plan("what asks are open today?").reply!;
    expect(r).toContain("Asks open:");
    expect(r).toMatch(/Comedy Square|TAG|Bloom/);
  });
  it("skips a room for the week by writing skipped asks", () => {
    const w = world();
    const p = plan("skip Banter this week", w);
    expect(p.run?.type).toBe("skip_asks");
    const r = executeComic(p.run!, w);
    expect(r.writes.asks.length).toBeGreaterThan(1);
    expect(r.writes.asks.every((a) => a.skipped && a.status === "expired")).toBe(true);
  });
});

describe("alerts", () => {
  it("lists open spots and nothing when there are none", () => {
    expect(plan("any open spots now?").reply).toContain("No open spots");
    const r = plan("any open spots now?", world({ alerts: [alert()] })).reply!;
    expect(r).toContain("Banter Comedy Club, today 9 PM: DM Dhruv");
  });
  it("asks for the one open spot after a yes, with the message the app would send", () => {
    const w = world({ alerts: [alert()] });
    const p = plan("ask for it", w);
    expect(p.pending?.stage).toBe("confirm");
    expect(comicAskText(p.pending!)).toContain('Hi Dhruv, I can do the 9:00 PM spot at Banter Comedy Club today!');
    const r = executeComic(planOf(p), w);
    expect(r.send).toMatchObject({ kind: "alert", alertId: "a1" });
  });
  it("asks which time when an alert offers two, and which alert when there are two", () => {
    expect(plan("ask for it", world({ alerts: [alert({ times: ["19:00", "21:00"] })] })).pending?.stage).toBe("choose");
    const two = world({ alerts: [alert(), alert({ id: "a2", roomName: "TAG", times: ["22:00"] })] });
    expect(plan("ask for it", two).pending?.stage).toBe("choose");
    expect(plan("ask for it", two).pending && comicAskText(plan("ask for it", two).pending!)).toContain("2. TAG");
  });
  it("won't ask for a closed or ended spot", () => {
    const w = world({ alerts: [alert({ status: "closed" })] });
    expect(plan("ask for it", w).reply).toContain("no open spot");
    const live = world({ alerts: [alert()] });
    const p = planOf(plan("ask for it", live));
    expect(executeComic(p, world({ alerts: [alert({ status: "closed" })] })).reply).toContain("closed it in the group");
  });
});

describe("the yes / number / no step", () => {
  const w = world();
  const confirm = plan("update TAG Monday to Zubin").pending!;
  it("yes runs it, no cancels, anything else drops it, late does nothing", () => {
    expect(stepComicPending(confirm, "yes", NOW + 1000, false).type).toBe("execute");
    expect(stepComicPending(confirm, "no", NOW + 1000, false).type).toBe("cancel");
    expect(stepComicPending(confirm, "ask TAG for Monday", NOW + 1000, false).type).toBe("drop");
    expect(stepComicPending(confirm, "yes", NOW + 11 * 60_000, false).type).toBe("expired");
    expect(stepComicPending(null, "yes", NOW, false).type).toBe("none");
  });
  it("a number picks, then asks yes for things that matter and just does the rest", () => {
    const pick = plan("update Bloom Indiranagar Thursday to Aditya").pending!;
    expect(stepComicPending(pick, "9", NOW + 1, false).type).toBe("reprompt");
    const s = stepComicPending(pick, "1", NOW + 1, false);
    expect(s.type).toBe("chosen");
    expect(stepComicPending(pick, "1", NOW + 1, true).type).toBe("execute");
    const spots = plan("I got a spot at Bloom tomorrow 8pm").pending!;
    expect(spots.stage).toBe("choose");
    expect(stepComicPending(spots, "1", NOW + 1, false).type).toBe("execute"); // a spot in My spots needs no second yes
  });
  it("only an ask that breaks a limit is confirmed under auto", () => {
    const base = { type: "ask", roomId: "r", showId: "s", showDate: TODAY, mode: "auto", summary: "x" } as const;
    expect(needsConfirm(base, false)).toBe(false);
    expect(needsConfirm({ ...base, mode: "review" }, false)).toBe(true);
    expect(needsConfirm({ ...base, mode: "review" }, true)).toBe(false);
    expect(needsConfirm({ ...base, warn: "over" }, true)).toBe(true);
  });
});

describe("a stale yes", () => {
  it("re-reads the room: a show that vanished does nothing", () => {
    const w = world();
    const p = planOf(plan("update TAG Monday to Zubin", w));
    const r = executeComic(p, { ...w, rooms: w.rooms.filter((x) => x.name !== "TAG") });
    expect(r.reply).toContain("that room isn't there any more");
    expect(r.writes.rooms).toEqual([]);
    expect(BLR_ROSTER.rooms.length).toBeGreaterThan(5);
  });
});

describe("types", () => {
  it("is exported as an intent shape", () => {
    const i: ComicIntent = { name: "help", text: "help" };
    expect(planComic(i, world()).reply).toContain("Rooms");
  });
});
