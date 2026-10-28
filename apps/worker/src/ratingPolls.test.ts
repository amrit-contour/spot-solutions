import { beforeEach, describe, expect, it, vi } from "vitest";

// Rating a show by tapping polls: when they may go out (quiet hours, no bursts), what is sent (one poll per comic, never the curator,
// then the overall one), and what a vote does (any time, a changed vote replaces the old one). In-memory Firestore + a fake agent number.
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
  get: async () => ({
    docs: [...store].filter(([k, d]) => k.startsWith(prefix) && filters.every(([f, , v]) => getPath(d, f) === v)).map(([k, d]) => ({ id: k.split("/").pop()!, data: () => d, ref: ref(k) })),
  }),
});
vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({ doc: (id: string) => ref(`${uid}/${c}/${id}`), ...query(`${uid}/${c}/`) }),
  userRef: (uid: string) => ({ get: async () => ({ data: () => store.get(`${uid}/user`) }) }),
  sessionRef: (uid: string) => ref(`${uid}/session/state`),
}));
vi.mock("./agentSession.ts", () => ({ agentRef: (uid: string) => ref(`${uid}/session/agent`), agentSessions: { get: () => ({ fake: true }) } }));
const out: { kind: "text" | "poll"; text: string; options?: string[]; id?: string; multi?: boolean; mentions?: string[] }[] = [];
vi.mock("./sendQueue.ts", () => ({
  sendQueued: async (_c: unknown, _to: string, text: string) => void out.push({ kind: "text", text }),
  deliverableId: async (_c: unknown, to: string) => to,
  sendContent: async (_c: unknown, _to: string, content: string | { pollName: string; pollOptions: { name: string }[]; options?: { allowMultipleAnswers?: boolean } }, _t?: number, opts?: { mentions?: string[] }) => {
    if (typeof content === "string") {
      out.push({ kind: "text", text: content, mentions: opts?.mentions });
      return { id: { _serialized: "text" } };
    }
    const id = `poll${out.filter((o) => o.kind === "poll").length + 1}`;
    out.push({ kind: "poll", text: content.pollName, options: content.pollOptions.map((o) => o.name), id, multi: content.options?.allowMultipleAnswers });
    return { id: { _serialized: id } };
  },
}));
vi.mock("./commands.ts", () => ({ loadComics: async (u: string, ids: string[]) => new Map(ids.map((id) => [id, store.get(`${u}/comics/${id}`)]).filter(([, v]) => v) as [string, unknown][]) }));
vi.mock("./userData.ts", () => ({
  settingsFromDoc: (d: unknown) => d,
  watchUser: () => ({ settings: { timezone: "Asia/Kolkata", micCheck: { enabled: true, rate: true, afterHours: 2 } }, shows: [{ id: "mon", name: "Open Mic - Monday", startTime: "20:00" }, { id: "tue", name: "Open Mic - Tuesday", startTime: "20:00" }], venues: [] }),
}));

const { askRatings } = await import("./ratings.ts");
const { applyVote } = await import("./agentPolls.ts");
const { readMemory, writeMemory } = await import("./agentOutbox.ts");
const { reviewComics, reviewLineup } = await import("./ratings.ts");

let n = 0;
let U = "";
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const polls = () => out.filter((o) => o.kind === "poll");
const lineup = (id: string, showId: string, date: string, extra: Record<string, unknown> = {}) =>
  store.set(`${U}/lineups/${id}`, { id, showId, date, status: "confirmed", outcome: "happened", slots: [{ comicId: "11111@c.us" }, { comicId: "22222@c.us" }, { comicId: "33333@c.us" }], ...extra });
const slots = (id: string) => (store.get(`${U}/lineups/${id}`) as { slots: { comicId: string; rating?: number; attendance?: string }[] }).slots;

beforeEach(() => {
  store.clear();
  out.length = 0;
  U = `u${++n}`;
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-28T10:00:00+05:30");
  store.set(`${U}/user`, { settings: { agent: { enabled: true, notify: true } } });
  store.set(`${U}/session/state`, { phone: "919800000001" });
  for (const [id, name] of [["11111@c.us", "Amrit Dash (you)"], ["22222@c.us", "Mohit Comic BLR"], ["33333@c.us", "Bo"]]) store.set(`${U}/comics/${id}`, { id, name, phone: id.split("@")[0], history: [] });
});

