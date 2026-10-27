import { describe, expect, it } from "vitest";
import { searchPeople } from "./peopleSearch.ts";
import { PHOTO_NONE, PHOTO_REFRESH_MS, photoDue, photoSrc } from "./profilePics.ts";

const people = [
  { id: "919876543210@c.us", name: "Sam Rao", phone: "919876543210" },
  { id: "911111111111@c.us", name: "Priya Samant", phone: "911111111111" },
  { id: "x@lid", name: "José Álvarez", phone: "" },
];

describe("searchPeople", () => {
  it("lists nobody for an empty or blank query", () => {
    expect(searchPeople(people, "")).toEqual([]);
    expect(searchPeople(people, "   ")).toEqual([]);
  });
  it("matches from the first character, name starts first", () => {
    expect(searchPeople(people, "s").map((p) => p.name)).toEqual(["Sam Rao", "Priya Samant"]);
    expect(searchPeople(people, "sam r").map((p) => p.name)).toEqual(["Sam Rao"]);
    expect(searchPeople(people, "rao").map((p) => p.name)).toEqual(["Sam Rao"]);
  });
  it("ignores accents and case", () => {
    expect(searchPeople(people, "jose alv")).toHaveLength(1);
  });
  it("matches phone digits anywhere, with formatting", () => {
    expect(searchPeople(people, "+91 98765").map((p) => p.name)).toEqual(["Sam Rao"]);
    expect(searchPeople(people, "4321").map((p) => p.name)).toEqual(["Sam Rao"]);
  });
  it("caps results", () => {
    expect(searchPeople(people, "s", 1)).toHaveLength(1);
  });
});

describe("photo rules", () => {
  const now = 10 * PHOTO_REFRESH_MS;
  it("is due when never asked, or after 7 days", () => {
    expect(photoDue({}, now)).toBe(true);
    expect(photoDue({ photoAt: now - 1000, photoUrl: PHOTO_NONE }, now)).toBe(false);
    expect(photoDue({ photoAt: now - PHOTO_REFRESH_MS, photoUrl: PHOTO_NONE }, now)).toBe(true);
  });
  it("force refreshes a fresh one only after the 5 minute floor", () => {
    expect(photoDue({ photoAt: now - 60_000 }, now, true)).toBe(false);
    expect(photoDue({ photoAt: now - 6 * 60_000 }, now, true)).toBe(true);
  });
  it("only shows https urls", () => {
    expect(photoSrc({ photoUrl: PHOTO_NONE })).toBeNull();
    expect(photoSrc({ photoUrl: "http://x" })).toBeNull();
    expect(photoSrc({ photoUrl: "https://pps.whatsapp.net/a" })).toBe("https://pps.whatsapp.net/a");
  });
});
