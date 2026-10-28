import { describe, expect, it } from "vitest";
import { MIRROR_CAP, MIRROR_GROUP_MS, MIRROR_TTL_MS, addAsk, claimAsks, closeByApp, composeDoneReply, conflictText, findResolved, judgeLateVote, mirrorKey, oppositeOf, replyDue, resolution, type MirrorAsk } from "./agentMirror.ts";

const ask = (o: Partial<MirrorAsk> & Pick<MirrorAsk, "key" | "kind">): MirrorAsk => ({ msgId: `m-${o.key}`, at: 1000, ...o });
const slot = (comicId: string, rating?: number) => ({ comicId, minutes: null, ...(rating ? { rating } : {}) });

describe("keys", () => {
  it("are stable per lineup and kind, and per notice", () => {
    expect(mirrorKey.mic("L")).toBe("mic:L");
    expect(mirrorKey.rate("L", "c1")).toBe("rate:L:c1");
    expect(mirrorKey.notices([{ c: "notices", id: "n1" }], "m9")).toBe("notices:n1");
    expect(mirrorKey.notices([{ c: "notices", id: "n1" }, { c: "actions", id: "a1" }], "m9")).toBe("batch:m9");
  });
});

describe("remembering", () => {
  it("replaces the same key, drops expired entries and caps the list", () => {
    let l = addAsk([], ask({ key: "mic:L", kind: "mic", msgId: "a" }), 1000);
    l = addAsk(l, ask({ key: "mic:L", kind: "mic", msgId: "b" }), 1000);
    expect(l.map((x) => x.msgId)).toEqual(["b"]);
    expect(addAsk(l, ask({ key: "x", kind: "mic", at: 1000 + MIRROR_TTL_MS }), 1000 + MIRROR_TTL_MS).map((x) => x.key)).toEqual(["x"]);
    let big: MirrorAsk[] = [];
    for (let i = 0; i < MIRROR_CAP + 5; i++) big = addAsk(big, ask({ key: `k${i}`, kind: "mic" }), 1000);
    expect(big).toHaveLength(MIRROR_CAP);
  });
  it("claiming closes only the open ones, as answered on WhatsApp (no reaction, no reply owed)", () => {
    const l = claimAsks([ask({ key: "a", kind: "mic" }), ask({ key: "b", kind: "mic", closed: { by: "app", at: 5 } })], (x) => x.kind === "mic", 9);
    expect(l[0]).toMatchObject({ closed: { by: "whatsapp", at: 9 }, reacted: true, replied: true });
    expect(l[1]!.closed).toEqual({ by: "app", at: 5 });
  });
});

describe("what counts as answered in the app", () => {
  const f = (l: object) => ({ lineups: { L: { status: "confirmed", slots: [], ...l } as never } });
  it("mic: an outcome", () => {
    expect(resolution(ask({ key: "mic:L", kind: "mic", lineupId: "L" }), f({}))).toBeNull();
    expect(resolution(ask({ key: "mic:L", kind: "mic", lineupId: "L" }), f({ outcome: "canned" }))).toMatchObject({ result: "canned", what: "marked didn't happen" });
  });
  it("repeat: repeatNext true or false, but not unset", () => {
    const a = ask({ key: "repeat:L", kind: "repeat", lineupId: "L" });
    expect(resolution(a, f({ repeatNext: null }))).toBeNull();
    expect(resolution(a, f({ repeatNext: false }))).toMatchObject({ result: "no", what: "Don't repeat", verb: "Answered" });
  });
  it("rate and overall: a rating on that comic or the show", () => {
    expect(resolution(ask({ key: "r", kind: "rate", lineupId: "L", comicId: "c2" }), f({ slots: [slot("c1", 5), slot("c2")] }))).toBeNull();
    expect(resolution(ask({ key: "r", kind: "rate", lineupId: "L", comicId: "c2" }), f({ slots: [slot("c2", 3)] }))).toMatchObject({ what: "rated 3" });
    expect(resolution(ask({ key: "o", kind: "overall", lineupId: "L" }), f({ review: { rating: 4, at: 1 } }))).toMatchObject({ what: "rated 4" });
  });
  it("cleanup: done or kept; asked and partial are still open", () => {
    const a = ask({ key: "cleanup:L", kind: "cleanup", lineupId: "L" });
    expect(resolution(a, f({ cleanup: { status: "asked", at: 1 } }))).toBeNull();
    expect(resolution(a, f({ cleanup: { status: "partial", at: 1 } }))).toBeNull();
    expect(resolution(a, f({ cleanup: { status: "kept", at: 1 } }))).toMatchObject({ result: "kept" });
    expect(resolution(a, f({ cleanup: { status: "done", at: 1 } }))).toMatchObject({ result: "cleared" });
  });
  it("adhoc: the round has no yeses waiting any more (and is unknown when not read)", () => {
    const a = ask({ key: "adhoc:R", kind: "adhoc", roundId: "R" });
    expect(resolution(a, { lineups: {} })).toBeNull();
    expect(resolution(a, { lineups: {}, openRounds: new Set(["R"]) })).toBeNull();
    expect(resolution(a, { lineups: {}, openRounds: new Set() })).not.toBeNull();
  });
  it("confirm: the lineup is confirmed", () => {
    expect(resolution(ask({ key: "confirm:L", kind: "confirm", lineupId: "L" }), f({ status: "confirmed" }))).toMatchObject({ what: "confirmed" });
    expect(resolution(ask({ key: "confirm:L", kind: "confirm", lineupId: "L" }), f({ status: "draft" }))).toBeNull();
  });
  it("a batch of notices: every one dismissed", () => {
    const a = ask({ key: "batch:m", kind: "batch", refs: [{ c: "notices", id: "n1" }, { c: "notices", id: "n2" }] });
    expect(resolution(a, { lineups: {}, handled: { "notices:n1": true } })).toBeNull();
    expect(resolution(a, { lineups: {}, handled: { "notices:n1": true, "notices:n2": true } })).toMatchObject({ what: "2 dismissed" });
  });
  it("findResolved skips what is closed or expired, and closeByApp stamps the rest", () => {
    const open = ask({ key: "mic:L", kind: "mic", lineupId: "L" });
    const shut = ask({ key: "mic:M", kind: "mic", lineupId: "M", closed: { by: "whatsapp", at: 1 } });
    const facts = { lineups: { L: { outcome: "happened", slots: [] } as never, M: { outcome: "happened", slots: [] } as never } };
    const found = findResolved([open, shut], facts, 5000);
    expect(found.map((x) => x.ask.key)).toEqual(["mic:L"]);
    expect(findResolved([open], facts, 1000 + MIRROR_TTL_MS)).toEqual([]);
    expect(closeByApp([open, shut], found, 5000)[0]!.closed).toMatchObject({ by: "app", at: 5000, result: "happened", what: "marked happened", verb: "Done" });
  });
});

