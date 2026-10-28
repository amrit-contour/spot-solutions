// "Is this comic already sorted?" for a spot ping: on the show's lineup for the date, and in the show's WhatsApp group.
// Regulars stay in the group and have a spot by default, so they shouldn't go through the request/ack/hold flows.
// Pure: group membership comes from the cached member list (Show.groupMembers), never from WhatsApp.
import { dateInWeek, DAY_NAMES, formatDate } from "./week.ts";
import { isRegularOf } from "./showRegulars.ts";
import { comicIdForPhone } from "./people.ts";
import type { Comic, GroupMembersCache, Lineup, Show, Weekday } from "./types.ts";

/** A cached member list older than this is treated as unknown (nothing here ever refreshes it). */
export const GROUP_CACHE_STALE_MS = 7 * 24 * 3600_000;

/** inGroup: true / false from a fresh cache; null when there is no usable cache (missing, other group, stale). */
export interface ShowCheck {
  showId: string;
  showName: string;
  day: string;
  date: string;
  inLineup: boolean;
  /** `none`: the show has no group linked, so only the lineup counts. */
  inGroup: boolean | null | "none";
  regular: boolean;
  /** Why the membership is unknown, for the held reason. */
  unknownWhy?: "missing" | "stale";
}

export type MembershipDecision =
  | { kind: "confirmed"; check: ShowCheck }
  | { kind: "hold_in_group"; check: ShowCheck; reason: string }
  | { kind: "hold_on_lineup"; check: ShowCheck; reason: string }
  | { kind: "hold_unknown"; check: ShowCheck; reason: string }
  | { kind: "normal"; regular: boolean };

export const HOLD_IN_GROUP_REASON = "In the group, not on the lineup";
export const HOLD_ON_LINEUP_REASON = "On the lineup, not in the group";

const keysOfComic = (c: Pick<Comic, "id" | "chatId" | "phone" | "aliases">) =>
  new Set([c.id, c.chatId, ...(c.aliases ?? []), c.phone ? comicIdForPhone(c.phone.replace(/\D/g, "")) : undefined].filter((x): x is string => Boolean(x)));

/** The cache's verdict for this comic: true/false, or null (with why) when the list can't be trusted. */
export function groupVerdict(comic: Pick<Comic, "id" | "chatId" | "phone" | "aliases">, show: Pick<Show, "groupId" | "groupMembers">, now: number): { inGroup: boolean | null | "none"; why?: "missing" | "stale" } {
  if (!show.groupId) return { inGroup: "none" };
  const c: GroupMembersCache | null | undefined = show.groupMembers;
  if (!c || c.groupId !== show.groupId) return { inGroup: null, why: "missing" };
  if (now - c.at > GROUP_CACHE_STALE_MS) return { inGroup: null, why: "stale" };
  const mine = keysOfComic(comic);
  return { inGroup: c.members.some((m) => [m.id, ...(m.alt ?? [])].some((k) => mine.has(k))) };
}

/**
 * Which shows a ping is about: the ones on their preferred days / named in the hint, else every active show.
 */
export function targetShows(shows: Show[], intent: { preferredDays?: Weekday[]; preferredShowHint?: string | null }): Show[] {
  const active = shows.filter((s) => s.active);
  const hint = intent.preferredShowHint?.trim().toLowerCase();
  const byHint = hint ? active.filter((s) => s.name.toLowerCase().includes(hint) || hint.includes(s.name.toLowerCase())) : [];
  if (byHint.length) return byHint;
  const byDay = intent.preferredDays?.length ? active.filter((s) => intent.preferredDays!.includes(s.weekday)) : [];
  return byDay.length ? byDay : active;
}

/** Per-show flags for this week. A cancelled or canned lineup doesn't count as being on it. */
export function checkShows(input: { comic: Pick<Comic, "id" | "chatId" | "phone" | "aliases" | "tier" | "regularOf">; shows: Show[]; lineups: Pick<Lineup, "showId" | "status" | "slots">[]; week: string; now: number }): ShowCheck[] {
  const { comic, week, now } = input;
  const mine = keysOfComic(comic);
  return input.shows.map((s) => {
    const l = input.lineups.find((x) => x.showId === s.id);
    const inLineup = Boolean(l && l.status !== "cancelled" && l.status !== "canned" && l.slots.some((x) => mine.has(x.comicId)));
    const v = groupVerdict(comic, s, now);
    return {
      showId: s.id,
      showName: s.name,
      day: DAY_NAMES[s.weekday],
      date: formatDate(dateInWeek(week, s.weekday)),
      inLineup,
      inGroup: v.inGroup,
      regular: isRegularOf(comic, s),
      ...(v.why && { unknownWhy: v.why }),
    };
  });
}

/**
 * The decision, over every show the ping is about (first match wins, so "on a lineup AND in its group" beats everything):
 * 1. on a show's lineup and in its group (or it has no group): confirmed, auto-reply, no request.
 * 2. on the lineup, group list unusable: hold (can't confirm the group).
 * 3. on the lineup, not in the group: hold, suggest the group add.
 * 4. in the group, not on the lineup: hold, don't reply.
 * 5. group list unusable for a show they could be in: hold, saying so.
 * 6. a regular of a show, neither on the lineup nor in the group: hold like 4.
 * 7. otherwise the normal flows; `regular` exempts them from the performed-recently hold.
 */
export function membershipDecision(checks: ShowCheck[]): MembershipDecision {
  const sure = checks.find((c) => c.inLineup && (c.inGroup === true || c.inGroup === "none"));
  if (sure) return { kind: "confirmed", check: sure };
  const lineupOnly = checks.find((c) => c.inLineup && c.inGroup === false);
  const lineupUnknown = checks.find((c) => c.inLineup && c.inGroup === null);
  if (lineupOnly) return { kind: "hold_on_lineup", check: lineupOnly, reason: HOLD_ON_LINEUP_REASON };
  if (lineupUnknown) return { kind: "hold_unknown", check: lineupUnknown, reason: unknownReason(lineupUnknown, "On the lineup") };
  const groupOnly = checks.find((c) => !c.inLineup && c.inGroup === true);
  if (groupOnly) return { kind: "hold_in_group", check: groupOnly, reason: HOLD_IN_GROUP_REASON };
  const unknown = checks.find((c) => c.inGroup === null);
  if (unknown) return { kind: "hold_unknown", check: unknown, reason: unknownReason(unknown, "Not on the lineup") };
  const regular = checks.find((c) => c.regular);
  if (regular) return { kind: "hold_in_group", check: regular, reason: `Regular of ${regular.showName}, not on the lineup or in the group` };
  return { kind: "normal", regular: regularOfChecks(checks) };
}

const unknownReason = (c: ShowCheck, lead: string) => `${lead}; ${c.showName}'s group list is ${c.unknownWhy === "stale" ? "out of date" : "not loaded"}, so membership is unknown`;

/** Regular of any of these shows: exempt from the performed-recently hold and request limits. */
export const regularOfChecks = (checks: ShowCheck[]) => checks.some((c) => c.regular);
