import { beforeEach, describe, expect, it, vi } from "vitest";
import { inMemberSet, memberKeySet, pairKey, personGroups } from "@spot/shared";
import type { Comic, Lineup, Show, SpotRequest } from "@spot/shared";

// Merging a duplicate comic (the same person under a phone id and an @lid) against an in-memory Firestore that supports what the
// merge uses: getAll, where(== / in / >=), add, batches of set/update/delete. Everything the dropped doc owned must end up on the kept one.
// `io` counts round trips (each get, getAll, add and commit) and documents read, so the tests can hold the merge to targeted queries.
const store = new Map<string, Record<string, unknown>>();
const io = { trips: 0, docsRead: 0, latencyMs: 0 };
const trip = async (docs = 0) => {
  io.trips++;
  io.docsRead += docs;
  if (io.latencyMs) await new Promise((r) => setTimeout(r, io.latencyMs));
};
const getPath = (d: Record<string, unknown>, f: string) => f.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
type Filter = [string, string, unknown];
const test = (d: Record<string, unknown>, [f, op, v]: Filter) => {
  const x = getPath(d, f);
  if (op === "in") return (v as unknown[]).includes(x);
  if (op === ">=") return x !== undefined && (x as string) >= (v as string);
  return x === v;
};
const snapOf = (k: string) => ({ id: k.split("/").pop()!, exists: store.has(k), data: () => clone(store.get(k)), get: (f: string) => getPath(store.get(k) ?? {}, f), ref: ref(k) });
const ref = (k: string): { id: string; path: string; get: () => Promise<ReturnType<typeof snapOf>> } => ({
  id: k.split("/").pop()!,
  path: k,
  get: async () => (await trip(1), snapOf(k)),
});
const query = (prefix: string, filters: Filter[] = []) => ({
  where: (f: string, op: string, v: unknown) => {
    if (op === "in" && (!Array.isArray(v) || !v.length || v.length > 30)) throw new Error(`'in' needs 1 to 30 values, got ${Array.isArray(v) ? v.length : v}`);
    return query(prefix, [...filters, [f, op, v]]);
  },
  get: async () => {
    const docs = [...store].filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/") && filters.every((fl) => test(d, fl))).map(([k]) => snapOf(k));
    await trip(docs.length);
    return { docs };
  },
});
const batchSizes: number[] = [];
vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({ doc: (id: string) => ref(`${uid}/${c}/${id}`), add: async (d: Record<string, unknown>) => (await trip(), store.set(`${uid}/${c}/n${store.size}`, clone(d))), ...query(`${uid}/${c}/`) }),
  userRef: (uid: string) => ref(`users/${uid}`),
  expireAt: (days: number) => days,
  db: {
    getAll: async (...refs: { path: string }[]) => (await trip(refs.length), refs.map((r) => snapOf(r.path))),
    batch: () => {
      const ops: (() => void)[] = [];
      return {
        set: (r: { path: string }, d: Record<string, unknown>) => void ops.push(() => store.set(r.path, clone(d))),
        update: (r: { path: string }, d: Record<string, unknown>) =>
          void ops.push(() => {
            if (!store.has(r.path)) throw new Error(`no document to update: ${r.path}`);
            store.set(r.path, { ...store.get(r.path), ...clone(d) });
          }),
        delete: (r: { path: string }) => void ops.push(() => store.delete(r.path)),
        commit: async () => (await trip(), batchSizes.push(ops.length), ops.forEach((o) => o())),
      };
    },
  },
}));

const { mergeComicDocs, autoMergeDuplicates } = await import("./mergeComics.ts");

const U = "u1";
const PHONE = "919876543210@c.us";
const LID = "55501234@lid";
const put = (c: string, id: string, d: object) => void store.set(`${U}/${c}/${id}`, { id, ...d });
const get = <T,>(c: string, id: string) => store.get(`${U}/${c}/${id}`) as T | undefined;
const all = <T,>(c: string) => [...store].filter(([k]) => k.startsWith(`${U}/${c}/`)).map(([, d]) => d as T);
const req = (weekOf: string, comicId: string, o: Partial<SpotRequest> = {}) => put("requests", `${weekOf}_${comicId}`, { comicId, comicName: comicId === PHONE ? "Aman Gupta" : "Aman", weekOf, messages: [], intent: { isSpotRequest: true, confidence: 1, preferredDays: [] }, status: "new", createdAt: 1, updatedAt: 1, ...o });

