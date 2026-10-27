import { describe, expect, it } from "vitest";
import { parseInline } from "./richText.ts";
import { activeMention, applyTags, highlightSegments, insertMention, liveTags, splitMentions, suggestTaggable, toPlain } from "./waFormat.ts";

const rahul = { token: "@919876543210", name: "Rahul", id: "919876543210@c.us" };

describe("splitMentions", () => {
  it("cuts the text at each tag", () => {
    expect(splitMentions("hi @919876543210, ok?", [rahul])).toEqual([
      { t: "text", v: "hi " },
      { t: "mention", v: "@919876543210", name: "Rahul", id: "919876543210@c.us" },
      { t: "text", v: ", ok?" },
    ]);
  });
  it("does not cut a longer number that starts the same", () => {
    expect(splitMentions("@9198765432109", [rahul])).toEqual([{ t: "text", v: "@9198765432109" }]);
  });
  it("handles no mentions and the same person twice", () => {
    expect(splitMentions("plain", [])).toEqual([{ t: "text", v: "plain" }]);
    expect(splitMentions("@919876543210 @919876543210", [rahul]).filter((s) => s.t === "mention")).toHaveLength(2);
  });
});

describe("toPlain", () => {
  it("strips marks and names tags", () => {
    expect(toPlain("*Hey* @919876543210, _bring_ ~x~ `mic`", [rahul])).toBe("Hey @Rahul, bring x mic");
  });
  it("keeps one line", () => {
    expect(toPlain("> quote\n- a\n- b\n```code```")).toBe("quote a b code");
  });
  it("handles nested and unmatched marks", () => {
    expect(toPlain("*bold _and italic_*")).toBe("bold and italic");
    expect(toPlain("5 * 3 = 15 and a_b")).toBe("5 * 3 = 15 and a_b");
    expect(toPlain("*unclosed")).toBe("*unclosed");
  });
  it("leaves links and emails alone", () => {
    expect(toPlain("see https://x.com/a_b_c and _me_")).toBe("see https://x.com/a_b_c and me");
    expect(toPlain("https://x.com/_a_ ok")).toBe("https://x.com/_a_ ok");
    expect(toPlain("mail first_last@x_y.com now")).toBe("mail first_last@x_y.com now");
  });
  it("a name with marks in it is not formatted", () => {
    expect(toPlain("hi @919876543210", [{ ...rahul, name: "_R_*" }])).toBe("hi @_R_*");
  });
});

describe("parseInline literals", () => {
  it("keeps a url whole inside bold", () => {
    expect(parseInline("*go https://a.com/x_y_z*")).toEqual([{ t: "b", c: [{ t: "text", v: "go https://a.com/x_y_z" }] }]);
  });
});

describe("composer", () => {
  const people = [
    { id: "1@c.us", name: "Rahul Verma" },
    { id: "2@c.us", name: "Ravi" },
    { id: "3@lid", name: "Priya Rao" },
  ];
  it("finds the word being typed", () => {
    expect(activeMention("hello @ra", 9)).toEqual({ query: "ra", start: 6 });
    expect(activeMention("mail a@b", 8)).toBeNull();
    expect(activeMention("@", 1)).toEqual({ query: "", start: 0 });
  });
  it("suggests by name start or any word", () => {
    expect(suggestTaggable(people, "ra").map((p) => p.name)).toEqual(["Rahul Verma", "Ravi", "Priya Rao"]);
    expect(suggestTaggable(people, "ve").map((p) => p.name)).toEqual(["Rahul Verma"]);
    expect(suggestTaggable(people, "", 2)).toHaveLength(2);
  });
  it("inserts the pick and records the tag", () => {
    const e = insertMention("hi @ra there", 6, people[0])!;
    expect(e.text).toBe("hi @Rahul Verma  there");
    expect(e.caret).toBe(16);
    expect(e.tag).toEqual({ label: "@Rahul Verma", comicId: "1@c.us" });
    expect(insertMention("no at", 5, people[0])).toBeNull();
  });
  it("drops tags whose label was deleted", () => {
    const tags = [{ label: "@Ravi", comicId: "2@c.us" }, { label: "@Gone", comicId: "9@c.us" }];
    expect(liveTags("hey @Ravi", tags)).toEqual([tags[0]]);
    expect(highlightSegments("hey @Ravi!", tags)).toEqual([{ v: "hey ", tag: false }, { v: "@Ravi", tag: true }, { v: "!", tag: false }]);
  });
  it("sends @<number> text with the ids, longer labels first", () => {
    const ids: Record<string, string> = { "1@c.us": "911@c.us", "2@c.us": "922@c.us" };
    const tags = [{ label: "@Ravi", comicId: "2@c.us" }, { label: "@Ravi Kumar", comicId: "1@c.us" }];
    const out = applyTags("@Ravi Kumar and @Ravi and @Ravi Kumar", tags, (c) => ids[c]);
    expect(out).toEqual({ text: "@911 and @922 and @911", mentions: ["911@c.us", "922@c.us"] });
  });
  it("leaves a label it can't resolve", () => {
    expect(applyTags("hi @Zed", [{ label: "@Zed", comicId: "x" }], () => undefined)).toEqual({ text: "hi @Zed", mentions: [] });
  });
});
