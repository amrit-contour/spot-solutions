import { describe, expect, it } from "vitest";
import {
  AGENT_CONFIRM_TTL_MS, agentVaultId, askText, choosePending, composeDigest, composeNotifyBatch, confirmPending, describePlan, digestDue, formatLineup, formatWaiting, intentPrompt, matchPeople,
  maskPhone, micAnswer, planAction, type PlanWorld, normalizeRawIntent, parseClock, parseIntentByRules, rateCheck, resolveShow, senderIsCurator, splitVaultId, stepPending, strictNo, strictYes, type ActionPlan, type ShowDay,
} from "./agent.ts";

const shows = [
  { id: "mon", name: "Monday Mic", weekday: 1 as const, venueId: "v1", active: true, startTime: "20:30", slotCount: 6 },
  { id: "tue", name: "Tuesday Mic", weekday: 2 as const, venueId: "v2", active: true, startTime: "20:00", slotCount: 6 },
  { id: "thu", name: "Thursday Open Mic", weekday: 4 as const, venueId: "v1", active: true, startTime: "20:00", slotCount: 5 },
  { id: "thu2", name: "Thursday Late", weekday: 4 as const, venueId: "v2", active: true, startTime: "22:00", slotCount: 5 },
];
const venues = [{ id: "v1", name: "Bloom", aliases: ["bloom cafe"] }, { id: "v2", name: "Indie Hub" }];

describe("who it obeys", () => {
  const base = { curatorPhone: "919876543210" };
  it("accepts the curator's own phone id", () => {
    expect(senderIsCurator({ ...base, from: "919876543210@c.us" })).toBe(true);
  });
  it("accepts a @lid only once it is resolved to the curator's phone", () => {
    expect(senderIsCurator({ ...base, from: "12345678@lid" })).toBe(false);
    expect(senderIsCurator({ ...base, from: "12345678@lid", resolvedPhone: "919876543210@c.us" })).toBe(true);
    expect(senderIsCurator({ ...base, from: "12345678@lid", resolvedPhone: "919999999999@c.us" })).toBe(false);
  });
  it("rejects other people, groups, broadcasts, our own sends and an unknown curator", () => {
    expect(senderIsCurator({ ...base, from: "919999999999@c.us" })).toBe(false);
    expect(senderIsCurator({ ...base, from: "120363@g.us" })).toBe(false);
    expect(senderIsCurator({ ...base, from: "status@broadcast" })).toBe(false);
    expect(senderIsCurator({ ...base, from: "919876543210@c.us", fromMe: true })).toBe(false);
    expect(senderIsCurator({ from: "919876543210@c.us", curatorPhone: null })).toBe(false);
    expect(senderIsCurator({ from: "919876543210@c.us", curatorPhone: "" })).toBe(false);
  });
  it("is not fooled by a number that merely ends the same way", () => {
    expect(senderIsCurator({ ...base, from: "9876543210@c.us" })).toBe(false);
    expect(senderIsCurator({ ...base, from: "1919876543210@c.us" })).toBe(false);
  });
});

describe("vault ids", () => {
  it("round-trips an account and its agent", () => {
    expect(agentVaultId("abc")).toBe("abc_agent");
    expect(splitVaultId("abc_agent")).toEqual({ uid: "abc", agent: true });
    expect(splitVaultId("abc")).toEqual({ uid: "abc", agent: false });
    expect(splitVaultId("_agent")).toEqual({ uid: "_agent", agent: false });
  });
});

