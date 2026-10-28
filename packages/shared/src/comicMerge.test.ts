import { describe, expect, it } from "vitest";
import { dismissedPairs, duplicateSuggestions, findDuplicateComics, findSamePersonByName, linksFromMembers, maskPhoneDigits, memberKeySet, mergeComics, pairIds, pairKey, pairKeysAgainst, pairKeysFromSetKeys, pairKeysWithin, personGroups, splitPairKeys, pickerRows, pickKeep, remapLineup, remapShow, similarNames } from "./comicMerge.ts";
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
  it("one slot when both ids were on the lineup, filling what the first lacked", () => {
    const l = { slots: [{ comicId: "new", minutes: 5 }, { comicId: "old", minutes: 9, rating: 3, tags: ["Hack"], attendance: "late" }], groupSync: { status: "pending", toAdd: ["old"], toRemove: [], kept: ["new", "old"], invited: { old: 1 } } } as unknown as Lineup;
    const p = remapLineup(l, from, "new")!;
    expect(p.slots).toEqual([{ comicId: "new", minutes: 5, rating: 3, tags: ["Hack"], attendance: "late" }]);
    expect(p.groupSync).toMatchObject({ toAdd: ["new"], kept: ["new"], invited: { new: 1 } });
  });
  it("shows: regulars, co-hosts, POCs", () => {
    const s = { regulars: ["old", "x"], protected: ["x"], pocs: ["old", "new"] } as unknown as Show;
    expect(remapShow(s, from, "new")).toEqual({ regulars: ["new", "x"], pocs: ["new"] });
    expect(remapShow({ ...s, regulars: [], pocs: [] }, from, "new")).toBeNull();
  });
});

