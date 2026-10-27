// Community rosters: pushing my rooms to a published roster, "update available", and suggested changes (build, show, apply).
// Pure, so it is tested without a UI or Firestore. Data model: docs/plans/comic-app.md ("Decided (Round 2)"), types in rooms.ts.
// A suggestion is field-level: `target` says which room / show / field, `before` is what the suggester saw, `after` what they
// propose. Approving applies `after` to the published roster (applySuggestion) and the caller bumps the version.
import {
  curatorKey, roomKey, shareableCurator, shareableDay, shareableRoster, showKey, slug,
  type AskRule, type CuratorShared, type DayPlan, type PublishedRoster, type RoomShared, type Roster, type RosterFollow,
  type RosterSuggestion, type ShowShared, type SharedRoster,
} from "./rooms.ts";
import { applyMerge, diffRosters, type RosterChange } from "./rosterMerge.ts";
import { formatValue, timesText } from "./rosterDescribe.ts";
import { DAY_NAMES } from "./week.ts";
import type { Weekday } from "./types.ts";

// ---------------------------------------------------------------------------------------------------------------------------
// The published document
// ---------------------------------------------------------------------------------------------------------------------------

export interface RosterChangelogEntry {
  version: number;
  at: number;
  text: string;
  by?: string;
}

/** publishedRosters/{id} as the app stores it: the PublishedRoster plus a short changelog and the co-maintainers' names. */
export interface PublishedRosterDoc extends PublishedRoster {
  /** Newest first, at most CHANGELOG_KEEP. */
  changelog?: RosterChangelogEntry[];
  /** uid -> display name, so the list can say who maintains it without reading other users. */
  maintainerNames?: Record<string, string>;
}

export const CHANGELOG_KEEP = 20;

/** An id for a new published roster: "bangalore-scene", then "bangalore-scene-2"... */
export function publishedRosterId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = slug(title) || "roster";
  let id = root;
  for (let n = 2; used.has(id); n++) id = `${root}-${n}`;
  return id;
}

export const toSharedRoster = (p: Pick<PublishedRoster, "rooms" | "curators">): SharedRoster => ({ rooms: p.rooms, curators: p.curators });

/** "Update available": a follower has seen an older version than the roster has now. */
export const hasUpdate = (follow: Pick<RosterFollow, "seenVersion"> | undefined | null, roster: Pick<PublishedRoster, "version">) =>
  Boolean(follow) && roster.version > follow!.seenVersion;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** "Added 1 room and 2 shows, updated 3 details". Used as the changelog line when the publisher doesn't write one. */
