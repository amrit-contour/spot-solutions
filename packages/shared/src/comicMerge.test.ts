import { describe, expect, it } from "vitest";
import { findDuplicateComics, linksFromMembers, maskPhoneDigits, memberKeySet, mergeComics, personGroups, pickerRows, pickKeep, remapLineup, remapShow } from "./comicMerge.ts";
import type { Comic, GroupMember, Lineup, Show } from "./types.ts";

const comic = (o: Partial<Comic> & { id: string }): Comic => ({ name: "Aman", phone: "", tier: "open", ...o });
const phoneDoc = comic({ id: "919876543210@c.us", phone: "919876543210", name: "Aman Gupta", nameSource: "contact" });
const lidDoc = comic({ id: "55501234@lid", chatId: "55501234@lid", name: "Aman", nameSource: "whatsapp" });
const members: GroupMember[] = [{ id: "919876543210@c.us", name: "Aman", isAdmin: false, alt: ["55501234@lid"] }];

describe("duplicates", () => {
  it("same phone digits under two ids are one person", () => {
    const a = comic({ id: "919876543210@c.us", phone: "919876543210" });
    const b = comic({ id: "x@c.us", phone: "+91 98765 43210" });
    expect(personGroups([a, b])).toHaveLength(1);
  });
  it("an @lid doc joins its phone doc through the group's id link, not by guessing digits", () => {
    expect(personGroups([phoneDoc, lidDoc])).toHaveLength(2);
    expect(personGroups([phoneDoc, lidDoc], linksFromMembers(members))).toHaveLength(1);
  });
  it("a phone doc that stored the @lid as its chatId matches without any link", () => {
    const d = comic({ id: "919876543210@c.us", phone: "919876543210", chatId: "55501234@lid" });
    expect(personGroups([d, lidDoc])).toHaveLength(1);
  });
  it("two different people with the same first name stay apart; an @lid number never equals a phone", () => {
    const other = comic({ id: "911111111111@c.us", phone: "911111111111" });
    const lidLooksLikePhone = comic({ id: "919876543210@lid" });
    expect(findDuplicateComics([phoneDoc, other, lidLooksLikePhone])).toEqual([]);
  });
  it("keeps the doc that is in the group, then one with a chatId, then a phone id", () => {
    const keys = memberKeySet(members);
    expect(pickKeep([lidDoc, phoneDoc], keys)).toBe(phoneDoc);
    const bare = comic({ id: "919000000001@c.us", phone: "919000000001" });
    const delivered = comic({ id: "919000000001@c.us", phone: "919000000001", chatId: "77@lid" });
    expect(pickKeep([bare, delivered])).toBe(delivered);
    expect(pickKeep([lidDoc, bare])).toBe(bare); // the phone id is the canonical one
    const onlyGroup = memberKeySet([{ id: "55501234@lid", name: "x", isAdmin: false }]);
    expect(pickKeep([bare, lidDoc], onlyGroup)).toBe(lidDoc);
  });
  it("finds the set and says why", () => {
    const [d] = findDuplicateComics([lidDoc, phoneDoc], linksFromMembers(members), memberKeySet(members));
    expect(d.keep).toBe(phoneDoc);
    expect(d.others).toEqual([lidDoc]);
    expect(d.why).toBe("whatsapp");
    const [n] = findDuplicateComics([comic({ id: "a@c.us", phone: "911234567890" }), comic({ id: "b@c.us", phone: "911234567890" })]);
    expect(n.why).toBe("number");
  });
});

