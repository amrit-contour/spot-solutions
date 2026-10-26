import type { GroupMember, GroupMode, Show } from "./types.ts";

export interface GroupDiffInput {
  participants: { id: string; isAdmin: boolean }[];
  confirmed: string[];
  regulars: string[];
  protected: string[];
  self: string;
  /** Marked to leave by the curator: removed even if an admin, regular or co-host. Never someone on the lineup. */
  forceRemove?: string[];
}

/** Who to add to / remove from a show's group so it holds exactly this week's lineup + regulars. */
export function diffGroup(input: GroupDiffInput) {
  const current = new Set(input.participants.map((p) => p.id));
  const onLineup = new Set(input.confirmed);
  const forced = new Set((input.forceRemove ?? []).filter((id) => !onLineup.has(id) && id !== input.self));
  const keep = new Set([
    ...input.confirmed,
    ...input.regulars,
    ...input.protected,
    input.self,
    ...input.participants.filter((p) => p.isAdmin).map((p) => p.id),
  ].filter((id) => !forced.has(id)));
  const toAdd = input.confirmed.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !keep.has(id));
  const kept = [...current].filter((id) => keep.has(id) && !onLineup.has(id));
  return { toAdd, toRemove, kept };
}

/**
 * Shows with a group that were saved before the choice existed updated it on confirm, so a missing mode means that.
 * A show with no group yet starts on "manual", the default for new ones.
 */
export const groupModeOf = (show: Pick<Show, "groupMode" | "groupId">): GroupMode => show.groupMode ?? (show.groupId ? "confirm" : "manual");

export type GroupTag = "admin" | "poc" | "cohost" | "regular" | "lineup" | "joining" | "leaving";

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
}

export interface GroupPanel {
  rows: GroupRow[];
  toAdd: string[];
  toRemove: string[];
  kept: string[];
}

const isPhoneId = (id: string) => id.endsWith("@c.us");

/**
 * What the group panel shows, and the sync it would run, from the last members read.
 * Anyone without a phone-based id is never tagged leaving: they can't be matched, so a sync keeps them.
 */
export function groupPanel(input: GroupPanelInput): GroupPanel {
  const known = input.members.filter((m) => isPhoneId(m.id));
  const { toAdd, toRemove, kept } = diffGroup({ participants: known, confirmed: input.lineup, regulars: input.regulars, protected: [...input.protected, ...(input.pocs ?? [])], self: "", forceRemove: input.forceRemove });
  const leaving = new Set(toRemove);
  const onLineup = new Set(input.lineup);
  const regulars = new Set(input.regulars);
  const cohosts = new Set(input.protected);
  const pocs = new Set(input.pocs ?? []);
  const tags = (id: string, isAdmin: boolean, member: boolean): GroupTag[] => [
    ...(isAdmin ? (["admin"] as const) : []),
    ...(pocs.has(id) ? (["poc"] as const) : []),
    ...(cohosts.has(id) && !pocs.has(id) ? (["cohost"] as const) : []),
    ...(regulars.has(id) ? (["regular"] as const) : []),
    ...(onLineup.has(id) ? ([member ? "lineup" : "joining"] as const) : []),
    ...(leaving.has(id) ? (["leaving"] as const) : []),
  ];
  const rows: GroupRow[] = [
    ...toAdd.map((id) => ({ id, member: false, isAdmin: false, known: true, tags: tags(id, false, false) })),
    ...input.members.map((m) => ({ id: m.id, member: true, isAdmin: m.isAdmin, known: isPhoneId(m.id), tags: tags(m.id, m.isAdmin, true) })),
  ];
  return { rows, toAdd, toRemove, kept };
}