describe("mergeComics details", () => {
  it("a shared history entry keeps one copy with the rating, note, attendance and tags from either doc", () => {
    const h = (o: object) => ({ date: "2026-01-05", showId: "a", showName: "A", status: "confirmed" as const, ...o });
    const out = mergeComics(comic({ id: "k", history: [h({ rating: 4 })] }), [comic({ id: "o", history: [h({ rating: 2, note: "n", tags: ["Killed"], attendance: "late" })] })]);
    expect(out.history).toEqual([h({ rating: 4, note: "n", tags: ["Killed"], attendance: "late" })]);
  });
  it("does not repeat a note, and a real photo beats a hidden one", () => {
    const out = mergeComics(comic({ id: "k", notes: "a\nb", photoUrl: "none" }), [comic({ id: "o", notes: "b", photoUrl: "https://x/p.jpg", photoAt: 7 })]);
    expect(out.notes).toBe("a\nb");
    expect(out).toMatchObject({ photoUrl: "https://x/p.jpg", photoAt: 7 });
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

describe("not the same person", () => {
  const aman = (n: number, name = "Aman Verma") => comic({ id: `91980000000${n}@c.us`, phone: `91980000000${n}`, name, nameSource: "contact" });
  const [a, b, c, d] = [1, 2, 3, 4].map((n) => aman(n));
  const ids = (s: { keep: Comic; others: Comic[] }) => [s.keep.id, ...s.others.map((o) => o.id)].sort();

  it("pair keys are order-free; a whole suggestion is every pair; the old per-device keys convert", () => {
    expect(pairKey("b", "a")).toBe(pairKey("a", "b"));
    expect(pairIds(pairKey("y@lid", "x@c.us"))).toEqual(["x@c.us", "y@lid"]);
    expect(pairKeysWithin(["a", "b", "c"]).sort()).toEqual(["a|b", "a|c", "b|c"]);
    expect(pairKeysAgainst("c", ["a", "b", "c"])).toEqual(["a|c", "b|c"]);
    expect(pairKeysFromSetKeys(["b|a", "a|b|c", 7, null]).sort()).toEqual(["a|b", "a|c", "b|c"]);
    expect(pairKeysFromSetKeys("nope")).toEqual([]);
  });

  it("four people with one name are one suggestion until someone is taken out", () => {
    expect(findSamePersonByName([a, b, c, d]).map(ids)).toEqual([[a.id, b.id, c.id, d.id]]);
  });

  it("Not this person on one member drops them and leaves the rest a suggestion", () => {
    const no = new Set(pairKeysAgainst(c.id, [a.id, b.id, d.id]));
    expect(findSamePersonByName([a, b, c, d], [], new Set(), no).map(ids)).toEqual([[a.id, b.id, d.id]]);
  });

  it("two members taken out of the same group come back as their own pair", () => {
    // c and d set aside from {a,b,c,d}: each is recorded against the ones that stay, never against each other.
    const no = new Set(splitPairKeys([a.id, b.id, c.id, d.id], [c.id, d.id]));
    expect([...no].sort()).toEqual([pairKey(a.id, c.id), pairKey(a.id, d.id), pairKey(b.id, c.id), pairKey(b.id, d.id)].sort());
    expect(findSamePersonByName([a, b, c, d], [], new Set(), no).map(ids).sort()).toEqual([[a.id, b.id], [c.id, d.id]]);
  });

  it("Not same person on a whole suggestion hides it for good", () => {
    expect(findSamePersonByName([a, b], [], new Set(), new Set(pairKeysWithin([a.id, b.id])))).toEqual([]);
    // a third Aman still pairs up with either of them
    expect(findSamePersonByName([a, b, c], [], new Set(), new Set(pairKeysWithin([a.id, b.id]))).map(ids)).toEqual([[a.id, c.id]]);
  });

  it("a dismissed pair is never a safe merge either", () => {
    const x = comic({ id: "919800000009@c.us", phone: "919800000009" });
    const y = comic({ id: "other@c.us", phone: "919800000009" });
    expect(findDuplicateComics([x, y])).toHaveLength(1);
    expect(findDuplicateComics([x, y], [], new Set(), new Set([pairKey(x.id, y.id)]))).toEqual([]);
  });

  it("duplicateSuggestions lists the safe sets, then the name matches; dismissedPairs only lists pairs that still exist", () => {
    const lid = comic({ id: "55500001@lid", chatId: "55500001@lid", name: "Asha" });
    const ph = comic({ id: "919800000005@c.us", phone: "919800000005", name: "Asha" });
    const m: GroupMember[] = [{ id: ph.id, name: "Asha", isAdmin: false, alt: [lid.id] }];
    expect(duplicateSuggestions([lid, ph, a, b], m).map((s) => s.why)).toEqual(["whatsapp", "name"]);
    expect(dismissedPairs([a, b], [pairKey(a.id, b.id), pairKey(a.id, "gone@c.us")]).map((p) => p.key)).toEqual([pairKey(a.id, b.id)]);
  });

  it("similar names: equal, whole-word start or end, one-letter typo of a long name; not substrings", () => {
    expect(similarNames("Aman", "aman verma")).toBe(true);
    expect(similarNames("Priyanka", "Priyanca")).toBe(true);
    expect(similarNames("Amanda", "Aman")).toBe(false);
    expect(similarNames("Ravi", "Ravi")).toBe(true);
  });
});

describe("mergeComics keeps the best of both", () => {
  it("best name (manual > contact > whatsapp > number), one photo, unions numbers, aliases, pinned/hidden tags, earliest comedySince", () => {
    const keep = comic({ id: "919800000001@c.us", phone: "919800000001", name: "919800000001", nameSource: "number", photoUrl: "https://x/k.jpg", photoAt: 1, aliases: ["111@lid"], tagsPinned: ["Clean"], tagsHidden: ["Hack"], comedySince: "2023-05-01" });
    const contact = comic({ id: "919800000002@c.us", phone: "919800000002", name: "Asha K", nameSource: "contact", photoUrl: "https://x/o.jpg", photoAt: 2, tagsPinned: ["Hack"], comedySince: "2021-01-01" });
    const manual = comic({ id: "222@lid", chatId: "222@lid", name: "Asha Kapoor", nameSource: "manual", tagsHidden: ["Killer"], comedySince: "2022-01-01" });
    const m = mergeComics(keep, [contact, manual]);
    expect(m).toMatchObject({ id: keep.id, name: "Asha Kapoor", nameSource: "manual", photoUrl: "https://x/k.jpg", photoAt: 1, phone: "919800000001", comedySince: "2021-01-01" });
    expect(m.numbers?.map((n) => [n.phone, Boolean(n.primary)])).toEqual([["919800000001", true], ["919800000002", false]]);
    expect(m.chatId).toBe("222@lid"); // the only delivery id carries over
    expect(new Set(m.aliases)).toEqual(new Set(["111@lid", "919800000002@c.us"]));
    expect(m.tagsPinned?.sort()).toEqual(["Clean", "Hack"]);
    expect(m.tagsHidden).toEqual(["Killer"]); // pinned on one doc beats hidden on the other
    expect(Object.values(m)).not.toContain(undefined);
  });
  it("a contact name beats WhatsApp's, and WhatsApp's beats a bare number", () => {
    expect(mergeComics(comic({ id: "k", name: "A", nameSource: "whatsapp" }), [comic({ id: "o", name: "B", nameSource: "contact" })]).name).toBe("B");
    expect(mergeComics(comic({ id: "k", name: "919800000001", nameSource: "number" }), [comic({ id: "o", name: "B", nameSource: "whatsapp" })]).name).toBe("B");
    expect(mergeComics(comic({ id: "k", name: "A", nameSource: "manual" }), [comic({ id: "o", name: "B", nameSource: "contact" })]).name).toBe("A");
  });
});