describe("intents by rules", () => {
  const cases: [string, object][] = [
    ["Monday lineup?", { name: "lineup", day: "monday" }],
    ["lineup for tuesday", { name: "lineup", day: "tuesday" }],
    ["who's on Monday", { name: "lineup", day: "monday" }],
    ["lineup", { name: "lineup" }],
    ["who's waiting?", { name: "waiting" }],
    ["What's left to confirm?", { name: "pending_confirm" }],
    ["Who asked for Tuesday?", { name: "asked", day: "tuesday" }],
    ["when did Rohan last perform?", { name: "last_performed", person: "rohan" }],
    ["add Rohan to Tuesday", { name: "add", person: "rohan", day: "tuesday" }],
    ["remove Rohan Mehta from Monday", { name: "remove", person: "rohan mehta", day: "monday" }],
    ["confirm Monday", { name: "confirm", day: "monday" }],
    ["mark Monday happened", { name: "outcome", day: "monday", happened: true }],
    ["mark monday as didn't happen", { name: "outcome", day: "monday", happened: false }],
    ["Bloom moved Thursday to 9 PM", { name: "retime", day: "bloom thursday", time: "21:00" }],
    ["move tuesday to 8:30pm", { name: "retime", day: "tuesday", time: "20:30" }],
    ["help", { name: "help" }],
  ];
  for (const [text, want] of cases) it(`"${text}"`, () => expect(parseIntentByRules(text)).toEqual(want));
  it("leaves the rest for the model", () => {
    expect(parseIntentByRules("how's the weather")).toBeNull();
    expect(parseIntentByRules("")).toBeNull();
  });
});

describe("model output is checked, never trusted", () => {
  it("accepts a well-formed intent", () => {
    expect(normalizeRawIntent('{"intent":"add","day":"tuesday","person":"Rohan","time":"","happened":false}')).toEqual({ name: "add", day: "tuesday", person: "Rohan" });
    expect(normalizeRawIntent({ intent: "retime", day: "thu", person: "", time: "9 pm", happened: false })).toEqual({ name: "retime", day: "thu", time: "21:00" });
    expect(normalizeRawIntent({ intent: "outcome", day: "monday", happened: false })).toEqual({ name: "outcome", day: "monday", happened: false });
  });
  it("turns nonsense into unknown", () => {
    for (const bad of ["not json", null, 5, { intent: "delete_everything" }, { intent: "add", day: "mon" }, { intent: "retime", day: "mon", time: "soon" }, { intent: "outcome", day: "mon" }, { intent: "confirm" }, { intent: "unknown" }]) {
      expect(normalizeRawIntent(bad)).toEqual({ name: "unknown" });
    }
  });
  it("puts the shows in the prompt and the message in quotes", () => {
    const p = intentPrompt("hello there", [{ name: "Monday Mic", weekday: 1, venue: "Bloom" }]);
    expect(p).toContain("Monday Mic (Monday, Bloom)");
    expect(p).toContain('"""hello there"""');
  });
});

describe("clock times", () => {
  it("reads common spellings", () => {
    expect(parseClock("9 PM")).toBe("21:00");
    expect(parseClock("9:30pm")).toBe("21:30");
    expect(parseClock("21:00")).toBe("21:00");
    expect(parseClock("12 am")).toBe("00:00");
    expect(parseClock("12pm")).toBe("12:00");
    expect(parseClock("9")).toBe("21:00");
    expect(parseClock("at 8")).toBe("20:00");
    expect(parseClock("soon")).toBeNull();
    expect(parseClock("25:00")).toBeNull();
  });
});

describe("resolving shows", () => {
  it("finds a show by weekday", () => {
    expect(resolveShow("monday", shows, venues, 3)).toMatchObject({ kind: "ok", show: { id: "mon" } });
    expect(resolveShow("tue", shows, venues, 3)).toMatchObject({ kind: "ok", show: { id: "tue" } });
  });
  it("uses today and tomorrow", () => {
    expect(resolveShow("today", shows, venues, 2)).toMatchObject({ kind: "ok", show: { id: "tue" } });
    expect(resolveShow("tomorrow", shows, venues, 1)).toMatchObject({ kind: "ok", show: { id: "tue" } });
  });
  it("asks which when two shows share a day", () => {
    const r = resolveShow("thursday", shows, venues, 1);
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.shows.map((s) => s.id)).toEqual(["thu", "thu2"]);
  });
  it("a venue name narrows a shared day", () => {
    expect(resolveShow("bloom thursday", shows, venues, 1)).toMatchObject({ kind: "ok", show: { id: "thu" } });
    expect(resolveShow("indie hub thursday", shows, venues, 1)).toMatchObject({ kind: "ok", show: { id: "thu2" } });
  });
  it("says none for a day with no show", () => {
    expect(resolveShow("saturday", shows, venues, 1).kind).toBe("none");
    expect(resolveShow("hello", shows, venues, 1).kind).toBe("none");
  });
  it("no words: the only show, or a choice", () => {
    expect(resolveShow(undefined, [shows[0]], venues, 1).kind).toBe("ok");
    expect(resolveShow("", shows, venues, 1).kind).toBe("ambiguous");
  });
});

