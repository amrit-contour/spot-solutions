// One person, several comic docs: WhatsApp hands the same contact over as a phone id (91…@c.us) or an @lid, so a roster can end up
// holding them twice. This finds those, picks the doc WhatsApp can actually deliver to, and merges the others into it.
// Pure logic: the worker applies the plan (apps/worker/src/mergeComics.ts), the Show editor's people picker uses the same identity rules.
import { numbersOf, unionNumbers, withNumbers } from "./comicNumbers.ts";
import type { Comic, ComicNumber, GroupMember, Lineup, Show, Slot, SpotHistoryEntry, Tier } from "./types.ts";

/** What identifies a comic across its ids: the phone, the id WhatsApp delivers to, the other ids it has been seen under. */
export type Identity = Pick<Comic, "id" | "chatId" | "phone"> & { aliases?: string[]; numbers?: ComicNumber[] };

/** An @lid and the phone it belongs to, as WhatsApp reported them (group member lists carry both). */
export interface IdLink {
  lid: string;
  phone: string;
}

const digitsOf = (s: string) => s.split("@")[0].split(":")[0].replace(/\D/g, "");
const isLid = (id: string) => id.endsWith("@lid");
const isPhoneJid = (id: string) => id.endsWith("@c.us");

/** Phone digits of this comic when it has one (its phone field, or a phone id), else "". An @lid number is not a phone. */
export function phoneDigitsOf(c: Identity): string {
  const own = (c.phone ?? "").replace(/\D/g, "");
  if (own.length >= 7) return own;
  const jid = [c.id, c.chatId, ...(c.aliases ?? [])].find((x): x is string => Boolean(x) && isPhoneJid(x as string));
  return jid ? digitsOf(jid) : "";
}

const lidDigitsOf = (c: Identity): string[] => [...new Set([c.id, c.chatId, ...(c.aliases ?? [])].filter((x): x is string => Boolean(x) && isLid(x as string)).map(digitsOf))];

/** Links from a show's cached group members: the phone id next to the raw @lid WhatsApp also knows them by. */
export function linksFromMembers(members: readonly GroupMember[]): IdLink[] {
  return members.flatMap((m) => (isPhoneJid(m.id) ? (m.alt ?? []).filter(isLid).map((l) => ({ lid: digitsOf(l), phone: digitsOf(m.id) })) : []));
}

/** Every key a member answers to (phone digits, lid digits), used to ask "is this comic in the group?". */
export function memberKeySet(members: readonly GroupMember[]): Set<string> {
  const keys = new Set<string>();
  for (const m of members) {
    const phone = isPhoneJid(m.id);
    keys.add(`${phone ? "p" : isLid(m.id) ? "l" : "x"}${digitsOf(m.id) || m.id}`);
    for (const a of m.alt ?? []) keys.add(`${isLid(a) ? "l" : "p"}${digitsOf(a)}`);
  }
  return keys;
}

/** The keys of one comic, in the same space as memberKeySet. */
export function identityKeys(c: Identity): string[] {
  const phone = phoneDigitsOf(c);
  const phones = [...new Set([phone, ...numbersOf({ phone: c.phone, numbers: c.numbers }).map((n) => n.phone.replace(/\D/g, ""))].filter(Boolean))];
  return [...phones.map((p) => `p${p}`), ...lidDigitsOf(c).map((l) => `l${l}`), ...(!phones.length && !lidDigitsOf(c).length ? [`x${c.id}`] : [])];
}

/** Is this comic one of these group members, by phone or @lid? */
export const inMemberSet = (c: Identity, members: Set<string>) => identityKeys(c).some((k) => members.has(k));

