import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupStep } from "@spot/shared";

// "Did it happen?" answered NO: the what-happened poll and the repeat-next-week poll, what their votes save, next week's lineup seeded
// from this one, and no second question from the day-after cleanup. In-memory Firestore + a fake agent number.
const store = new Map<string, Record<string, unknown>>();
const getPath = (d: Record<string, unknown>, f: string) => f.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);
const ref = (k: string) => ({
  id: k.split("/").pop()!,
  get: async () => ({ data: () => store.get(k) }),
  update: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
  set: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
});
const query = (prefix: string, filters: [string, string, unknown][] = []) => ({
  where: (f: string, op: string, v: unknown) => query(prefix, [...filters, [f, op, v]]),
  get: async () => ({ docs: [...store].filter(([k, d]) => k.startsWith(prefix) && filters.every(([f, , v]) => getPath(d, f) === v)).map(([k, d]) => ({ id: k.split("/").pop()!, data: () => d, ref: ref(k) })) }),
});
vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({ doc: (id: string) => ref(`${uid}/${c}/${id}`), ...query(`${uid}/${c}/`) }),
  userRef: (uid: string) => ({ get: async () => ({ data: () => store.get(`${uid}/user`) }) }),
  sessionRef: (uid: string) => ref(`${uid}/session/state`),
}));
vi.mock("./agentSession.ts", () => ({ agentRef: (uid: string) => ref(`${uid}/session/agent`), agentSessions: { get: () => ({ fake: true }) } }));
const out: { kind: "text" | "poll"; text: string; options?: string[]; multi?: boolean; id?: string }[] = [];
vi.mock("./sendQueue.ts", () => ({
  sendQueued: async (_c: unknown, _to: string, text: string) => void out.push({ kind: "text", text }),
  deliverableId: async (_c: unknown, to: string) => to,
  sendContent: async (_c: unknown, _to: string, content: { pollName: string; pollOptions: { name: string }[]; options?: { allowMultipleAnswers?: boolean } }) => {
    const id = `poll${++pollN}`;
    out.push({ kind: "poll", text: content.pollName, options: content.pollOptions.map((o) => o.name), multi: content.options?.allowMultipleAnswers, id });
    return { id: { _serialized: id } };
  },
}));
let pollN = 0;
let aiReasons: unknown = null;
vi.mock("./llm.ts", () => ({
  generateJson: async () => {
    if (!aiReasons) throw new Error("no model");
    return { text: JSON.stringify(aiReasons) };
  },
}));
let cleanupOn = false;
vi.mock("./userData.ts", () => ({
  settingsFromDoc: (d: unknown) => d,
  watchUser: () => ({
    settings: { timezone: "Asia/Kolkata", micCheck: { enabled: true, rate: true, afterHours: 2 } },
    shows: [{ id: "tue", name: "Open Mic - Tuesday", weekday: 2, startTime: "20:00", groupId: cleanupOn ? "g@g.us" : undefined, cleanup: cleanupOn ? { enabled: true, mode: "ask", time: "10:00" } : undefined }],
    venues: [],
  }),
}));

const { askDidntHappen, askRepeatAgain, answerNoText } = await import("./noShow.ts");
const { applyVote } = await import("./agentPolls.ts");
const { readMemory, writeMemory } = await import("./agentOutbox.ts");
const { setWhy, setNote, answerRepeat } = await import("./noShow.ts");
const { seedAfterKeep } = await import("./repeatNext.ts");
const { parseNoNote } = await import("@spot/shared");

let n = 0;
let U = "";
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const polls = () => out.filter((o) => o.kind === "poll");
const L = (id: string) => store.get(`${U}/lineups/${id}`) as Record<string, any>;
const lineup = (extra: Record<string, unknown> = {}) =>
  store.set(`${U}/lineups/2026-10-26_tue`, { id: "2026-10-26_tue", weekOf: "2026-10-26", showId: "tue", date: "2026-10-27", status: "canned", outcome: "canned", outcomeAt: Date.now(), slots: [{ comicId: "a@c.us", minutes: 5, rating: 4 }, { comicId: "b@c.us" }], ...extra });
const NEXT = "2026-11-02_tue";

const deps = () => ({
  readMemory: () => readMemory(U),
  writeMemory: (p: Record<string, unknown>) => writeMemory(U, p),
  say: async (t: string) => void said.push(t),
  now: () => Date.now(),
  answer: async () => undefined,
  why: (l: string, r: string[]) => setWhy(U, l, r),
  repeat: (l: string, c: "repeat" | "no" | "later") => answerRepeat(U, l, c),
});
const said: string[] = [];

beforeEach(() => {
  store.clear();
  out.length = 0;
  pollN = 0;
  said.length = 0;
  aiReasons = null;
  cleanupOn = false;
  U = `u${++n}`;
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-27T22:10:00+05:30");
  store.set(`${U}/user`, { settings: { agent: { enabled: true, notify: true } } });
  store.set(`${U}/session/state`, { phone: "919800000001" });
  lineup();
});

