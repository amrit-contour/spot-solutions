import { describe, expect, it } from "vitest";
import { cleanName, displayName, displayNames } from "./index.ts";

describe("displayNames", () => {
  it("first names only", () => expect(displayNames(["Rohan Sharma", "Priya Nair", "Dhruv"])).toEqual(["Rohan", "Priya", "Dhruv"]));
  it("strips noise tokens", () => {
    expect(cleanName("Rohan Comic BLR")).toBe("Rohan");
    expect(cleanName("Priya (Comic)")).toBe("Priya");
    expect(cleanName("Comic J… Dhruv")).toBe("Dhruv");
    expect(displayNames(["Aman Comic BLR", "Neha (Comic)"])).toEqual(["Aman", "Neha"]);
  });
  it("keeps a name that is only noise or a number", () => {
    expect(cleanName("Comic")).toBe("Comic");
    expect(displayNames(["+91 98765 43210"])).toEqual(["+91"]);
  });
  it("adds a last initial only for a shared first name", () => {
    expect(displayNames(["Rohan Sharma", "Rohan Kapoor", "Priya"])).toEqual(["Rohan S.", "Rohan K.", "Priya"]);
  });
  it("uses the last name when initials clash", () => {
    expect(displayNames(["Rohan Sharma", "Rohan Singh"])).toEqual(["Rohan Sharma", "Rohan Singh"]);
  });
  it("noise doesn't create a false clash, and the same person twice stays one name", () => {
    expect(displayNames(["Rohan Comic BLR", "Rohan Kapoor"])).toEqual(["Rohan", "Rohan K."]);
    expect(displayNames(["Priya Nair", "Priya Nair"])).toEqual(["Priya", "Priya"]);
  });
  it("one name", () => expect(displayName("Rohan Sharma Comic BLR")).toBe("Rohan"));
});
