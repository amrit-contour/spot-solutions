import { describe, expect, it } from "vitest";
import { addNeverRead, comicsOnNeverRead, compileNeverRead, defaultCountryCode, maskNumber, matchesNeverRead, neverReadLookups, normalizeNeverReadId, removeNeverRead, searchNeverRead, type NeverReadEntry } from "./neverRead.ts";

const e = (id: string, kind: "person" | "group" = "person"): NeverReadEntry => ({ id, kind, addedAt: 1 });

describe("normalizeNeverReadId", () => {
  it("keeps c.us and g.us ids", () => {
    expect(normalizeNeverReadId("919876543210@c.us")).toEqual({ id: "919876543210@c.us", kind: "person" });
    expect(normalizeNeverReadId("120363012345@g.us")).toEqual({ id: "120363012345@g.us", kind: "group" });
    expect(normalizeNeverReadId("919876543210:12@c.us")?.id).toBe("919876543210@c.us");
  });
  it("types a number with or without +91", () => {
    for (const t of ["+91 98765 43210", "919876543210", "98765 43210", "09876543210", "0091 9876543210", "(+91) 98765-43210"]) {
      expect(normalizeNeverReadId(t, { countryCode: "91" })?.id, t).toBe("919876543210@c.us");
    }
  });
  it("a 10-digit number that starts like the country code still gets it", () => expect(normalizeNeverReadId("91111 11111", { countryCode: "91" })?.id).toBe("919111111111@c.us"));
  it("uses the given country code for national numbers, never for + numbers", () => {
    expect(normalizeNeverReadId("0412 345 678", { countryCode: "61" })?.id).toBe("61412345678@c.us");
    expect(normalizeNeverReadId("+61 412 345 678", { countryCode: "91" })?.id).toBe("61412345678@c.us");
  });
  it("keeps a lid as a lid", () => expect(normalizeNeverReadId("1234567890123@lid")).toEqual({ id: "1234567890123@lid", kind: "person" }));
  it("rejects junk", () => {
    expect(normalizeNeverReadId("")).toBeNull();
    expect(normalizeNeverReadId("hello")).toBeNull();
    expect(normalizeNeverReadId("123")).toBeNull();
    expect(normalizeNeverReadId("x@example.com")).toBeNull();
  });
  it("defaults to +91, and follows the timezone", () => {
    expect(defaultCountryCode(undefined)).toBe("91");
    expect(defaultCountryCode("Asia/Kolkata")).toBe("91");
    expect(defaultCountryCode("Australia/Melbourne")).toBe("61");
  });
});

describe("matchesNeverRead", () => {
  const list = [e("919876543210@c.us"), e("120363012345@g.us", "group")];
  it("matches c.us, plain digits and groups", () => {
    expect(matchesNeverRead(list, ["919876543210@c.us"])).toBe(true);
    expect(matchesNeverRead(list, ["+91 98765 43210"])).toBe(true);
    expect(matchesNeverRead(list, ["919876543210"])).toBe(true);
    expect(matchesNeverRead(list, ["120363012345@g.us"])).toBe(true);
    expect(matchesNeverRead(list, ["919876543211@c.us", "999@g.us"])).toBe(false);
  });
  it("matches any of several ids (chat, author)", () => expect(matchesNeverRead(list, ["120999@g.us", "919876543210@c.us"])).toBe(true));
  it("matches a lid through the map, and not without it", () => {
    const lid = "55512345678901@lid";
    expect(matchesNeverRead(list, [lid])).toBe(false);
    expect(matchesNeverRead(list, [lid], { lidToPhone: new Map([[lid, "919876543210@c.us"]]) })).toBe(true);
    expect(matchesNeverRead(list, [lid], { lidToPhone: new Map([[lid, "919000000000@c.us"]]) })).toBe(false);
  });
  it("matches a phone against a lid entry through the reverse map", () => {
    const lid = "55512345678901@lid";
    const l = [e(lid)];
    expect(matchesNeverRead(l, [lid])).toBe(true);
    expect(matchesNeverRead(l, ["919876543210@c.us"])).toBe(false);
    expect(matchesNeverRead(l, ["919876543210@c.us"], { phoneToLid: new Map([["919876543210@c.us", lid]]) })).toBe(true);
  });
  it("an empty list matches nothing", () => {
    expect(matchesNeverRead([], ["919876543210@c.us"])).toBe(false);
    expect(matchesNeverRead(undefined, ["x@g.us"])).toBe(false);
  });
  it("only asks for lookups when an entry could use them", () => {
    const m = compileNeverRead(list);
    expect(neverReadLookups(m, ["55512345678901@lid", "919111111111@c.us", "1@g.us"])).toEqual({ lids: ["55512345678901@lid"], phones: [] });
    expect(neverReadLookups(compileNeverRead([e("1@g.us", "group")]), ["55512345678901@lid"])).toEqual({ lids: [], phones: [] });
  });
});

describe("list helpers", () => {
  it("adds newest first without duplicates and removes", () => {
    let l = addNeverRead(undefined, [{ id: "919876543210@c.us", kind: "person", name: "Mum" }], 5);
    l = addNeverRead(l, [{ id: "919876543210@c.us", kind: "person" }, { id: "1@g.us", kind: "group", name: "Family" }], 6);
    expect(l.map((x) => x.id)).toEqual(["1@g.us", "919876543210@c.us"]);
    expect(l[1].name).toBe("Mum");
    expect(removeNeverRead(l, "1@g.us").map((x) => x.id)).toEqual(["919876543210@c.us"]);
  });
  it("searches by name or number", () => {
    const l = [{ ...e("919876543210@c.us"), name: "Mum" }, { ...e("1@g.us", "group"), name: "Family" }];
    expect(searchNeverRead(l, "fam").map((x) => x.name)).toEqual(["Family"]);
    expect(searchNeverRead(l, "98765").map((x) => x.name)).toEqual(["Mum"]);
  });
  it("masks numbers", () => expect(maskNumber("919876543210@c.us")).toBe("+91 ••••• ••210"));
  it("finds roster comics on the list", () => {
    const comics = [{ id: "919876543210@c.us", name: "A" }, { id: "55512345678901@lid", chatId: "55512345678901@lid", phone: "919111111111", name: "B" }, { id: "x", name: "C" }];
    expect(comicsOnNeverRead(comics, ["919876543210@c.us", "919111111111@c.us"]).map((c) => c.name)).toEqual(["A", "B"]);
  });
});
