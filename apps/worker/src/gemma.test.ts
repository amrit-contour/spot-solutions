import { describe, expect, it } from "vitest";
import { INTENT_TAGS, type SenderFacts, type Show, type Venue } from "@spot/shared";
import { buildPrompt, cleanNote, evidenceIsReal, parseIntent } from "./gemma.ts";

// Regression: the model once "quoted" asks that weren't in notification/link messages, and acks went out.
describe("evidenceIsReal", () => {
  it("rejects evidence the model made up", () => {
    expect(evidenceIsReal("can I get a spot this monday", ["NOTICE: Your bank account will be marked inactive. Please transact to keep it active."])).toBe(false);
    expect(evidenceIsReal("wants to perform", ["https://example.com/share/v/abc123"])).toBe(false);
    expect(evidenceIsReal("", ["bro any spot?"])).toBe(false);
  });
  it("accepts a real quote, ignoring case and punctuation", () => {
    expect(evidenceIsReal("Can i get a spot for Tue", ["Can i get a spot for Tue?"])).toBe(true);
    expect(evidenceIsReal("monday ka spot milega", ["hey bro", "Monday ka spot milega??"])).toBe(true);
  });
});

const venues: Venue[] = [
  { id: "v_bloom", name: "Bloom Indiranagar", area: "Indiranagar", aliases: ["bloom", "indira nagar"] },
  { id: "v_other", name: "Unused Venue" },
];
const shows = [
  { name: "Open Mic - Monday", weekday: 1, startTime: "20:30", venueId: "v_bloom" },
  { name: "Open Mic - Tuesday", weekday: 2, startTime: "20:30", venueId: "v_bloom" },
] as Show[];
const sender: SenderFacts = { onRoster: true, savedName: "Asha K", pastSpots: 4, lastSpotDate: "2026-09-29", tags: [], performedLastWeek: true, priorRequests: 6 };

describe("buildPrompt", () => {
  const p = buildPrompt(["bloom pe spot hai kya monday"], shows, venues, sender);
  it("lists active venues with area, aliases and their shows", () => {
    expect(p).toContain('venue_id "v_bloom": Bloom Indiranagar, area Indiranagar, also called: bloom, indira nagar');
    expect(p).toContain("Open Mic - Monday (Monday 20:30)");
    expect(p).toContain("Open Mic - Tuesday (Tuesday 20:30)");
    expect(p).not.toContain("Unused Venue");
  });
  it("states what the app knows about the sender and forbids judging newness", () => {
    expect(p).toContain("On the curator's roster: yes");
    expect(p).toContain("Saved name: Asha K");
    expect(p).toContain("Past spots here: 4, last on 2026-09-29");
    expect(p).toContain("Experience tags:");
    expect(p).toContain("Performed last week: yes");
    expect(p).toContain("Do not judge whether this person is new");
  });
  it("tells the model to map venue words to ids and lists the tag enum", () => {
    expect(p).toContain("is the place, not a nickname");
    for (const t of INTENT_TAGS) expect(p).toContain(`- ${t}:`);
  });
  it("no longer primes 'new 5'", () => {
    expect(p).not.toMatch(/naya 5|trying new 5|new 5/i);
  });
  it("still works without venues or sender", () => {
    const bare = buildPrompt(["hi"], shows);
    expect(bare).toContain("Open Mic - Monday (Monday 20:30)");
    expect(bare).not.toContain("Facts about the sender");
  });
});