/** Groups of items that are the same person (every group is in input order; singletons included). */
export function personGroups<T extends Identity>(items: readonly T[], links: readonly IdLink[] = []): T[][] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = parent.get(k) ?? k;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const l of links) union(`p${l.phone}`, `l${l.lid}`);
  const keysOf = items.map((it) => identityKeys(it));
  keysOf.forEach((ks) => ks.slice(1).forEach((k) => union(ks[0], k)));
  const out = new Map<string, T[]>();
  items.forEach((it, i) => {
    const root = find(keysOf[i][0]);
    out.set(root, [...(out.get(root) ?? []), it]);
  });
  return [...out.values()];
}

/**
 * Which of several docs for one person to keep: the one WhatsApp can reach. In the group first, then a phone-based id (the
 * canonical id; the merge carries the delivery id over), then one with a delivery id (chatId), then the one with more history. Stable: a tie keeps the earlier one.
 */
export function pickKeep<T extends Identity & { history?: unknown[] }>(group: readonly T[], members: Set<string> = new Set()): T {
  const score = (c: T) => (inMemberSet(c, members) ? 8 : 0) + (isPhoneJid(c.id) ? 3 : 0) + (c.chatId ? 2 : 0) + Math.min(c.history?.length ?? 0, 30) / 100;
  return group.reduce((best, c) => (score(c) > score(best) ? c : best), group[0]);
}

export interface DuplicateSet<T extends Identity> {
  keep: T;
  others: T[];
  /** Why they look like one person. */
  why: "number" | "whatsapp" | "name";
}

// ---- "Not the same person" ----
// The curator's answer to a suggestion, kept as pairs of comic ids (users/{uid}.settings.dupDismissed) so it syncs across
// devices and the worker's automatic merge respects it. A pair is never suggested or merged again, whatever links them.

/** Two comic ids, sorted and joined: one key per pair whichever way round it is asked. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The two ids of a pair key. */
export const pairIds = (key: string): [string, string] => {
  const [a = "", b = ""] = key.split("|");
  return [a, b];
};

/** "Not this person": the pair keys between one member and each of the others. */
export const pairKeysAgainst = (one: string, others: readonly string[]) => [...new Set(others.filter((o) => o && o !== one).map((o) => pairKey(one, o)))];

/** "Not this person" on some members of a suggestion: each of them against each member that stays (never against each other). */
export function splitPairKeys(memberIds: readonly string[], asideIds: readonly string[]): string[] {
  const aside = new Set(asideIds);
  const stay = memberIds.filter((id) => !aside.has(id));
  return [...new Set([...aside].flatMap((id) => pairKeysAgainst(id, stay)))];
}

/** "Not same person" on a whole suggestion: every pair inside it. */
export function pairKeysWithin(ids: readonly string[]): string[] {
  const u = [...new Set(ids.filter(Boolean))];
  return u.flatMap((a, i) => u.slice(i + 1).map((b) => pairKey(a, b)));
}

/** The old per-device format (each dismissed suggestion as all its ids joined with "|") as pair keys. Junk is skipped. */
export function pairKeysFromSetKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((k): k is string => typeof k === "string").flatMap((k) => pairKeysWithin(k.split("|"))))];
}

/** Dismissed pairs where both comics still exist (the Restore list), with the two docs. */
export function dismissedPairs<T extends { id: string }>(comics: readonly T[], dismissed: Iterable<string>): { key: string; a: T; b: T }[] {
  const byId = new Map(comics.map((c) => [c.id, c]));
  return [...new Set(dismissed)].flatMap((key) => {
    const [x, y] = pairIds(key);
    const a = byId.get(x);
    const b = byId.get(y);
    return a && b ? [{ key, a, b }] : [];
  });
}

/**
 * Groups of units (each unit one or more docs) that belong together, never putting a dismissed pair in the same group.
 * Greedy and stable: a unit joins the first group it is linked to and has no dismissal with; if it links two such groups
 * that don't clash, they become one. So taking someone out of a group leaves the rest together, and two people taken out
 * of the same group who match each other come back as their own group.
 */
