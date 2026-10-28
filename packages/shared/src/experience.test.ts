import { describe, it, expect } from "vitest";
import { experienceOf } from "./experience.ts";

describe("experienceOf", () => {
  it("new under 6 months", () => {
    const r = experienceOf({ comedySince: new Date().toISOString().slice(0, 4), history: [] }, new Date());
    expect(r.tags).toContain("New");
  });
  it("killer by average", () => {
    const hist = Array.from({ length: 5 }, (_, i) => ({ date: `2025-0${i + 1}-01`, showId: "s", rating: 4.5 }));
    const r = experienceOf({ comedySince: "2020", history: hist }, new Date("2025-06-01"));
    expect(r.tags).toContain("Killer");
    expect(r.averageRating).toBe(4.5);
  });
  it("inactive since", () => {
    const r = experienceOf({ comedySince: "2020", history: [{ date: "2020-01-01", showId: "s" }] }, new Date("2025-06-01"));
    expect(r.inactiveSince).toBeTruthy();
  });
});
