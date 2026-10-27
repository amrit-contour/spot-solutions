// Messages page: the pure rules behind the on-device parts of the chat screens. No I/O, so they are tested without a browser.
// Nothing here is ever sent to Firestore: the cache, the "done" marks and the sync line all live on the user's own device.
import type { GetThreadResult, ReactionChip } from "./threads.ts";

// ---- Sync line ----

/** A sync this recent counts as current. The open chat refreshes every 30 s and the list every 60 s, so a miss or two still reads as live. */
export const SYNC_FRESH_MS = 150_000;

export function agoLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export interface SyncInput {
  /** The last time this visit read WhatsApp successfully (0 = not yet, so what is on screen is a saved copy). */
  lastOkAt: number;
  loading: boolean;
  error?: string | null;
  now: number;
}
export interface SyncView {
  /** Reading right now. */
  syncing: boolean;
  /** What is on screen was read from WhatsApp recently and the last attempt worked: actions need no warning. */
  ok: boolean;
  label: string;
}

/** The header's "Synced 2 min ago" / "Syncing…" line, and whether an action should warn first. */
export function chatSyncView({ lastOkAt, loading, error, now }: SyncInput, savedAt?: number | null): SyncView {
  const fresh = lastOkAt > 0 && now - lastOkAt < SYNC_FRESH_MS;
  const ok = fresh && !error;
  if (loading) return { syncing: true, ok, label: "Syncing…" };
  if (error) return { syncing: false, ok: false, label: lastOkAt > 0 ? `Sync failed · last synced ${agoLabel(lastOkAt, now)}` : savedAt ? `Offline · saved ${agoLabel(savedAt, now)}` : "Couldn't sync" };
  if (lastOkAt > 0) return { syncing: false, ok, label: `Synced ${agoLabel(lastOkAt, now)}` };
  return { syncing: false, ok: false, label: savedAt ? `Saved ${agoLabel(savedAt, now)}` : "Not synced yet" };
}

/** "2:14 pm" today, else "Mon 2:14 pm". For "Showing saved messages from …". */
export function savedFromLabel(at: number, now: number, timezone: string): string {
  const key = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(t));
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(at)).replace(/\s?([ap])m/i, (_, x: string) => ` ${x.toLowerCase()}m`);
  if (key(at) === key(now)) return clock;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(new Date(at));
  return `${day}, ${clock}`;
}

// ---- Done / Needs reply marks (this device only) ----

/** `at` is the newest message's time when you marked it, so a newer message cancels the mark. */
export interface ChatMark {
  kind: "done" | "needs";
  at: number;
}
export type ChatMarks = Record<string, ChatMark>;

export interface MarkTarget {
  at: number;
  awaitingYou: boolean;
}

/** Done clears "needs reply" until something new arrives; Needs reply keeps it on until you answer (or something new arrives and WhatsApp's own rule takes over). */
export function effectiveAwaiting(t: MarkTarget, mark: ChatMark | undefined): boolean {
  if (!mark || t.at > mark.at) return t.awaitingYou;
  return mark.kind === "needs";
}

export function setMark(marks: ChatMarks, id: string, kind: ChatMark["kind"], t: Pick<MarkTarget, "at">): ChatMarks {
  return { ...marks, [id]: { kind, at: t.at } };
}
export function clearMark(marks: ChatMarks, id: string): ChatMarks {
  const { [id]: _gone, ...rest } = marks;
  return rest;
}
/** The right-swipe toggle: waiting on you -> clear it (done); not waiting -> flag it as needing a reply. */
export function toggleNeedsReply(marks: ChatMarks, id: string, t: MarkTarget): ChatMarks {
  return setMark(marks, id, effectiveAwaiting(t, marks[id]) ? "done" : "needs", t);
}
/** Marks that a newer message made moot (or for chats that are gone) are dropped. */
export function pruneMarks(marks: ChatMarks, threads: ({ id: string } & Pick<MarkTarget, "at">)[]): ChatMarks {
  const at = new Map(threads.map((t) => [t.id, t.at]));
  const out: ChatMarks = {};
  for (const [id, m] of Object.entries(marks)) if (at.has(id) && at.get(id)! <= m.at) out[id] = m;
  return out;
}

// ---- Reactions ----

/** The inner edge of a bubble (the side facing the middle of the screen): the right edge of an incoming bubble, the left edge of an outgoing one. */
export function reactionEdge(fromMe: boolean): "left" | "right" {
  return fromMe ? "left" : "right";
}
/** The chips hang this far below the bubble's bottom edge minus the overlap, so they touch only the corner's padding and never the text or the time. */
export const REACTION_OVERLAP_PX = 6;
export const REACTION_HEIGHT_PX = 24;
export const reactionReservePx = () => REACTION_HEIGHT_PX - REACTION_OVERLAP_PX;

/** One chip per emoji, counts added, biggest first (ties keep their order). */
export function groupReactions(chips: ReactionChip[] | undefined): ReactionChip[] {
  const by = new Map<string, ReactionChip>();
  for (const c of chips ?? []) {
    if (!c.emoji) continue;
    const p = by.get(c.emoji);
    by.set(c.emoji, p ? { emoji: c.emoji, count: p.count + Math.max(1, c.count), byMe: p.byMe || c.byMe } : { emoji: c.emoji, count: Math.max(1, c.count), byMe: c.byMe });
  }
  return [...by.values()].map((c, i) => ({ c, i })).sort((a, b) => b.c.count - a.c.count || a.i - b.i).map((x) => x.c);
}

/** Your reaction, applied at once while it is sent. You have one reaction per message: a new emoji replaces it, the same emoji takes it back. */
export function toggleMyReaction(chips: ReactionChip[] | undefined, emoji: string): { chips: ReactionChip[]; sent: string } {
  const mine = (chips ?? []).find((c) => c.byMe)?.emoji;
  const without = (chips ?? []).map((c) => (c.byMe ? { ...c, count: c.count - 1, byMe: false } : c)).filter((c) => c.count > 0);
  if (mine === emoji) return { chips: groupReactions(without), sent: "" };
  return { chips: groupReactions([...without, { emoji, count: 1, byMe: true }]), sent: emoji };
}

// ---- The on-device cache ----

export const CACHE_THREAD_MESSAGES = 40;
export const CACHE_MAX_THREADS = 30;

/** A thread as it is kept on the device: the newest messages only. */
export function trimThreadForCache(r: GetThreadResult, max = CACHE_THREAD_MESSAGES): GetThreadResult {
  const messages = r.messages.slice(-max);
  return { ...r, messages, hasMore: r.hasMore || messages.length < r.messages.length };
}
/** Which saved threads to forget so no more than `max` stay (the least recently saved go first). */
export function cacheEvictions(entries: { key: string; savedAt: number }[], max = CACHE_MAX_THREADS): string[] {
  return [...entries].sort((a, b) => b.savedAt - a.savedAt).slice(max).map((e) => e.key);
}
export const cacheKey = (uid: string, what: string) => `${uid}:${what}`;

// ---- Photos ----

export const PHOTO_PICK_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_SEND_MAX_EDGE = 1600;
/** A sent photo travels as a short-lived command (Firestore documents hold 1 MB), so the JPEG is squeezed to this. */
export const PHOTO_SEND_MAX_BYTES = 600_000;

/** Fit inside a square of `max` pixels, never enlarging. */
export function fitWithin(w: number, h: number, max = PHOTO_SEND_MAX_EDGE): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