describe("a no sends the two polls", () => {
  it("what happened (multi-select, presets) then repeat next week (single-select), each remembered", async () => {
    await askDidntHappen(U, { immediate: true });
    expect(out[0]!.kind).toBe("text");
    expect(out[0]!.text).toContain("note: …");
    expect(polls().map((p) => p.text)).toEqual(["What happened at Open Mic - Tuesday?", "Repeat this lineup next week?"]);
    expect(polls()[0]!.options).toEqual(["No audience", "Too few comics", "Venue cancelled", "Weather/rain", "Clash/event at venue", "Called off by me", "Other"]);
    expect(polls()[0]!.multi).toBe(true);
    expect(polls()[1]!.options).toEqual(["Repeat", "Don't repeat", "Not decided"]);
    expect(polls()[1]!.multi).toBe(false);
    expect((await readMemory(U)).ratingPolls?.map((p) => [p.id, p.kind])).toEqual([["poll1", "why"], ["poll2", "repeat"]]);
    expect(L("2026-10-26_tue").noAskedOn).toBe("2026-10-27");
  });
  it("the model's suggestions are used when there is a model, with Other last", async () => {
    aiReasons = { reasons: ["Heavy rain", "Venue double-booked", "No audience", "Host unwell"] };
    store.set(`${U}/user`, { settings: { ai: { policy: "auto" }, agent: { enabled: true, notify: true } } });
    await askDidntHappen(U, { immediate: true });
    expect(polls()[0]!.options).toEqual(["Heavy rain", "Venue double-booked", "No audience", "Host unwell", "Other"]);
  });
  it("is asked once, and not when already answered (repeatNext known skips the repeat poll)", async () => {
    await askDidntHappen(U, { immediate: true });
    const sent = out.length;
    await askDidntHappen(U, { immediate: true });
    expect(out).toHaveLength(sent);
    out.length = 0;
    lineup({ repeatNext: false });
    await askDidntHappen(U, { immediate: true });
    expect(polls().map((p) => p.text)).toEqual(["What happened at Open Mic - Tuesday?"]);
  });
  it("a backlog (a no from over 12 hours ago) waits for 09:30; a fresh one does not", async () => {
    lineup({ outcomeAt: Date.now() - 14 * 3_600_000 });
    at("2026-10-28T03:45:00+05:30");
    await askDidntHappen(U);
    expect(out).toHaveLength(0);
    at("2026-10-28T09:30:00+05:30");
    await askDidntHappen(U);
    expect(polls()).toHaveLength(2);
    out.length = 0;
    lineup({ outcomeAt: Date.now() });
    store.set(`${U}/lineups/2026-10-26_tue`, { ...L("2026-10-26_tue"), noAskedOn: null });
    at("2026-10-28T03:50:00+05:30");
    lineup({ outcomeAt: Date.now() });
    await askDidntHappen(U);
    expect(polls().length).toBeGreaterThan(0);
  });
});

describe("reasons and a note", () => {
  it("ticked reasons and a typed note are saved on the lineup and in the review notes; a changed vote replaces", async () => {
    await askDidntHappen(U, { immediate: true });
    await applyVote(deps(), "poll1", ["No audience", "Weather/rain"]);
    expect(L("2026-10-26_tue").noReasons).toEqual(["No audience", "Weather/rain"]);
    expect(L("2026-10-26_tue").review.notes).toBe("Didn't happen: No audience, Weather/rain.");
    await applyVote(deps(), "poll1", ["Venue cancelled"]);
    expect(L("2026-10-26_tue").review.notes).toBe("Didn't happen: Venue cancelled.");
    await setNote(U, "2026-10-26_tue", "flooded road");
    expect(L("2026-10-26_tue").review.notes).toBe("Didn't happen: Venue cancelled. flooded road");
    await applyVote(deps(), "poll1", []);
    expect(L("2026-10-26_tue").review.notes).toBe("flooded road");
  });
  it("'note: ...' typed after the question is saved; an ordinary message is not read as one", async () => {
    await askDidntHappen(U, { immediate: true });
    expect(await answerNoText(U, "Monday lineup?", parseNoNote)).toBeNull();
    expect(await answerNoText(U, "note: rain all day", parseNoNote)).toContain("Saved");
    expect(L("2026-10-26_tue").noNote).toBe("rain all day");
    expect(L("2026-10-26_tue").review.notes).toContain("rain all day");
  });
});