describe("when rating questions go out", () => {
  const asked = (id: string) => (store.get(`${U}/lineups/${id}`) as { ratingAskedOn?: string }).ratingAskedOn;
  it("a yes sends the header and polls right away (no waiting for a due time), at any hour", async () => {
    lineup("t1", "tue", "2026-10-27", { outcomeAt: Date.now() });
    at("2026-10-28T00:35:00+05:30");
    store.set(`${U}/lineups/t1`, { ...(store.get(`${U}/lineups/t1`) as object), outcomeAt: Date.now() });
    await askRatings(U);
    expect(out[0]!.kind).toBe("text");
    expect(polls().length).toBeGreaterThan(0);
  });
  it("a yes in the small hours is not held back by quiet hours", async () => {
    lineup("t1", "tue", "2026-10-27");
    at("2026-10-28T00:35:00+05:30");
    await askRatings(U);
    expect(asked("t1")).toBe("2026-10-28");
    expect(polls().length).toBeGreaterThan(0);
  });
  it("a catch-up (over 12h past due, e.g. a 3:45 AM restart) waits until 09:30", async () => {
    lineup("m1", "mon", "2026-10-26");
    for (const t of ["03:47", "09:15"]) {
      at(`2026-10-28T${t}:00+05:30`);
      await askRatings(U);
    }
    expect(out).toHaveLength(0);
    expect(asked("m1")).toBeUndefined();
    at("2026-10-28T09:30:00+05:30");
    await askRatings(U);
    expect(polls().length).toBeGreaterThan(0);
    expect(asked("m1")).toBe("2026-10-28");
  });
  it("answering yes late sends right away, even for a catch-up in the small hours", async () => {
    lineup("m1", "mon", "2026-10-26");
    at("2026-10-28T03:47:00+05:30");
    await askRatings(U, { immediate: true });
    expect(polls().length).toBeGreaterThan(0);
  });
  it("catch-ups: one show now, the next only after the gap, and neither is ever asked twice", async () => {
    lineup("t1", "tue", "2026-10-27");
    lineup("m1", "mon", "2026-10-26");
    at("2026-10-28T10:30:00+05:30"); // both are catch-ups now
    await askRatings(U);
    const first = out.length;
    expect(out[0]!.text).toContain("Open Mic - Tuesday");
    at("2026-10-28T10:32:00+05:30");
    await askRatings(U);
    expect(out).toHaveLength(first);
    at("2026-10-28T10:52:00+05:30");
    await askRatings(U);
    expect(out[first]!.text).toContain("Open Mic - Monday");
    const total = out.length;
    at("2026-10-28T12:00:00+05:30");
    await askRatings(U);
    await askRatings(U);
    expect(out).toHaveLength(total);
  });
  it("a show already asked (ratingAskedOn) is never asked again", async () => {
    lineup("t1", "tue", "2026-10-27", { ratingAskedOn: "2026-10-27" });
    await askRatings(U);
    expect(out).toHaveLength(0);
  });
});

describe("what is sent", () => {
  it("a header that @mentions the comics, one multi-select poll per comic (curator included), then the single-select overall poll; each poll is remembered", async () => {
    lineup("t1", "tue", "2026-10-27");
    await askRatings(U);
    expect(out[0]!.kind).toBe("text");
    expect(out[0]!.text).toContain("Tap a poll for each:");
    expect(out[0]!.text).toContain("1. @11111\n2. @22222\n3. @33333");
    expect(out[0]!.mentions).toEqual(["11111@c.us", "22222@c.us", "33333@c.us"]);
    expect(polls().map((p) => p.text)).toEqual(["Amrit Dash (you), how did they do?", "Mohit Comic BLR, how did they do?", "Bo, how did they do?", "How was Open Mic - Tuesday overall?"]);
    expect(polls()[0]!.options).toEqual(["5 Killed it", "4 Good", "3 OK", "2 Rough", "1 Bombed", "Late", "No-show"]);
    expect(polls().map((p) => p.multi)).toEqual([true, true, true, false]);
    const mem = await readMemory(U);
    expect(mem.ratingPolls?.map((p) => [p.id, p.comicId])).toEqual([["poll1", "11111@c.us"], ["poll2", "22222@c.us"], ["poll3", "33333@c.us"], ["poll4", null]]);
    expect(mem.ratingAsk?.lineupId).toBe("t1");
    expect((store.get(`${U}/lineups/t1`) as { reviewAskedOn?: string }).reviewAskedOn).toBe("2026-10-28");
  });
  it("with polls switched off it asks in text as before", async () => {
    store.set(`${U}/user`, { settings: { agent: { enabled: true, notify: true, agentPolls: false } } });
    lineup("t1", "tue", "2026-10-27");
    await askRatings(U);
    expect(polls()).toHaveLength(0);
    expect(out[0]!.text).toContain("1. Amrit Dash (you)");
  });
});

