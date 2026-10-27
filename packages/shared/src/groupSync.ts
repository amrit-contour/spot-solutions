import type { GroupMember, GroupMode, Show } from "./types.ts";

/** Digits of a WhatsApp id or number: how people are matched across @c.us, @lid, comic ids and chat ids. */
const digitsOf = (id: string) => id.split("@")[0].split(":")[0].replace(/\D/g, "");
/** Digits when there are any (a phone or @lid number), else the id itself (test ids, odd JIDs). */
const keysOf = (ids: (string | undefined | null)[]) => ids.filter((x): x is string => Boolean(x)).map((x) => digitsOf(x) || x);

/** An invite link is good for this long: after it, someone who never joined is offered again ("Resend invite"). */
export const INVITE_TTL_MS = 24 * 3600_000;

export interface GroupParticipant {
  id: string;
  isAdmin: boolean;
  /** Every other id WhatsApp gave for this member (the @lid next to a phone id, or the reverse). */
  keys?: string[];
}

export interface GroupDiffInput {
  participants: GroupParticipant[];
  confirmed: string[];
  regulars: string[];
  protected: string[];
  /** The show's POCs: kept exactly like co-hosts (never removed unless marked to leave). */
  pocs?: string[];
  self: string;
  /** Marked to leave by the curator: removed even if an admin, regular or co-host. Never someone on the lineup. */
  forceRemove?: string[];
  /** Comic id -> the other ids that comic goes by (chat id, phone id), so an @lid comic matches a member read as a phone. */
  aliases?: Record<string, string[]>;
  /** Comics who were sent an invite link that is still good (not yet joined): not offered again. */
  waiting?: string[];
}

/**
 * Who to add to / remove from a show's group so it holds exactly this week's lineup + regulars.
 * People are matched by phone digits across every id form (the same rule as the cleanup), so someone already in the group is
 * never offered for adding just because the roster knows them by an @lid and the group by a phone id.
 */
export function diffGroup(input: GroupDiffInput) {
  const aliases = input.aliases ?? {};
  const idKeys = (id: string) => keysOf([id, ...(aliases[id] ?? [])]);
  const keySet = (ids: string[]) => new Set(ids.flatMap(idKeys));
  const memberKeys = (p: GroupParticipant) => keysOf([p.id, ...(p.keys ?? [])]);
  const present = new Set(input.participants.flatMap(memberKeys));
  const lineupKeys = keySet(input.confirmed);
  const selfKeys = new Set(idKeys(input.self));
  const forcedKeys = new Set((input.forceRemove ?? []).flatMap(idKeys).filter((k) => !lineupKeys.has(k) && !selfKeys.has(k)));
  const stay = new Set([...keySet([...input.confirmed, ...input.regulars, ...input.protected, ...(input.pocs ?? [])]), ...selfKeys]);
  for (const k of forcedKeys) stay.delete(k);
  const isKept = (p: GroupParticipant) => {
    const ks = memberKeys(p);
    return ks.some((k) => stay.has(k)) || (p.isAdmin && !ks.some((k) => forcedKeys.has(k)));
  };
  const waiting = new Set(input.waiting ?? []);
  const missing = input.confirmed.filter((id) => !idKeys(id).some((k) => present.has(k)));
  const toAdd = missing.filter((id) => !waiting.has(id));
  const invited = missing.filter((id) => waiting.has(id));
  const toRemove = input.participants.filter((p) => !isKept(p)).map((p) => p.id);
  const kept = input.participants.filter((p) => isKept(p) && !memberKeys(p).some((k) => lineupKeys.has(k))).map((p) => p.id);
  return { toAdd, toRemove, kept, invited };
}

/** Is this person (a comic id, with its aliases) among these group members? The review sheet uses it to never list who is already in. */
export function inGroup(id: string, members: { id: string; alt?: string[] }[], aliases: Record<string, string[]> = {}): boolean {
  const mine = keysOf([id, ...(aliases[id] ?? [])]);
  return members.some((m) => keysOf([m.id, ...(m.alt ?? [])]).some((k) => mine.includes(k)));
}

/**
 * Does a computed group plan hold anything the curator has to review: someone to add (a lapsed invite counts, it is offered again)
 * or remove? People already in the group, and invites still waiting ("Invite sent · waiting"), are not work.
 * `members` (the cached member list) drops anyone the plan only lists because it is a little old.
 */
export function groupPlanNeedsReview(
  plan: { toAdd?: string[]; toRemove?: string[]; invited?: Record<string, number> } | null | undefined,
  opts: { members?: { id: string; alt?: string[] }[]; aliases?: Record<string, string[]>; lapsed?: string[] } = {},
): boolean {
  if (!plan) return false;
  const lapsed = new Set(opts.lapsed ?? []);
  const adds = (plan.toAdd ?? []).filter((id) => (!plan.invited?.[id] || lapsed.has(id)) && !(opts.members && inGroup(id, opts.members, opts.aliases)));
  return adds.length + (plan.toRemove ?? []).length > 0;
}

/**
 * Which invites are still good. `lapsed`: invited more than a day ago and still not in, offered again with "Resend invite".
 * Anyone in the group (or off the lineup) drops out of the record.
 */
export function liveInvites(invites: Record<string, number> | null | undefined, now: number, confirmed: string[], isIn: (id: string) => boolean) {
  const waiting: Record<string, number> = {};
  const all: Record<string, number> = {};
  const lapsed: string[] = [];
  for (const [id, at] of Object.entries(invites ?? {})) {
    if (!confirmed.includes(id) || isIn(id)) continue;
    all[id] = at;
    if (now - at < INVITE_TTL_MS) waiting[id] = at;
    else lapsed.push(id);
  }
  return { waiting, lapsed, all };
}

