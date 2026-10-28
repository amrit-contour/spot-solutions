// One contact per person, several numbers (phone-style). A comic's `phone` is the primary number; `numbers` lists every number when
// there is more than one; `aliases` holds the WhatsApp ids of all of them, and `chatId` is the chat messages go to (the primary's).
// Every place that asks "is this message from this person?" uses comicIdsOf / matchesComic, so a second number never needs its own doc.
import { comicIdForPhone, normalizePhone } from "./people.ts";
import type { Comic, ComicNumber } from "./types.ts";

type Ids = Pick<Comic, "id"> & { chatId?: string; phone?: string; aliases?: string[]; numbers?: ComicNumber[] };

/** Digits of a phone / JID: "919800000001:12@c.us" -> "919800000001". */
const digitsOf = (s: string) => s.split("@")[0].split(":")[0].replace(/\D/g, "");

/** Digits only, or "" when it isn't a plausible phone number. */
export const cleanNumber = (raw: string) => normalizePhone(raw);

/** Every number of this comic, primary first: `numbers` when set, else the single `phone`. */
export function numbersOf(c: { phone?: string; numbers?: ComicNumber[] }): ComicNumber[] {
  const list = (c.numbers ?? []).filter((n) => n.phone);
  if (!list.length) return c.phone ? [{ phone: c.phone, primary: true }] : [];
  const at = Math.max(0, list.findIndex((n) => n.primary));
  return [{ ...list[at], primary: true }, ...list.filter((_, i) => i !== at).map((n) => ({ ...n, primary: false }))];
}

/** The number messages go to: the primary entry, else the phone field. */
export const primaryNumberOf = (c: { phone?: string; numbers?: ComicNumber[] }): string => numbersOf(c)[0]?.phone ?? "";

/** Every WhatsApp id this person answers to: own ids, aliases, and the phone id of each of their numbers. */
export function comicIdsOf(c: Ids): string[] {
  const phoneIds = [...numbersOf(c).map((n) => n.phone), c.phone].map((p) => (p ?? "").replace(/\D/g, "")).filter(Boolean).map(comicIdForPhone);
  return [...new Set([c.id, c.chatId, ...(c.aliases ?? []), ...phoneIds].filter((x): x is string => Boolean(x)))];
}

/** Is this JID (a phone id, an @lid, a bare number) one of this person's? Device suffixes (":12") are ignored. */
export function matchesComic(c: Ids, jid: string | null | undefined): boolean {
  if (!jid) return false;
  const ids = comicIdsOf(c);
  if (ids.includes(jid)) return true;
  const [user, host] = jid.split("@");
  const base = `${user.split(":")[0]}@${host ?? "c.us"}`;
  return ids.includes(base) || (!host && ids.some((x) => x.endsWith("@c.us") && digitsOf(x) === digitsOf(jid)));
}

/** The id outbound messages (confirmations, polls, DMs) are sent to: the primary number's chat. */
export const deliveryIdOf = (c: Pick<Comic, "id" | "chatId">): string => c.chatId ?? c.id;

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The comic with `numbers` set to this list (primary first), phone following the primary and every number's WhatsApp id in
 * `aliases`. One number collapses back to the plain `phone` field. `chatId` moves to the new primary's chat only when the primary
 * changed; the old chat stays an alias so its replies still land here.
 */
export function withNumbers(c: Comic, list: ComicNumber[]): Comic {
  const seen = new Set<string>();
  const clean = list.map((n) => ({ ...n, phone: n.phone.replace(/\D/g, "") })).filter((n) => n.phone && !seen.has(n.phone) && seen.add(n.phone));
  if (!clean.length) return strip({ ...c, numbers: undefined });
  const at = Math.max(0, clean.findIndex((n) => n.primary));
  const ordered = [clean[at], ...clean.filter((_, i) => i !== at)].map((n, i) => strip({ phone: n.phone, label: n.label || undefined, primary: i === 0 ? true : undefined }));
  const out: Comic = { ...c, phone: ordered[0].phone, numbers: ordered.length > 1 ? ordered : undefined };
  if (c.phone && ordered[0].phone !== c.phone.replace(/\D/g, "")) out.chatId = comicIdForPhone(ordered[0].phone);
  const aliases = new Set([...comicIdsOf(c), ...ordered.map((n) => comicIdForPhone(n.phone))]);
  for (const x of [out.id, out.chatId]) aliases.delete(x as string);
  out.aliases = aliases.size ? [...aliases] : undefined;
  return strip(out);
}

/** Add a number (digits validated by the caller). Already there: the label is updated. */
export function addNumber(c: Comic, phone: string, label?: string): Comic {
  const d = phone.replace(/\D/g, "");
  const cur = numbersOf(c);
  if (cur.some((n) => n.phone === d)) return withNumbers(c, cur.map((n) => (n.phone === d && label ? { ...n, label } : n)));
  return withNumbers(c, [...cur, { phone: d, ...(label ? { label } : {}) }]);
}

export function makePrimary(c: Comic, phone: string): Comic {
  const d = phone.replace(/\D/g, "");
  return withNumbers(c, numbersOf(c).map((n) => ({ ...n, primary: n.phone === d })));
}

/** Remove a number. The last one can't be removed; removing the primary promotes the next. */
export function removeNumber(c: Comic, phone: string): Comic {
  const d = phone.replace(/\D/g, "");
  const cur = numbersOf(c);
  if (cur.length < 2 || !cur.some((n) => n.phone === d)) return c;
  const gone = comicIdForPhone(d);
  const out = withNumbers(c, cur.filter((n) => n.phone !== d));
  // Their id for the removed number is no longer theirs (unless it is the doc id).
  const aliases = (out.aliases ?? []).filter((x) => x !== gone);
  return strip({ ...out, aliases: aliases.length ? aliases : undefined });
}

/** Number lists joined (the kept doc's first, so its number stays primary), without repeats. */
export function unionNumbers(a: Pick<Comic, "phone" | "numbers">, others: readonly Pick<Comic, "phone" | "numbers">[]): ComicNumber[] {
  const out = [...numbersOf(a)];
  const seen = new Set(out.map((n) => n.phone.replace(/\D/g, "")));
  for (const o of others) {
    for (const n of numbersOf(o)) {
      const d = n.phone.replace(/\D/g, "");
      if (d && !seen.has(d)) (seen.add(d), out.push({ phone: n.phone, ...(n.label ? { label: n.label } : {}), primary: false }));
    }
  }
  return out;
}
