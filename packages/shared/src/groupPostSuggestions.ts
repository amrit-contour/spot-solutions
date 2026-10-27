// "Copy what we did in one group into the other": the scheduled posts other shows have that this one doesn't, ready to add with one tap.
// Pure rules (no I/O). Hard-coded names in the text (the source show's or venue's, written out) become {{show}} / {{venue}}, so a
// copied post reads right for the show it lands in.
import { clampDays, groupPostMessage, whenLabel, type GroupPost } from "./groupPosts.ts";
import { messageType, normalizeMessage, storeMessage, type RichMessage } from "./messages.ts";
import { formatTime } from "./week.ts";
import type { Settings } from "./types.ts";

/** A show whose posts can be copied. */
export interface PostSource {
  id: string;
  name: string;
  venueName?: string | null;
  posts: GroupPost[];
}

export interface PostTarget {
  id?: string;
  name: string;
  venueName?: string | null;
}

export interface PostSuggestion {
  /** Same for the same timing and text, whichever show it came from. */
  key: string;
  /** The show it is copied from. */
  sourceId: string;
  sourceName: string;
  /** Other shows that have the same post. */
  alsoIn: string[];
  /** "Day before, 5:00 PM". */
  timing: string;
  /** "Reminder", "My own message", ... */
  kind: string;
  /** The text as it will read, variables still in place (poll: the question). */
  snippet: string;
  /** Names that were written out in the text and are now variables ("Monday Mic" for {{show}}). */
  swapped: { name: string; variable: "show" | "venue" }[];
  /** The post to add: a fresh id, everything else copied. */
  post: GroupPost;
}

const MIN_NAME = 3;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Swap a show's or venue's name, written out in some text, for its variable. Whole words only, any case. */
export function templatizeNames(text: string, names: { show?: string | null; venue?: string | null }): { text: string; swapped: PostSuggestion["swapped"] } {
  const swapped: PostSuggestion["swapped"] = [];
  const pairs = (
    [
      ["venue", names.venue],
      ["show", names.show],
    ] as const
  )
    .map(([variable, name]) => ({ variable, name: (name ?? "").trim() }))
    .filter((p) => p.name.length >= MIN_NAME)
    .sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const { variable, name } of pairs) {
    // Never inside an existing {{variable}}.
    const re = new RegExp(`(?<![\\p{L}\\p{N}{])${escapeRe(name)}(?![\\p{L}\\p{N}}])`, "giu");
    let hit = false;
    out = out.replace(re, () => ((hit = true), `{{${variable}}}`));
    if (hit) swapped.push({ name, variable });
  }
  return { text: out, swapped };
}

/** The writing of a post with names turned into variables, plus which names were swapped. */
function templatized(msg: RichMessage, names: { show?: string | null; venue?: string | null }) {
  const swapped: PostSuggestion["swapped"] = [];
  const t = (s: string) => {
    const r = templatizeNames(s, names);
    for (const w of r.swapped) if (!swapped.some((x) => x.variable === w.variable)) swapped.push(w);
    return r.text;
  };
  const out: RichMessage = { ...msg, body: t(msg.body) };
  if (msg.poll) out.poll = { ...msg.poll, question: t(msg.poll.question), options: msg.poll.options.map(t) };
  return { msg: out, swapped };
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** What makes two posts "the same": the day offset and the (name-neutral) text. The time of day is not part of it. */
export function postKey(settings: Pick<Settings, "messages">, post: GroupPost, names: { show?: string | null; venue?: string | null }): string {
  const { msg } = templatized(groupPostMessage(settings, post), names);
  const text = msg.kind === "poll" ? [msg.poll?.question, ...(msg.poll?.options ?? [])].join("|") : msg.kind === "location" ? "location" : msg.body;
  return `${clampDays(post.daysBefore)}#${msg.kind}#${squash(text)}`;
}

/** "Reminder", "Venue pin"..., or "My own message". */
export function postKindLabel(template: GroupPost["template"]): string {
  return template === "custom" ? "My own message" : messageType(template).label;
}

const snippetOf = (m: RichMessage) => (m.kind === "poll" ? `Poll: ${m.poll?.question ?? ""}` : m.kind === "location" ? "Venue location pin" : m.body).replace(/\s+/g, " ").trim();

function makeSuggestion(settings: Pick<Settings, "messages">, source: PostSource, post: GroupPost, key: string, newId: () => string): PostSuggestion {
  const names = { show: source.name, venue: source.venueName };
  const own = post.template === "custom" || (post.message != null && post.message !== "");
  const base = groupPostMessage(settings, post);
  const { msg, swapped } = templatized(base, names);
  const copy: GroupPost = { ...post, id: newId(), enabled: true };
  // Last-sent history stays with the source show; a copy starts fresh. Its own wording comes along (picture, pin, poll included).
  if (own) copy.message = storeMessage(msg);
  else delete copy.message;
  return {
    key,
    sourceId: source.id,
    sourceName: source.name,
    alsoIn: [],
    timing: `${whenLabel(post.daysBefore)}, ${formatTime(post.time)}`,
    kind: postKindLabel(post.template),
    snippet: snippetOf(own ? msg : normalizeMessage(base)),
    swapped: own ? swapped : [],
    post: copy,
  };
}

const defaultId = (() => {
  let n = 0;
  return () => `p${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
})();

/**
 * Posts in other shows that this show doesn't have yet, earliest-in-the-week first. A post counts as already there when this show
 * has one at the same day offset with the same text (names taken out). The same post in several shows is offered once.
 */
export function suggestPosts(settings: Pick<Settings, "messages">, target: PostTarget, existing: GroupPost[], sources: PostSource[], newId: () => string = defaultId): PostSuggestion[] {
  const tNames = { show: target.name, venue: target.venueName };
  const have = new Set(existing.map((p) => postKey(settings, p, tNames)));
  const out = new Map<string, PostSuggestion>();
  for (const s of sources) {
    if (s.id === target.id) continue;
    const sNames = { show: s.name, venue: s.venueName };
    for (const p of s.posts) {
      if (!p.enabled) continue;
      const key = postKey(settings, p, sNames);
      if (have.has(key)) continue;
      const seen = out.get(key);
      if (seen) {
        if (!seen.alsoIn.includes(s.name) && seen.sourceName !== s.name) seen.alsoIn.push(s.name);
        continue;
      }
      out.set(key, makeSuggestion(settings, s, p, key, newId));
    }
  }
  return [...out.values()].sort((a, b) => b.post.daysBefore - a.post.daysBefore || a.post.time.localeCompare(b.post.time));
}

/** "Copy all from <show>": what would be added from that one show, and how many of its posts are skipped as already here. */
export function planCopyAll(settings: Pick<Settings, "messages">, target: PostTarget, existing: GroupPost[], source: PostSource, newId: () => string = defaultId): { add: PostSuggestion[]; skipped: number } {
  const add = suggestPosts(settings, target, existing, [source], newId).filter((s) => s.sourceId === source.id);
  const total = source.posts.filter((p) => p.enabled).length;
  return { add, skipped: total - add.length };
}