export type SyncResult = "added" | "removed" | "invited" | "failed";

/**
 * WhatsApp says "added" even when it only sent an invite link (the person's privacy settings), so the group is read again:
 * an add that isn't in it becomes an invite waiting for them to accept; a removal that is still in it failed.
 * `invites` is the new record (existing ones for people who still aren't in, plus these).
 */
export function settleSyncResults(input: {
  results: Record<string, SyncResult>;
  now: number;
  isIn: (id: string) => boolean;
  prior?: Record<string, number> | null;
}): { results: Record<string, SyncResult>; invites: Record<string, number> } {
  const results: Record<string, SyncResult> = {};
  const invites: Record<string, number> = {};
  for (const [id, r] of Object.entries(input.results)) {
    const inside = input.isIn(id);
    if (r === "added") results[id] = inside ? "added" : "invited";
    else if (r === "removed") results[id] = inside ? "failed" : "removed";
    else results[id] = r === "invited" && inside ? "added" : r;
    if (results[id] === "invited") invites[id] = input.now;
  }
  for (const [id, at] of Object.entries(input.prior ?? {})) if (!(id in input.results) && !input.isIn(id)) invites[id] = at;
  return { results, invites };
}

/**
 * Shows with a group that were saved before the choice existed updated it on confirm, so a missing mode means that.
 * A show with no group yet starts on "manual", the default for new ones.
 */
export const groupModeOf = (show: Pick<Show, "groupMode" | "groupId">): GroupMode => show.groupMode ?? (show.groupId ? "confirm" : "manual");

/** joining: on the lineup, not in the group yet. invited: an invite link was sent and they haven't accepted. */
export type GroupTag = "admin" | "poc" | "cohost" | "regular" | "lineup" | "joining" | "invited" | "leaving";

export interface GroupRow {
  id: string;
  /** In the group right now (false: on the lineup but not added yet). */
  member: boolean;
  isAdmin: boolean;
  /** The number is known, so the person can be tagged and synced. */
  known: boolean;
  tags: GroupTag[];
}

export interface GroupPanelInput {
  members: GroupMember[];
  /** Comic ids on this lineup, in order. */
  lineup: string[];
  regulars: string[];
  protected: string[];
  /** POCs who run the mic: always kept, tagged POC. */
  pocs?: string[];
  forceRemove?: string[];
  aliases?: Record<string, string[]>;
  /** Comic id -> when the invite link went out (only the ones still good). */
  invited?: Record<string, number>;
}

export interface GroupPanel {
  rows: GroupRow[];
  toAdd: string[];
  toRemove: string[];
  kept: string[];
  /** On the lineup with an invite link out: not offered again until it lapses. */
  invited: string[];
}

const isPhoneId = (id: string) => id.endsWith("@c.us");

/**
 * What the group panel shows, and the sync it would run, from the last members read.
 * Anyone without a phone-based id is never tagged leaving: they can't be matched, so a sync keeps them.
 */
export function groupPanel(input: GroupPanelInput): GroupPanel {
  const aliases = input.aliases ?? {};
  const idKeys = (id: string) => keysOf([id, ...(aliases[id] ?? [])]);
  const keySet = (ids: string[]) => new Set(ids.flatMap(idKeys));
  const memberKeys = (m: GroupMember) => keysOf([m.id, ...(m.alt ?? [])]);
  const { toAdd, toRemove: wouldRemove, kept, invited } = diffGroup({
    participants: input.members.map((m) => ({ id: m.id, isAdmin: m.isAdmin, keys: m.alt })),
    confirmed: input.lineup,
    regulars: input.regulars,
    protected: input.protected,
    pocs: input.pocs,
    self: "",
    forceRemove: input.forceRemove,
    aliases,
    waiting: Object.keys(input.invited ?? {}),
  });
  const phoneOf = new Set(input.members.filter((m) => isPhoneId(m.id)).map((m) => m.id));
  const toRemove = wouldRemove.filter((id) => phoneOf.has(id));
  const keptKnown = kept.filter((id) => phoneOf.has(id));
  const leaving = new Set(toRemove);
  const onLineup = keySet(input.lineup);
  const regulars = keySet(input.regulars);
  const cohosts = keySet(input.protected);
  const pocs = keySet(input.pocs ?? []);
  const has = (set: Set<string>, ks: string[]) => ks.some((k) => set.has(k));
  const invitedIds = new Set(invited);
  const tags = (id: string, ks: string[], isAdmin: boolean, member: boolean): GroupTag[] => [
    ...(isAdmin ? (["admin"] as const) : []),
    ...(has(pocs, ks) ? (["poc"] as const) : []),
    ...(has(cohosts, ks) && !has(pocs, ks) ? (["cohost"] as const) : []),
    ...(has(regulars, ks) ? (["regular"] as const) : []),
    ...(has(onLineup, ks) ? ([member ? "lineup" : invitedIds.has(id) ? "invited" : "joining"] as const) : []),
    ...(leaving.has(id) ? (["leaving"] as const) : []),
  ];
  const rows: GroupRow[] = [
    ...[...toAdd, ...invited].map((id) => ({ id, member: false, isAdmin: false, known: true, tags: tags(id, idKeys(id), false, false) })),
    ...input.members.map((m) => ({ id: m.id, member: true, isAdmin: m.isAdmin, known: isPhoneId(m.id), tags: tags(m.id, memberKeys(m), m.isAdmin, true) })),
  ];
  return { rows, toAdd, toRemove, kept: keptKnown, invited };
}
