import { describe, expect, it } from "vitest";
import { shareableRoster, type Roster, type RosterFollow, type SharedRoster } from "./rooms.ts";
import { buildBlrRoster } from "./fixtures/blrRooms.ts";
import {
  CHANGELOG_KEEP, applyPush, applySuggestion, buildPushDoc, currentValue, describeChanges, describeSuggestion, hasUpdate, planPush, publishedRosterId,
  suggestAddRoom, suggestAddShow, suggestCurator, suggestDay, suggestRemoveRoom, suggestRemoveShow, suggestRoomField, suggestShowField, suggestionConflict,
  type PublishedRosterDoc,
} from "./rosterCommunity.ts";

const mine = (): Roster => buildBlrRoster();
const published = (): SharedRoster => shareableRoster(mine());
const room = (r: SharedRoster, name: string, area?: string) => r.rooms.find((x) => x.name === name && (!area || x.area === area))!;

describe("hasUpdate", () => {
  const f = (v: number): RosterFollow => ({ rosterId: "r", seenVersion: v, followedAt: 0 });
  it("is true only when the roster is newer than what the follower last saw", () => {
    expect(hasUpdate(f(2), { version: 3 })).toBe(true);
    expect(hasUpdate(f(3), { version: 3 })).toBe(false);
    expect(hasUpdate(undefined, { version: 3 })).toBe(false);
  });
});

describe("publishedRosterId", () => {
  it("slugs the title and avoids ids in use", () => {
    expect(publishedRosterId("Bangalore Scene", [])).toBe("bangalore-scene");
    expect(publishedRosterId("Bangalore Scene", ["bangalore-scene"])).toBe("bangalore-scene-2");
    expect(publishedRosterId("!!!", [])).toBe("roster");
  });
});

describe("push", () => {
  it("first push adds every room and keeps nothing private", () => {
    const changes = planPush(null, mine());
    expect(changes.every((c) => c.op === "added")).toBe(true);
    const next = applyPush(null, mine(), changes.map((c) => c.id));
    expect(next.rooms).toHaveLength(mine().rooms.length);
    const text = JSON.stringify(next);
    expect(text).not.toContain("Good sound, tough crowd on Thursdays.");
    expect(text).not.toContain("myRole");
  });

  it("a second push with nothing new changes nothing", () => {
    expect(planPush(published(), mine())).toEqual([]);
  });

  it("pushes a change and leaves the rest of the published roster alone (including rooms mine lacks)", () => {
    const pub = published();
    const m = mine();
    room(m as unknown as SharedRoster, "Zostel").tags = ["new-comics"];
    m.rooms = m.rooms.filter((r) => r.name !== "TAG");
    const changes = planPush(pub, m);
    const tagChange = changes.find((c) => c.label.startsWith("Zostel") && c.field === "tags")!;
    expect(tagChange).toBeTruthy();
    // TAG is in the published roster only: "removed", and unpicked it stays.
    expect(changes.find((c) => c.op === "removed" && c.level === "room")?.label).toBe("TAG");
    const next = applyPush(pub, m, [tagChange.id]);
    expect(room(next, "Zostel").tags).toEqual(["new-comics"]);
    expect(next.rooms.some((r) => r.name === "TAG")).toBe(true);
    // Picking the removal takes it out.
    const removal = changes.find((c) => c.op === "removed")!;
    expect(applyPush(pub, m, [removal.id]).rooms.some((r) => r.name === "TAG")).toBe(false);
  });

  it("describes what was picked in a changelog line", () => {
    const pub = published();
    const m = mine();
    m.rooms.push({ id: "new-room", name: "New Room", area: "HSR", city: "Bengaluru", aliases: [], tags: [], notes: [], limits: [], shows: [] });
    room(m as unknown as SharedRoster, "Zostel").tags = ["bringer"];
    const changes = planPush(pub, m);
    expect(describeChanges(changes)).toBe("Added 1 room and updated 1 detail");
    expect(describeChanges([])).toBe("No changes");
  });

  it("buildPushDoc bumps the version, writes a changelog line and keeps the owner and co-maintainers", () => {
    const first = buildPushDoc({ current: null, next: published(), changes: [], picked: [], title: " Bangalore Scene ", city: "Bengaluru", ownerUid: "u1", ownerName: "Amrit", now: 1000 });
    expect(first).toMatchObject({ title: "Bangalore Scene", version: 1, ownerUid: "u1", coMaintainers: [], updatedAt: 1000 });
    expect(first.changelog?.[0]).toMatchObject({ version: 1, by: "Amrit" });
    const cur = { ...first, id: "x", coMaintainers: ["u2"], maintainerNames: { u2: "Sam" } } as PublishedRosterDoc;
    const next = buildPushDoc({ current: cur, next: published(), changes: [], picked: [], title: "Bangalore Scene", city: "Bengaluru", ownerUid: "someone-else", note: "Added Zostel", now: 2000 });
    expect(next.version).toBe(2);
    expect(next.ownerUid).toBe("u1");
    expect(next.coMaintainers).toEqual(["u2"]);
    expect(next.maintainerNames).toEqual({ u2: "Sam" });
    expect(next.changelog?.map((c) => c.text)).toEqual(["Added Zostel", first.changelog![0]!.text]);
  });

  it("keeps the changelog short", () => {
    let doc = buildPushDoc({ current: null, next: published(), changes: [], picked: [], title: "T", city: "C", ownerUid: "u", now: 1 });
    for (let i = 0; i < CHANGELOG_KEEP + 5; i++) doc = buildPushDoc({ current: { ...doc, id: "x" }, next: published(), changes: [], picked: [], title: "T", city: "C", ownerUid: "u", note: `n${i}`, now: i + 2 });
    expect(doc.changelog).toHaveLength(CHANGELOG_KEEP);
    expect(doc.changelog![0]!.text).toBe(`n${CHANGELOG_KEEP + 4}`);
  });
});