describe("a vote", () => {
  const said: string[] = [];
  const deps = (now = Date.now()) => ({
    readMemory: () => readMemory(U),
    writeMemory: (p: Record<string, unknown>) => writeMemory(U, p),
    say: async (t: string) => void said.push(t),
    now: () => now,
    answer: async () => undefined,
    review: (l: string, c: string, r: Parameters<typeof reviewComics>[2][string]) => reviewComics(U, l, { [c]: r }),
    overall: (l: string, rating: number) => reviewLineup(U, l, { rating }),
    nameOf: async () => "Mohit Comic BLR",
  });
  beforeEach(async () => {
    said.length = 0;
    lineup("t1", "tue", "2026-10-27");
    await askRatings(U);
  });
  // poll1 = the curator, poll2 = Mohit (slot 2), poll3 = Bo, poll4 = overall
  it("rates that comic's slot, in the lineup and the comic's history; the curator can be rated like anyone", async () => {
    store.set(`${U}/comics/22222@c.us`, { id: "22222@c.us", name: "Mohit Comic BLR", history: [{ date: "2026-10-27", showId: "tue", status: "confirmed" }] });
    expect(await applyVote(deps(), "poll2", ["4 Good"])).toBe("answered");
    expect(slots("t1")[1]).toMatchObject({ comicId: "22222@c.us", rating: 4 });
    expect(slots("t1")[2]!.rating).toBeUndefined();
    expect((store.get(`${U}/comics/22222@c.us`) as { history: { rating?: number }[] }).history[0]!.rating).toBe(4);
    await applyVote(deps(), "poll1", ["5 Killed it"]);
    expect(slots("t1")[0]!.rating).toBe(5);
  });
  it("reads the whole ticked set: Late with a rating, No-show clears the rating, unticking everything clears both", async () => {
    await applyVote(deps(), "poll2", ["3 OK", "Late"]);
    expect(slots("t1")[1]).toMatchObject({ rating: 3, attendance: "late" });
    await applyVote(deps(), "poll2", ["3 OK", "Late", "No-show"]);
    expect(slots("t1")[1]).toMatchObject({ attendance: "no_show" });
    expect(slots("t1")[1]!.rating).toBeUndefined();
    await applyVote(deps(), "poll2", ["2 Rough"]);
    expect(slots("t1")[1]).toMatchObject({ rating: 2 });
    expect(slots("t1")[1]!.attendance == null).toBe(true);
    await applyVote(deps(), "poll2", []);
    expect(slots("t1")[1]).toEqual({ comicId: "22222@c.us" });
    expect(said).toHaveLength(0);
  });
  it("two ratings ticked: the highest is saved and it says so once, briefly", async () => {
    await applyVote(deps(), "poll2", ["2 Rough", "4 Good"]);
    expect(slots("t1")[1]!.rating).toBe(4);
    expect(said).toEqual(["Saved 4 for Mohit Comic BLR (you picked two ratings)."]);
  });
  it("counts days later, and not after the 3 days are over", async () => {
    expect(await applyVote(deps(Date.now() + 2 * 86_400_000), "poll3", ["3 OK"])).toBe("answered");
    expect(slots("t1")[2]!.rating).toBe(3);
    expect(await applyVote(deps(Date.now() + 4 * 86_400_000), "poll2", ["5 Killed it"])).toBe("ignored");
    expect(slots("t1")[1]!.rating).toBeUndefined();
    expect(await applyVote(deps(), "poll999", ["4 Good"])).toBe("ignored");
  });
  it("the overall poll sets the show's rating; Skip leaves it", async () => {
    expect(await applyVote(deps(), "poll4", ["Skip"])).toBe("ignored");
    expect((store.get(`${U}/lineups/t1`) as { review?: unknown }).review ?? null).toBeNull();
    expect(await applyVote(deps(), "poll4", ["4 Good"])).toBe("answered");
    expect((store.get(`${U}/lineups/t1`) as { review?: { rating?: number } }).review?.rating).toBe(4);
    await applyVote(deps(), "poll4", ["2 Rough"]);
    expect((store.get(`${U}/lineups/t1`) as { review?: { rating?: number } }).review?.rating).toBe(2);
  });
});
