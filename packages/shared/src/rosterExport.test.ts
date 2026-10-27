import { describe, expect, it } from "vitest";
import { buildBlrRoster } from "./fixtures/blrRooms.ts";
import { fromCsv, fromRosterJson } from "./rosterIO.ts";
import { buildExport } from "./rosterExport.ts";

const roster = () => buildBlrRoster();

describe("buildExport", () => {
  it("exports every room as CSV that reads back", () => {
    const r = roster();
    const f = buildExport(r, { format: "csv", stamp: "2026-10-27" })!;
    expect(f.filename).toBe("nothing-bot-rooms-2026-10-27.csv");
    expect(fromCsv(f.text).rooms).toHaveLength(r.rooms.length);
  });
  it("exports chosen rooms only, with only their curators", () => {
    const r = roster();
    const one = r.rooms[0]!;
    const f = buildExport(r, { format: "json", roomIds: new Set([one.id]), stamp: "d" })!;
    expect(f.filename).toBe("nothing-bot-rooms-d-selected.json");
    const back = fromRosterJson(f.text).roster;
    expect(back.rooms.map((x) => x.id)).toEqual([one.id]);
    expect(back.curators.length).toBeLessThanOrEqual(r.curators.length);
  });
  it("a backup keeps private notes and a share does not", () => {
    const r = roster();
    r.rooms[0]!.shows[0]!.myNotes = "PRIVATE-NOTE";
    const share = buildExport(r, { format: "json", stamp: "d" })!;
    const backup = buildExport(r, { format: "json", full: true, stamp: "d" })!;
    expect(backup.filename).toMatch(/-backup\.json$/);
    expect(backup.text).toContain("PRIVATE-NOTE");
    expect(share.text).not.toContain("PRIVATE-NOTE");
  });
  it("returns null when no room is chosen", () => {
    expect(buildExport(roster(), { format: "csv", roomIds: new Set(), stamp: "d" })).toBeNull();
  });
});