describe("matching people", () => {
  const people = [
    { id: "1@c.us", name: "Rohan Mehta", phone: "919812345612" },
    { id: "2@c.us", name: "Rohan Iyer", phone: "919800000002" },
    { id: "3@c.us", name: "Priya Nair", phone: "919800000003" },
    { id: "4@c.us", name: "Rohit Rao", phone: "919800000004" },
  ];
  it("prefers an exact name", () => expect(matchPeople("rohan mehta", people).map((p) => p.id)).toEqual(["1@c.us"]));
  it("returns every first-name match", () => expect(matchPeople("Rohan", people).map((p) => p.id)).toEqual(["1@c.us", "2@c.us"]));
  it("matches the end of a phone number", () => expect(matchPeople("98 1234 5612", people).map((p) => p.id)).toEqual(["1@c.us"]));
  it("finds nobody for a stranger", () => expect(matchPeople("Zed", people)).toEqual([]));
  it("matches prefixes and ignores accents", () => expect(matchPeople("pri", people).map((p) => p.id)).toEqual(["3@c.us"]));
});

describe("masking a number", () => {
  it("keeps the country code and the ends", () => {
    expect(maskPhone("919812345612")).toBe("+91 98•••12");
    expect(maskPhone("")).toBe("");
  });
});

describe("yes and no", () => {
  it("is strict about yes", () => {
    for (const y of ["yes", "Yes!", "y", "ok", "do it", "yes please", "go ahead"]) expect(strictYes(y)).toBe(true);
    for (const n of ["yes but not Rohan", "yesterday", "maybe", "add him too", "no"]) expect(strictYes(n)).toBe(false);
  });
  it("reads no", () => {
    for (const n of ["no", "No.", "cancel", "don't", "never mind"]) expect(strictNo(n)).toBe(true);
    expect(strictNo("not now please")).toBe(false);
  });
});

describe("answering a mic check", () => {
  it("takes yes, no and the plain facts", () => {
    for (const y of ["yes", "Yes!", "it happened", "happened", "went well"]) expect(micAnswer(y)).toBe(true);
    for (const n of ["no", "nope", "didn't happen", "it did not happen", "was cancelled"]) expect(micAnswer(n)).toBe(false);
  });
  it("leaves everything else alone", () => {
    for (const t of ["no one asked for tuesday", "not sure", "yes but add rohan too", "in tuesday", "Monday lineup?", "ok great, who's waiting"]) expect(micAnswer(t)).toBeNull();
  });
});