export function describeChanges(changes: RosterChange[]): string {
  const out: string[] = [];
  for (const op of ["added", "removed"] as const) {
    const parts = (["room", "show"] as const)
      .map((level) => ({ level, n: changes.filter((c) => c.op === op && c.level === level && !c.field).length }))
      .filter((x) => x.n > 0)
      .map((x) => plural(x.n, x.level));
    if (parts.length) out.push(`${op} ${sentence(parts)}`);
  }
  // Fields, weekdays and curator numbers are details.
  const details = changes.filter((c) => c.field).length;
  if (details) out.push(`updated ${plural(details, "detail")}`);
  if (!out.length) return "No changes";
  const text = sentence(out);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What pushing my rooms would change in the published roster (nothing published yet: everything is added). */
export function planPush(published: SharedRoster | null, mine: Roster): RosterChange[] {
  return diffRosters((published ?? { rooms: [], curators: [] }) as Roster, shareableRoster(mine));
}

/** The published rooms after taking the picked changes of a push. Private fields are never in either side. */
export function applyPush(published: SharedRoster | null, mine: Roster, picks: Iterable<string>): SharedRoster {
  const base = (published ?? { rooms: [], curators: [] }) as Roster;
  return shareableRoster(applyMerge(base, shareableRoster(mine), picks));
}

export interface PushInput {
  /** The current document, or null for the first push. */
  current: PublishedRosterDoc | null;
  next: SharedRoster;
  changes: RosterChange[];
  picked: string[];
  title: string;
  city: string;
  ownerUid: string;
  ownerName?: string;
  /** The publisher's changelog line; empty uses a summary of what was picked. */
  note?: string;
  now: number;
}

/** The document to write for a push: version + 1, a changelog line, owner and co-maintainers carried over. */
export function buildPushDoc(i: PushInput): Omit<PublishedRosterDoc, "id"> {
  const version = (i.current?.version ?? 0) + 1;
  const chosen = i.changes.filter((c) => i.picked.includes(c.id));
  const text = i.note?.trim() || (i.current ? describeChanges(chosen) : `First version, ${plural(i.next.rooms.length, "room")}`);
  const entry: RosterChangelogEntry = { version, at: i.now, text, ...(i.ownerName ? { by: i.ownerName } : {}) };
  return {
    title: i.title.trim(),
    city: i.city.trim(),
    ownerUid: i.current?.ownerUid ?? i.ownerUid,
    ...(i.current?.ownerName || i.ownerName ? { ownerName: i.current?.ownerName ?? i.ownerName } : {}),
    coMaintainers: i.current?.coMaintainers ?? [],
    ...(i.current?.maintainerNames ? { maintainerNames: i.current.maintainerNames } : {}),
    version,
    updatedAt: i.now,
    rooms: i.next.rooms,
    curators: i.next.curators,
    changelog: [entry, ...(i.current?.changelog ?? [])].slice(0, CHANGELOG_KEEP),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------------------------------------

/** What a day looks like in a suggestion: curators by name (ids differ between rosters). */
export interface DayProposal {
  times?: string[];
  curators: { name: string; phone?: string; instagram?: string }[];
  theyReachOut?: boolean;
  askRule?: AskRule;
  note?: string;
}
export interface NewRoomProposal {
  room: RoomShared;
  curators: CuratorShared[];
}
export interface NewShowProposal {
  show: ShowShared;
  curators: CuratorShared[];
}

export const ROOM_FIELD_LABEL = {
  name: "Name", area: "Area", city: "City", brand: "Chain", aliases: "Other names", tags: "Tags", notes: "Other ways to ask", limits: "Limits",
} as const;
export const SHOW_FIELD_LABEL = {
  name: "Name", type: "What it is", cadence: "How often", monthlyWeeks: "Which weeks", times: "Start times", askRule: "When to ask", tags: "Tags", note: "Note",
} as const;
export type RoomField = keyof typeof ROOM_FIELD_LABEL;
export type ShowField = keyof typeof SHOW_FIELD_LABEL;

export type SuggestionDraft = Omit<RosterSuggestion, "id" | "byUid" | "byName" | "status" | "createdAt" | "baseVersion">;

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
/** Equal however the keys are ordered and ignoring empty values. */
function stable(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, val]) => !empty(val) && val !== false).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, walk(val)]));
    }
    return x;
  };
  return JSON.stringify(walk(v)) ?? "null";
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const findRoom = (r: SharedRoster, id: string) => r.rooms.find((x) => x.id === id);
const findShow = (room: RoomShared | undefined, id: string | undefined) => (id ? room?.shows.find((s) => s.id === id) : undefined);
const nameOfCurator = (r: SharedRoster, id: string) => r.curators.find((c) => c.id === id)?.name ?? id;

/** A published day in the form a suggestion carries. */
export function dayProposalOf(roster: SharedRoster, d: DayPlan): DayProposal {
  return clone({
    times: d.times,
    curators: d.curatorIds.map((id) => {
      const c = roster.curators.find((x) => x.id === id);
      return { name: c?.name ?? id, ...(c?.phone ? { phone: c.phone } : {}), ...(c?.instagram ? { instagram: c.instagram } : {}) };
    }),
    theyReachOut: d.theyReachOut || undefined,
    askRule: d.askRule,
    note: d.note,
  });
}

/** The value a suggestion's field has in this roster right now (undefined when its room, show or day is gone). */
export function currentValue(roster: SharedRoster, t: RosterSuggestion["target"]): unknown {
  const room = findRoom(roster, t.roomId);
  if (!room) return undefined;
  if (!t.showId) return t.field ? (room as unknown as Record<string, unknown>)[t.field] : undefined;
  const show = findShow(room, t.showId);
  if (!show) return undefined;
  if (t.field?.startsWith("days.")) {
    const d = show.days.find((x) => x.weekday === Number(t.field!.slice(5)));
    return d ? dayProposalOf(roster, d) : undefined;
  }
  return t.field ? (show as unknown as Record<string, unknown>)[t.field] : undefined;
}

export function curatorFieldValue(roster: SharedRoster, curatorId: string, f: "phone" | "instagram") {
  return roster.curators.find((c) => c.id === curatorId)?.[f];
}

