import { describe, expect, it } from "vitest";
import { ROSTER_AI_SCHEMA, buildRosterPrompt, cleanPhone, jsonFromReply, mergeParsed, normTime, normaliseAiRoster, parseDays, parsePing, parseWhatsAppList, takeDays } from "./rosterParse.ts";
import { diffRosters } from "./rosterMerge.ts";
import { CURATOR_LIST } from "./fixtures/curatorList.ts";
import { BLR_ROSTER } from "./fixtures/blrRooms.ts";

const parsed = () => parseWhatsAppList(CURATOR_LIST, { city: "Bengaluru" });
const room = (name: string) => parsed().rooms.find((r) => r.name === name)!;
const mic = (name: string) => room(name).shows[0]!;
const dayNames = (name: string) => mic(name).days.map((d) => d.weekday).sort();
const who = (name: string, wd: number) => mic(name).days.find((d) => d.weekday === wd)!.curatorIds;

describe("days", () => {
  it("reads ranges, lists and groups", () => {
    expect(takeDays("Mon to Thu: x")?.days).toEqual([1, 2, 3, 4]);
    expect(takeDays("Mon-Thu - x")?.days).toEqual([1, 2, 3, 4]);
    expect(takeDays("Fri to Sun: x")?.days).toEqual([5, 6, 0]);
    expect(takeDays("Sat to Mon: x")?.days).toEqual([6, 0, 1]);
    expect(takeDays("Mon & Wed: x")?.days).toEqual([1, 3]);
    expect(takeDays("Mon, Wed and Fri: x")?.days).toEqual([1, 3, 5]);
    expect(takeDays("Weekends: x")?.days).toEqual([6, 0]);
    expect(takeDays("Weekday: x")?.days).toEqual([1, 2, 3, 4, 5]);
    expect(takeDays("Daily: x")?.days).toHaveLength(7);
    expect(takeDays("Thurs: x")?.days).toEqual([4]);
  });
  it("stops at a name that only looks like a day", () => {
    expect(takeDays("Monday - Vedant - 9000000012")?.days).toEqual([1]);
    expect(takeDays("Sunil: 9000000012")).toBeNull();
    expect(takeDays("Monica - hi")).toBeNull();
    expect(takeDays("Ping Monday")).toBeNull();
  });
  it("parseDays wants the whole string", () => {
    expect(parseDays("Tue to Thu")).toEqual([2, 3, 4]);
    expect(parseDays("Mon and a half")).toBeNull();
  });
});

describe("ping and numbers", () => {
  it("reads when to ask", () => {
    expect(parsePing("ping on Mondays")?.rule).toEqual({ kind: "weekday", day: 1 });
    expect(parsePing("Ping Mon morning")?.rule).toEqual({ kind: "weekday", day: 1, morning: true });
    expect(parsePing("ping the day before")?.rule).toEqual({ kind: "day_before" });
    expect(parsePing("ping same day morning")?.rule).toEqual({ kind: "same_day", morning: true });
    expect(parsePing("ping at the start of the month")?.rule).toEqual({ kind: "start_of_month" });
    expect(parsePing("they will reach out")?.rule?.kind).toBe("they_reach_out");
    expect(parsePing("Ping Comedy Bandar's Insta page on Sunday")?.note?.kind).toBe("instagram");
    expect(parsePing("register at https://ministryofcomedy.in/mics")?.note?.url).toBe("https://ministryofcomedy.in/mics");
    expect(parsePing("nothing to see")).toBeUndefined();
  });
  it("normalises numbers", () => {
    expect(cleanPhone("96119 39277")).toBe("+919611939277");
    expect(cleanPhone("+91-96119-39277")).toBe("+919611939277");
    expect(cleanPhone("09611939277")).toBe("+919611939277");
    expect(cleanPhone("12345")).toBe("");
  });
  it("reads times", () => {
    expect(normTime("8:30 PM")).toBe("20:30");
    expect(normTime("8pm")).toBe("20:00");
    expect(normTime("12 am")).toBe("00:00");
    expect(normTime("20:30")).toBe("20:30");
    expect(normTime("25:00")).toBeUndefined();
  });
});

