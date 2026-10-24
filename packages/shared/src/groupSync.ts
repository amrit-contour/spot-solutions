export interface GroupDiffInput {
  participants: { id: string; isAdmin: boolean }[];
  confirmed: string[];
  regulars: string[];
  protected: string[];
  self: string;
}

/** Who to add to / remove from a show's group so it holds exactly this week's lineup + regulars. */
export function diffGroup(input: GroupDiffInput) {
  const current = new Set(input.participants.map((p) => p.id));
  const keep = new Set([
    ...input.confirmed,
    ...input.regulars,
    ...input.protected,
    input.self,
    ...input.participants.filter((p) => p.isAdmin).map((p) => p.id),
  ]);
  const toAdd = input.confirmed.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !keep.has(id));
  const kept = [...current].filter((id) => keep.has(id) && !input.confirmed.includes(id));
  return { toAdd, toRemove, kept };
}
