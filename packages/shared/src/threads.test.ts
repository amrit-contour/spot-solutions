import { describe, expect, it } from "vitest";
import { SNIPPET_MAX, authorOf, dayLabel, filterThreads, groupByDay, isAwaitingYou, matchGroupThreads, matchThreads, mentionsOf, pageMessages, snippetOf, toThreadMessage, withMentionNames, type WaChatLike, type WaMessageLike } from "./threads.ts";

const msg = (o: Partial<WaMessageLike> & { id: string }): WaMessageLike => ({ type: "chat", body: "hi", fromMe: false, timestamp: 1_000, ...o });
const chat = (o: Partial<WaChatLike> & { id: string }): WaChatLike => ({ isGroup: false, timestamp: 1_000, unreadCount: 0, lastMessage: msg({ id: "m" }), ...o });
const comic = (id: string, name: string, extra: Record<string, string> = {}) => ({ id, name, phone: id.split("@")[0], ...extra });

describe("toThreadMessage", () => {
  it("keeps text, labels media and drops system rows", () => {
    expect(toThreadMessage(msg({ id: "1", body: "*hey*" }))).toMatchObject({ kind: "text", text: "*hey*", at: 1_000_000 });
    expect(toThreadMessage(msg({ id: "1", type: "image", body: "" }))).toMatchObject({ kind: "media", text: "[photo]" });
    expect(toThreadMessage(msg({ id: "1", type: "ptt", body: "" }))?.text).toBe("[voice note]");
    expect(toThreadMessage(msg({ id: "1", type: "image", body: "my set" }))?.text).toBe("[photo] my set");
    expect(toThreadMessage(msg({ id: "1", type: "revoked", body: "" }))?.kind).toBe("deleted");
    expect(toThreadMessage(msg({ id: "1", type: "e2e_notification" }))).toBeNull();
    expect(toThreadMessage(msg({ id: "1", body: "   " }))).toBeNull();
  });
  it("summarises polls and pins", () => {
    const p = toThreadMessage(msg({ id: "1", type: "poll_creation", pollName: "Mon?", pollOptions: ["Yes", "Pass"] }));
    expect(p?.poll).toEqual({ question: "Mon?", options: ["Yes", "Pass"], multi: false });
    const l = toThreadMessage(msg({ id: "1", type: "location", location: { name: "The Pub", address: "MG Road" } }));
    expect(l?.pin).toEqual({ name: "The Pub", detail: "MG Road" });
  });
});

describe("snippetOf", () => {
  it("truncates to 80 characters on one line", () => {
    const s = snippetOf(msg({ id: "1", body: `line one\nline two ${"x".repeat(200)}` }));
    expect(s.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toContain("\n");
  });
  it("is empty without a message", () => expect(snippetOf(null)).toBe(""));
  it("shows a poll's question", () => expect(snippetOf(msg({ id: "1", type: "poll_creation", pollName: "Mon?", pollOptions: ["a", "b"] }))).toBe("Poll: Mon?"));
});

describe("matchThreads", () => {
  const comics = [comic("919800000001@c.us", "Asha"), comic("919800000002@c.us", "Ravi", { chatId: "555@lid" })];
  it("lists only roster comics, newest first, never groups", () => {
    const out = matchThreads(
      [
        chat({ id: "919800000001@c.us", timestamp: 100, lastMessage: msg({ id: "a", timestamp: 100, fromMe: true, body: "see you" }) }),
        chat({ id: "555@lid", timestamp: 200, unreadCount: 2, lastMessage: msg({ id: "b", timestamp: 200 }) }),
        chat({ id: "stranger@c.us", timestamp: 300 }),
        chat({ id: "g@g.us", isGroup: true, timestamp: 400 }),
      ],
      comics,
    );
    expect(out.map((t) => t.name)).toEqual(["Ravi", "Asha"]);
    expect(out[0]).toMatchObject({ unread: 2, awaitingYou: true, fromMe: false, comicId: "919800000002@c.us", chatId: "555@lid" });
    expect(out[1]).toMatchObject({ awaitingYou: false, fromMe: true });
  });
  it("lists a comic once when two chats match, keeping the newer", () => {
    const out = matchThreads(
      [chat({ id: "919800000002@c.us", lastMessage: msg({ id: "a", timestamp: 10 }), unreadCount: 1 }), chat({ id: "555@lid", lastMessage: msg({ id: "b", timestamp: 20, body: "newer" }), unreadCount: 1 })],
      comics,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ snippet: "newer", unread: 2 });
  });
  it("skips empty chats", () => expect(matchThreads([chat({ id: "919800000001@c.us", timestamp: 0, lastMessage: null })], comics)).toEqual([]));
  it("does not flag a chat as awaiting you when the last row isn't a message", () => {
    const out = matchThreads([chat({ id: "919800000001@c.us", lastMessage: msg({ id: "x", type: "e2e_notification" }) })], comics);
    expect(out[0].awaitingYou).toBe(false);
  });
});

