import { describe, expect, it } from "vitest";
import { applyFormat, insertText, parseInline, parseWhatsApp, shortcutOp, stripFormatting } from "./richText.ts";

describe("parseInline", () => {
  it("reads bold, italic, strike and code", () => {
    expect(parseInline("a *b* _c_ ~d~ `e`")).toEqual([
      { t: "text", v: "a " },
      { t: "b", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "i", c: [{ t: "text", v: "c" }] },
      { t: "text", v: " " },
      { t: "s", c: [{ t: "text", v: "d" }] },
      { t: "text", v: " " },
      { t: "code", v: "e" },
    ]);
  });
  it("nests marks", () => {
    expect(parseInline("*_hi_*")).toEqual([{ t: "b", c: [{ t: "i", c: [{ t: "text", v: "hi" }] }] }]);
  });
  it("leaves snake_case, math and lone marks alone", () => {
    expect(parseInline("my_var_name")).toEqual([{ t: "text", v: "my_var_name" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
    expect(parseInline("*not closed")).toEqual([{ t: "text", v: "*not closed" }]);
  });
  it("needs the closer to follow a non-space", () => {
    expect(parseInline("*bold *")).toEqual([{ t: "text", v: "*bold *" }]);
  });
  it("keeps variables untouched", () => {
    expect(parseInline("*{{name}}*")).toEqual([{ t: "b", c: [{ t: "text", v: "{{name}}" }] }]);
  });
  it("does not nest inside code", () => {
    expect(parseInline("`*x*`")).toEqual([{ t: "code", v: "*x*" }]);
  });
});

describe("parseWhatsApp", () => {
  it("builds quotes and lists from consecutive lines", () => {
    const b = parseWhatsApp("> one\n> two\n- a\n* b\n1. x\n2. y\nplain");
    expect(b.map((x) => x.t)).toEqual(["quote", "ul", "ol", "p"]);
    expect((b[0] as { lines: unknown[] }).lines).toHaveLength(2);
    expect((b[1] as { items: unknown[] }).items).toHaveLength(2);
  });
  it("keeps fenced monospace as one block, spanning lines", () => {
    const b = parseWhatsApp("before\n```\nline 1\n*not bold*\n```\nafter");
    expect(b.map((x) => x.t)).toEqual(["p", "pre", "p"]);
    expect(b[1]).toEqual({ t: "pre", v: "line 1\n*not bold*" });
  });
  it("an inline triple-backtick run is monospace too", () => {
    expect(parseWhatsApp("a ```x``` b").some((x) => x.t === "pre")).toBe(true);
  });
  it("never produces markup from angle brackets", () => {
    expect(parseWhatsApp("<b>hi</b>")).toEqual([{ t: "p", c: [{ t: "text", v: "<b>hi</b>" }] }]);
  });
  it("strips formatting for plain places", () => {
    expect(stripFormatting("*Hi* _there_\n> q\n- a")).toBe("Hi there\nq\na");
  });
});

describe("applyFormat", () => {
  it("wraps a selection", () => {
    expect(applyFormat("hello world", 6, 11, "bold")).toEqual({ value: "hello *world*", start: 7, end: 12 });
  });
  it("puts the caret inside an empty pair", () => {
    expect(applyFormat("hi ", 3, 3, "italic")).toEqual({ value: "hi __", start: 4, end: 4 });
  });
  it("unwraps when the marks surround the selection", () => {
    expect(applyFormat("a *b* c", 3, 4, "bold")).toEqual({ value: "a b c", start: 2, end: 3 });
  });
  it("unwraps when the selection includes the marks", () => {
    expect(applyFormat("a *b* c", 2, 5, "bold").value).toBe("a b c");
  });
  it("keeps surrounding spaces outside the marks", () => {
    expect(applyFormat("a word b", 1, 7, "bold").value).toBe("a *word* b");
  });
  it("uses triple backticks for monospace", () => {
    expect(applyFormat("x", 0, 1, "mono").value).toBe("```x```");
  });
  it("prefixes every selected line, and toggles off", () => {
    const on = applyFormat("a\nb\nc", 0, 5, "bullet");
    expect(on.value).toBe("- a\n- b\n- c");
    expect(applyFormat(on.value, on.start, on.end, "bullet").value).toBe("a\nb\nc");
  });
  it("numbers lines and swaps one list style for another", () => {
    expect(applyFormat("a\nb", 0, 3, "number").value).toBe("1. a\n2. b");
    expect(applyFormat("- a\n- b", 0, 7, "number").value).toBe("1. a\n2. b");
  });
  it("quotes only the caret's line", () => {
    expect(applyFormat("a\nb", 3, 3, "quote").value).toBe("a\n> b");
  });
});

describe("insertText and shortcuts", () => {
  it("inserts an emoji at the caret and replaces a selection", () => {
    expect(insertText("hi there", 2, 2, " 🎤")).toEqual({ value: "hi 🎤 there", start: 5, end: 5 });
    expect(insertText("hi there", 3, 8, "all").value).toBe("hi all");
  });
  it("maps shortcuts", () => {
    expect(shortcutOp("b", false)).toBe("bold");
    expect(shortcutOp("I", false)).toBe("italic");
    expect(shortcutOp("x", true)).toBe("strike");
    expect(shortcutOp("q", false)).toBeNull();
  });
});