describe("repeat next week", () => {
  it("Repeat sets repeatNext, seeds next week's lineup from these comics and tags it", async () => {
    await askDidntHappen(U, { immediate: true });
    expect(await applyVote(deps(), "poll2", ["Repeat"])).toBe("answered");
    expect(L("2026-10-26_tue").repeatNext).toBe(true);
    expect(L(NEXT)).toMatchObject({ weekOf: "2026-11-02", showId: "tue", date: "2026-11-03", status: "draft", repeatOf: "2026-10-27" });
    expect(L(NEXT).slots).toEqual([{ comicId: "a@c.us", minutes: 5 }, { comicId: "b@c.us" }]);
    expect(said[0]).toContain("repeat of");
  });
  it("leaves next week alone when it already has people", async () => {
    store.set(`${U}/lineups/${NEXT}`, { id: NEXT, weekOf: "2026-11-02", showId: "tue", date: "2026-11-03", status: "draft", slots: [{ comicId: "z@c.us" }] });
    await askDidntHappen(U, { immediate: true });
    await applyVote(deps(), "poll2", ["Repeat"]);
    expect(L("2026-10-26_tue").repeatNext).toBe(true);
    expect(L(NEXT).slots).toEqual([{ comicId: "z@c.us" }]);
    expect(L(NEXT).repeatOf).toBeUndefined();
  });
  it("Don't repeat sets repeatNext false; changing to Repeat later still works", async () => {
    await askDidntHappen(U, { immediate: true });
    await applyVote(deps(), "poll2", ["Don't repeat"]);
    expect(L("2026-10-26_tue").repeatNext).toBe(false);
    expect(L(NEXT)).toBeUndefined();
    await applyVote(deps(), "poll2", ["Repeat"]);
    expect(L("2026-10-26_tue").repeatNext).toBe(true);
    expect(L(NEXT).repeatOf).toBe("2026-10-27");
  });
  it("Not decided leaves it unset and the next morning asks again, once the day has turned", async () => {
    await askDidntHappen(U, { immediate: true });
    await applyVote(deps(), "poll2", ["Not decided"]);
    expect(L("2026-10-26_tue").repeatNext ?? null).toBeNull();
    out.length = 0;
    expect(await askRepeatAgain(U, "2026-10-27")).toBe(false); // same day: not yet
    expect(await askRepeatAgain(U, "2026-10-28")).toBe(true);
    expect(polls()[0]!.text).toBe("Repeat Tuesday's lineup (Open Mic - Tuesday)?");
    const again = (await readMemory(U)).ratingPolls!.find((p) => p.id === "poll3")!;
    expect(again.kind).toBe("repeat");
    await applyVote(deps(), "poll3", ["Repeat"]);
    expect(L("2026-10-26_tue").repeatNext).toBe(true);
    out.length = 0;
    expect(await askRepeatAgain(U, "2026-10-29")).toBe(false); // answered: never again
  });
  it("votes still count 2 days later and not after the 3 days", async () => {
    await askDidntHappen(U, { immediate: true });
    const late = (days: number) => ({ ...deps(), now: () => Date.now() + days * 86_400_000 });
    expect(await applyVote(late(2), "poll1", ["No audience"])).toBe("answered");
    expect(await applyVote(late(4), "poll2", ["Repeat"])).toBe("ignored");
    expect(L("2026-10-26_tue").repeatNext).toBeUndefined();
  });
  it("typed 'repeat' works while the question waits", async () => {
    await askDidntHappen(U, { immediate: true });
    expect(await answerNoText(U, "repeat", parseNoNote)).toContain("Next week's lineup starts");
    expect(L("2026-10-26_tue").repeatNext).toBe(true);
  });
});

describe("one question, not two, with the group cleanup", () => {
  const show = { groupId: "g@g.us", cleanup: { enabled: true, mode: "ask", time: "10:00" } } as never;
  const now = { date: "2026-10-28", time: "10:30" };
  it("answering Repeat answers the cleanup's keep-everyone question: it is marked kept and never asks", async () => {
    cleanupOn = true;
    await askDidntHappen(U, { immediate: true });
    expect(cleanupStep(show, L("2026-10-26_tue") as never, now, true)).toBe("ask"); // would have asked tomorrow
    await applyVote(deps(), "poll2", ["Repeat"]);
    expect(L("2026-10-26_tue").cleanup).toMatchObject({ status: "kept" });
    expect(cleanupStep(show, L("2026-10-26_tue") as never, now, true)).toBeNull();
  });
  it("and the other way: the cleanup's keep (which sets repeatNext) brings next week's lineup along", async () => {
    store.set(`${U}/lineups/2026-10-26_tue`, { ...L("2026-10-26_tue"), repeatNext: true, cleanup: { status: "kept", at: 1 } });
    await seedAfterKeep(U, "2026-10-26_tue");
    expect(L(NEXT).repeatOf).toBe("2026-10-27");
    expect(L(NEXT).slots).toHaveLength(2);
  });
  it("the morning re-ask is left to the cleanup for a show whose group it clears", async () => {
    cleanupOn = true;
    await askDidntHappen(U, { immediate: true });
    await applyVote(deps(), "poll2", ["Not decided"]);
    out.length = 0;
    expect(await askRepeatAgain(U, "2026-10-28")).toBe(false);
  });
});