/** Draft: change one field of a room. */
export function suggestRoomField(roster: SharedRoster, roomId: string, field: RoomField, after: unknown, note?: string): SuggestionDraft {
  const target = { roomId, field };
  return { target, kind: "change", before: currentValue(roster, target), after: clone(after), ...(note?.trim() ? { note: note.trim() } : {}) };
}
/** Draft: change one field of a show. */
export function suggestShowField(roster: SharedRoster, roomId: string, showId: string, field: ShowField, after: unknown, note?: string): SuggestionDraft {
  const target = { roomId, showId, field };
  return { target, kind: "change", before: currentValue(roster, target), after: clone(after), ...(note?.trim() ? { note: note.trim() } : {}) };
}
/** Draft: who is on a day (null: the show does not run that day). */
export function suggestDay(roster: SharedRoster, roomId: string, showId: string, weekday: Weekday, after: DayProposal | null, note?: string): SuggestionDraft {
  const target = { roomId, showId, field: `days.${weekday}` };
  const before = currentValue(roster, target);
  return { target, kind: after === null ? "remove" : before === undefined ? "add" : "change", before, ...(after ? { after: clone(after) } : {}), ...(note?.trim() ? { note: note.trim() } : {}) };
}
/** Draft: a curator's number or Instagram. */
export function suggestCurator(roster: SharedRoster, roomId: string, curatorId: string, field: "phone" | "instagram", after: string, note?: string): SuggestionDraft {
  return { target: { roomId, field: `curator:${curatorId}:${field}` }, kind: "change", before: curatorFieldValue(roster, curatorId, field), after, ...(note?.trim() ? { note: note.trim() } : {}) };
}
export const suggestAddRoom = (p: NewRoomProposal, note?: string): SuggestionDraft => ({ target: { roomId: p.room.id }, kind: "add", after: clone(p), ...(note?.trim() ? { note: note.trim() } : {}) });
export const suggestAddShow = (roomId: string, p: NewShowProposal, note?: string): SuggestionDraft => ({ target: { roomId, showId: p.show.id }, kind: "add", after: clone(p), ...(note?.trim() ? { note: note.trim() } : {}) });
export const suggestRemoveRoom = (roster: SharedRoster, roomId: string, note?: string): SuggestionDraft => ({ target: { roomId }, kind: "remove", before: findRoom(roster, roomId)?.name, ...(note?.trim() ? { note: note.trim() } : {}) });
export const suggestRemoveShow = (roster: SharedRoster, roomId: string, showId: string, note?: string): SuggestionDraft => ({ target: { roomId, showId }, kind: "remove", before: findShow(findRoom(roster, roomId), showId)?.name, ...(note?.trim() ? { note: note.trim() } : {}) });

// ----- applying -----

export type ApplyResult = { ok: true; roster: SharedRoster } | { ok: false; reason: string };
const fail = (reason: string): ApplyResult => ({ ok: false, reason });

function uniqueCuratorId(r: SharedRoster, name: string) {
  const root = slug(name) || "curator";
  let id = root;
  for (let n = 2; r.curators.some((c) => c.id === id); n++) id = `${root}-${n}`;
  return id;
}
/** The curator with this name, added if the roster doesn't have them. A number only fills a gap; it never replaces one. */
function ensure(r: SharedRoster, c: { name: string; phone?: string; instagram?: string }): string {
  const hit = r.curators.find((x) => curatorKey(x) === curatorKey(c));
  if (hit) {
    if (!hit.phone && c.phone) hit.phone = c.phone;
    if (!hit.instagram && c.instagram) hit.instagram = c.instagram;
    return hit.id;
  }
  const id = uniqueCuratorId(r, c.name);
  r.curators.push(shareableCurator({ id, name: c.name.trim(), phone: c.phone, instagram: c.instagram }));
  return id;
}

const ROOM_FIELDS = Object.keys(ROOM_FIELD_LABEL);
const SHOW_FIELDS = Object.keys(SHOW_FIELD_LABEL);