const hist = (date: string, showId: string, o: object = {}) => ({ date, showId, showName: showId, status: "confirmed", ...o });

function beforeEachSeed() {
  put("comics", PHONE, {
    name: "Aman",
    nameSource: "whatsapp",
    phone: "919876543210",
    tier: "open",
    notes: "reliable",
    regularOf: ["tue"],
    lastPerformedWeek: "2026-10-12",
    history: [hist("2026-10-12", "tue", { rating: 4 }), hist("2026-09-28", "tue", { note: "new bit worked" })],
  });
  put("comics", LID, {
    name: "Aman Gupta",
    nameSource: "manual",
    phone: "",
    chatId: LID,
    tier: "regular",
    notes: "bring own mic",
    regularOf: ["tue", "fri"],
    lastPerformedWeek: "2026-10-19",
    photoUrl: "https://pic/aman.jpg",
    photoAt: 99,
    // the 12 Oct entry is the same show as on the phone doc, with a rating and tags the phone doc never got; 19 Oct is new
    history: [hist("2026-10-19", "fri", { rating: 5, attendance: "late", tags: ["Killed"], note: "ran over" }), hist("2026-10-12", "tue", { rating: 4, tags: ["Hack"], attendance: "showed" })],
  });
  put("comics", "919111111111@c.us", { name: "Other", phone: "919111111111", tier: "open" });
}

beforeEach(() => {
  store.clear();
  batchSizes.length = 0;
  io.trips = 0;
  io.docsRead = 0;
  beforeEachSeed();
});

const merge = () => mergeComicDocs(U, { keepId: PHONE, dropIds: [LID] });