describe("filterThreads", () => {
  const items = matchThreads([chat({ id: "919800000001@c.us", lastMessage: msg({ id: "a", body: "Monday works" }) })], [comic("919800000001@c.us", "Asha Rao")]);
  it("searches name, number and preview", () => {
    expect(filterThreads(items, "asha")).toHaveLength(1);
    expect(filterThreads(items, "98000000")).toHaveLength(1);
    expect(filterThreads(items, "monday")).toHaveLength(1);
    expect(filterThreads(items, "zzz")).toHaveLength(0);
    expect(filterThreads(items, "  ")).toHaveLength(1);
  });
});

describe("pageMessages", () => {
  const many = Array.from({ length: 120 }, (_, i) => msg({ id: `m${i}`, timestamp: 1000 + i, body: `n${i}` }));
  it("returns the newest page, oldest first, and says more exists", () => {
    const p = pageMessages(many, null, 50);
    expect(p.messages).toHaveLength(50);
    expect(p.messages[49].text).toBe("n119");
    expect(p.messages[0].text).toBe("n70");
    expect(p.hasMore).toBe(true);
  });
  it("pages before a time", () => {
    const p = pageMessages(many, 1070 * 1000, 50);
    expect(p.messages[49].text).toBe("n69");
    expect(p.messages[0].text).toBe("n20");
  });
  it("ends when the chat is exhausted", () => expect(pageMessages(many.slice(0, 10), null, 50).hasMore).toBe(false));
});

describe("day separators", () => {
  const tz = "Asia/Kolkata";
  const now = Date.parse("2026-10-26T10:00:00+05:30");
  it("labels today and yesterday", () => {
    expect(dayLabel(Date.parse("2026-10-26T01:00:00+05:30"), now, tz)).toBe("Today");
    expect(dayLabel(Date.parse("2026-10-25T23:00:00+05:30"), now, tz)).toBe("Yesterday");
    expect(dayLabel(Date.parse("2026-10-20T12:00:00+05:30"), now, tz)).toMatch(/Tue/);
  });
  it("inserts a separator at each new day", () => {
    const rows = groupByDay(
      [{ id: "a", at: Date.parse("2026-10-25T09:00:00+05:30"), fromMe: false, kind: "text", text: "a" }, { id: "b", at: Date.parse("2026-10-25T10:00:00+05:30"), fromMe: true, kind: "text", text: "b" }, { id: "c", at: now, fromMe: false, kind: "text", text: "c" }],
      now,
      tz,
    );
    expect(rows.map((r) => r.row)).toEqual(["day", "msg", "msg", "day", "msg"]);
  });
});