/** Apply an approved suggestion to the published roster. Never throws; says why when it can't (the room is gone, already there). */
export function applySuggestion(roster: SharedRoster, s: Pick<RosterSuggestion, "target" | "kind" | "after">): ApplyResult {
  const t = s.target;
  const draft: SharedRoster = clone(roster);
  const room = findRoom(draft, t.roomId);

  // Curator details
  const cm = t.field?.match(/^curator:(.+):(phone|instagram)$/);
  if (cm) {
    const c = draft.curators.find((x) => x.id === cm[1]);
    if (!c) return fail("That curator is no longer in the roster.");
    const v = typeof s.after === "string" ? s.after.trim() : "";
    if (!v) return fail("There is no new value to apply.");
    c[cm[2] as "phone" | "instagram"] = v;
    return { ok: true, roster: shareableRoster(draft) };
  }

  // Whole room
  if (!t.showId && !t.field) {
    if (s.kind === "remove") {
      if (!room) return fail("That room is already gone.");
      draft.rooms = draft.rooms.filter((r) => r.id !== room.id);
      return { ok: true, roster: shareableRoster(draft) };
    }
    if (s.kind === "add") {
      const p = s.after as NewRoomProposal | undefined;
      if (!p?.room?.name) return fail("The suggestion is missing the room.");
      const base = draft as Roster;
      const added = diffRosters(base, { rooms: [p.room], curators: p.curators ?? [] }).filter((c) => c.op === "added" && c.level === "room");
      if (!added.length) return fail("That room is already in the roster.");
      return { ok: true, roster: shareableRoster(applyMerge(base, { rooms: [p.room], curators: p.curators ?? [] }, added.map((c) => c.id))) };
    }
    return fail("That kind of change isn't supported.");
  }
  if (!room) return fail("That room is no longer in the roster.");

  // Whole show
  if (t.showId && !t.field) {
    if (s.kind === "remove") {
      if (!findShow(room, t.showId)) return fail("That show is already gone.");
      room.shows = room.shows.filter((x) => x.id !== t.showId);
      room.limits = room.limits.filter((l) => l.showId !== t.showId);
      return { ok: true, roster: shareableRoster(draft) };
    }
    if (s.kind === "add") {
      const p = s.after as NewShowProposal | undefined;
      if (!p?.show?.name) return fail("The suggestion is missing the show.");
      if (room.shows.some((x) => showKey(x) === showKey(p.show))) return fail("That show is already in the room.");
      const base = draft as Roster;
      const proposed: RoomShared = { ...clone(room), shows: [...room.shows, p.show] };
      const target: SharedRoster = { rooms: draft.rooms.map((r) => (r.id === room.id ? proposed : r)), curators: [...draft.curators, ...(p.curators ?? [])] };
      const added = diffRosters(base, target).filter((c) => c.op === "added" && c.level === "show" && c.roomId === room.id);
      if (!added.length) return fail("That show is already in the room.");
      return { ok: true, roster: shareableRoster(applyMerge(base, target, added.map((c) => c.id))) };
    }
    return fail("That kind of change isn't supported.");
  }

  // A field of a room
  if (!t.showId && t.field) {
    if (!ROOM_FIELDS.includes(t.field)) return fail("That detail can't be changed by a suggestion.");
    const rec = room as unknown as Record<string, unknown>;
    const v = clone(s.after);
    if (empty(v) && t.field === "brand") delete rec.brand;
    else if (empty(v) && ["name", "area", "city"].includes(t.field)) return fail("The new value is empty.");
    else rec[t.field] = v ?? [];
    return { ok: true, roster: shareableRoster(draft) };
  }

  // A field or a weekday of a show
  const show = findShow(room, t.showId);
  if (!show) return fail("That show is no longer in the room.");
  const field = t.field!;
  if (field.startsWith("days.")) {
    const wd = Number(field.slice(5)) as Weekday;
    if (!(wd >= 0 && wd <= 6)) return fail("That day isn't valid.");
    const rest = show.days.filter((d) => d.weekday !== wd);
    if (s.kind === "remove") {
      if (rest.length === show.days.length) return fail("The show doesn't run that day already.");
      show.days = rest;
      return { ok: true, roster: shareableRoster(draft) };
    }
    const p = s.after as DayProposal | undefined;
    if (!p) return fail("The suggestion is missing the day.");
    const day: DayPlan = shareableDay({
      weekday: wd,
      times: p.times,
      curatorIds: (p.curators ?? []).filter((c) => c.name?.trim()).map((c) => ensure(draft, c)),
      theyReachOut: p.theyReachOut,
      askRule: p.askRule,
      note: p.note,
    });
    show.days = [...rest, day].sort((a, b) => a.weekday - b.weekday);
    return { ok: true, roster: shareableRoster(draft) };
  }
  if (!SHOW_FIELDS.includes(field)) return fail("That detail can't be changed by a suggestion.");
  const rec = show as unknown as Record<string, unknown>;
  const v = clone(s.after);
  if (empty(v) && !["name", "type", "cadence", "times"].includes(field)) delete rec[field];
  else rec[field] = v ?? [];
  return { ok: true, roster: shareableRoster(draft) };
}

