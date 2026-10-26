import { describe, expect, it } from "vitest";
import { movesOffOtherShows } from "./rules.ts";

describe("one show per week", () => {
  const show = { pocs: ["poc"], regulars: ["reg"], protected: ["host"] };
  it("is off by default: nobody is moved off their other show", () => {
    expect(movesOffOtherShows({}, show, "anyone")).toBe(false);
  });
  it("when on, moves others but never POCs, regulars or co-hosts", () => {
    expect(movesOffOtherShows({ onePerWeek: true }, show, "anyone")).toBe(true);
    for (const id of ["poc", "reg", "host"]) expect(movesOffOtherShows({ onePerWeek: true }, show, id)).toBe(false);
  });
});
