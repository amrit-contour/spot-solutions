import { describe, expect, it } from "vitest";
import { demoTemplateWeek, shiftDemoData, type DemoData } from "./demo.ts";

const H = 3_600_000;
const SEEDED = Date.parse("2026-10-14T10:00:00Z"); // a Wednesday; the template week is 2026-10-12 (rolled)
const W = "2026-10-12";
const LAST = "2026-10-05";

const template = (): DemoData => ({
  shows: [{ id: "mon", data: { id: "mon", name: "Monday Mic" } }],
  comics: [
    { id: "c1@c.us", data: { id: "c1@c.us", lastPerformedWeek: LAST, history: [{ date: "2026-10-06", showId: "tue", showName: "T", status: "confirmed" }] } },
    { id: "c2@c.us", data: { id: "c2@c.us", lastPerformedWeek: null } },
  ],
  requests: [
    {
      id: `${W}_c1@c.us`,
      data: { id: `${W}_c1@c.us`, comicId: "c1@c.us", weekOf: W, status: "acked", messages: [{ id: "m", body: "hi", at: SEEDED - 10 * H }], ackedAt: SEEDED - 9 * H, createdAt: SEEDED - 10 * H, updatedAt: SEEDED - 9 * H },
    },
  ],
  lineups: [
    { id: `${W}_mon`, data: { id: `${W}_mon`, weekOf: W, showId: "mon", date: W, slots: [], status: "draft", sentAt: null, groupSync: null } },
    { id: `${LAST}_tue`, data: { id: `${LAST}_tue`, weekOf: LAST, showId: "tue", date: "2026-10-06", slots: [], status: "confirmed", sentAt: SEEDED - 7 * 24 * H } },
  ],
  actions: [{ id: "a", data: { weekOf: W, lineupId: `${W}_mon`, createdAt: SEEDED - H, status: "pending" } }],
  notices: [{ id: "n", data: { text: "hi", createdAt: SEEDED - 2 * H, read: false } }],
});

describe("demoTemplateWeek", () => {
  it("is the newest request week", () => {
    expect(demoTemplateWeek(template())).toBe(W);
  });
  it("falls back to lineups, then null", () => {
    expect(demoTemplateWeek({ lineups: template().lineups })).toBe(W);
    expect(demoTemplateWeek({ shows: template().shows })).toBeNull();
  });
});

describe("shiftDemoData", () => {
  const NOW = Date.parse("2027-01-06T08:00:00Z");
  const TO = "2027-01-04";
  const out = shiftDemoData(template(), { toWeek: TO, now: NOW, templateAt: SEEDED });
  const one = (coll: string, id: string) => out[coll].find((d) => d.id === id)!;

  it("moves week keys, ids and dates by whole weeks", () => {
    const r = one("requests", `${TO}_c1@c.us`);
    expect(r.data).toMatchObject({ id: `${TO}_c1@c.us`, weekOf: TO });
    const l = one("lineups", `${TO}_mon`);
    expect(l.data).toMatchObject({ id: `${TO}_mon`, weekOf: TO, date: TO });
    const prev = one("lineups", "2026-12-28_tue");
    expect(prev.data).toMatchObject({ weekOf: "2026-12-28", date: "2026-12-29" });
    expect(one("actions", "a").data).toMatchObject({ weekOf: TO, lineupId: `${TO}_mon` });
  });

  it("moves comics' last performed week and history", () => {
    expect(one("comics", "c1@c.us").data).toMatchObject({ lastPerformedWeek: "2026-12-28", history: [{ date: "2026-12-29", showId: "tue" }] });
    expect(one("comics", "c2@c.us").data.lastPerformedWeek).toBeNull();
  });

  it("keeps relative times: ages are unchanged", () => {
    const r = one("requests", `${TO}_c1@c.us`).data as { createdAt: number; ackedAt: number; messages: { at: number }[] };
    expect(NOW - r.createdAt).toBe(10 * H);
    expect(NOW - r.ackedAt).toBe(9 * H);
    expect(NOW - r.messages[0].at).toBe(10 * H);
    expect(NOW - (one("actions", "a").data.createdAt as number)).toBe(H);
    expect(NOW - (one("notices", "n").data.createdAt as number)).toBe(2 * H);
    expect(NOW - (one("lineups", "2026-12-28_tue").data.sentAt as number)).toBe(7 * 24 * H);
  });

  it("leaves other docs and null fields alone, and does not mutate the template", () => {
    expect(out.shows).toEqual(template().shows);
    expect(one("lineups", `${TO}_mon`).data.sentAt).toBeNull();
    expect(template().requests[0].id).toBe(`${W}_c1@c.us`);
  });

  it("is a no-op in the template's own week", () => {
    const same = shiftDemoData(template(), { toWeek: W, now: SEEDED, templateAt: SEEDED });
    expect(same.requests[0].id).toBe(`${W}_c1@c.us`);
    expect(same.requests[0].data.createdAt).toBe(SEEDED - 10 * H);
  });

  it("moves backwards too, and derives the seed time from the data", () => {
    const back = shiftDemoData(template(), { toWeek: "2026-09-28", now: SEEDED - 14 * 24 * H });
    expect(back.requests[0].id).toBe("2026-09-28_c1@c.us");
    // Newest template timestamp (SEEDED - 1h, the action) becomes `now`.
    expect(back.actions[0].data.createdAt).toBe(SEEDED - 14 * 24 * H);
  });
});
