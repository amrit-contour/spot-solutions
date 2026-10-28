// Messages page data. Real accounts read chats live through worker commands whose results are deleted as soon as they are read
// (nothing is kept). The demo has no WhatsApp, so its conversations are built right here from the demo sandbox's own
// requests and lineups, and the page says so. Nothing in this file is ever used for a real account's data.
import {
  AI_APP_WAIT_MS,
  applyTags,
  groupReactions,
  liveTags,
  matchGroupThreads,
  matchThreads,
  type Comic,
  type GetThreadResult,
  type Lineup,
  type ListThreadsResult,
  type ReactionChip,
  type RichMessage,
  type Show,
  type SpotRequest,
  type SummarizeThreadResult,
  type ThreadMember,
  type ThreadMessage,
  type WaChatLike,
  type WaMessageLike,
} from "@spot/shared";
import { runCommand } from "./data";
import { fetchPicture, type FetchedPicture } from "./pictures";

export interface ChatTarget {
  id: string;
  chatId?: string;
  /** Which chat this is, so the server opens it itself (roster comic or linked group) instead of trusting an id. */
  comicId?: string;
  groupId?: string;
  name: string;
  /** Groups: "@Name" tags in the text that should become real WhatsApp tags. `comicId` is any member's id (roster, phone id or @lid). */
  tags?: MentionTag[];
}

export interface MentionTag {
  label: string;
  comicId: string;
}

/** Which chat a media request is about: a comic's or a show group. */
export type MediaTarget = { comicId: string } | { groupId: string };

export interface ChatSource {
  /** Sample conversations built from the demo sandbox, not WhatsApp. */
  demo: boolean;
  list: () => Promise<ListThreadsResult>;
  thread: (comicId: string, before?: number) => Promise<GetThreadResult>;
  /** A show's group (linked groups only). */
  groupThread: (groupId: string, before?: number) => Promise<GetThreadResult>;
  summarize: (comicId: string, weekOf: string, onStage?: (stage: string) => void) => Promise<SummarizeThreadResult>;
  /**
   * The curator tapped View on a picture: ask the server for that one message's picture (fetch_media). Nothing is fetched before
   * this. The picture sits in a short-lived cache file; `forgetPicture` deletes it when the chat is closed.
   */
  fetchMedia: (target: MediaTarget, messageId: string) => Promise<FetchedPicture>;
  send: (to: ChatTarget, msg: RichMessage, opts: { voice: boolean; venueId: string | null }) => Promise<{ body: string }>;
  /** React to a message (an empty emoji takes your reaction back). */
  react: (target: MediaTarget, messageId: string, emoji: string) => Promise<unknown>;
  sendImage: (target: MediaTarget, photo: OutPhoto) => Promise<unknown>;
}

/** A photo ready to send: already squeezed to a JPEG and uploaded to the curator's Storage folder (`path`), with an optional caption. */
export interface OutPhoto {
  path: string;
  name: string;
  caption: string;
  /** An object URL of the picture, for showing it in the chat (the demo keeps it as the "sent" picture). */
  previewUrl: string;
}

/** The send payload: the same shape the reply cards use, plus the voice switch. */
export const sendPayload = (to: ChatTarget, msg: RichMessage, opts: { voice: boolean; venueId: string | null }) => ({
  to: to.chatId ?? to.id,
  ...(to.comicId && { comicId: to.comicId }),
  ...(to.groupId && { groupId: to.groupId }),
  body: msg.body,
  name: to.name.split(/\s+/)[0],
  voice: opts.voice && msg.kind === "text",
  ...(to.tags?.length && msg.kind === "text" && { tags: liveTags(msg.body, to.tags) }),
  rich: { kind: msg.kind, ...(msg.poll && msg.kind === "poll" && { poll: msg.poll }), attachLocation: Boolean(msg.attachLocation), venueId: opts.venueId },
});

