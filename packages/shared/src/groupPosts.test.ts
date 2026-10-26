import { describe, expect, it } from "vitest";
import { duePosts, groupPostMessage, groupPostVars, needsLineup, newGroupPost, nextRun, renderGroupPost, type GroupPost } from "./groupPosts.ts";
import { matchGroupThreads } from "./threads.ts";

// 2026-10-26 is a Monday.
const post = (p: Partial<GroupPost>): GroupPost => ({ id: "p1", template: "groupLineup", daysBefore: 0, time: "17:00", enabled: true, ...p });
const monday = { weekday: 1 as const };

describe("duePosts", () => {
  it("is due on the show day once its time has come", () => {
    expect(duePosts({ ...monday, groupPosts: [post({})] }, { date: "2026-10-26", time: "16:59" })).toEqual([]);
    expect(duePosts({ ...monday, groupPosts: [post({})] }, { date: "2026-10-26", time: "17:00" })).toEqual([{ post: post({}), showDate: "2026-10-26" }]);
  });
  it("a day-before post is due on Sunday for Monday's show", () => {
    const p = post({ daysBefore: 1, time: "18:00" });
    expect(duePosts({ ...monday, groupPosts: [p] }, { date: "2026-10-25", time: "19:00" })).toEqual([{ post: p, showDate: "2026-10-26" }]);
    expect(duePosts({ ...monday, groupPosts: [p] }, { date: "2026-10-26", time: "19:00" })).toEqual([]);
  });
  it("goes once per show date, and never when paused", () => {
    expect(duePosts({ ...monday, groupPosts: [post({})], groupPostsSent: { p1: "2026-10-26" } }, { date: "2026-10-26", time: "20:00" })).toEqual([]);
    expect(duePosts({ ...monday, groupPosts: [post({})], groupPostsSent: { p1: "2026-10-19" } }, { date: "2026-10-26", time: "20:00" })).toHaveLength(1);
    expect(duePosts({ ...monday, groupPosts: [post({ enabled: false })] }, { date: "2026-10-26", time: "20:00" })).toEqual([]);
  });
});

describe("nextRun", () => {
  it("is later today, or next week once today's has gone", () => {
    expect(nextRun(monday, post({}), "2026-10-26")).toEqual({ date: "2026-10-26", time: "17:00" });
    expect(nextRun({ ...monday, groupPostsSent: { p1: "2026-10-26" } }, post({}), "2026-10-26")).toEqual({ date: "2026-11-02", time: "17:00" });
  });
  it("skips a day-before post whose day has passed this week", () => {
    expect(nextRun(monday, post({ daysBefore: 2 }), "2026-10-25")).toEqual({ date: "2026-10-31", time: "17:00" });
  });
});

describe("group messages", () => {
  const settings = { messages: {} };
  it("the lineup post waits for a lineup; the reminder doesn't", () => {
    expect(needsLineup(groupPostMessage(settings, post({})))).toBe(true);
    expect(needsLineup(groupPostMessage(settings, post({ template: "groupReminder" })))).toBe(false);
  });
  it("renders the running order and the show details", () => {
    const vars = groupPostVars({ name: "Monday Mic", startTime: "20:30" }, { name: "Bloom", mapsLink: "" }, "2026-10-26", ["Rohan", "Priya"]);
    const r = renderGroupPost(settings, post({}), vars);
    expect(r.body).toContain("1. Rohan\n2. Priya");
    expect(r.body).toContain("Monday 26 Oct, 8:30 PM at Bloom");
  });
  it("a post's own wording wins over the template", () => {
    expect(groupPostMessage(settings, post({ template: "custom", message: "Be on time today 🙏" })).body).toBe("Be on time today 🙏");
  });
  it("new posts start at a sensible time before the show", () => {
    expect(newGroupPost("groupVenue", { startTime: "20:00" })).toMatchObject({ daysBefore: 0, time: "18:00" });
    expect(newGroupPost("groupReminder", { startTime: "20:00" })).toMatchObject({ daysBefore: 1 });
  });
});

describe("matchGroupThreads", () => {
  it("lists only groups linked to a show, once each, with who wrote last", () => {
    const chats = [
      { id: "mon@g.us", isGroup: true, name: "Monday comics", timestamp: 100, unreadCount: 2, lastMessage: { id: "m", type: "chat", body: "on my way", fromMe: false, timestamp: 100, author: "919876543210@c.us" } },
      { id: "family@g.us", isGroup: true, name: "Family", timestamp: 200, unreadCount: 5 },
      { id: "919876543210@c.us", isGroup: false, timestamp: 300, unreadCount: 0 },
    ];
    const shows = [{ id: "mon", name: "Monday Mic", groupId: "mon@g.us" }, { id: "mon2", name: "Monday Late", groupId: "mon@g.us" }];
    const out = matchGroupThreads(chats, shows, [{ id: "919876543210@c.us", phone: "919876543210", name: "Rohan" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ groupId: "mon@g.us", name: "Monday comics", showIds: ["mon", "mon2"], author: "Rohan", unread: 2, snippet: "on my way" });
  });
});
