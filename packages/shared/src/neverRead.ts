// "Never read": people and groups whose messages are skipped before anything else happens. Never read, never sent to the AI,
// never stored. The worker checks this first in every inbound path (live messages, catch-up, scans, voice learning, group watch).
// Entry ids are normalised: a person is `<digits>@c.us` (or `<n>@lid` when WhatsApp only gave a lid), a group is `<id>@g.us`.
import { comicIdsOf } from "./comicNumbers.ts";
import type { Comic } from "./types.ts";

export interface NeverReadEntry {
  /** `<phone digits with country code>@c.us`, `<n>@lid` or `<id>@g.us`. */
  id: string;
  kind: "person" | "group";
  /** What the curator saw when adding it: a name or the typed number. Shown in Settings, never used to match. */
  name?: string;
  addedAt: number;
}

export const NEVER_READ_MAX = 500;

/** Country calling code for typed numbers without one. India unless the curator's timezone says otherwise. */
export function defaultCountryCode(timezone?: string): string {
  const tz = timezone ?? "";
  if (/^Australia\//.test(tz)) return "61";
  if (/^(Europe\/London|Europe\/Dublin)$/.test(tz)) return tz.endsWith("London") ? "44" : "353";
  if (/^(America\/(New_York|Chicago|Denver|Los_Angeles|Toronto))$/.test(tz)) return "1";
  if (/^Pacific\/Auckland$/.test(tz)) return "64";
  if (/^Asia\/(Singapore)$/.test(tz)) return "65";
  if (/^Asia\/(Dubai)$/.test(tz)) return "971";
  return "91";
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Normalise a WhatsApp id or something typed. null when it is neither a group id nor a plausible phone number. */
export function normalizeNeverReadId(input: string, opts: { countryCode?: string } = {}): { id: string; kind: "person" | "group" } | null {
  const raw = input.trim();
  if (!raw) return null;
  const at = raw.lastIndexOf("@");
  if (at > 0) {
    const local = raw.slice(0, at).trim();
    const server = raw.slice(at + 1).toLowerCase();
    if (server === "g.us") return /^[\w.-]+$/.test(local) ? { id: `${local}@g.us`, kind: "group" } : null;
    if (server === "lid") {
      const d = digitsOf(local.split(":")[0]);
      return d ? { id: `${d}@lid`, kind: "person" } : null;
    }
    if (server === "c.us" || server === "s.whatsapp.net") {
      const d = digitsOf(local.split(":")[0]);
      return d.length >= 7 && d.length <= 15 ? { id: `${d}@c.us`, kind: "person" } : null;
    }
    return null;
  }
  let d = digitsOf(raw);
  const plus = raw.startsWith("+");
  if (!plus && d.startsWith("00")) d = d.slice(2); // 0091… dialled form
  else if (!plus) {
    const cc = opts.countryCode ?? "91";
    if (d.startsWith("0") && d.length >= 9 && d.length <= 12) d = cc + d.replace(/^0+/, ""); // national format 098…
    else if (d.length >= 7 && d.length <= 10) d = cc + d; // 98765 43210: up to 10 digits is a national number, even one that starts like the code (91111 11111)
  }
  return d.length >= 8 && d.length <= 15 ? { id: `${d}@c.us`, kind: "person" } : null;
}

/** `+91 ••••• ••210`: enough to recognise, not enough to read out. */
export function maskNumber(id: string): string {
  const d = digitsOf(id.split("@")[0]);
  if (d.length < 6) return "••••";
  return `+${d.slice(0, 2)} ••••• ••${d.slice(-3)}`;
}

/** The line under a name in the list: a masked number for people (not for lid-only ones), "Group" for groups. */
export function neverReadSubtitle(e: NeverReadEntry): string {
  if (e.kind === "group") return "Group";
  return e.id.endsWith("@lid") ? "WhatsApp contact" : maskNumber(e.id);
}

export interface NeverReadMatcher {
  size: number;
  /** Any entry that is a phone (so a lid has to be mapped to a phone to be compared). */
  hasPhones: boolean;
  /** Any entry that is a lid (so a phone has to be mapped to a lid). */
  hasLids: boolean;
  ids: Set<string>;
  /** "Never read any group": every @g.us id matches, except `exceptGroups`. */
  allGroups: boolean;
  exceptGroups: Set<string>;
}

export interface NeverReadOptions {
  /** `settings.neverReadAllGroups`. */
  allGroups?: boolean;
  /** Linked groups (the curator's show groups, Comedy's watched groups, the host poll group): never silenced, whether by allGroups or by a list entry. Linked groups always win. */
  exceptGroups?: Iterable<string | null | undefined>;
}

export function compileNeverRead(entries: NeverReadEntry[] | undefined, opts: NeverReadOptions = {}): NeverReadMatcher {
  const ids = new Set<string>();
  for (const e of entries ?? []) {
    const n = normalizeNeverReadId(e.id);
    if (n) ids.add(n.id);
  }
  const except = new Set<string>();
  for (const g of opts.exceptGroups ?? []) {
    const n = g ? normalizeNeverReadId(g.includes("@") ? g : `${g}@g.us`) : null;
    if (n?.kind === "group") except.add(n.id);
  }
  const all = [...ids];
  const allGroups = !!opts.allGroups;
  return { size: ids.size + (allGroups ? 1 : 0), hasPhones: all.some((i) => i.endsWith("@c.us")), hasLids: all.some((i) => i.endsWith("@lid")), ids, allGroups, exceptGroups: except };
}

/** Is this chat id a group that Never read silences ("Never read any group" on, and not linked)? */
export function groupSilenced(m: NeverReadMatcher, id: string): boolean {
  if (!m.allGroups) return false;
  const n = normalizeNeverReadId(id);
  return !!n && n.kind === "group" && !m.exceptGroups.has(n.id);
}

export interface NeverReadMaps {
  /** `<n>@lid` → `<digits>@c.us` (or bare digits), as WhatsApp's getContactLidAndPhone gives it. */
  lidToPhone?: ReadonlyMap<string, string>;
  /** the reverse. */
  phoneToLid?: ReadonlyMap<string, string>;
}

/** Ids that could stand for the same chat as `id`, in normalised form. */
function variants(id: string, maps: NeverReadMaps, m: NeverReadMatcher): string[] {
  const n = normalizeNeverReadId(id);
  if (!n) return [];
  const out = [n.id];
  if (n.id.endsWith("@lid") && m.hasPhones) {
    const pn = maps.lidToPhone?.get(n.id);
    const p = pn ? normalizeNeverReadId(pn.includes("@") ? pn : `${pn}@c.us`) : null;
    if (p) out.push(p.id);
  } else if (n.id.endsWith("@c.us") && m.hasLids) {
    const lid = maps.phoneToLid?.get(n.id);
    const l = lid ? normalizeNeverReadId(lid.includes("@") ? lid : `${lid}@lid`) : null;
    if (l) out.push(l.id);
  }
  return out;
}

/** Is any of these ids (chat id, sender, author) on the list? Pass the lid maps when you have them. Typed numbers without a suffix count as phones. */
export function matchesNeverRead(source: NeverReadEntry[] | NeverReadMatcher | undefined, ids: (string | null | undefined)[], maps: NeverReadMaps = {}, opts: NeverReadOptions = {}): boolean {
  const m = Array.isArray(source) || !source ? compileNeverRead(source as NeverReadEntry[] | undefined, opts) : source;
  if (!m.size) return false;
  for (const id of ids) {
    if (!id) continue;
    if (m.exceptGroups.size) {
      const g = normalizeNeverReadId(id);
      if (g?.kind === "group" && m.exceptGroups.has(g.id)) continue; // linked: wins over the list
    }
    if (m.allGroups && groupSilenced(m, id)) return true;
    const plain = /^\+?\d[\d\s-]*$/.test(id.trim()) ? `${digitsOf(id)}@c.us` : id;
    if (variants(plain, maps, m).some((v) => m.ids.has(v))) return true;
  }
  return false;
}

/** The ids that still need a lid↔phone lookup before matching (nothing when no entry could use the answer). */
export function neverReadLookups(m: NeverReadMatcher, ids: (string | null | undefined)[]): { lids: string[]; phones: string[] } {
  const lids: string[] = [];
  const phones: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const n = normalizeNeverReadId(id);
    if (!n || n.kind === "group") continue;
    if (n.id.endsWith("@lid") && m.hasPhones && !m.ids.has(n.id)) lids.push(n.id);
    else if (n.id.endsWith("@c.us") && m.hasLids && !m.ids.has(n.id)) phones.push(n.id);
  }
  return { lids, phones };
}

/** Add (or rename) entries, newest first, no duplicates, capped. */
export function addNeverRead(list: NeverReadEntry[] | undefined, items: { id: string; kind: "person" | "group"; name?: string }[], now = Date.now()): NeverReadEntry[] {
  const out = [...(list ?? [])];
  for (const it of items) {
    const n = normalizeNeverReadId(it.id);
    if (!n) continue;
    const at = out.findIndex((e) => e.id === n.id);
    const name = it.name?.trim() || undefined;
    if (at >= 0) {
      if (name && !out[at].name) out[at] = { ...out[at], name };
      continue;
    }
    out.unshift({ id: n.id, kind: n.kind, ...(name && { name }), addedAt: now });
  }
  return out.slice(0, NEVER_READ_MAX);
}

export function removeNeverRead(list: NeverReadEntry[] | undefined, id: string): NeverReadEntry[] {
  return (list ?? []).filter((e) => e.id !== id);
}

/** Search the list by name or number. */
export function searchNeverRead(list: NeverReadEntry[], q: string): NeverReadEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  const digits = digitsOf(needle);
  return list.filter((e) => (e.name ?? "").toLowerCase().includes(needle) || (digits.length >= 3 && e.id.split("@")[0].includes(digits)));
}