describe("suggestions", () => {
  const bloom = () => room(published(), "Bloom Indiranagar");

  it("changes a room field and records what the suggester saw", () => {
    const pub = published();
    const d = suggestRoomField(pub, bloom().id, "tags", ["english-only"], "  they only allow English ");
    expect(d).toMatchObject({ kind: "change", target: { field: "tags" }, before: [], after: ["english-only"], note: "they only allow English" });
    const r = applySuggestion(pub, d);
    expect(r.ok && room(r.roster, "Bloom Indiranagar").tags).toEqual(["english-only"]);
    // The input is untouched.
    expect(bloom().tags).toEqual([]);
  });

  it("changes a show field: times and ask rule", () => {
    const pub = published();
    const rm = room(pub, "Bloom Indiranagar");
    const d = suggestShowField(pub, rm.id, "mic", "times", ["21:00"]);
    expect(d.before).toEqual(["20:00"]);
    let r = applySuggestion(pub, d);
    expect(r.ok && room(r.roster, "Bloom Indiranagar").shows[0]!.times).toEqual(["21:00"]);
    r = applySuggestion(pub, suggestShowField(pub, rm.id, "mic", "askRule", { kind: "day_before", morning: true }));
    expect(r.ok && room(r.roster, "Bloom Indiranagar").shows[0]!.askRule).toEqual({ kind: "day_before", morning: true });
    // Clearing an optional field removes it.
    r = applySuggestion(pub, suggestShowField(pub, rm.id, "mic", "askRule", undefined));
    expect(r.ok && room(r.roster, "Bloom Indiranagar").shows[0]!.askRule).toBeUndefined();
  });

  it("changes who is on a day, adding a curator by name when the roster doesn't have them", () => {
    const pub = published();
    const rm = room(pub, "Bloom Indiranagar");
    const before = currentValue(pub, { roomId: rm.id, showId: "mic", field: "days.3" }) as { curators: { name: string }[] };
    expect(before.curators.map((c) => c.name)).toEqual(["Sharan"]);
    const d = suggestDay(pub, rm.id, "mic", 3, { curators: [{ name: "Priya Rao", phone: "+919800000001" }, { name: "sharan" }] });
    expect(d.kind).toBe("change");
    const r = applySuggestion(pub, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const day = room(r.roster, "Bloom Indiranagar").shows[0]!.days.find((x) => x.weekday === 3)!;
    const names = day.curatorIds.map((id) => r.roster.curators.find((c) => c.id === id)!.name);
    expect(names).toEqual(["Priya Rao", "Sharan"]);
    expect(r.roster.curators.find((c) => c.name === "Priya Rao")?.phone).toBe("+919800000001");
    // Sharan matched the existing curator instead of being duplicated.
    expect(r.roster.curators.filter((c) => c.name.toLowerCase() === "sharan")).toHaveLength(1);
  });

  it("adds a day the show didn't run, and removes one", () => {
    const pub = published();
    const rm = room(pub, "Bloom Indiranagar");
    const add = suggestDay(pub, rm.id, "mic", 5, { curators: [{ name: "Sharan" }], times: ["19:00"] });
    expect(add.kind).toBe("add");
    const a = applySuggestion(pub, add);
    expect(a.ok && room(a.roster, "Bloom Indiranagar").shows[0]!.days.map((d) => d.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const rem = suggestDay(pub, rm.id, "mic", 2, null);
    expect(rem.kind).toBe("remove");
    const b = applySuggestion(pub, rem);
    expect(b.ok && room(b.roster, "Bloom Indiranagar").shows[0]!.days.some((d) => d.weekday === 2)).toBe(false);
    // Removing a day that is already gone says so.
    if (b.ok) expect(applySuggestion(b.roster, rem)).toMatchObject({ ok: false });
  });

  it("changes a curator's number", () => {
    const pub = published();
    const rm = room(pub, "Bloom Indiranagar");
    const cid = pub.curators.find((c) => c.name === "Sharan")!.id;
    const d = suggestCurator(pub, rm.id, cid, "phone", "+919811111111");
    const r = applySuggestion(pub, d);
    expect(r.ok && r.roster.curators.find((c) => c.id === cid)?.phone).toBe("+919811111111");
    expect(applySuggestion(pub, { ...d, target: { roomId: rm.id, field: "curator:nobody:phone" } })).toMatchObject({ ok: false });
  });

  it("adds a new room with its curators, and refuses one that is already there", () => {
    const pub = published();
    const proposal = {
      room: { id: "new-spot", name: "New Spot", area: "HSR", city: "Bengaluru", aliases: [], tags: [], notes: [], limits: [], shows: [{ id: "mic", name: "Mic", type: "mic" as const, cadence: "weekly" as const, times: ["20:00"], days: [{ weekday: 2 as const, curatorIds: ["rita"] }] }] },
      curators: [{ id: "rita", name: "Rita", phone: "+919800000002" }],
    };
    const d = suggestAddRoom(proposal);
    const r = applySuggestion(pub, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(room(r.roster, "New Spot").shows[0]!.days[0]!.curatorIds).toEqual(["rita"]);
    expect(r.roster.curators.find((c) => c.id === "rita")?.phone).toBe("+919800000002");
    expect(applySuggestion(r.roster, d)).toMatchObject({ ok: false, reason: "That room is already in the roster." });
  });

  it("adds and removes a show", () => {
    const pub = published();
    const rm = room(pub, "Zostel");
    const show = { id: "show", name: "Late show", type: "show" as const, cadence: "weekly" as const, times: ["22:00"], days: [{ weekday: 5 as const, curatorIds: ["dev"] }] };
    const d = suggestAddShow(rm.id, { show, curators: [{ id: "dev", name: "Dev" }] });
    const r = applySuggestion(pub, d);
    expect(r.ok && room(r.roster, "Zostel").shows.map((s) => s.name)).toEqual(["Mic", "Late show"]);
    if (!r.ok) return;
    expect(applySuggestion(r.roster, d)).toMatchObject({ ok: false });
    const rem = suggestRemoveShow(r.roster, rm.id, "show");
    const r2 = applySuggestion(r.roster, rem);
    expect(r2.ok && room(r2.roster, "Zostel").shows.map((s) => s.name)).toEqual(["Mic"]);
  });

  it("removing a show also removes its limits; removing a room removes the room", () => {
    const pub = published();
    const rm = room(pub, "Glen's Bakehouse", "Koramangala");
    expect(rm.limits.some((l) => l.showId === "mic")).toBe(true);
    const r = applySuggestion(pub, suggestRemoveShow(pub, rm.id, "mic"));
    expect(r.ok && room(r.roster, "Glen's Bakehouse", "Koramangala").limits.some((l) => l.showId === "mic")).toBe(false);
    const gone = applySuggestion(pub, suggestRemoveRoom(pub, rm.id));
    expect(gone.ok && gone.roster.rooms.some((x) => x.id === rm.id)).toBe(false);
    if (gone.ok) expect(applySuggestion(gone.roster, suggestRemoveRoom(pub, rm.id))).toMatchObject({ ok: false });
  });

  it("refuses a suggestion about a room that has gone, and a field it doesn't know", () => {
    const pub = published();
    expect(applySuggestion(pub, { target: { roomId: "nope", field: "tags" }, kind: "change", after: [] })).toMatchObject({ ok: false });
    expect(applySuggestion(pub, { target: { roomId: bloom().id, field: "pin" }, kind: "change", after: {} })).toMatchObject({ ok: false });
    expect(applySuggestion(pub, { target: { roomId: bloom().id, field: "name" }, kind: "change", after: "" })).toMatchObject({ ok: false });
  });

  it("flags a conflict when the published value moved on", () => {
    const pub = published();
    const rm = bloom();
    const d = suggestShowField(pub, rm.id, "mic", "times", ["21:00"]);
    expect(suggestionConflict(pub, d)).toBe(false);
    const moved = applySuggestion(pub, suggestShowField(pub, rm.id, "mic", "times", ["22:00"]));
    expect(moved.ok && suggestionConflict(moved.roster, d)).toBe(true);
    expect(suggestionConflict(pub, suggestRemoveRoom(pub, rm.id))).toBe(false);
    expect(suggestionConflict({ rooms: [], curators: [] }, suggestRemoveRoom(pub, rm.id))).toBe(true);
  });

  it("describes a suggestion in plain words", () => {
    const pub = published();
    const rm = bloom();
    expect(describeSuggestion(suggestShowField(pub, rm.id, "mic", "times", ["21:00"]), pub)).toEqual({ where: "Bloom Indiranagar · Mic", what: "Change start times", from: "8 PM", to: "9 PM" });
    const day = describeSuggestion(suggestDay(pub, rm.id, "mic", 3, { curators: [{ name: "Priya" }], theyReachOut: false }), pub);
    expect(day).toEqual({ where: "Bloom Indiranagar · Mic", what: "Change Wednesday", from: "Sharan", to: "Priya" });
    expect(describeSuggestion(suggestRemoveRoom(pub, rm.id), pub)).toEqual({ where: "Bloom Indiranagar", what: "Remove this room" });
    expect(describeSuggestion(suggestRoomField(pub, rm.id, "tags", ["english-only"]), pub)).toMatchObject({ what: "Change tags", from: "nothing", to: "english-only" });
  });
});
