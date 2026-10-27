// How the agent names people in a reply: first names only, and a last name (or just its initial, when that tells them apart) only
// when two people in that same reply share a first name. Comic names often carry noise ("Comic BLR", "Comic J…", "(Comic)"): that is
// dropped first. One helper so Curate and Comedy replies agree.

const NOISE = new Set(["comic", "comics", "comedian", "blr", "bangalore", "bengaluru", "mumbai", "delhi", "del", "mum", "pune", "hyd", "nbs"]);

/** The name without noise tokens. Falls back to the trimmed original when nothing real is left (a bare number, an all-noise name). */
export function cleanName(raw: string): string {
  const original = raw.replace(/\s+/g, " ").trim();
  let t = original.replace(/\([^)]*\)/g, (m) => (m.slice(1, -1).split(/[\s,]+/).every((w) => !w || NOISE.has(w.toLowerCase().replace(/[^a-z]/g, ""))) ? " " : m));
  const words = t.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const bare = w.toLowerCase().replace(/[^a-z]/g, "");
    if (NOISE.has(bare)) {
      // "Comic J…": the clipped fragment after the noise word goes too.
      const next = words[i + 1];
      if (bare === "comic" && next && /^[A-Za-z]{1,2}[….]*$/.test(next) && /[….]$/.test(next)) i++;
      continue;
    }
    out.push(w);
  }
  t = out.join(" ").trim();
  return t || original;
}

const first = (n: string) => n.split(" ")[0]!;
const lastWord = (n: string) => (n.split(" ").length > 1 ? n.split(" ").slice(1).join(" ") : "");

/**
 * First names for a list of people, in order. Two people in the list with the same first name get a last initial ("Rohan S.",
 * "Rohan K."), or the whole last name when the initials clash too. The same person twice (identical names) stays the same.
 */
export function displayNames(people: string[]): string[] {
  const clean = people.map(cleanName);
  const out = clean.map(first);
  const groups = new Map<string, number[]>();
  clean.forEach((n, i) => {
    const k = first(n).toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  for (const idx of groups.values()) {
    const distinct = [...new Set(idx.map((i) => clean[i]!.toLowerCase()))];
    if (distinct.length < 2) continue; // the same person, or alone
    const withLast = distinct.filter((d) => lastWord(d));
    const initialsTell = new Set(withLast.map((d) => lastWord(d).charAt(0))).size === withLast.length;
    idx.forEach((i) => {
      const last = lastWord(clean[i]!);
      if (!last) return; // no last name known: nothing to add
      out[i] = initialsTell ? `${first(clean[i]!)} ${last.charAt(0).toUpperCase()}.` : `${first(clean[i]!)} ${last}`;
    });
  }
  return out;
}

/** One person's first name (noise removed), for a reply that names just them. */
export const displayName = (name: string): string => first(cleanName(name));
