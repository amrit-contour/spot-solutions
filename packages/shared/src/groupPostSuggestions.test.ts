import { describe, expect, it } from "vitest";
import { planCopyAll, postKey, suggestPosts, templatizeNames, type PostSource } from "./groupPostSuggestions.ts";
import type { GroupPost } from "./groupPosts.ts";

const settings = { messages: {} };
const post = (p: Partial<GroupPost>): GroupPost => ({ id: "x", template: "custom", daysBefore: 1, time: "17:00", enabled: true, message: "See you tomorrow!", ...p });
let n = 0;
const id = () => `new${n++}`;
const target = { id: "t", name: "Tuesday Laughs", venueName: "The Pub" };
const monday = (posts: GroupPost[]): PostSource => ({ id: "m", name: "Monday Mic", venueName: "Zed Bar", posts });

describe("templatizeNames", () => {
  it("swaps the show and venue for variables, whole words, any case", () => {
    const r = templatizeNames("Welcome to monday mic at Zed Bar! Zed Barn is closed.", { show: "Monday Mic", venue: "Zed Bar" });
    expect(r.text).toBe("Welcome to {{show}} at {{venue}}! Zed Barn is closed.");
    expect(r.swapped.map((s) => s.variable).sort()).toEqual(["show", "venue"]);
  });
  it("leaves existing variables, short names and unrelated text alone", () => {
    expect(templatizeNames("{{show}} tonight", { show: "show" }).text).toBe("{{show}} tonight");
    expect(templatizeNames("Go to the mic", { show: "Go" }).swapped).toEqual([]);
    expect(templatizeNames("Nothing here", { show: "Monday Mic" })).toEqual({ text: "Nothing here", swapped: [] });
  });
  it("handles regex characters in a name", () => {
    expect(templatizeNames("Come to Laughs (Late)!", { show: "Laughs (Late)" }).text).toBe("Come to {{show}}!");
  });
});

describe("suggestPosts", () => {
  it("offers other shows' posts this one lacks, copied with a fresh id, timing, kind and variables", () => {
    const src = monday([post({ id: "a", template: "groupReminder", message: undefined, time: "18:00" }), post({ id: "b", message: "Monday Mic is on at Zed Bar", daysBefore: 0, voice: true })]);
    const s = suggestPosts(settings, target, [], [src], id);
    expect(s).toHaveLength(2);
    const custom = s.find((x) => x.post.template === "custom")!;
    expect(custom.post.id).not.toBe("b");
    expect(custom.post.message).toBe("{{show}} is on at {{venue}}");
    expect(custom.post.voice).toBe(true);
    expect(custom.swapped.map((w) => w.name).sort()).toEqual(["Monday Mic", "Zed Bar"]);
    expect(custom.sourceName).toBe("Monday Mic");
    const reminder = s.find((x) => x.post.template === "groupReminder")!;
    expect(reminder.timing).toBe("Day before, 6:00 PM");
    expect(reminder.kind).toBe("Show reminder");
    expect(reminder.post.message).toBeUndefined();
    expect(s[0].post.daysBefore).toBeGreaterThanOrEqual(s[1].post.daysBefore);
  });
  it("skips posts this show already has (same offset and text, names ignored, time may differ)", () => {
    const mine = [post({ id: "mine", message: "See you tomorrow!", time: "09:00" }), post({ id: "m2", message: "Tuesday Laughs tonight", daysBefore: 0 })];
    const src = monday([post({ message: "  see you   tomorrow! " }), post({ message: "Monday Mic tonight", daysBefore: 0 }), post({ message: "See you tomorrow!", daysBefore: 2 })]);
    const s = suggestPosts(settings, target, mine, [src], id);
    expect(s.map((x) => x.post.daysBefore)).toEqual([2]);
  });
  it("a different day offset is not a duplicate", () => {
    expect(postKey(settings, post({ daysBefore: 1 }), {})).not.toBe(postKey(settings, post({ daysBefore: 2 }), {}));
  });
  it("offers a post found in several shows once, and never from the show itself or a paused post", () => {
    const a = monday([post({ message: "Doors at 7" }), post({ message: "Paused one", enabled: false })]);
    const b: PostSource = { id: "w", name: "Wednesday Wit", posts: [post({ message: "Doors at 7" })] };
    const self: PostSource = { id: "t", name: "Tuesday Laughs", posts: [post({ message: "Own only" })] };
    const s = suggestPosts(settings, target, [], [a, b, self], id);
    expect(s).toHaveLength(1);
    expect(s[0].alsoIn).toEqual(["Wednesday Wit"]);
  });
  it("a template post with no wording of its own matches another show's template post", () => {
    const s = suggestPosts(settings, target, [post({ template: "groupReminder", message: undefined })], [monday([post({ template: "groupReminder", message: undefined })])], id);
    expect(s).toEqual([]);
  });
  it("copies a picture, pin and poll along, and swaps names in a poll", () => {
    const rich = post({ message: { kind: "text", body: "Poster for Monday Mic", image: { path: "users/u/attachments/abcdefgh.jpg", name: "p.jpg" }, attachLocation: true } });
    const poll = post({ daysBefore: 3, message: { kind: "poll", body: "", poll: { question: "Coming to Monday Mic?", options: ["Yes", "No"], multi: false } } });
    const s = suggestPosts(settings, target, [], [monday([rich, poll])], id);
    const r = s.find((x) => x.post.daysBefore === 1)!.post.message as { image?: unknown; attachLocation?: boolean; body: string };
    expect(r.image).toEqual({ path: "users/u/attachments/abcdefgh.jpg", name: "p.jpg" });
    expect(r.attachLocation).toBe(true);
    expect(r.body).toBe("Poster for {{show}}");
    const p = s.find((x) => x.post.daysBefore === 3)!;
    expect((p.post.message as { poll: { question: string } }).poll.question).toBe("Coming to {{show}}?");
    expect(p.snippet).toBe("Poll: Coming to {{show}}?");
  });
});

describe("planCopyAll", () => {
  it("lists what is added and counts the duplicates skipped", () => {
    const src = monday([post({ message: "One" }), post({ message: "Two", daysBefore: 2 }), post({ message: "Three", daysBefore: 3 })]);
    const r = planCopyAll(settings, target, [post({ message: "Two", daysBefore: 2 })], src, id);
    expect(r.add.map((s) => s.snippet)).toEqual(["Three", "One"]);
    expect(r.skipped).toBe(1);
  });
});