describe("the confirmation state machine", () => {
  const plan: ActionPlan = { type: "add", showId: "tue", comicId: "1@c.us", comicName: "Rohan Mehta", phone: "919812345612" };
  const now = 1_000_000;
  const pending = confirmPending(plan, "Add Rohan Mehta to Tuesday Mic?", now);

  it("nothing pending: nothing happens", () => expect(stepPending(null, "yes", now)).toEqual({ type: "none" }));
  it("yes inside the window runs the plan", () => expect(stepPending(pending, "yes", now + 1000)).toEqual({ type: "execute", plan }));
  it("yes exactly at the limit still counts, one ms later does not", () => {
    expect(stepPending(pending, "yes", now + AGENT_CONFIRM_TTL_MS).type).toBe("execute");
    expect(stepPending(pending, "yes", now + AGENT_CONFIRM_TTL_MS + 1).type).toBe("expired");
  });
  it("no cancels", () => expect(stepPending(pending, "no", now + 5).type).toBe("cancel"));
  it("anything else drops it (a new message), never runs it", () => {
    expect(stepPending(pending, "yes but also add Priya", now + 5).type).toBe("drop");
    expect(stepPending(pending, "Monday lineup?", now + 5).type).toBe("drop");
  });
  it("a list: a number picks, then it still needs yes", () => {
    const list = choosePending("Which Rohan?", [
      { label: "Rohan Mehta (+91 98•••12)", plan, summary: "Add Rohan Mehta?" },
      { label: "Rohan Iyer (+91 98•••02)", plan: { ...plan, comicId: "2@c.us", comicName: "Rohan Iyer" }, summary: "Add Rohan Iyer?" },
    ], now);
    const r = stepPending(list, "2", now + 5);
    expect(r.type).toBe("chosen");
    if (r.type === "chosen") {
      expect(r.pending.stage).toBe("confirm");
      expect(r.pending.stage === "confirm" && r.pending.plan).toMatchObject({ comicId: "2@c.us" });
      expect(r.pending.expiresAt).toBe(now + 5 + AGENT_CONFIRM_TTL_MS);
    }
    expect(stepPending(list, "yes", now + 5).type).toBe("drop"); // yes to a list is not a choice
    expect(stepPending(list, "9", now + 5).type).toBe("reprompt");
    expect(stepPending(list, "no", now + 5).type).toBe("cancel");
  });
  it("asks in plain words", () => {
    expect(askText(pending)).toContain("Reply *yes*");
    expect(askText(choosePending("Which?", [{ label: "A", plan, summary: "s" }], now))).toContain("1. A");
  });
});

describe("describing a plan", () => {
  const show = { name: "Tuesday Mic", weekday: 2 as const, startTime: "20:00", slotCount: 6 };
  it("repeats what it understood, with a masked number", () => {
    const t = describePlan({ type: "add", showId: "tue", comicId: "919812345612@c.us", comicName: "Rohan Mehta", phone: "919812345612" }, { show, week: "2026-10-26" });
    expect(t).toBe("Add Rohan Mehta (+91 98•••12) to Tuesday Mic, Tue 27 Oct?");
  });
  it("warns that confirmed shows don't tell the comic", () => {
    expect(describePlan({ type: "add", showId: "tue", comicId: "x@c.us", comicName: "A", phone: "919812345612" }, { show, week: "2026-10-26", alreadyConfirmed: true })).toContain("won't be told");
  });
  it("says who the confirmations go to", () => {
    expect(describePlan({ type: "confirm", showId: "tue", lineupId: "l" }, { show, week: "2026-10-26", filled: 4, told: 1 })).toContain("to 4 people (1 already told, skipped) from your own WhatsApp");
  });
  it("retime shows old and new time", () => {
    expect(describePlan({ type: "retime", showId: "tue", startTime: "21:00" }, { show, week: "2026-10-26" })).toContain("from 8:00 PM to 9:00 PM");
  });
});

describe("rate limit", () => {
  it("allows up to the cap inside the window and forgets old sends", () => {
    const t0 = 10_000_000;
    let sent: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = rateCheck(sent, t0 + i, 3);
      expect(r.ok).toBe(true);
      sent = [...r.sent, t0 + i];
    }
    expect(rateCheck(sent, t0 + 10, 3).ok).toBe(false);
    expect(rateCheck(sent, t0 + 3_600_001, 3).ok).toBe(true);
  });
});

const day = (over: Partial<ShowDay> = {}): ShowDay => ({ showId: "mon", showName: "Monday Mic", weekday: 1, date: "2026-10-26", time: "20:30", slotCount: 6, status: "confirmed", names: ["Asha", "Rohan Mehta"], ...over });

