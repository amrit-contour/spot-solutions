// Member picker search: who matches what was typed. Case and accents don't matter; each typed word must start a word in the name or
// the email ("sam r" finds Sam Rao; "rao" finds him too; "sam@" finds by email), so there is no mid-word noise.

export interface MemberLike {
  uid: string;
  name: string;
  email: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Members matching `query`, best first: name-prefix, then other matches, then by name and email. Blank query lists everyone. */
export function filterMembers<T extends MemberLike>(members: readonly T[], query: string, exclude: ReadonlySet<string> | readonly string[] = []): T[] {
  const skip = new Set(exclude);
  const pool = members.filter((m) => !skip.has(m.uid));
  const q = fold(query).trim();
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...pool];
  const scored: { m: T; rank: number }[] = [];
  for (const m of pool) {
    const nameWords = words(m.name);
    const all = [...nameWords, ...words(m.email), fold(m.email)];
    if (!terms.every((t) => all.some((w) => w.startsWith(t)))) continue;
    const full = fold(m.name);
    scored.push({ m, rank: full.startsWith(q) ? 0 : terms.every((t) => nameWords.some((w) => w.startsWith(t))) ? 1 : 2 });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.m.name.localeCompare(b.m.name, undefined, { sensitivity: "base" }) || a.m.email.localeCompare(b.m.email))
    .map((s) => s.m);
}