describe("mergeComicDocs", () => {
  it("deletes the dropped doc, keeps the other comics, and reports what it moved", async () => {
    req("2026-10-26", LID);
    const r = await merge();
    expect(r.merged).toBe(1);
    expect(get("comics", LID)).toBeUndefined();
    expect(get("comics", PHONE)).toBeDefined();
    expect(get("comics", "919111111111@c.us")).toBeDefined();
    expect(r.moved.requests).toBe(1);
  });

  it("moves requests to the kept id; for the same week the newer request wins, either way round", async () => {
    req("2026-10-26", LID, { updatedAt: 500, status: "acked", comicName: "Aman" }); // only the lid asked
    req("2026-11-02", PHONE, { updatedAt: 100 }); // both asked: lid newer
    req("2026-11-02", LID, { updatedAt: 900, status: "confirmed" });
    req("2026-11-09", PHONE, { updatedAt: 800, status: "assigned" }); // both asked: phone newer
    req("2026-11-09", LID, { updatedAt: 200 });
    await merge();
    const ids = all<SpotRequest>("requests").map((r) => r.id).sort();
    expect(ids).toEqual(["2026-10-26_" + PHONE, "2026-11-02_" + PHONE, "2026-11-09_" + PHONE]);
    for (const r of all<SpotRequest>("requests")) {
      expect(r.comicId).toBe(PHONE);
      expect(r.comicName).toBe("Aman Gupta"); // the kept doc's name after the merge
    }
    expect(get<SpotRequest>("requests", `2026-10-26_${PHONE}`)!.status).toBe("acked");
    expect(get<SpotRequest>("requests", `2026-11-02_${PHONE}`)!.status).toBe("confirmed");
    expect(get<SpotRequest>("requests", `2026-11-09_${PHONE}`)!.status).toBe("assigned");
  });

  it("two dropped docs that both asked the same week leave the newest of all three", async () => {
    const LID2 = "77777@lid";
    put("comics", LID2, { name: "Aman", phone: "", tier: "open" });
    req("2026-11-02", PHONE, { updatedAt: 300 });
    req("2026-11-02", LID, { updatedAt: 900, status: "confirmed" });
    req("2026-11-02", LID2, { updatedAt: 600, status: "acked" });
    await mergeComicDocs(U, { keepId: PHONE, dropIds: [LID2, LID] }); // the older one is processed last
    expect(all<SpotRequest>("requests")).toHaveLength(1);
    expect(get<SpotRequest>("requests", `2026-11-02_${PHONE}`)!.status).toBe("confirmed");
  });

  it("points lineups at the kept id without duplicating a slot, and keeps the slot's rating, note, attendance, tags and live pill", async () => {
    const lineup = (id: string, slots: Lineup["slots"], o: object = {}) => put("lineups", id, { weekOf: id.split("_")[0], showId: id.split("_")[1], date: "2026-10-27", status: "confirmed", slots, ...o });
    lineup("2026-10-26_tue", [{ comicId: "x@c.us" }, { comicId: LID, minutes: 5 }, { comicId: PHONE }], {
      sent: { [LID]: { at: 1, minutes: 5, order: 1 }, [PHONE]: { at: 2, minutes: 5, order: 2 } },
      groupInvites: { [LID]: 10 },
      groupLeaving: [LID, PHONE],
      dropped: [{ comicId: LID, at: 3 }],
    });
    // only the lid is on this one, with everything the review sheet and show watch write
    lineup("2026-11-02_fri", [{ comicId: LID, adhoc: true, rating: 4, note: "solid", attendance: "late", tags: ["Killed"], live: { kind: "late", at: 5, msgId: "m1", snippet: "10 min", expireAt: 9 } }], { repeatOf: "2026-10-26", review: { rating: 4, at: 1 }, groupSync: { status: "pending", toAdd: [LID], toRemove: [], kept: [PHONE, "x@c.us"], lapsed: [LID], invited: { [LID]: 4 }, results: { [LID]: "added" } } });
    lineup("2026-11-09_tue", [{ comicId: "x@c.us" }]);
    const r = await merge();
    expect(r.moved.lineups).toBe(2);
    const a = get<Lineup>("lineups", "2026-10-26_tue")!;
    expect(a.slots.map((s) => s.comicId)).toEqual(["x@c.us", PHONE]);
    expect(a.slots[1].minutes).toBe(5); // the slot that was the lid's first, with its set length
    expect(Object.keys(a.sent!).sort()).toEqual([PHONE]);
    expect(a.sent![PHONE].at).toBe(2); // the kept comic's own record wins
    expect(a.groupInvites).toEqual({ [PHONE]: 10 });
    expect(a.groupLeaving).toEqual([PHONE]);
    expect(a.dropped).toEqual([{ comicId: PHONE, at: 3 }]);
    const b = get<Lineup>("lineups", "2026-11-02_fri")!;
    expect(b.slots).toEqual([{ comicId: PHONE, adhoc: true, rating: 4, note: "solid", attendance: "late", tags: ["Killed"], live: { kind: "late", at: 5, msgId: "m1", snippet: "10 min", expireAt: 9 } }]);
    expect(b.repeatOf).toBe("2026-10-26");
    expect(b.review).toEqual({ rating: 4, at: 1 });
    expect(b.groupSync).toEqual({ status: "pending", toAdd: [PHONE], toRemove: [], kept: [PHONE, "x@c.us"], lapsed: [PHONE], invited: { [PHONE]: 4 }, results: { [PHONE]: "added" } });
    expect(get<Lineup>("lineups", "2026-11-09_tue")!.slots).toEqual([{ comicId: "x@c.us" }]);
  });

  it("when both docs were on the same lineup the slots collapse into one that keeps what either had", async () => {
    put("lineups", "2026-10-26_tue", { weekOf: "2026-10-26", showId: "tue", date: "2026-10-27", status: "confirmed", slots: [{ comicId: PHONE, minutes: 5 }, { comicId: LID, minutes: 7, rating: 3, note: "ok", attendance: "late", tags: ["Hack"], adhoc: true }] });
    await merge();
    const s = get<Lineup>("lineups", "2026-10-26_tue")!.slots;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ comicId: PHONE, minutes: 5, rating: 3, note: "ok", attendance: "late", tags: ["Hack"] });
  });

  it("swaps regulars, pocs and protected in shows (once) and leaves the group member cache alone", async () => {
    const members = [{ id: PHONE, name: "Aman", isAdmin: false, alt: [LID] }];
    put("shows", "tue", { name: "Tue", regulars: [LID, "x@c.us", PHONE], protected: [LID], pocs: ["x@c.us", LID], groupMembers: { groupId: "g@g.us", at: 1, members } });
    put("shows", "fri", { name: "Fri", regulars: ["x@c.us"], protected: [], pocs: [] });
    const r = await merge();
    expect(r.moved.shows).toBe(1);
    const t = get<Show>("shows", "tue")!;
    expect(t.regulars).toEqual([PHONE, "x@c.us"]);
    expect(t.protected).toEqual([PHONE]);
    expect(t.pocs).toEqual(["x@c.us", PHONE]);
    expect(t.groupMembers!.members).toEqual(members);
    expect(get<Show>("shows", "fri")!.regulars).toEqual(["x@c.us"]);
  });

  it("the kept comic is still found in the group by its phone, its @lid and the old id, and is no longer a duplicate", async () => {
    await merge();
    const keep = get<Comic>("comics", PHONE)!;
    for (const members of [[{ id: PHONE, name: "A", isAdmin: false }], [{ id: LID, name: "A", isAdmin: false }], [{ id: "x@c.us", name: "A", isAdmin: false, alt: [LID] }]]) expect(inMemberSet(keep, memberKeySet(members))).toBe(true);
    expect(personGroups(all<Comic>("comics"))).toHaveLength(2);
    expect(keep.chatId).toBe(LID); // the id WhatsApp delivers to carries over (knownComicId finds the person by chatId)
    expect(keep.aliases).toBeUndefined();
  });

  it("a kept doc with its own delivery id keeps the dropped id as an alias, so knownComicId still finds it", async () => {
    put("comics", PHONE, { ...get<Comic>("comics", PHONE)!, chatId: "999@lid" });
    await merge();
    expect(get<Comic>("comics", PHONE)!.chatId).toBe("999@lid");
    expect(get<Comic>("comics", PHONE)!.aliases).toEqual([LID]);
  });

  it("re-points offers and actions at the kept comic", async () => {
    put("offers", "o1", { comicId: LID, comicName: "Aman", status: "pending" });
    put("offers", "o2", { comicId: "x@c.us", comicName: "X", status: "pending" });
    put("actions", "a1", { comicId: LID, comicName: "Aman", status: "pending", draft: "hi" });
    const r = await merge();
    expect(r.moved).toMatchObject({ offers: 1, actions: 1 });
    expect(get("offers", "o1")).toMatchObject({ comicId: PHONE, comicName: "Aman Gupta", status: "pending" });
    expect(get("offers", "o2")).toMatchObject({ comicId: "x@c.us", comicName: "X" });
    expect(get("actions", "a1")).toMatchObject({ comicId: PHONE, comicName: "Aman Gupta", draft: "hi" });
  });

  it("combines history without duplicates, filling in ratings, notes, attendance and tags either doc had, newest first", async () => {
    await merge();
    const h = get<Comic>("comics", PHONE)!.history!;
    expect(h.map((e) => `${e.date}|${e.showId}`)).toEqual(["2026-10-19|fri", "2026-10-12|tue", "2026-09-28|tue"]);
    expect(h[0]).toMatchObject({ rating: 5, attendance: "late", tags: ["Killed"], note: "ran over" });
    // the same show on both docs: the kept doc's rating stands, what only the other recorded is added
    expect(h[1]).toMatchObject({ rating: 4, attendance: "showed", tags: ["Hack"] });
    expect(h[2]).toMatchObject({ note: "new bit worked" });
  });

  it("merges photo, tier, regularOf, notes, name, last performed, phone and chat id sensibly", async () => {
    await merge();
    const c = get<Comic>("comics", PHONE)!;
    expect(c).toMatchObject({ id: PHONE, name: "Aman Gupta", nameSource: "manual", phone: "919876543210", tier: "regular", lastPerformedWeek: "2026-10-19", photoUrl: "https://pic/aman.jpg", photoAt: 99 });
    expect(c.regularOf).toEqual(["tue", "fri"]);
    expect(c.notes).toBe("reliable\nbring own mic");
    expect(Object.values(c).includes(undefined)).toBe(false);
  });

  it("does not repeat a note both docs already carry, and a real photo replaces a hidden one", async () => {
    put("comics", PHONE, { ...get<Comic>("comics", PHONE)!, notes: "reliable\nbring own mic", photoUrl: "none", photoAt: 5 });
    await merge();
    const c = get<Comic>("comics", PHONE)!;
    expect(c.notes).toBe("reliable\nbring own mic");
    expect(c.photoUrl).toBe("https://pic/aman.jpg");
  });

  it("is safe to run twice, and refuses nonsense", async () => {
    await merge();
    const before = clone([...store]);
    expect((await merge()).merged).toBe(0);
    expect([...store]).toEqual(before);
    await expect(mergeComicDocs(U, { keepId: PHONE, dropIds: [PHONE] })).rejects.toThrow(/at least one/);
    await expect(mergeComicDocs(U, { keepId: "gone@c.us", dropIds: [LID] })).rejects.toThrow(/gone/);
  });

  it("commits in batches of at most 400 writes", async () => {
    for (let i = 0; i < 450; i++) put("offers", `o${i}`, { comicId: LID, comicName: "Aman", status: "expired" });
    await merge();
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(400);
    expect(all<{ comicId: string }>("offers").every((o) => o.comicId === PHONE)).toBe(true);
  });
});

