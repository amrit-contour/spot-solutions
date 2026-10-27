// "Never read": people and groups whose messages are skipped before anything else happens. Never read, never sent to the AI,
// never stored. The worker checks this first in every inbound path (live messages, catch-up, scans, voice learning, group watch).
// Entry ids are normalised: a person is `<digits>@c.us` (or `<n>@lid` when WhatsApp only gave a lid), a group is `<id>@g.us`.

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
}

export function compileNeverRead(entries: NeverReadEntry[] | undefined): NeverReadMatcher {
  const ids = new Set<string>();
  for (const e of entries ?? []) {
    const n = normalizeNeverReadId(e.id);
    if (n) ids.add(n.id);
  }
  const all = [...ids];
  return { size: ids.size, hasPhones: all.some((i) => i.endsWith("@c.us")), hasLids: all.some((i) => i.endsWith("@lid")), ids };
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
export function matchesNeverRead(source: NeverReadEntry[] | NeverReadMatcher | undefined, ids: (string | null | undefined)[], maps: NeverReadMaps = {}): boolean {
  const m = Array.isArray(source) || !source ? compileNeverRead(source as NeverReadEntry[] | undefined) : source;
  if (!m.size) return false;
  for (const id of ids) {
    if (!id) continue;
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
export function comicsOnNeverRead<C extends { id: string; chatId?: string; phone?: string; name: string }>(comics: C[], ids: string[]): C[] {
  const m = compileNeverRead(ids.map((id) => ({ id, kind: "person" as const, addedAt: 0 })));
  return comics.filter((c) => matchesNeverRead(m, [c.id, c.chatId, c.phone]));
}
