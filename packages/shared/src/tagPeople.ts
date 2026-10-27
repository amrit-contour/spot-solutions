// A reply that lists people, in two forms: with real WhatsApp mentions ("@<number>" placeholders plus the ids for sendMessage's
// `mentions`, which WhatsApp renders as the person's name and makes tappable) and as plain text (first names, the displayNames
// rule) for when mentions are switched off or the send with mentions fails. People with no WhatsApp id stay plain first names.
import { cleanName, displayNames } from "./displayNames.ts";

export interface TagPerson {
  name: string;
  /** The WhatsApp id (…@c.us or …@lid), when known. */
  id?: string | null;
}

export interface Tagged {
  /** What goes in the text where each person is named, in the order given. "@<digits>" for a mentionable person, else the first name. */
  tagged: string[];
  /** The same, all plain first names (last initial / last name only where two in this reply share a first name). */
  plain: string[];
  /** The ids to pass as `mentions`, each once, in order of first appearance. */
  mentions: string[];
}

const digits = (id: string) => id.split("@")[0]!.replace(/\D/g, "");

export function tagPeople(people: TagPerson[]): Tagged {
  const plain = displayNames(people.map((p) => p.name));
  const mentions: string[] = [];
  const tagged = people.map((p, i) => {
    const d = p.id && p.id.includes("@") ? digits(p.id) : "";
    if (!d) return plain[i]!;
    if (!mentions.includes(p.id!)) mentions.push(p.id!);
    return `@${d}`;
  });
  return { tagged, plain, mentions };
}

/** A reply ready to send: text with placeholders, its plain twin, and the mention ids (raw; resolved to deliverable ids at send time). */
export interface RichReply {
  text: string;
  plain: string;
  mentions: string[];
}

/** Build a reply once per form from the same formatter: `build` gets the labels to print for `people`. */
export function richReply(people: TagPerson[], build: (labels: string[]) => string): RichReply {
  const t = tagPeople(people);
  return { text: build(t.tagged), plain: build(t.plain), mentions: t.mentions };
}

/** Swap each "@<raw digits>" placeholder for the digits of the id WhatsApp will actually deliver to (often a lid). */
export function resolvePlaceholders(text: string, map: { raw: string; resolved: string }[]): string {
  const by = new Map(map.map((m) => [digits(m.raw), digits(m.resolved)]));
  return text.replace(/@(\d+)\b/g, (all, d: string) => (by.has(d) ? `@${by.get(d)}` : all));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Any finished reply: every known person it names becomes a mention (people with a WhatsApp id) and is shortened to a first name in the
 * plain twin (last initial where two named people share a first name). Matches the person's whole name, or their first name when no
 * other known person has it. People without an id are left as written. This is the default path for replies that name people.
 */
export function tagText(text: string, people: TagPerson[]): RichReply {
  const known = people.filter((p) => p.id && p.id.includes("@") && digits(p.id));
  const cands = known.map((p) => ({ p, full: cleanName(p.name), first: cleanName(p.name).split(" ")[0]! }));
  const firstCount = new Map<string, number>();
  for (const c of cands) firstCount.set(c.first.toLowerCase(), (firstCount.get(c.first.toLowerCase()) ?? 0) + 1);
  const keys = new Map<string, (typeof cands)[number]>();
  for (const c of cands) {
    if (c.full.includes(" ")) keys.set(c.full.toLowerCase(), c);
    if (firstCount.get(c.first.toLowerCase()) === 1 && c.first.length >= 3) keys.set(c.first.toLowerCase(), c);
  }
  if (!keys.size) return { text, plain: text, mentions: [] };
  const re = new RegExp(`(?<![\\w@])(?:${[...keys.keys()].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\w])`, "gi");
  const hits: (typeof cands)[number][] = [];
  for (const m of text.matchAll(re)) {
    const c = keys.get(m[0].toLowerCase());
    if (c && !hits.includes(c)) hits.push(c);
  }
  if (!hits.length) return { text, plain: text, mentions: [] };
  const labels = displayNames(hits.map((c) => c.p.name));
  const label = new Map(hits.map((c, i) => [c, labels[i]!]));
  const mentions: string[] = [];
  const tagged = text.replace(re, (m) => {
    const c = keys.get(m.toLowerCase())!;
    if (!mentions.includes(c.p.id!)) mentions.push(c.p.id!);
    return `@${digits(c.p.id!)}`;
  });
  const plain = text.replace(re, (m) => label.get(keys.get(m.toLowerCase())!)!);
  return { text: tagged, plain, mentions };
}