// A busy account: 6 shows a week for a year and a half of lineups, 600 requests, and a duplicate who asked 8 times and played 10 shows.
function busyAccount() {
  const weeks = Array.from({ length: 78 }, (_, i) => new Date(Date.UTC(2025, 4, 5) + i * 7 * 86_400_000).toISOString().slice(0, 10));
  const shows = ["mon", "tue", "wed", "thu", "fri", "sat"];
  shows.forEach((s) => put("shows", s, { name: s, regulars: ["x@c.us"], protected: [], pocs: [] }));
  for (const w of weeks) for (const s of shows) put("lineups", `${w}_${s}`, { weekOf: w, showId: s, date: w, status: "confirmed", slots: Array.from({ length: 8 }, (_, i) => ({ comicId: `9190000${i}@c.us` })) });
  for (let i = 0; i < 600; i++) put("requests", `${weeks[i % 78]}_r${i}@c.us`, { comicId: `r${i}@c.us`, weekOf: weeks[i % 78], updatedAt: 1 });
  const played = weeks.slice(-30, -20);
  played.forEach((w, i) => put("lineups", `${w}_${shows[i % 6]}`, { weekOf: w, showId: shows[i % 6], date: w, status: "confirmed", slots: [{ comicId: LID }, { comicId: "y@c.us" }] }));
  put("comics", LID, { ...get<Comic>("comics", LID)!, history: played.map((w, i) => hist(w, shows[i % 6])) });
  weeks.slice(-8).forEach((w, i) => req(w, LID, { updatedAt: 10 + i }));
  weeks.slice(-8, -4).forEach((w) => req(w, PHONE, { updatedAt: 5 }));
  for (let i = 0; i < 3; i++) put("offers", `o${i}`, { comicId: LID, comicName: "Aman", status: "expired" });
  for (let i = 0; i < 2; i++) put("actions", `a${i}`, { comicId: LID, comicName: "Aman", status: "done" });
  // this week's draft has them on it too (no history entry yet)
  put("lineups", `${weeks[77]}_tue`, { weekOf: weeks[77], showId: "tue", date: weeks[77], status: "draft", slots: [{ comicId: LID }], groupInvites: { [LID]: 1 } });
  return weeks;
}