describe("the WhatsApp list (no model)", () => {
  it("finds every room under its bold heading", () => {
    const r = parsed();
    expect(r.rooms.map((x) => x.name)).toEqual(["Klayworkz", "Comedy Square", "TAG Comedy Club", "Humble Pie", "Ministry of Comedy", "Bloom"]);
    expect(r.unparsed).toEqual([]);
    expect(r.preamble).toEqual(["Curator list, Bangalore (updated Oct)"]);
  });
  it("splits name and area, and expands short areas", () => {
    expect(room("Klayworkz")).toMatchObject({ area: "JP Nagar", city: "Bengaluru", id: "klayworkz-jp-nagar" });
    expect(room("Comedy Square")).toMatchObject({ area: "HSR Layout", id: "comedy-square-hsr-layout" });
    expect(room("Humble Pie")).toMatchObject({ area: "HSR Layout" });
    expect(room("Bloom")).toMatchObject({ area: "HSR Layout", id: "bloom-hsr-layout" });
  });
  it("reads a day range with one curator and a ping rule", () => {
    expect(dayNames("Klayworkz")).toEqual([2, 3, 4]);
    const p = parsed();
    expect(p.curators.find((c) => c.id === "pronoy")).toEqual({ id: "pronoy", name: "Pronoy", phone: "+919000000011" });
    expect(mic("Klayworkz").askRule).toEqual({ kind: "weekday", day: 1 });
    expect(mic("Klayworkz").days.every((d) => d.askRule === undefined)).toBe(true);
  });
  it("reads a heading hint as the room's ask rule, and one curator per day", () => {
    expect(mic("Comedy Square").askRule).toEqual({ kind: "weekday", day: 1 });
    expect(dayNames("Comedy Square")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(mic("Comedy Square").cadence).toBe("daily");
    expect(who("Comedy Square", 1)).toEqual(["vedant"]);
    expect(who("Comedy Square", 4)).toEqual(["akhil"]);
    expect(who("Comedy Square", 0)).toEqual(["varun"]);
    const varun = parsed().curators.find((c) => c.id === "varun")!;
    expect(varun.phone).toBe("+919000000013");
    expect(parsed().curators.filter((c) => c.id === "varun")).toHaveLength(1);
  });
  it("reads 'X himself will reach out' as they-reach-out for those days", () => {
    for (const wd of [5, 6, 0]) {
      const d = mic("TAG Comedy Club").days.find((x) => x.weekday === wd)!;
      expect(d.theyReachOut).toBe(true);
      expect(d.curatorIds).toEqual(["tarun"]);
      expect(d.askRule).toEqual({ kind: "they_reach_out", note: "Tarun himself will reach out" });
    }
    expect(who("TAG Comedy Club", 1)).toEqual(["gilheri"]);
    expect(mic("TAG Comedy Club").days.find((d) => d.weekday === 1)!.theyReachOut).toBeUndefined();
  });
  it("turns an Instagram line into a note, not an action", () => {
    const r = room("Humble Pie");
    expect(r.notes).toEqual([{ kind: "instagram", text: "Ping Comedy Bandar's Insta page on Sunday" }]);
    expect(r.shows[0]!.askRule).toMatchObject({ kind: "instagram" });
    expect(r.shows[0]!.days).toEqual([]);
  });
  it("reads a morning ping, an ampersand day list and a bracketed number", () => {
    expect(mic("Ministry of Comedy").days.find((d) => d.weekday === 3)).toMatchObject({ curatorIds: ["prasidh"] });
    // The ping rule was written on the Mon-Thu line only, so only those days carry it.
    expect(mic("Ministry of Comedy").days.filter((d) => d.askRule).map((d) => d.weekday)).toEqual([1, 2, 3, 4]);
    expect(mic("Ministry of Comedy").days[0]!.askRule).toEqual({ kind: "weekday", day: 1, morning: true });
    expect(dayNames("Ministry of Comedy")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parsed().curators.find((c) => c.id === "gaurav")?.phone).toBe("+919000000016");
  });
  it("matches two curators to two numbers in order", () => {
    expect(who("Bloom", 6)).toEqual(["sharan", "minahaj"]);
    const c = parsed().curators;
    expect(c.find((x) => x.id === "sharan")?.phone).toBe("+919000000017");
    expect(c.find((x) => x.id === "minahaj")?.phone).toBe("+919000000018");
  });
  it("lines up with the Bangalore seed so the review shows few changes", () => {
    const r = parsed();
    const changes = diffRosters({ rooms: BLR_ROSTER.rooms, curators: BLR_ROSTER.curators }, { rooms: r.rooms, curators: r.curators });
    // Klayworkz and Comedy Square are the same rooms (by name and area): they are matched, not added.
    expect(changes.some((c) => c.op === "added" && c.level === "room" && /Klayworkz|Comedy Square/.test(c.label))).toBe(false);
  });
  it("keeps what it can't read as a note and says which block", () => {
    const r = parseWhatsAppList("*Some Room, Indiranagar*\nMon: Asha\nplease bring your own mic stand sometimes\n", { city: "Bengaluru" });
    expect(r.unparsed).toHaveLength(1);
    expect(r.unparsed[0]!.lines).toEqual(["please bring your own mic stand sometimes"]);
    expect(r.rooms[0]!.notes).toContainEqual({ kind: "other", text: "please bring your own mic stand sometimes" });
    expect(r.rooms[0]!.shows[0]!.days).toHaveLength(1);
  });
  it("reads plain (not bold) headings and times", () => {
    const r = parseWhatsAppList("Laugh Junction, HSR\nMon & Wed: Sid 9000000021 (8 pm)\nTue: Rishabh\n", { city: "Bengaluru" });
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.shows[0]!.days.find((d) => d.weekday === 1)).toMatchObject({ curatorIds: ["sid"], times: ["20:00"] });
  });
  it("finds nothing in prose, and warns about two numbers for one name", () => {
    expect(parseWhatsAppList("hello, can you add me to the list?").rooms).toEqual([]);
    const r = parseWhatsAppList("*A*\nMon: Sid 9000000021\n*B*\nTue: Sid 9000000022\n");
    expect(r.warnings.some((w) => /two numbers/.test(w))).toBe(true);
  });
});

