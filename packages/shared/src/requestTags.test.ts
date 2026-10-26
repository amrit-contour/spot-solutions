import { describe, expect, it } from "vitest";
import { factTags, senderFacts } from "./requestTags.ts";
import type { Comic } from "./types.ts";

const comic = (o: Partial<Comic> = {}): Comic => ({ id: "c1", name: "Asha", phone: "1", tier: "open", ...o });
const base = { shows: [{ regulars: [] as string[], protected: [] as string[] }], week: "2026-10-26", today: "2026-10-27" };
const ids = (i: Parameters<typeof factTags>[0]) => factTags(i).map((t) => t.id);

describe("factTags", () => {
  it("marks someone created by this request as new to you", () => {
    expect(ids({ ...base, comic: comic(), firstContact: true })).toContain("new_to_you");
  });
  it("marks a rostered comic with no history and no earlier requests as new to you", () => {
    expect(ids({ ...base, comic: comic() })).toContain("new_to_you");
    expect(ids({ ...base, comic: comic(), priorRequests: 2 })).not.toContain("new_to_you");
  });
  it("is not new once there is history or a last performed week", () => {
    const h = [{ date: "2026-09-01", showId: "s", showName: "Mic", status: "confirmed" as const }];
    expect(ids({ ...base, comic: comic({ history: h }) })).not.toContain("new_to_you");
    expect(ids({ ...base, comic: comic({ lastPerformedWeek: "2026-10-12" }) })).not.toContain("new_to_you");
  });
  it("a missing comic is new to you", () => {
    expect(ids({ ...base, comic: undefined })).toEqual(["new_to_you"]);
  });
  it("flags performed last week only for the week before", () => {
    expect(ids({ ...base, comic: comic({ lastPerformedWeek: "2026-10-19" }) })).toContain("performed_last_week");
    expect(ids({ ...base, comic: comic({ lastPerformedWeek: "2026-10-12" }) })).not.toContain("performed_last_week");
  });
  it("flags regulars by tier or by a show's regulars list", () => {
    expect(ids({ ...base, comic: comic({ tier: "regular" }) })).toContain("regular");
    expect(ids({ ...base, comic: comic(), shows: [{ regulars: ["c1"], protected: [] }] })).toContain("regular");
    expect(ids({ ...base, comic: comic() })).not.toContain("regular");
  });
  it("flags protected comics as co-hosts", () => {
    expect(ids({ ...base, comic: comic(), shows: [{ regulars: [], protected: ["c1"] }] })).toContain("co_host");
  });
  it("counts only confirmed spots on or before today", () => {
    const h = [
      { date: "2026-11-02", showId: "s", showName: "Mic", status: "confirmed" as const },
      { date: "2026-10-20", showId: "s", showName: "Mic", status: "confirmed" as const },
      { date: "2026-10-13", showId: "s", showName: "Mic", status: "cancelled" as const },
      { date: "2026-10-06", showId: "s", showName: "Mic", status: "confirmed" as const },
    ];
    const tags = factTags({ ...base, comic: comic({ history: h }) });
    expect(tags.find((t) => t.id === "spots")?.label).toBe("Spots: 2");
    expect(ids({ ...base, comic: comic() })).not.toContain("spots");
  });
  it("is stable for the same input", () => {
    const i = { ...base, comic: comic({ tier: "regular" }) };
    expect(factTags(i)).toEqual(factTags(i));
  });
});

describe("senderFacts", () => {
  it("reports what the app knows", () => {
    const h = [
      { date: "2026-10-20", showId: "s", showName: "Mic", status: "confirmed" as const },
      { date: "2026-10-06", showId: "s", showName: "Mic", status: "confirmed" as const },
    ];
    const f = senderFacts({ comic: comic({ name: "Asha K", nameSource: "contact", tier: "regular", history: h, lastPerformedWeek: "2026-10-19" }), week: "2026-10-26", today: "2026-10-27", priorRequests: 3 });
    expect(f).toEqual({ onRoster: true, savedName: "Asha K", pastSpots: 2, lastSpotDate: "2026-10-20", tier: "regular", performedLastWeek: true, priorRequests: 3 });
  });
  it("describes a stranger without guessing", () => {
    const f = senderFacts({ comic: undefined, week: "2026-10-26", today: "2026-10-27" });
    expect(f).toMatchObject({ onRoster: false, savedName: null, pastSpots: 0, lastSpotDate: null, tier: "open", performedLastWeek: false });
  });
  it("does not treat a WhatsApp profile name as a saved name", () => {
    expect(senderFacts({ comic: comic({ nameSource: "whatsapp" }), week: "2026-10-26", today: "2026-10-27" }).savedName).toBeNull();
  });
});
