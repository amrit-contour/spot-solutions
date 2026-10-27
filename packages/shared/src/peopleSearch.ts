// Type-first people pickers: nothing is listed until something is typed. Each typed word must start a word of the name
// ("sam r" finds Sam Rao), and typed digits match anywhere in the phone number ("98765", "+91 98765"). Case and accents don't matter.

export interface PersonLike {
  id: string;
  name: string;
  phone?: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Shown under an empty search field. */
export const PEOPLE_SEARCH_HINT = "Type a name or number";

/** People matching `query`, best first (name starts with it, then word starts, then number). An empty query returns nobody. */
export function searchPeople<T extends PersonLike>(people: readonly T[], query: string, limit = 30): T[] {
  const q = fold(query).trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const digits = q.replace(/\D/g, "");
  const numeric = digits.length > 0 && /^[\d\s+()-]+$/.test(q);
  const scored: { p: T; rank: number }[] = [];
  for (const p of people) {
    const nameWords = words(p.name);
    const byName = terms.every((t) => nameWords.some((w) => w.startsWith(t)));
    const number = (p.phone || p.id.split("@")[0]).replace(/\D/g, "");
    const byNumber = numeric && number.includes(digits);
    if (!byName && !byNumber) continue;
    scored.push({ p, rank: fold(p.name).startsWith(q) ? 0 : byName ? 1 : 2 });
  }
  return scored.sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name, undefined, { sensitivity: "base" })).slice(0, limit).map((s) => s.p);
}
