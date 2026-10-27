import { describe, expect, it } from "vitest";
import { resolvePlaceholders, richReply, tagPeople, tagText } from "./index.ts";

describe("tagPeople", () => {
  it("mentions people with an id, plain first names for the rest", () => {
    const t = tagPeople([{ name: "Rohan Sharma", id: "919800000001@c.us" }, { name: "Priya Nair" }, { name: "Dev Comic BLR", id: "" }]);
    expect(t.tagged).toEqual(["@919800000001", "Priya", "Dev"]);
    expect(t.plain).toEqual(["Rohan", "Priya", "Dev"]);
    expect(t.mentions).toEqual(["919800000001@c.us"]);
  });
  it("dedupes the same person listed twice", () => {
    const t = tagPeople([{ name: "Rohan", id: "1@c.us" }, { name: "Rohan", id: "1@c.us" }]);
    expect(t.mentions).toEqual(["1@c.us"]);
    expect(t.tagged).toEqual(["@1", "@1"]);
  });
  it("keeps clashing first names apart in the plain form (tagged ones are told apart by WhatsApp)", () => {
    const t = tagPeople([{ name: "Rohan Sharma", id: "1@c.us" }, { name: "Rohan Kapoor" }]);
    expect(t.tagged).toEqual(["@1", "Rohan K."]);
    expect(t.plain).toEqual(["Rohan S.", "Rohan K."]);
  });
  it("lid ids work", () => expect(tagPeople([{ name: "A", id: "123456@lid" }]).tagged).toEqual(["@123456"]));
  it("richReply builds both forms from one formatter", () => {
    const r = richReply([{ name: "Rohan Sharma", id: "9@c.us" }, { name: "Priya" }], (l) => `On: ${l.join(", ")}`);
    expect(r).toEqual({ text: "On: @9, Priya", plain: "On: Rohan, Priya", mentions: ["9@c.us"] });
  });
  it("placeholders follow the id WhatsApp delivers to", () => expect(resolvePlaceholders("On: @9, @8", [{ raw: "9@c.us", resolved: "555@lid" }])).toBe("On: @555, @8"));
  it("placeholders don't clobber longer numbers", () => expect(resolvePlaceholders("@98765 @9", [{ raw: "9@c.us", resolved: "5@lid" }])).toBe("@98765 @5"));
});

describe("tagText", () => {
  const people = [{ name: "Dhruv Kumar", id: "9111@c.us" }, { name: "Akhil Comic BLR", id: "9222@c.us" }, { name: "No Id" }];
  it("mentions known people by whole or unique first name, plain twin uses first names", () => {
    const r = tagText("I'll ask Dhruv Kumar for TAG. Akhil is on Monday; Dhruv too.", people);
    expect(r.text).toBe("I'll ask @9111 for TAG. @9222 is on Monday; @9111 too.");
    expect(r.plain).toBe("I'll ask Dhruv for TAG. Akhil is on Monday; Dhruv too.");
    expect(r.mentions).toEqual(["9111@c.us", "9222@c.us"]);
  });
  it("leaves people without an id and unknown text alone", () => expect(tagText("No Id said hi", people)).toEqual({ text: "No Id said hi", plain: "No Id said hi", mentions: [] }));
  it("doesn't match inside other words", () => expect(tagText("Akhilesh is here", people).mentions).toEqual([]));
  it("two people with one first name: whole names only, told apart in plain", () => {
    const r = tagText("Rohan Sharma and Rohan Kapoor", [{ name: "Rohan Sharma", id: "1@c.us" }, { name: "Rohan Kapoor", id: "2@c.us" }]);
    expect(r.text).toBe("@1 and @2");
    expect(r.plain).toBe("Rohan S. and Rohan K.");
  });
});
