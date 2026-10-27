// One place for how a WhatsApp message text reads outside the bubble: tags ("@<number>" with a name to show instead), a plain
// one-line form for previews, and what the composer does when you pick someone from the "@" list. The rich form (bold, italic,
// quotes, lists) is parseWhatsApp in richText.ts; this module sits on top of it. Pure functions, no HTML.
import { stripFormatting } from "./richText.ts";

/** A tag in a text: `token` is what the text holds ("@98870264598667"), `name` what to show, `id` the WhatsApp id when known. */
export interface MentionRef {
  token: string;
  name: string;
  id?: string;
}

export type MentionSegment = { t: "text"; v: string } | { t: "mention"; v: string; name: string; id?: string };

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Cut a text where the given tags occur. A tag only counts when not glued to more digits ("@9198" is not a tag inside "@919876"). */
export function splitMentions(text: string, mentions: MentionRef[] | undefined): MentionSegment[] {
  const list = (mentions ?? []).filter((m) => m.token);
  if (!list.length || !text) return text ? [{ t: "text", v: text }] : [];
  const byToken = new Map(list.map((m) => [m.token, m]));
  // Longest first, so a number that starts another one isn't cut short.
  const re = new RegExp(`(${[...byToken.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  const out: MentionSegment[] = [];
  let last = 0;
  for (const hit of text.matchAll(re)) {
    const at = hit.index!;
    const m = byToken.get(hit[1])!;
    if (at > last) out.push({ t: "text", v: text.slice(last, at) });
    out.push({ t: "mention", v: hit[1], name: m.name, ...(m.id && { id: m.id }) });
    last = at + hit[1].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** The text as plain words: WhatsApp marks removed, tags written "@Name". One line (whitespace collapsed) unless `oneLine` is false. */
export function toPlain(text: string, mentions?: MentionRef[], opts: { oneLine?: boolean } = {}): string {
  const plain = stripFormatting(text ?? "");
  const named = splitMentions(plain, mentions)
    .map((s) => (s.t === "mention" ? `@${s.name}` : s.v))
    .join("");
  return opts.oneLine === false ? named : named.replace(/\s+/g, " ").trim();
}

// ---------- composer ----------

/** Someone the "@" list offers: `id` is what a tag is sent to. */
export interface Taggable {
  id: string;
  name: string;
}

/** A tag the box holds: the "@Name" label as typed, and who it is. */
export interface PickedTag {
  label: string;
  comicId: string;
}

/** Who matches what's typed after "@": names (or any word of a name) starting with it. */
export function suggestTaggable(people: Taggable[], query: string, max = 6): Taggable[] {
  const q = query.toLowerCase();
  return people.filter((m) => m.name.toLowerCase().startsWith(q) || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).slice(0, max);
}

/** The "@word" being typed right before the caret, or null. */
export function activeMention(text: string, caret: number): { query: string; start: number } | null {
  const m = text.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,30})$/);
  return m ? { query: m[1], start: caret - m[1].length - 1 } : null;
}

export interface MentionEdit {
  text: string;
  caret: number;
  tag: PickedTag;
}

/** Pick someone from the list: their "@Name " replaces the "@word" being typed. */
export function insertMention(text: string, caret: number, person: Taggable): MentionEdit | null {
  const active = activeMention(text, caret);
  if (!active) return null;
  const label = `@${person.name}`;
  return { text: `${text.slice(0, active.start)}${label} ${text.slice(caret)}`, caret: active.start + label.length + 1, tag: { label, comicId: person.id } };
}

/** The tags a text still holds (a label deleted from the box takes its tag with it). */
export function liveTags(text: string, tags: PickedTag[]): PickedTag[] {
  const seen = new Set<string>();
  return tags.filter((t) => {
    const key = `${t.label}\u0000${t.comicId}`;
    if (seen.has(key) || !text.includes(t.label)) return false;
    seen.add(key);
    return true;
  });
}

/** Where tag labels sit in the box, for the highlight behind them. */
export function highlightSegments(text: string, tags: PickedTag[]): { v: string; tag: boolean }[] {
  const labels = [...new Set(liveTags(text, tags).map((t) => t.label))].sort((a, b) => b.length - a.length);
  if (!labels.length) return [{ v: text, tag: false }];
  const re = new RegExp(`(${labels.map(escapeRe).join("|")})`, "g");
  return text.split(re).filter(Boolean).map((v) => ({ v, tag: labels.includes(v) }));
}

/**
 * Turn "@Name" labels into WhatsApp tags: the text carries "@<number>" for each and `mentions` the ids to send them to.
 * `idFor` gives the id WhatsApp can deliver to (a phone id or @lid); a label it can't resolve stays as typed.
 * Longer labels go first so "@Ravi Kumar" isn't eaten by "@Ravi".
 */
export function applyTags(text: string, tags: PickedTag[], idFor: (comicId: string) => string | undefined): { text: string; mentions: string[] } {
  const mentions: string[] = [];
  let out = text;
  for (const t of [...tags].filter((x) => x.label && x.comicId).sort((a, b) => b.label.length - a.label.length)) {
    if (!out.includes(t.label)) continue;
    const id = idFor(t.comicId);
    if (!id) continue;
    out = out.split(t.label).join(`@${id.split("@")[0]}`);
    if (!mentions.includes(id)) mentions.push(id);
  }
  return { text: out, mentions };
}