describe("mergeComics", () => {
  it("fills the kept doc from the other, never overwrites, and keeps the other ids as aliases", () => {
    const keep = comic({ id: "919876543210@c.us", phone: "919876543210", name: "Aman", nameSource: "whatsapp", tier: "open", notes: "great", history: [{ date: "2026-01-05", showId: "a", showName: "A", status: "confirmed" }] });
    const other = comic({
      id: "55501234@lid",
      chatId: "55501234@lid",
      name: "Aman Gupta",
      nameSource: "manual",
      tier: "regular",
      list: "host",
      notes: "bring mic",
      regularOf: ["a"],
      lastPerformedWeek: "2026-02-02",
      history: [{ date: "2026-02-02", showId: "a", showName: "A", status: "confirmed" }, { date: "2026-01-05", showId: "a", showName: "A", status: "confirmed" }],
    });
    const m = mergeComics(keep, [other]);
    expect(m).toMatchObject({ id: keep.id, name: "Aman Gupta", nameSource: "manual", tier: "regular", list: "host", chatId: "55501234@lid", lastPerformedWeek: "2026-02-02", regularOf: ["a"] });
    expect(m.notes).toBe("great\nbring mic");
    expect(m.history?.map((h) => h.date)).toEqual(["2026-02-02", "2026-01-05"]);
    expect(m.aliases ?? []).not.toContain(keep.id);
    expect(Object.values(m)).not.toContain(undefined);
  });
  it("remembers a delivery id that differs from the kept one", () => {
    const keep = comic({ id: "919876543210@c.us", phone: "919876543210", chatId: "919876543210@c.us" });
    const m = mergeComics(keep, [lidDoc]);
    expect(m.aliases).toEqual(["55501234@lid"]);
  });
});

describe("remaps", () => {
  const from = new Set(["old"]);
  it("lineups: slots (deduped), sent, invites, leaving, dropped", () => {
    const l = {
      id: "w_s",
      weekOf: "w",
      showId: "s",
      date: "d",
      status: "draft",
      slots: [{ comicId: "old", minutes: 5 }, { comicId: "new" }, { comicId: "z" }],
      sent: { old: { at: 1, minutes: 5 } },
      groupInvites: { old: 9 },
      groupLeaving: ["old", "new"],
      dropped: [{ comicId: "old", at: 3 }],
    } as unknown as Lineup;
    const p = remapLineup(l, from, "new")!;
    expect(p.slots?.map((s) => s.comicId)).toEqual(["new", "z"]);
    expect(p.sent).toEqual({ new: { at: 1, minutes: 5 } });
    expect(p.groupInvites).toEqual({ new: 9 });
    expect(p.groupLeaving).toEqual(["new"]);
    expect(p.dropped).toEqual([{ comicId: "new", at: 3 }]);
    expect(remapLineup({ ...l, slots: [{ comicId: "z" }], sent: null, groupInvites: null, groupLeaving: null, dropped: [] }, from, "new")).toBeNull();
  });
  it("shows: regulars, co-hosts, POCs", () => {
    const s = { regulars: ["old", "x"], protected: ["x"], pocs: ["old", "new"] } as unknown as Show;
    expect(remapShow(s, from, "new")).toEqual({ regulars: ["new", "x"], pocs: ["new"] });
    expect(remapShow({ ...s, regulars: [], pocs: [] }, from, "new")).toBeNull();
  });
});

describe("picker rows", () => {
  it("merges duplicates into one row on the id WhatsApp reaches, with group + role + masked number", () => {
    const rows = pickerRows([lidDoc, phoneDoc, comic({ id: "911111111111@c.us", phone: "911111111111", name: "Priya" })], { members, regulars: ["55501234@lid"] });
    expect(rows).toHaveLength(2);
    const aman = rows.find((r) => r.name === "Aman Gupta")!;
    expect(aman).toMatchObject({ id: phoneDoc.id, inGroup: true, roles: ["regular"], masked: "+91 ••••• 3210" });
    expect(aman.ids.sort()).toEqual(["55501234@lid", "919876543210@c.us"]);
    expect(rows.find((r) => r.name === "Priya")).toMatchObject({ inGroup: false, roles: [] });
  });
  it("masks short and unknown numbers", () => {
    expect(maskPhoneDigits("")).toBe("");
    expect(maskPhoneDigits("12345")).toBe("");
    expect(maskPhoneDigits("6591234567")).toBe("+65 ••••• 4567");
  });
});