/** A comic on the roster whose chat id or phone is on the list (to warn before adding them). */
export function comicsOnNeverRead<C extends { id: string; chatId?: string; phone?: string; name: string; aliases?: string[]; numbers?: Comic["numbers"] }>(comics: C[], ids: string[]): C[] {
  const m = compileNeverRead(ids.map((id) => ({ id, kind: "person" as const, addedAt: 0 })));
  return comics.filter((c) => matchesNeverRead(m, [...comicIdsOf({ id: c.id, chatId: c.chatId, phone: c.phone ?? "", aliases: c.aliases, numbers: c.numbers }), c.phone]));
}

/** The Never read list, grouped for the card: people first, then groups (each keeps its newest-first order). */
export function splitNeverRead(list: NeverReadEntry[]): { people: NeverReadEntry[]; groups: NeverReadEntry[] } {
  return { people: list.filter((e) => e.kind === "person"), groups: list.filter((e) => e.kind === "group") };
}

/** Rows a select-all would tick: the visible ones that are not already ticked. Empty when everything visible is ticked. */
export function selectAllState(visibleIds: string[], picked: ReadonlySet<string>): { selected: number; all: boolean; some: boolean } {
  const selected = visibleIds.filter((i) => picked.has(i)).length;
  return { selected, all: visibleIds.length > 0 && selected === visibleIds.length, some: selected > 0 && selected < visibleIds.length };
}

