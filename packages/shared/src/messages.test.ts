import { describe, expect, it } from "vitest";
import { MESSAGE_TYPES, firstName, greetName, messageTemplate, renderMessage } from "./messages.ts";
import { renderTemplate } from "./template.ts";

describe("firstName", () => {
  it.each([
    ["Rohan Sharma", "Rohan"],
    ["🎤 Rohan Comic BLR", "Rohan"],
    ["ROHAN", "Rohan"],
    ["Dr. Meera Iyer", "Meera"],
    ["Bhai Aakash", "Aakash"],
    ["K. Raghav", "Raghav"],
    ["rohan_s", "Rohan"],
    ["McKenzie", "McKenzie"],
    ["+91 98450 12345", ""],
    ["", ""],
    [null, ""],
  ])("%s → %s", (full, want) => expect(firstName(full)).toBe(want));

  it("greets unknown people as there", () => expect(greetName("+919845012345")).toBe("there"));
});

describe("message templates", () => {
  it("uses the curator's version when set, default otherwise", () => {
    expect(messageTemplate({ messages: { offerFull: "Gone, {{name}}!" } }, "offerFull")).toBe("Gone, {{name}}!");
    expect(messageTemplate({ messages: { offerFull: "  " } }, "offerFull")).toBe(MESSAGE_TYPES.find((m) => m.key === "offerFull")!.default);
  });

  it("every default only uses its declared variables", () => {
    for (const m of MESSAGE_TYPES) {
      const used = [...m.default.matchAll(/\{\{[#^/]?\s*(\w+)\s*\}\}/g)].map((x) => x[1]);
      for (const k of used) expect(["name", ...m.vars]).toContain(k);
    }
  });

  it("last spot and show info fall back cleanly", () => {
    expect(renderMessage({}, "lastSpot", { name: "Rohan" })).toBe("I don't have a record of your last spot yet.");
    expect(renderMessage({}, "lastSpot", { lastShow: "Monday Mic", lastDate: "20 Oct" })).toBe("Your last spot was Monday Mic on 20 Oct.");
    expect(renderMessage({}, "showInfo", { name: "there", shows: "" })).toBe("Hey there! Here's where and when:\nI'll share the details soon.");
  });

  it("renders a default with every variable filled", () => {
    expect(renderTemplate(MESSAGE_TYPES.find((m) => m.key === "offer")!.default, { name: "Rohan", show: "Monday Mic", day: "Monday", date: "27 Oct", time: "8:30 PM" })).toContain("Monday Mic, Monday 27 Oct at 8:30 PM");
  });
});
