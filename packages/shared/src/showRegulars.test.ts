import { describe, expect, it } from "vitest";
import { factTags } from "./requestTags.ts";
import { isRegularOf, isRegularOfAny, showsLastWeekMarker } from "./showRegulars.ts";
import type { Comic, Show } from "./types.ts";

const LAST = "2026-10-19";
const comic = (o: Partial<Comic> = {}) => ({ id: "a@c.us", tier: "open", regularOf: [], lastPerformedWeek: LAST, ...o }) as Comic;
const show = (o: Partial<Show> = {}) => ({ id: "mon", regulars: [], ...o }) as Show;

describe("isRegularOf", () => {
  it("is on the show's regulars list", () => expect(isRegularOf(comic(), show({ regulars: ["a@c.us"] }))).toBe(true));
  it("is tier regular with that show in their shows", () => expect(isRegularOf(comic({ tier: "regular", regularOf: ["mon"] }), show())).toBe(true));
  it("tier regular of another show is not a regular here", () => expect(isRegularOf(comic({ tier: "regular", regularOf: ["tue"] }), show())).toBe(false));
  it("the show in their shows without tier regular does not count", () => expect(isRegularOf(comic({ regularOf: ["mon"] }), show())).toBe(false));
  it("any show", () => expect(isRegularOfAny(comic({ tier: "regular", regularOf: ["tue"] }), [show(), show({ id: "tue" })])).toBe(true));
});

describe("showsLastWeekMarker", () => {
  it("shows for someone who played last week and is not a regular", () => expect(showsLastWeekMarker(comic(), show(), LAST)).toBe(true));
  it("hidden for a regular of that show, either way of being one", () => {
    expect(showsLastWeekMarker(comic(), show({ regulars: ["a@c.us"] }), LAST)).toBe(false);
    expect(showsLastWeekMarker(comic({ tier: "regular", regularOf: ["mon"] }), show(), LAST)).toBe(false);
  });
  it("kept for a regular of a different show", () => expect(showsLastWeekMarker(comic({ tier: "regular", regularOf: ["tue"] }), show(), LAST)).toBe(true));
  it("false when they did not play last week", () => expect(showsLastWeekMarker(comic({ lastPerformedWeek: "2026-10-12" }), show(), LAST)).toBe(false));
  it("a list of shows hides it when they are a regular of any", () => {
    expect(showsLastWeekMarker(comic({ tier: "regular", regularOf: ["tue"] }), [show(), show({ id: "tue" })], LAST)).toBe(false);
    expect(showsLastWeekMarker(comic(), [show()], LAST)).toBe(true);
  });
});

describe("request fact tags", () => {
  const base = { week: "2026-10-26", today: "2026-10-27", shows: [show({ regulars: ["a@c.us"] })] };
  it("a regular does not get Performed last week; others do", () => {
    expect(factTags({ ...base, comic: comic() }).map((t) => t.id)).not.toContain("performed_last_week");
    expect(factTags({ ...base, shows: [show()], comic: comic() }).map((t) => t.id)).toContain("performed_last_week");
  });
});