export function liveSource(uid: string): ChatSource {
  return {
    demo: false,
    list: () => runCommand<ListThreadsResult>(uid, "list_threads", {}, 90_000, { ephemeral: true }),
    thread: (comicId, before) => runCommand<GetThreadResult>(uid, "get_thread", { comicId, ...(before ? { before } : {}) }, 90_000, { ephemeral: true }),
    groupThread: (groupId, before) => runCommand<GetThreadResult>(uid, "get_thread", { groupId, ...(before ? { before } : {}) }, 90_000, { ephemeral: true }),
    // The server's model budget is AI_INTERACTIVE_DEADLINE_MS; the app waits that plus a margin, so the server's own (clearer) error wins.
    summarize: (comicId, weekOf, onStage) => runCommand<SummarizeThreadResult>(uid, "summarize_thread", { comicId, weekOf }, AI_APP_WAIT_MS, { ephemeral: true, onStage }),
    fetchMedia: (target, messageId) => fetchPicture(uid, target, messageId),
    send: async (to, msg, opts) => {
      const r = await runCommand<{ body?: string } | null>(uid, "send_message", sendPayload(to, msg, opts), opts.voice ? AI_APP_WAIT_MS : 180_000);
      return { body: r?.body ?? msg.body };
    },
    react: (target, messageId, emoji) => runCommand(uid, "react_message", { ...target, messageId, emoji }, 60_000, { ephemeral: true }),
    // The photo is already in Storage; the command carries only its path. The server sends it and deletes it.
    sendImage: (target, p) => runCommand(uid, "send_image", { ...target, path: p.path, name: p.name, caption: p.caption }, 180_000, { ephemeral: true }),
  };
}

// ---- demo ----

interface DemoData {
  comics: Comic[];
  requests: SpotRequest[];
  lineups: Lineup[];
  shows: Show[];
  now: number;
}


/** A believable chat for each demo request: what they asked, and what the curator said back (when they did). */
export function demoConversations({ comics, requests, lineups, shows, now }: DemoData) {
  const out = new Map<string, ThreadMessage[]>();
  const placedShow = (id: string) => shows.find((s) => s.id === lineups.find((l) => l.slots.some((x) => x.comicId === id))?.showId);
  for (const r of requests) {
    const first = r.comicName.split(/\s+/)[0];
    const msgs: ThreadMessage[] = r.messages.map((m) => ({ id: `${r.id}-${m.id}`, at: m.at, fromMe: false, kind: "text", text: m.body }));
    const at = Math.max(r.updatedAt, msgs[msgs.length - 1]?.at ?? 0);
    const show = placedShow(r.comicId);
    if (r.status === "acked") msgs.push({ id: `${r.id}-ack`, at: at + 60_000, fromMe: true, kind: "text", text: `Hi ${first}, got your request. I'll confirm once the lineup is set.` });
    if (show && (r.status === "assigned" || r.status === "confirmed")) msgs.push({ id: `${r.id}-yes`, at: at + 60_000, fromMe: true, kind: "text", text: `You're on *${show.name}* this week, ${first}. Details coming soon.` });
    if (r.status === "rejected" || r.status === "dismissed") msgs.push({ id: `${r.id}-no`, at: at + 60_000, fromMe: true, kind: "text", text: `Sorry ${first}, we're full this week. Ask again next week.` });
    if (comics.some((c) => c.id === r.comicId)) out.set(r.comicId, [...(out.get(r.comicId) ?? []), ...msgs].sort((a, b) => a.at - b.at));
  }
  // Sample stickers and reactions: a sticker from the first comic, and a thumbs-up from you on the second one's last message
  // (which is therefore not "waiting on you").
  const chats = [...out.entries()];
  const [a, b] = [chats[0], chats[1]];
  if (a) {
    const last = a[1][a[1].length - 1];
    if (last && !last.fromMe) out.set(a[0], [...a[1], { id: `${a[0]}-sticker`, at: last.at + 30_000, fromMe: false, kind: "sticker", text: "[sticker]", reactions: [{ emoji: "😂", count: 1, byMe: true }] }]);
  }
  if (b) {
    const last = b[1][b[1].length - 1];
    if (last && !last.fromMe) out.set(b[0], [...b[1].slice(0, -1), { ...last, reactions: [{ emoji: "👍", count: 1, byMe: true }] }]);
  }
  // A photo and a video from the third and fourth comics (just before the last message), so a thread shows a picture and the
  // "open on your phone" label.
  const [c, d4] = [chats[2], chats[3]];
  const before = (rows: ThreadMessage[], m: Omit<ThreadMessage, "at">) => [...rows, { ...m, at: (rows[rows.length - 1]?.at ?? 0) - 90_000 }].sort((x, y) => x.at - y.at);
  if (c) out.set(c[0], before(c[1], { id: `${c[0]}-photo`, fromMe: false, kind: "media", media: "image", bytes: 214_000, text: "[photo] Last night's set 🎤" }));
  if (d4) out.set(d4[0], before(d4[1], { id: `${d4[0]}-video`, fromMe: false, kind: "media", media: "video", text: "[video]" }));
  // A message with formatting and a tag, so the list preview, the bubble and the chip can be seen: "*Quick one*" and "@<number>" for
  // another comic on the roster.
  const target = chats[4] ?? chats[0];
  const other = comics.find((c) => c.phone && c.id !== target?.[0]);
  if (target && other) {
    const rows = target[1];
    const last = rows[rows.length - 1];
    const token = `@${other.phone!.replace(/\D/g, "")}`;
    out.set(target[0], [...rows, { id: `${target[0]}-tag`, at: (last?.at ?? now) + 45_000, fromMe: false, kind: "text", text: `*Quick one* _please_: can you ask ${token} to send their ~old~ bio? \`thanks\` https://x.com/a_b_c`, mentions: [{ id: other.id, token, name: other.name }] }]);
  }
  return out;
}