describe("awaitingYou", () => {
  const comics = [comic("919800000001@c.us", "Asha")];
  const theirs = (id: string, t: number, extra: Partial<WaMessageLike> = {}) => msg({ id, timestamp: t, ...extra });
  const mine = (id: string, t: number, extra: Partial<WaMessageLike> = {}) => msg({ id, timestamp: t, fromMe: true, ...extra });
  const thread = (last: WaMessageLike, recent?: WaMessageLike[]) => matchThreads([chat({ id: "919800000001@c.us", timestamp: last.timestamp, lastMessage: last, recent })], comics)[0];

  it("waits when their newest message has no answer", () => {
    expect(thread(theirs("b", 20), [mine("a", 10), theirs("b", 20)]).awaitingYou).toBe(true);
    expect(thread(theirs("b", 20)).awaitingYou).toBe(true);
  });
  it("is answered when you reacted to it", () => {
    const b = theirs("b", 20, { hasReaction: true, reactions: [{ emoji: "👍", byMe: true }] });
    expect(thread(b, [mine("a", 10), b]).awaitingYou).toBe(false);
  });
  it("is answered when you reacted to any of their messages after your last one", () => {
    const b = theirs("b", 20, { reactions: [{ emoji: "❤️", byMe: true }] });
    const c = theirs("c", 30);
    expect(thread(c, [mine("a", 10), b, c]).awaitingYou).toBe(false);
  });
  it("ignores reactions that are theirs, or on messages you had already answered", () => {
    const a = theirs("a", 10, { reactions: [{ emoji: "👍", byMe: true }] });
    const c = theirs("c", 30, { reactions: [{ emoji: "👍", byMe: false }] });
    expect(thread(c, [a, mine("m", 20), c]).awaitingYou).toBe(true);
  });
  it("is never waiting once you sent something after it", () => expect(isAwaitingYou(mine("z", 40), [theirs("c", 30), mine("z", 40)])).toBe(false));
  it("uses the reactions the worker attached to the same message in `recent`", () => {
    const last = theirs("b", 20);
    expect(thread(last, [{ ...last, reactions: [{ emoji: "👌", byMe: true }] }]).awaitingYou).toBe(false);
  });
});

describe("group writers and tags", () => {
  const names = new Map([["98870264598667@lid", "Ravi Kumar"], ["919800000001@c.us", "Asha"]]);
  it("resolves an @lid writer through the names the worker found", () => {
    expect(authorOf({ author: "98870264598667@lid" }, names)).toBe("Ravi Kumar");
    expect(toThreadMessage(msg({ id: "1", author: "98870264598667@lid" }), names)?.author).toBe("Ravi Kumar");
  });
  it("falls back to their WhatsApp name, then their number, then Someone", () => {
    expect(authorOf({ author: "5551@lid", authorName: "Pat" }, names)).toBe("Pat");
    expect(authorOf({ author: "919811111111@c.us" }, names)).toBe("+919811111111");
    expect(authorOf({ author: "5551@lid" }, names)).toBe("Someone");
  });
  it("turns a tag's raw digits into a name, keeping the id", () => {
    const m = msg({ id: "1", body: "hey @98870264598667 and @919800000001 and @555", mentionedIds: ["98870264598667@lid", "919800000001@c.us", "555@lid", "777@lid"] });
    expect(mentionsOf(m, names)).toEqual([
      { id: "98870264598667@lid", token: "@98870264598667", name: "Ravi Kumar" },
      { id: "919800000001@c.us", token: "@919800000001", name: "Asha" },
      { id: "555@lid", token: "@555", name: "Someone" },
    ]);
    const t = toThreadMessage(m, names)!;
    expect(t.text).toContain("@98870264598667");
    expect(t.mentions).toHaveLength(3);
    expect(withMentionNames(t.text, t.mentions)).toBe("hey @Ravi Kumar and @Asha and @Someone");
  });
  it("shows the resolved name in the group list preview and writer", () => {
    const last = msg({ id: "1", body: "@98870264598667 see you", author: "98870264598667@lid", mentionedIds: ["98870264598667@lid"] });
    const g = matchGroupThreads([chat({ id: "g@g.us", isGroup: true, lastMessage: last })], [{ id: "s", name: "Mon", groupId: "g@g.us" }], [], names)[0];
    expect(g).toMatchObject({ author: "Ravi Kumar", snippet: "@Ravi Kumar see you" });
  });
});

describe("stickers and reactions", () => {
  it("keeps stickers as their own kind", () => expect(toThreadMessage(msg({ id: "1", type: "sticker", body: "" }))).toMatchObject({ kind: "sticker", text: "[sticker]" }));
  it("lists reactions as chips and marks yours", () => {
    const t = toThreadMessage(msg({ id: "1", reactions: [{ emoji: "👍", byMe: false, count: 2 }, { emoji: "❤️", byMe: true }] }));
    expect(t?.reactions).toEqual([{ emoji: "👍", count: 2, byMe: false }, { emoji: "❤️", count: 1, byMe: true }]);
    expect(toThreadMessage(msg({ id: "1" }))?.reactions).toBeUndefined();
  });
});