/** Groups the app needs, by group id → why ("Linked to Open Mic - Monday", "Watched in Comedy", "Used for the host poll"). */
export function linkedGroups(src: { shows?: { name: string; groupId?: string | null }[]; watched?: { id: string }[]; hostPollGroupId?: string | null }): Map<string, string> {
  const out = new Map<string, string>();
  const put = (raw: string | null | undefined, why: string) => {
    const n = raw ? normalizeNeverReadId(raw.includes("@") ? raw : `${raw}@g.us`) : null;
    if (n?.kind === "group" && !out.has(n.id)) out.set(n.id, why);
  };
  for (const s of src.shows ?? []) put(s.groupId, `Linked to ${s.name}`);
  for (const w of src.watched ?? []) put(w.id, "Watched in Comedy");
  put(src.hostPollGroupId, "Used for the host poll");
  return out;
}

/** Drop list entries that are now linked groups. `removed` carries what to tell the curator. */
export function pruneLinkedNeverRead(list: NeverReadEntry[] | undefined, linked: ReadonlyMap<string, string>): { list: NeverReadEntry[]; removed: { id: string; name?: string; reason: string }[] } {
  const removed: { id: string; name?: string; reason: string }[] = [];
  const kept = (list ?? []).filter((e) => {
    const why = e.kind === "group" ? linked.get(e.id) : undefined;
    if (why) removed.push({ id: e.id, name: e.name, reason: why });
    return !why;
  });
  return { list: kept, removed };
}