describe("mergeComicDocs cost", () => {
  // Before (every lineup read, each query after the last): 15 round trips, 497 docs, ~630 ms at 40 ms a trip on this account.
  it("reads only what can mention the dropped id, in parallel, and still moves everything", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
    busyAccount();
    io.trips = 0;
    io.docsRead = 0;
    io.latencyMs = 40;
    const t0 = performance.now();
    const r = await mergeComicDocs(U, { keepId: PHONE, dropIds: [LID] });
    const ms = performance.now() - t0;
    io.latencyMs = 0;
    vi.useRealTimers();
    expect(r.moved).toEqual({ requests: 8, lineups: 11, shows: 0, offers: 3, actions: 2 });
    expect(all<Lineup>("lineups").filter((l) => l.slots.some((s) => s.comicId === LID) || (l.groupInvites && LID in l.groupInvites))).toEqual([]);
    expect(io.docsRead).toBeLessThan(200);
    expect(io.trips).toBeLessThanOrEqual(12);
    expect(ms).toBeLessThan(6 * 40 + 150); // four sequential rounds: comics, queries, stored requests + old weeks, one batch
  });

  it("finds an old lineup through a history date, a request week or the last performed week", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
    const lineup = (weekOf: string, showId: string, date: string) => put("lineups", `${weekOf}_${showId}`, { weekOf, showId, date, status: "confirmed", slots: [{ comicId: LID }] });
    lineup("2025-01-06", "tue", "2025-01-07"); // in history
    lineup("2025-02-03", "fri", "2025-02-07"); // they asked that week
    lineup("2025-03-03", "sat", "2025-03-08"); // their last performed week
    lineup("2025-04-07", "sun", "2025-04-13"); // nothing points here: left alone (a stale id on an old record)
    put("comics", LID, { ...get<Comic>("comics", LID)!, history: [hist("2025-01-07", "tue")], lastPerformedWeek: "2025-03-03" });
    req("2025-02-03", LID);
    const r = await merge();
    vi.useRealTimers();
    expect(r.moved.lineups).toBe(3);
    expect(get<Lineup>("lineups", "2025-04-07_sun")!.slots[0].comicId).toBe(LID);
    for (const id of ["2025-01-06_tue", "2025-02-03_fri", "2025-03-03_sat"]) expect(get<Lineup>("lineups", id)!.slots[0].comicId).toBe(PHONE);
  });

  it("more than 30 dropped ids are queried in chunks", async () => {
    const ids = Array.from({ length: 35 }, (_, i) => `${7000 + i}@lid`);
    ids.forEach((id) => (put("comics", id, { name: "Aman", phone: "" }), put("offers", `of-${id}`, { comicId: id, comicName: "Aman", status: "expired" })));
    const r = await mergeComicDocs(U, { keepId: PHONE, dropIds: ids });
    expect(r.merged).toBe(35);
    expect(r.moved.offers).toBe(35);
  });
});