describe("parseIntent", () => {
  const msgs = ["bloom pe spot hai kya monday, flexible on days"];
  const raw = (o: object) => JSON.stringify({ evidence: "spot hai kya monday", kind: "spot_request", is_spot_request: true, confidence: 0.9, preferred_days: ["Monday"], note: "wants Monday", tags: [], venue_id: "", ...o });
  const ids = ["v_bloom"];

  it("keeps known tags once and drops unknown ones", () => {
    const i = parseIntent(raw({ tags: ["flexible_days", "FLEXIBLE_DAYS", "new_comic", "vip", "travelling"] }), "m", msgs, ids);
    expect(i.tags).toEqual(["flexible_days", "travelling"]);
  });
  it("keeps a venue id that exists and drops one that does not", () => {
    expect(parseIntent(raw({ venue_id: "v_bloom" }), "m", msgs, ids).venueId).toBe("v_bloom");
    expect(parseIntent(raw({ venue_id: "bloom" }), "m", msgs, ids).venueId).toBeNull();
    expect(parseIntent(raw({ venue_id: "v_bloom" }), "m", msgs, []).venueId).toBeNull();
  });
  it("drops tags and venue when the quoted evidence is made up", () => {
    const i = parseIntent(raw({ evidence: "please give me a spot on friday", tags: ["travelling"], venue_id: "v_bloom" }), "m", msgs, ids);
    expect(i.kind).toBe("other");
    expect(i.tags).toEqual([]);
    expect(i.venueId).toBeNull();
  });
  it("never passes on a 'new comic' claim from the model", () => {
    expect(parseIntent(raw({ note: "New comic wants Monday" }), "m", msgs, ids).note).toBeNull();
    expect(parseIntent(raw({ note: "Wants Monday, new comic to the scene" }), "m", msgs, ids).note).toBe("Wants Monday");
    expect(parseIntent(raw({ note: "wants Monday, trying new jokes" }), "m", msgs, ids).note).toBe("wants Monday, trying new jokes");
  });
});

describe("cleanNote", () => {
  it("removes newness claims and keeps the ask", () => {
    expect(cleanNote("first time comic. wants Tuesday")).toBe("wants Tuesday");
    expect(cleanNote("New face. Wants Tuesday")).toBe("Wants Tuesday");
    expect(cleanNote("newcomer asking for monday")).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
  });
});

// Regression from production: unrelated chats scored 0.95, and a "spot available?" ask was filed as where/when.
describe("spot signal", () => {
  const ask = (evidence: string, o: object = {}) => JSON.stringify({ evidence, kind: "spot_request", is_spot_request: true, confidence: 0.95, preferred_days: [], note: "Asks for a spot", tags: [], venue_id: "", ...o });
  const terms = ["Bloom Indiranagar", "Indiranagar", "bloom"];
  it.each([
    [["Mu aga porter dekhe kete paduchi", "Sei hisab re", "Hau lunch kariki kahuchi model"], "Sei hisab re"],
    [["Bro", "Is month ka maintenance pay ho gya hai kya ?", "I cant recall if you paid it or me"], "Is month ka maintenance pay ho gya hai kya"],
    [["Pls come whenever", "It is semi furnished", "Location is murugeshpalya"], "Pls come whenever"],
    [["Bhai 5k patheibu?"], "Bhai 5k patheibu"],
  ])("caps a chat with no spot, day or venue to Maybe", (msgs, ev) => {
    const i = parseIntent(ask(ev), "m", msgs, ["v_bloom"], terms);
    expect(i.confidence).toBeLessThanOrEqual(0.45);
  });
  it.each([
    [["yoo can i get bloom tomorrow?"]],
    [["Bhai kal tuesday ko bloom karlu?"]],
    [["Hello Bro. Kal please spot dena"]],
    [["can I come up next week"]],
  ])("keeps real asks", (msgs) => {
    expect(parseIntent(ask(msgs[0]), "m", msgs, ["v_bloom"], terms).confidence).toBe(0.95);
  });
  it("treats 'spot available at Bloom 9 pm today?' as a spot request", () => {
    const msgs = ["Hello, spot available at Bloom 9 pm today?"];
    const i = parseIntent(ask("spot available at Bloom 9 pm today", { kind: "show_info", is_spot_request: false }), "m", msgs, ["v_bloom"], terms);
    expect(i.kind).toBe("spot_request");
    expect(i.isSpotRequest).toBe(true);
  });
});