/** A tiny sticker for the demo: an emoji on a coloured rounded square, as an image. */
export const demoSticker = (seed: string) => {
  const faces = ["😂", "🎤", "🙌", "🔥", "👏"];
  const tints = ["#fde68a", "#bfdbfe", "#fbcfe8", "#bbf7d0", "#ddd6fe"];
  const n = [...seed].reduce((t, c) => t + c.charCodeAt(0), 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="${tints[n % tints.length]}"/><text x="64" y="86" font-size="72" text-anchor="middle">${faces[n % faces.length]}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

/** Who the demo group's "@" picker offers: the roster's first few comics. */
const demoMembers = (comics: Comic[]): ThreadMember[] => comics.slice(0, 8).map((c) => ({ id: c.id, name: c.name }));

/** A demo group: the latest lineup posted by you, replies from people on it (one tags you by their number), a sticker and reactions. */
const demoGroupAll = (d: DemoData) => d.shows.flatMap((s) => (s.groupId ? demoGroup(d, s.groupId) : []));

function demoGroup({ shows, lineups, comics, now }: DemoData, groupId: string): ThreadMessage[] {
  const show = shows.find((s) => s.groupId === groupId);
  const lineup = lineups.find((l) => l.showId === show?.id && l.slots.length);
  if (!show) return [];
  const names = (lineup?.slots ?? []).map((s, i) => `${i + 1}. ${comics.find((c) => c.id === s.comicId)?.name ?? "TBA"}`);
  const at = now - 3 * 3600_000;
  const people = (lineup?.slots ?? []).map((s) => comics.find((c) => c.id === s.comicId)).filter((c): c is Comic => Boolean(c));
  const first = people[0]?.name;
  const second = people[1] ?? comics[1];
  return [
    { id: `${groupId}-1`, at, fromMe: true, kind: "text", text: `*${show.name}: the lineup* 🎤\n\n${names.join("\n") || "Lineup coming soon."}`, reactions: [{ emoji: "🔥", count: 3, byMe: false }, { emoji: "👍", count: 1, byMe: true }] },
    ...(first ? [{ id: `${groupId}-2`, at: at + 20 * 60_000, fromMe: false, kind: "text" as const, text: "See you all there 🙌", author: first }] : []),
    ...(second ? [{ id: `${groupId}-3`, at: at + 25 * 60_000, fromMe: false, kind: "text" as const, text: `@98870264598667 can you bring the mic stand? @${second.phone} is on first`, author: second.name, mentions: [{ id: "98870264598667@lid", token: "@98870264598667", name: "You" }, { id: second.id, token: `@${second.phone}`, name: second.name }] }] : []),
    ...(first ? [{ id: `${groupId}-4`, at: at + 30 * 60_000, fromMe: false, kind: "sticker" as const, text: "[sticker]", author: first }] : []),
  ];
}

/** A sample photo for the demo: a stage scene as an image. */
export const demoPhoto = (seed: string) => {
  const hue = [...seed].reduce((t, c) => t + c.charCodeAt(0), 0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 28%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 60% 12%)"/></linearGradient></defs><rect width="480" height="320" fill="url(#g)"/><ellipse cx="240" cy="300" rx="190" ry="30" fill="hsl(${hue} 80% 70% / .25)"/><text x="240" y="205" font-size="120" text-anchor="middle">🎤</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

/** Dev only (never in a production build): `localStorage["spot.chatDelayMs"]` slows the demo's reads and `spot.chatFail` = "1" fails them, to see the cached and failed sync states. */
const devLag = async () => {
  if (!import.meta.env.DEV) return;
  try {
    const ms = Number(localStorage.getItem("spot.chatDelayMs") || 0);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (localStorage.getItem("spot.chatFail") === "1") throw new Error("Sample failure (spot.chatFail)");
  } catch (e) {
    if (e instanceof Error && /Sample failure/.test(e.message)) throw e;
  }
};

export function demoSource(get: () => DemoData): ChatSource {
  const local = new Map<string, ThreadMessage[]>();
  const localPhotos = new Map<string, string>();
  const reacted = new Map<string, ReactionChip[]>();
  const withReacted = (rows: ThreadMessage[]) => rows.map((m) => (reacted.has(m.id) ? { ...m, reactions: reacted.get(m.id) } : m));
  const all = () => {
    const d = get();
    const base = demoConversations(d);
    for (const [id, extra] of local) base.set(id, [...(base.get(id) ?? []), ...extra].sort((a, b) => a.at - b.at));
    for (const [id, rows] of base) base.set(id, withReacted(rows));
    return base;
  };
  // The demo's messages as WhatsApp's: the same shape the worker hands matchThreads, so "needs reply" is the real rule.
  const asLike = (m: ThreadMessage): WaMessageLike => ({
    id: m.id,
    type: m.kind === "sticker" ? "sticker" : "chat",
    body: m.kind === "sticker" ? "" : m.kind === "poll" && m.poll ? `Poll: ${m.poll.question}` : m.text,
    mentionedIds: m.mentions?.map((x) => x.id),
    fromMe: m.fromMe,
    timestamp: Math.floor(m.at / 1000),
    authorName: m.author,
    reactions: m.reactions?.map((r) => ({ emoji: r.emoji, byMe: r.byMe, count: r.count })),
  });
  /** Names for the tags in the demo's messages, as the worker resolves them for the real list. */
  const tagNames = () => new Map([...all().values(), ...local.values()].flat().flatMap((m) => (m.mentions ?? []).map((x) => [x.id, x.name] as const)));
  return {
    demo: true,
    list: async () => {
      await devLag();
      const d = get();
      const chats: WaChatLike[] = [];
      for (const [id, msgs] of all()) {
        const last = msgs[msgs.length - 1];
        if (!last) continue;
        const comic = d.comics.find((c) => c.id === id);
        chats.push({
          id: comic?.chatId ?? id,
          isGroup: false,
          timestamp: Math.floor(last.at / 1000),
          unreadCount: last.fromMe ? 0 : 1,
          // Shaped like a WhatsApp chat's last message, so matchThreads does the real work here too.
          lastMessage: asLike(last),
          recent: msgs.slice(-8).map(asLike),
        });
      }
      // The demo's show groups: a lineup post from you, plus anything sent here.
      for (const show of d.shows) {
        if (!show.groupId || chats.some((c) => c.id === show.groupId)) continue;
        const last = [...demoGroup(d, show.groupId), ...(local.get(show.groupId) ?? [])].pop();
        if (last) chats.push({ id: show.groupId, isGroup: true, name: `${show.name} comics`, timestamp: Math.floor(last.at / 1000), unreadCount: 0, lastMessage: asLike(last) });
      }
      return { threads: matchThreads(chats, d.comics, tagNames()), groups: matchGroupThreads(chats, d.shows, d.comics, tagNames()), at: Date.now() };
    },
    thread: async (comicId, before) => {
      await devLag();
      const rows = (all().get(comicId) ?? []).filter((m) => (before ? m.at < before : true));
      return { comicId, chatId: comicId, messages: rows.slice(-50), hasMore: rows.length > 50, at: Date.now() };
    },
    groupThread: async (groupId, before) => {
      await devLag();
      const rows = withReacted([...demoGroup(get(), groupId), ...(local.get(groupId) ?? [])]).filter((m) => (before ? m.at < before : true));
      return { comicId: groupId, groupId, chatId: groupId, messages: rows.slice(-50), hasMore: rows.length > 50, members: demoMembers(get().comics), at: Date.now() };
    },
    fetchMedia: async (_t, messageId) => {
      await new Promise((r) => setTimeout(r, 600)); // a real fetch takes a moment: show the loading state
      return { url: localPhotos.get(messageId) ?? (/photo/.test(messageId) ? demoPhoto(messageId) : demoSticker(messageId)), bytes: 0, path: null };
    },
    react: async (_t, messageId, emoji) => {
      const current = withReacted([...[...all().values()].flat(), ...demoGroupAll(get()), ...[...local.values()].flat()]).find((m) => m.id === messageId)?.reactions;
      const others = (current ?? []).map((c) => (c.byMe ? { ...c, count: c.count - 1, byMe: false } : c)).filter((c) => c.count > 0);
      reacted.set(messageId, groupReactions(emoji ? [...others, { emoji, count: 1, byMe: true }] : others));
    },
    sendImage: async (target, p) => {
      const id = `local-photo-${Date.now()}`;
      localPhotos.set(id, p.previewUrl);
      const to = "groupId" in target ? target.groupId : target.comicId;
      local.set(to, [...(local.get(to) ?? []), { id, at: Date.now(), fromMe: true, kind: "media", media: "image", text: p.caption ? `[photo] ${p.caption}` : "[photo]" }]);
    },
    summarize: async (comicId) => {
      const d = get();
      const req = d.requests.find((r) => r.comicId === comicId);
      const msgs = all().get(comicId) ?? [];
      const theirs = [...msgs].reverse().find((m) => !m.fromMe);
      const show = d.shows.find((s) => req && (req.intent?.preferredDays ?? []).includes(s.weekday)) ?? d.shows[0];
      return {
        summary: req ? `${req.comicName.split(/\s+/)[0]} asked for a spot${ (req.intent?.preferredDays ?? []).length ? " on their preferred day" : ""}. Sample summary: the demo has no model.` : "Sample summary: the demo has no model.",
        suggestedReply: "Thanks! I'll check the lineup and confirm soon.",
        actions: theirs && show ? [{ kind: "place", showId: show.id, evidence: theirs.text.slice(0, 120), told: false }] : [],
        model: "demo/sample",
        at: Date.now(),
      };
    },
    send: async (to, msg) => {
      // Picked tags go out as "@<number>" with the person's name kept for display, like a real tag read back.
      const tags = msg.kind === "text" ? liveTags(msg.body, to.tags ?? []) : [];
      const tagged = applyTags(msg.body, tags, (id) => id);
      const mentions = tagged.mentions.map((id) => ({ id, token: `@${id.split("@")[0].replace(/\D/g, "") || id}`, name: tags.find((t) => t.comicId === id)?.label.slice(1) ?? "Someone" }));
      const m: ThreadMessage = {
        id: `local-${Date.now()}`,
        at: Date.now(),
        fromMe: true,
        kind: msg.kind === "poll" ? "poll" : msg.kind === "location" ? "location" : "text",
        text: msg.kind === "poll" ? `Poll: ${msg.poll?.question ?? ""}` : msg.kind === "location" ? "Location: venue pin" : tagged.text,
        ...(mentions.length ? { mentions } : {}),
        ...(msg.kind === "poll" && msg.poll ? { poll: { question: msg.poll.question, options: msg.poll.options.filter((o) => o.trim()), multi: msg.poll.multi } } : {}),
        ...(msg.kind === "location" ? { pin: { name: "Venue pin" } } : {}),
      };
      local.set(to.id, [...(local.get(to.id) ?? []), m]);
      return { body: msg.body };
    },
  };
}