describe("normaliseAiRoster", () => {
  const reply = {
    rooms: [{
      name: "Klayworkz", area: "JP Nagar", instagram: "@klayworkz", website: "klayworkz.in", tags: ["English Only"], notes: ["Bring a friend"], junk: 1,
      shows: [{ name: "Mic", type: "both", times: ["8:30 PM", "nope"], ask: "weekday", ask_day: "Monday", ask_morning: true,
        days: [{ days: ["Tue to Thu", "Sat"], curators: [{ name: "Pronoy", phone: "96119 39277", extra: 1 }], note: "ok" }, { days: ["Funday"], curators: [] }] }],
    }, { name: "", shows: [] }, "bad"],
    notes: ["from the list"],
    other: 5,
  };
  it("builds rooms, drops what is unknown and normalises", () => {
    const r = normaliseAiRoster(reply, { city: "Bengaluru" });
    expect(r.rooms).toHaveLength(1);
    const room = r.rooms[0]!;
    expect(room).toMatchObject({ id: "klayworkz-jp-nagar", city: "Bengaluru", tags: ["english-only"] });
    expect(room.notes).toEqual([{ kind: "instagram", handle: "klayworkz" }, { kind: "website", url: "https://klayworkz.in/" }, { kind: "other", text: "Bring a friend" }]);
    const show = room.shows[0]!;
    expect(show).toMatchObject({ type: "both", times: ["20:30"], askRule: { kind: "weekday", day: 1, morning: true } });
    expect(show.days.map((d) => d.weekday)).toEqual([2, 3, 4, 6]);
    expect(show.days[0]).toMatchObject({ curatorIds: ["pronoy"], note: "ok" });
    expect(r.curators).toEqual([{ id: "pronoy", name: "Pronoy", phone: "+919611939277" }]);
    expect(r.warnings.some((w) => /Funday/.test(w))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("junk");
  });
  it("drops a number that isn't in the source text", () => {
    const text = "Pronoy 9611939277";
    const ok = normaliseAiRoster({ rooms: [{ name: "A", shows: [{ days: [{ days: ["Mon"], curators: [{ name: "Pronoy", phone: "9611939277" }] }] }] }] }, { sourceText: text });
    expect(ok.curators[0]!.phone).toBe("+919611939277");
    const bad = normaliseAiRoster({ rooms: [{ name: "A", shows: [{ days: [{ days: ["Mon"], curators: [{ name: "Pronoy", phone: "9999999999" }] }] }] }] }, { sourceText: text });
    expect(bad.curators[0]!.phone).toBeUndefined();
    expect(bad.warnings.some((w) => /isn't in what you gave me/.test(w))).toBe(true);
  });
  it("reads fenced JSON, chatter, and survives garbage", () => {
    expect(jsonFromReply('Sure!\n```json\n{"rooms":[]}\n```')).toEqual({ rooms: [] });
    expect(jsonFromReply('here {"rooms":[{"name":"A","shows":[]}]} done')).toEqual({ rooms: [{ name: "A", shows: [] }] });
    expect(normaliseAiRoster("not json").warnings).toHaveLength(1);
    expect(normaliseAiRoster(null).rooms).toEqual([]);
    expect(normaliseAiRoster({ rooms: "x" }).rooms).toEqual([]);
  });
  it("merges two rooms with the same name and area, and refuses non-http links", () => {
    const r = normaliseAiRoster({ rooms: [
      { name: "A", area: "X", website: "javascript:alert(1)", shows: [{ days: [{ days: ["Mon"], curators: [{ name: "Sid" }] }] }] },
      { name: "A", area: "X", shows: [{ days: [{ days: ["Tue"], curators: [{ name: "Sid" }] }] }] },
    ] });
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.shows).toHaveLength(1);
    expect(r.rooms[0]!.shows[0]!.days).toHaveLength(2);
    expect(r.rooms[0]!.notes).toEqual([]);
  });
  it("the schema and prompt are usable", () => {
    expect(ROSTER_AI_SCHEMA.required).toEqual(["rooms"]);
    const p = buildRosterPrompt({ text: "*X*\nMon: Y", city: "Pune" });
    expect(p).toContain("*X*\nMon: Y");
    expect(p).toContain("Pune");
  });
});

describe("mergeParsed", () => {
  it("replaces a room the second pass re-read, keeps the rest", () => {
    const a = parseWhatsAppList("*A, X*\nMon: Sid\n*B, Y*\nTue: Asha\n");
    const b = normaliseAiRoster({ rooms: [{ name: "B", area: "Y", shows: [{ days: [{ days: ["Wed"], curators: [{ name: "Asha" }] }] }] }] });
    const m = mergeParsed({ rooms: a.rooms, curators: a.curators }, { rooms: b.rooms, curators: b.curators });
    expect(m.rooms.map((r) => r.name)).toEqual(["A", "B"]);
    expect(m.rooms[1]!.shows[0]!.days[0]!.weekday).toBe(3);
    expect(m.curators.map((c) => c.id).sort()).toEqual(["asha", "sid"]);
  });
});