describe("answers", () => {
  it("formats a lineup from data only", () => {
    expect(formatLineup(day())).toBe("*Monday Mic*, Mon 26 Oct · 8:30 PM (confirmed, 2 of 6)\n1. Asha\n2. Rohan Mehta");
    expect(formatLineup(day({ names: [], status: "draft" }))).toContain("Nobody yet.");
    expect(formatLineup(day({ status: "cancelled" }))).toContain("called off");
  });
  it("lists who's waiting, capped", () => {
    expect(formatWaiting([])).toBe("Nobody is waiting this week.");
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `P${i}`, days: "Mon" }));
    expect(formatWaiting(many)).toContain("…and 3 more.");
  });
});

describe("notice batches", () => {
  it("counts new requests instead of sending one each", () => {
    const out = composeNotifyBatch(["Asha", "Ben", "Chi"].map((text) => ({ kind: "request" as const, text })));
    expect(out).toBe("3 new spot requests: Asha, Ben, Chi.");
  });
  it("one request reads naturally; empty is null", () => {
    expect(composeNotifyBatch([{ kind: "request", text: "Asha" }])).toBe("New spot request: Asha.");
    expect(composeNotifyBatch([])).toBeNull();
  });
  it("mixes kinds in one message", () => {
    const out = composeNotifyBatch([{ kind: "request", text: "Asha" }, { kind: "notice", text: "Ben took the Monday spot." }, { kind: "warn", text: "WhatsApp needs a scan." }]);
    expect(out).toContain("New spot request: Asha.");
    expect(out).toContain("Ben took the Monday spot.");
    expect(out).toContain("Heads up: WhatsApp needs a scan.");
  });
});

describe("the morning digest", () => {
  const input = { today: "2026-10-26", todayShows: [day()], tomorrowShows: [day({ showName: "Tuesday Mic", weekday: 2, date: "2026-10-27", status: "draft", names: ["Priya"] })], waiting: [{ name: "Zed" }, { name: "Yan" }], updates: 3, unconfirmed: [day({ showName: "Tuesday Mic", weekday: 2, status: "draft" })] };
  it("covers today, waiting, what needs you and tomorrow", () => {
    const out = composeDigest(input)!;
    expect(out).toContain("*Today: Monday Mic* · 8:30 PM (confirmed, 2 of 6)");
    expect(out).toContain("1. Asha");
    expect(out).toContain("*Waiting this week (2):* Zed, Yan");
    expect(out).toContain("3 items in Updates");
    expect(out).toContain("Tuesday Mic (Tue) isn't confirmed");
    expect(out).toContain("*Tomorrow: Tuesday Mic*");
  });
  it("says nothing when there is nothing to say", () => {
    expect(composeDigest({ today: "2026-10-26", todayShows: [], tomorrowShows: [], waiting: [], updates: 0, unconfirmed: [] })).toBeNull();
    expect(composeDigest({ today: "2026-10-26", todayShows: [day({ status: "cancelled" })], tomorrowShows: [], waiting: [], updates: 0, unconfirmed: [] })).toBeNull();
  });
  it("is due once a day, from the chosen time", () => {
    expect(digestDue({ now: { date: "2026-10-26", time: "09:59" }, digestTime: "10:00" })).toBe(false);
    expect(digestDue({ now: { date: "2026-10-26", time: "10:00" }, digestTime: "10:00" })).toBe(true);
    expect(digestDue({ now: { date: "2026-10-26", time: "15:00" }, digestTime: "10:00", lastDigestOn: "2026-10-26" })).toBe(false);
    expect(digestDue({ now: { date: "2026-10-27", time: "10:01" }, digestTime: "10:00", lastDigestOn: "2026-10-26" })).toBe(true);
    // linked or restarted hours late: skip today rather than say good morning at teatime
    expect(digestDue({ now: { date: "2026-10-27", time: "14:01" }, digestTime: "10:00", lastDigestOn: "2026-10-26" })).toBe(false);
    expect(digestDue({ now: { date: "2026-10-27", time: "14:00" }, digestTime: "10:00" })).toBe(true);
  });
});