function clusterApart<T extends { id: string }>(units: readonly T[][], linked: (a: number, b: number) => boolean, dismissed: ReadonlySet<string>): T[][][] {
  const clash = (a: T[], b: T[]) => dismissed.size > 0 && a.some((x) => b.some((y) => dismissed.has(pairKey(x.id, y.id))));
  const groups: number[][] = [];
  units.forEach((u, i) => {
    const fits = groups.filter((g) => g.some((j) => linked(i, j)) && !g.some((j) => clash(u, units[j])));
    if (!fits.length) return void groups.push([i]);
    const [first, ...rest] = fits;
    first.push(i);
    for (const g of rest) {
      if (g.some((j) => first.some((k) => clash(units[j], units[k])))) continue;
      first.push(...g);
      groups.splice(groups.indexOf(g), 1);
    }
  });
  return groups.map((g) => g.sort((a, b) => a - b).map((i) => units[i] as T[]));
}

/** One person's docs, split where the curator said two of them are not the same person. */
const splitDismissed = <T extends { id: string }>(group: T[], dismissed: ReadonlySet<string>): T[][] =>
  dismissed.size && group.length > 1 ? clusterApart(group.map((c) => [c]), () => true, dismissed).map((g) => g.flat()) : [group];

/**
 * Comics that are the same person under more than one doc (the same number, or a phone id and the @lid of the same WhatsApp
 * account). The doc to keep is the one WhatsApp reaches. These are the safe cases the worker merges by itself; a pair the
 * curator dismissed is never put together.
 */
export function findDuplicateComics<T extends Identity & { name: string; history?: unknown[] }>(comics: readonly T[], links: readonly IdLink[] = [], members: Set<string> = new Set(), dismissed: ReadonlySet<string> = new Set()): DuplicateSet<T>[] {
  return personGroups(comics, links)
    .flatMap((g) => splitDismissed(g, dismissed))
    .filter((g) => g.length > 1)
    .map((g) => {
      const keep = pickKeep(g, members);
      const phones = new Set(g.map((c) => phoneDigitsOf(c)).filter(Boolean));
      return { keep, others: g.filter((c) => c !== keep), why: (phones.size === 1 && g.every((c) => phoneDigitsOf(c)) ? "number" : "whatsapp") as "number" | "whatsapp" };
    })
    .sort((a, b) => a.keep.name.localeCompare(b.keep.name));
}

// ---- Same name, different number ----

const nameKey = (n: string) => n.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

/** A name worth comparing: a real one, not a bare number or a single short word. */
const comparable = (c: { name: string; nameSource?: Comic["nameSource"] }) => c.nameSource !== "number" && !/^\+?[\d\s-]+$/.test(c.name.trim()) && nameKey(c.name).length >= 3;

const editDistance = (a: string, b: string): number => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

/** similarNames on names already put through nameKey. */
function similarKeys(x: string, y: string): boolean {
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && (long.startsWith(`${short} `) || long.endsWith(` ${short}`))) return true;
  return short.length >= 6 && long.length - short.length <= 1 && editDistance(x, y) <= 1;
}

/** Same or similar name: equal, one the whole-word start of the other ("Aman" / "Aman Verma"), or a one-letter typo of a longer name. */
export const similarNames = (a: string, b: string): boolean => similarKeys(nameKey(a), nameKey(b));

/**
 * Different people-docs with the same or similar name but different numbers: a suggestion, never merged automatically.
 * Docs that are already the same account (same number, phone id and @lid) are not split here, `findDuplicateComics` has them.
 * Pairs the curator dismissed ("Not same person", "Not this person") are kept apart; the rest of a group stays a suggestion.
 */