describe("the grouped reply", () => {
  const done = (key: string, at: number, what = "marked happened", label?: string, verb: "Done" | "Answered" = "Done"): MirrorAsk => ask({ key, kind: "mic", label, closed: { by: "app", at, what, verb } });
  it("waits out the minute after the first one, and answers WhatsApp-answered asks never", () => {
    const l = [done("a", 10_000), ask({ key: "w", kind: "mic", closed: { by: "whatsapp", at: 0 }, replied: true })];
    expect(replyDue(l, 10_000 + MIRROR_GROUP_MS - 1)).toEqual([]);
    expect(replyDue(l, 10_000 + MIRROR_GROUP_MS).map((a) => a.key)).toEqual(["a"]);
    expect(replyDue([{ ...done("a", 10_000), replied: true }], 1e9)).toEqual([]);
  });
  it("one is a short sentence; the others are a list quoting the newest", () => {
    expect(composeDoneReply([done("a", 1)])).toEqual({ text: "Done in the app: marked happened ✓", quoteMsgId: "m-a" });
    expect(composeDoneReply([done("a", 1, "Repeat", undefined, "Answered")]).text).toBe("Answered in the app: Repeat ✓");
    const r = composeDoneReply([done("b", 20, "rated 4", "Ana"), done("a", 10, "marked happened", "Monday Mic")]);
    expect(r).toEqual({ text: "Handled in the app ✓\n• Monday Mic: marked happened\n• Ana: rated 4", quoteMsgId: "m-b" });
  });
  it("a long list is cut", () => {
    const r = composeDoneReply(Array.from({ length: 11 }, (_, i) => done(`k${i}`, i, "rated 3", `C${i}`)));
    expect(r.text.split("\n")).toHaveLength(1 + 8 + 1);
    expect(r.text.endsWith("• +3 more")).toBe(true);
  });
});

describe("late votes", () => {
  const closed = (result: string, what = "x"): Pick<MirrorAsk, "closed" | "kind"> => ({ kind: "mic", closed: { by: "app", at: 1, result, what } });
  it("agree when it is the same answer or the vote has no opinion; conflict otherwise", () => {
    expect(judgeLateVote(closed("happened"), "happened")).toBe("agree");
    expect(judgeLateVote(closed("happened"), null)).toBe("agree");
    expect(judgeLateVote(closed("happened"), "canned")).toBe("conflict");
    expect(judgeLateVote({ closed: { by: "whatsapp", at: 1 } }, "canned")).toBe("agree");
  });
  it("the message and the opposite answer", () => {
    expect(conflictText({ kind: "mic", closed: { by: "app", at: 1, what: "marked happened" } })).toBe("Already marked happened in the app. Reply *change* to switch.");
    expect(oppositeOf("canned")).toBe("happened");
    expect(oppositeOf("repeat")).toBe("no");
    expect(oppositeOf("kept")).toBeNull();
  });
});