describe("planning an action (what it repeats back, and what it refuses before asking)", () => {
  const full = (id: string, name: string, weekday: 1 | 2 | 4, over: object = {}) => ({ id, name, weekday, venueId: "v1", active: true, startTime: "20:00", slotCount: 2, includeSlotTime: false, regulars: [], protected: [], ...over });
  const world = (over: Partial<PlanWorld> = {}): PlanWorld => ({
    shows: [full("mon", "Monday Mic", 1), full("tue", "Tuesday Mic", 2), full("thu", "Thursday Open Mic", 4, { venueId: "v1" }), full("thu2", "Thursday Late", 4, { venueId: "v2" })],
    venues,
    week: "2026-10-26",
    todayWeekday: 3,
    lineups: [
      { id: "2026-10-26_mon", showId: "mon", status: "draft", slots: [{ comicId: "a@c.us" }, { comicId: "b@c.us" }] },
      { id: "2026-10-26_tue", showId: "tue", status: "confirmed", slots: [{ comicId: "a@c.us" }], sent: { "a@c.us": { at: 1, minutes: null, order: 0 } } },
    ],
    ...over,
  });
  const people = [
    { id: "919812345612@c.us", name: "Rohan Mehta", phone: "919812345612" },
    { id: "919800000002@c.us", name: "Rohan Iyer", phone: "919800000002" },
    { id: "a@c.us", name: "Asha", phone: "919800000001" },
    { id: "b@c.us", name: "Ben", phone: "919800000009", banned: true },
  ];
  const o = { primaryReady: true, now: 5_000 };

  it("add: repeats exactly what it understood and waits for yes", () => {
    const r = planAction({ name: "add", person: "rohan mehta", day: "tuesday" }, world(), people, o);
    expect(r.pending?.stage).toBe("confirm");
    expect(r.pending?.stage === "confirm" && r.pending.summary).toContain("Add Rohan Mehta (+91 98•••12) to Tuesday Mic, Tue 27 Oct?");
    expect(r.pending?.stage === "confirm" && r.pending.summary).toContain("already confirmed"); // Tuesday is confirmed: they won't be told
    expect(r.pending?.stage === "confirm" && r.pending.plan).toEqual({ type: "add", showId: "tue", comicId: "919812345612@c.us", comicName: "Rohan Mehta", phone: "919812345612" });
    expect(r.pending?.expiresAt).toBe(5_000 + AGENT_CONFIRM_TTL_MS);
  });
  it("add: two Rohans become a numbered list", () => {
    const r = planAction({ name: "add", person: "rohan", day: "tuesday" }, world(), people, o);
    expect(r.pending?.stage).toBe("choose");
    expect(askText(r.pending!)).toMatch(/1\. Rohan Mehta → Tuesday Mic.*\n2\. Rohan Iyer → Tuesday Mic/);
  });
  it("add: two shows on one day and two people make every combination a choice", () => {
    const r = planAction({ name: "add", person: "rohan", day: "thursday" }, world(), people, o);
    expect(r.pending?.stage === "choose" && r.pending.choices).toHaveLength(4);
  });
  it("add: refuses before asking when it is already on, full, or the person is unknown", () => {
    expect(planAction({ name: "add", person: "asha", day: "monday" }, world(), people, o).reply).toBe("Asha is already on Monday Mic.");
    expect(planAction({ name: "add", person: "rohan mehta", day: "monday" }, world(), people, o).reply).toBe("Monday Mic is full (2 of 2).");
    expect(planAction({ name: "add", person: "zed", day: "monday" }, world(), people, o).reply).toContain('couldn\'t find anyone called "zed"');
    expect(planAction({ name: "add", person: "rohan mehta", day: "saturday" }, world(), people, o).reply).toContain("couldn't match");
  });
  it("add: flags someone on the banned list", () => {
    const r = planAction({ name: "add", person: "ben", day: "thursday" }, world({ shows: world().shows.filter((s) => s.id === "thu") }), people, o);
    expect(r.pending?.stage === "confirm" && r.pending.summary).toContain("Banned list");
  });
  it("remove: only people who are on it", () => {
    expect(planAction({ name: "remove", person: "asha", day: "monday" }, world(), people, o).pending?.stage).toBe("confirm");
    expect(planAction({ name: "remove", person: "rohan mehta", day: "monday" }, world(), people, o).reply).toBe("Rohan Mehta isn't on Monday Mic.");
  });
  it("confirm: says who gets it and from where; skips people already told; refuses what's pointless", () => {
    const r = planAction({ name: "confirm", day: "monday" }, world(), people, o);
    expect(r.pending?.stage === "confirm" && r.pending.summary).toBe("Send confirmations for Monday Mic, Mon 26 Oct to 2 people from your own WhatsApp?");
    expect(planAction({ name: "confirm", day: "tuesday" }, world(), people, o).reply).toContain("already confirmed");
    expect(planAction({ name: "confirm", day: "monday" }, world(), people, { ...o, primaryReady: false }).reply).toContain("isn't connected");
    expect(planAction({ name: "confirm", day: "thursday" }, world({ shows: world().shows.filter((s) => s.id === "thu") }), people, o).reply).toContain("Nobody is placed");
    const told = world({ lineups: [{ id: "x", showId: "mon", status: "draft", slots: [{ comicId: "a@c.us" }, { comicId: "b@c.us" }], sent: { "a@c.us": { at: 1, minutes: null, order: 0 } } }] });
    expect(planAction({ name: "confirm", day: "monday" }, told, people, o).pending?.stage === "confirm" && true).toBe(true);
    const r2 = planAction({ name: "confirm", day: "monday" }, told, people, o);
    expect(r2.pending?.stage === "confirm" && r2.pending.summary).toContain("to 1 person (1 already told, skipped)");
  });
  it("outcome: only for a confirmed show", () => {
    expect(planAction({ name: "outcome", day: "tuesday", happened: true }, world(), people, o).pending?.stage).toBe("confirm");
    expect(planAction({ name: "outcome", day: "monday", happened: true }, world(), people, o).reply).toContain("isn't confirmed");
    const marked = world({ lineups: [{ id: "x", showId: "tue", status: "confirmed", outcome: "happened", slots: [] }] });
    expect(planAction({ name: "outcome", day: "tuesday", happened: true }, marked, people, o).reply).toContain("already marked");
  });
  it("retime: 'Bloom moved Thursday to 9 PM' picks the Thursday show at Bloom", () => {
    const r = planAction({ name: "retime", day: "bloom thursday", time: "21:00" }, world(), people, o);
    expect(r.pending?.stage === "confirm" && r.pending.plan).toEqual({ type: "retime", showId: "thu", startTime: "21:00" });
    expect(r.pending?.stage === "confirm" && r.pending.summary).toContain("from 8:00 PM to 9:00 PM");
    expect(planAction({ name: "retime", day: "monday", time: "20:00" }, world(), people, o).reply).toContain("already starts");
  });
  it("end to end: text -> intent -> plan -> yes -> the plan to run", () => {
    const intent = parseIntentByRules("add Rohan Mehta to Tuesday")!;
    const planned = planAction(intent, world(), people, o);
    const r = stepPending(planned.pending, "yes", 6_000);
    expect(r).toMatchObject({ type: "execute", plan: { type: "add", showId: "tue", comicName: "Rohan Mehta" } });
    expect(stepPending(planned.pending, "yes", 5_000 + AGENT_CONFIRM_TTL_MS + 1).type).toBe("expired"); // too late: never runs
  });
});