export function findSamePersonByName<T extends Identity & { name: string; nameSource?: Comic["nameSource"]; history?: unknown[] }>(comics: readonly T[], links: readonly IdLink[] = [], members: Set<string> = new Set(), dismissed: ReadonlySet<string> = new Set()): DuplicateSet<T>[] {
  const units = personGroups(comics, links).flatMap((g) => splitDismissed(g, dismissed));
  const keys = units.map((u) => [...new Set(u.filter(comparable).map((c) => nameKey(c.name)))]);
  const linked = (i: number, j: number) => keys[i].some((a) => keys[j].some((b) => similarKeys(a, b)));
  return clusterApart(units, linked, dismissed)
    .filter((g) => g.length > 1)
    .map((g) => {
      const docs = g.flat();
      const keep = pickKeep(docs, members);
      return { keep, others: docs.filter((c) => c !== keep), why: "name" as const };
    })
    .sort((a, b) => a.keep.name.localeCompare(b.keep.name));
}

/** Everything the Possible duplicates card lists: the safe sets first, then the same-name suggestions. */
export function duplicateSuggestions<T extends Identity & { name: string; nameSource?: Comic["nameSource"]; history?: unknown[] }>(comics: readonly T[], members: readonly GroupMember[] = [], dismissed: Iterable<string> = []): DuplicateSet<T>[] {
  const links = linksFromMembers(members);
  const keys = memberKeySet(members);
  const no = new Set(dismissed);
  return [...findDuplicateComics(comics, links, keys, no), ...findSamePersonByName(comics, links, keys, no)];
}

const NAME_RANK = { number: 0, whatsapp: 1, contact: 2, manual: 3 } as const;
const TIER_RANK: Record<Tier, number> = { open: 0, regular: 1, featured: 2 };

/** The doc that survives a merge: the kept one, filled in from the others (never overwriting what the kept one has). */
export function mergeComics(keep: Comic, others: readonly Comic[]): Comic {
  let out: Comic = { ...keep };
  const ids = new Set<string>([keep.id, ...(keep.aliases ?? [])]);
  const seen = (x: string | undefined) => x && ids.has(x);
  for (const o of others) {
    // The best name wins: hand-edited, then saved in your phone, then WhatsApp's, then the bare number.
    if (NAME_RANK[o.nameSource ?? "whatsapp"] > NAME_RANK[out.nameSource ?? "whatsapp"]) out = { ...out, name: o.name, nameSource: o.nameSource };
    if (!out.phone && o.phone) out.phone = o.phone;
    if (!out.chatId && o.chatId) out.chatId = o.chatId;
    if (o.notes && !(out.notes ?? "").split("\n").includes(o.notes)) out.notes = out.notes ? `${out.notes}\n${o.notes}` : o.notes;
    if (o.tier && (!out.tier || TIER_RANK[o.tier] > TIER_RANK[out.tier])) out.tier = o.tier;
    if (!out.list && o.list) out.list = o.list;
    if ((o.lastPerformedWeek ?? "") > (out.lastPerformedWeek ?? "")) out.lastPerformedWeek = o.lastPerformedWeek;
    if (o.regularOf?.length) out.regularOf = [...new Set([...(out.regularOf ?? []), ...o.regularOf])];
    if (o.history?.length) out.history = mergeHistory(out.history, o.history);
    if (o.comedySince && (!out.comedySince || o.comedySince < out.comedySince)) out.comedySince = o.comedySince;
    if (o.tagsPinned?.length) out.tagsPinned = [...new Set([...(out.tagsPinned ?? []), ...o.tagsPinned])];
    if (o.tagsHidden?.length) out.tagsHidden = [...new Set([...(out.tagsHidden ?? []), ...o.tagsHidden])];
    if (!out.onboarding && o.onboarding) out.onboarding = o.onboarding;
    if (o.profile) out.profile = { ...o.profile, ...out.profile };
    // "none" means their picture is hidden: a real one found under the other id beats it.
    if ((!out.photoUrl || (out.photoUrl === "none" && o.photoUrl !== "none")) && o.photoUrl) {
      out.photoUrl = o.photoUrl;
      out.photoAt = o.photoAt;
    }
    for (const x of [o.id, o.chatId, ...(o.aliases ?? [])]) if (x && !seen(x)) ids.add(x);
  }
  // A tag pinned on either doc stays shown, even if the other had hidden it.
  if (out.tagsHidden?.length && out.tagsPinned?.length) {
    const hidden = out.tagsHidden.filter((t) => !out.tagsPinned!.includes(t));
    out.tagsHidden = hidden.length ? hidden : undefined;
  }
  // Every other id WhatsApp has known them by stays on the doc, so a message from the old one still finds this person.
  const aliases = [...ids].filter((x) => x !== out.id && x !== out.chatId);
  if (aliases.length) out.aliases = aliases;
  // Two different numbers for one person: both stay on the contact, the kept doc's number is the primary.
  const numbers = unionNumbers(out, [keep, ...others]);
  if (numbers.length > 1) out = withNumbers(out, numbers.map((n, i) => ({ ...n, primary: i === 0 })));
  // Firestore refuses undefined.
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as unknown as Comic;
}