/** The published roster has moved on since the suggester looked: what they saw is not what is there now. */
export function suggestionConflict(roster: SharedRoster, s: Pick<RosterSuggestion, "target" | "kind" | "before">): boolean {
  const t = s.target;
  const cm = t.field?.match(/^curator:(.+):(phone|instagram)$/);
  if (cm) return !same(curatorFieldValue(roster, cm[1]!, cm[2] as "phone" | "instagram"), s.before);
  if (!t.field) {
    if (s.kind === "remove") return t.showId ? !findShow(findRoom(roster, t.roomId), t.showId) : !findRoom(roster, t.roomId);
    return false;
  }
  return !same(currentValue(roster, t), s.before);
}

// ----- plain-language text -----

const FIELD_NAME: Record<string, string> = { ...ROOM_FIELD_LABEL, ...SHOW_FIELD_LABEL };

export interface SuggestionText {
  /** "Bloom Indiranagar · Mic". */
  where: string;
  /** "Add a room", "Change start times", "Change Monday". */
  what: string;
  from?: string;
  to?: string;
}

/** Plain words for the review queue. `roster` is the current published roster (for names). */
export function describeSuggestion(s: Pick<RosterSuggestion, "target" | "kind" | "before" | "after">, roster: SharedRoster): SuggestionText {
  const t = s.target;
  const room = findRoom(roster, t.roomId);
  const proposedRoom = s.kind === "add" && !t.showId && !t.field ? (s.after as NewRoomProposal | undefined)?.room : undefined;
  const roomName = room?.name ?? proposedRoom?.name ?? t.roomId;
  const show = findShow(room, t.showId);
  const proposedShow = s.kind === "add" && t.showId && !t.field ? (s.after as NewShowProposal | undefined)?.show : undefined;
  const showName = show?.name ?? proposedShow?.name ?? (typeof s.before === "string" && t.showId && !t.field ? s.before : undefined);
  const where = [roomName, t.showId ? showName : ""].filter(Boolean).join(" · ");
  const cm = t.field?.match(/^curator:(.+):(phone|instagram)$/);
  if (cm) return { where: nameOfCurator(roster, cm[1]!), what: `Change ${cm[2] === "phone" ? "their number" : "their Instagram"}`, from: formatValue(undefined, s.before), to: formatValue(undefined, s.after) };
  if (!t.field) {
    if (s.kind === "add") return t.showId ? { where, what: "Add a show", to: formatShowProposal(s.after as NewShowProposal | undefined) } : { where: roomName, what: "Add a room", to: formatRoomProposal(s.after as NewRoomProposal | undefined) };
    return { where, what: t.showId ? "Remove this show" : "Remove this room" };
  }
  if (t.field.startsWith("days.")) {
    const day = DAY_NAMES[Number(t.field.slice(5))] ?? "a day";
    const what = s.kind === "remove" ? `Stop running on ${day}` : s.kind === "add" ? `Add ${day}` : `Change ${day}`;
    return { where, what, from: s.before === undefined ? undefined : formatValue(t.field, s.before), to: s.kind === "remove" ? undefined : formatValue(t.field, s.after) };
  }
  return { where, what: `Change ${(FIELD_NAME[t.field] ?? t.field).toLowerCase()}`, from: formatValue(t.field, s.before), to: formatValue(t.field, s.after) };
}

function formatShowProposal(p: NewShowProposal | undefined) {
  if (!p) return undefined;
  const days = p.show.days.map((d) => DAY_NAMES[d.weekday]!.slice(0, 3)).join(", ");
  return [p.show.name, days, p.show.times.length ? timesText(p.show.times) : ""].filter(Boolean).join(", ");
}
function formatRoomProposal(p: NewRoomProposal | undefined) {
  if (!p) return undefined;
  return [p.room.name, [p.room.area, p.room.city].filter(Boolean).join(", "), ...p.room.shows.map(formatShowProposalShow)].filter(Boolean).join(" · ");
}
const formatShowProposalShow = (s: ShowShared) => formatShowProposal({ show: s, curators: [] }) ?? "";

/** Keep roomKey in the export surface: rooms in a suggestion match published ones by this when ids differ. */
export const sameRoom = (a: Pick<RoomShared, "name" | "area">, b: Pick<RoomShared, "name" | "area">) => roomKey(a) === roomKey(b);