describe("autoMergeDuplicates", () => {
  const members = [{ id: PHONE, name: "Aman", isAdmin: false, alt: [LID] }];
  const notices = () => all<{ text: string; level: string }>("notices");

  it("merges a phone id and the @lid of the same account, and says so once in Updates", async () => {
    put("shows", "tue", { name: "Tue", regulars: [], protected: [], pocs: [], groupMembers: { groupId: "g@g.us", at: 1, members } });
    expect(await autoMergeDuplicates(U)).toBe(1);
    expect(get("comics", LID)).toBeUndefined();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ level: "info", text: "Merged 1 duplicate contact automatically (same WhatsApp account)" });
  });

  it("never merges a pair the curator dismissed, nor two numbers that only share a name", async () => {
    put("shows", "tue", { name: "Tue", regulars: [], protected: [], pocs: [], groupMembers: { groupId: "g@g.us", at: 1, members } });
    store.set(`users/${U}`, { settings: { dupDismissed: [pairKey(PHONE, LID)] } });
    put("comics", "919800000001@c.us", { name: "Other", phone: "919800000001" }); // same name as "Other" below, different number
    expect(await autoMergeDuplicates(U)).toBe(0);
    expect(get("comics", LID)).toBeDefined();
    expect(get("comics", "919800000001@c.us")).toBeDefined();
    expect(notices()).toEqual([]);
  });
});