function mergeHistory(a: SpotHistoryEntry[] | undefined, b: SpotHistoryEntry[]): SpotHistoryEntry[] {
  // The same show on both docs is one entry: the kept doc's values stand, and what only the other recorded (rating, note, attendance, tags) is added.
  const byKey = new Map<string, SpotHistoryEntry>();
  const defined = (h: SpotHistoryEntry) => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined && v !== null)) as unknown as SpotHistoryEntry;
  for (const h of [...b, ...(a ?? [])]) {
    const key = `${h.date}|${h.showId}`;
    byKey.set(key, byKey.has(key) ? { ...byKey.get(key)!, ...defined(h) } : h);
  }
  return [...byKey.values()].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 30);
}

const SLOT_FILL = ["minutes", "adhoc", "rating", "note", "attendance", "tags", "live"] as const;
const swapId = (id: string, from: ReadonlySet<string>, to: string) => (from.has(id) ? to : id);
const swapList = (xs: string[], from: ReadonlySet<string>, to: string) => [...new Set(xs.map((x) => swapId(x, from, to)))];

/** A show with the dropped comic ids replaced by the kept one (regulars, co-hosts, POCs). Null when nothing changes. */
export function remapShow(show: Show, from: ReadonlySet<string>, to: string): Partial<Pick<Show, "regulars" | "protected" | "pocs">> | null {
  const patch: Partial<Pick<Show, "regulars" | "protected" | "pocs">> = {};
  for (const k of ["regulars", "protected", "pocs"] as const) {
    const cur = show[k];
    if (cur?.some((x) => from.has(x))) patch[k] = swapList(cur, from, to);
  }
  return Object.keys(patch).length ? patch : null;
}

/** A lineup with the dropped comic ids replaced by the kept one (slots, what was sent, invites, leaving, dropped). Null when nothing changes. */
export function remapLineup(l: Lineup, from: ReadonlySet<string>, to: string): Partial<Lineup> | null {
  const patch: Partial<Lineup> = {};
  if (l.slots.some((s) => from.has(s.comicId))) {
    const seen = new Set<string>();
    // Someone on the lineup under both docs is one slot (the first).
    // The first slot stays, and fills in the set length, rating, note, attendance, tags and live pill only the other one had.
    const slots: Slot[] = [];
    for (const s of l.slots) {
      const slot = { ...s, comicId: swapId(s.comicId, from, to) };
      if (!seen.has(slot.comicId)) {
        seen.add(slot.comicId);
        slots.push(slot);
        continue;
      }
      const first = slots.find((x) => x.comicId === slot.comicId)!;
      for (const k of SLOT_FILL) if (first[k] == null && slot[k] != null) (first as unknown as Record<string, unknown>)[k] = slot[k];
    }
    patch.slots = slots;
  }
  const rekey = <V>(m: Record<string, V> | null | undefined): Record<string, V> | null => {
    if (!m || !Object.keys(m).some((k) => from.has(k))) return null;
    const out: Record<string, V> = {};
    for (const [k, v] of Object.entries(m)) {
      const nk = swapId(k, from, to);
      if (!(nk in out) || k === to) out[nk] = v;
    }
    return out;
  };
  const sent = rekey(l.sent);
  if (sent) patch.sent = sent;
  const invites = rekey(l.groupInvites);
  if (invites) patch.groupInvites = invites;
  if (l.groupLeaving?.some((x) => from.has(x))) patch.groupLeaving = swapList(l.groupLeaving, from, to);
  const gs = l.groupSync;
  if (gs && ([gs.toAdd, gs.toRemove, gs.kept, gs.lapsed ?? []].some((xs) => xs.some((x) => from.has(x))) || [gs.invited, gs.results].some((m) => m && Object.keys(m).some((k) => from.has(k))))) {
    patch.groupSync = { ...gs, toAdd: swapList(gs.toAdd, from, to), toRemove: swapList(gs.toRemove, from, to), kept: swapList(gs.kept, from, to), ...(gs.lapsed ? { lapsed: swapList(gs.lapsed, from, to) } : {}), ...(gs.invited ? { invited: rekey(gs.invited) ?? gs.invited } : {}), ...(gs.results ? { results: rekey(gs.results) ?? gs.results } : {}) };
  }
  if (l.dropped?.some((d) => from.has(d.comicId))) patch.dropped = l.dropped.map((d) => ({ ...d, comicId: swapId(d.comicId, from, to) }));
  return Object.keys(patch).length ? patch : null;
}

/** Request docs are named `${week}_${comicId}`: the id a request moves to when its comic is merged. */
export const requestIdFor = (weekOf: string, comicId: string) => `${weekOf}_${comicId}`;

// ---- People picker rows ----

export type PickerRole = "poc" | "regular" | "cohost";

export interface PickerRow {
  /** The id a tap toggles: the doc WhatsApp reaches. */
  id: string;
  /** Every doc id for this person (the duplicates); a tap on one counts for all. */
  ids: string[];
  name: string;
  phone: string;
  /** "+91 ••••• 3210", or "" when the number isn't known. */
  masked: string;
  inGroup: boolean;
  roles: PickerRole[];
}

/** "919876543210" -> "+91 ••••• 3210": enough to tell two Amans apart, without printing the number. */
export function maskPhoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length < 7) return "";
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : d.slice(0, 2);
  return `+${cc} ••••• ${d.slice(-4)}`;
}

export interface PickerContext {
  members?: readonly GroupMember[];
  pocs?: readonly string[];
  regulars?: readonly string[];
  cohosts?: readonly string[];
}

/** One row per person (duplicate docs merged), with group membership, roles and a masked number. */
export function pickerRows<T extends Identity & { name: string; nameSource?: Comic["nameSource"]; history?: unknown[] }>(comics: readonly T[], ctx: PickerContext = {}): PickerRow[] {
  const members = ctx.members ?? [];
  const keys = memberKeySet(members);
  const poc = new Set(ctx.pocs ?? []);
  const reg = new Set(ctx.regulars ?? []);
  const co = new Set(ctx.cohosts ?? []);
  return personGroups(comics, linksFromMembers(members)).map((g) => {
    const rep = pickKeep(g, keys);
    const ids = g.map((c) => c.id);
    const any = (s: Set<string>) => ids.some((i) => s.has(i));
    const phone = g.map(phoneDigitsOf).find(Boolean) ?? "";
    // Prefer a hand-set name, then a saved one: the same ranking as a merge.
    const name = g.reduce((best, c) => (NAME_RANK[c.nameSource ?? "whatsapp"] > NAME_RANK[best.nameSource ?? "whatsapp"] ? c : best), rep).name;
    return {
      id: rep.id,
      ids,
      name,
      phone,
      masked: maskPhoneDigits(phone),
      inGroup: g.some((c) => inMemberSet(c, keys)),
      roles: [...(any(poc) ? (["poc"] as const) : []), ...(any(reg) ? (["regular"] as const) : []), ...(any(co) ? (["cohost"] as const) : [])],
    };
  });
}
