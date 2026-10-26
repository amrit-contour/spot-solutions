// Messages page data. Real accounts read chats live through worker commands whose results are deleted as soon as they are read
// (nothing is kept). The demo has no WhatsApp, so its conversations are built right here from the demo sandbox's own
// requests and lineups, and the page says so. Nothing in this file is ever used for a real account's data.
import {
  matchThreads,
  type Comic,
  type GetThreadResult,
  type Lineup,
  type ListThreadsResult,
  type RichMessage,
  type Show,
  type SpotRequest,
  type SummarizeThreadResult,
  type ThreadMessage,
  type WaChatLike,
} from "@spot/shared";
import { runCommand } from "./data";

export interface ChatTarget {
  id: string;
  chatId?: string;
  name: string;
}

export interface ChatSource {
  /** Sample conversations built from the demo sandbox, not WhatsApp. */
  demo: boolean;
  list: () => Promise<ListThreadsResult>;
  thread: (comicId: string, before?: number) => Promise<GetThreadResult>;
  summarize: (comicId: string, weekOf: string) => Promise<SummarizeThreadResult>;
  send: (to: ChatTarget, msg: RichMessage, opts: { voice: boolean; venueId: string | null }) => Promise<{ body: string }>;
}

/** The send payload: the same shape the reply cards use, plus the voice switch. */
export const sendPayload = (to: ChatTarget, msg: RichMessage, opts: { voice: boolean; venueId: string | null }) => ({
  to: to.chatId ?? to.id,
  body: msg.body,
  name: to.name.split(/\s+/)[0],
  voice: opts.voice && msg.kind === "text",
  rich: { kind: msg.kind, ...(msg.poll && msg.kind === "poll" && { poll: msg.poll }), attachLocation: Boolean(msg.attachLocation), venueId: opts.venueId },
});

export function liveSource(uid: string): ChatSource {
  return {
    demo: false,
    list: () => runCommand<ListThreadsResult>(uid, "list_threads", {}, 90_000, { ephemeral: true }),
    thread: (comicId, before) => runCommand<GetThreadResult>(uid, "get_thread", { comicId, ...(before ? { before } : {}) }, 90_000, { ephemeral: true }),
    summarize: (comicId, weekOf) => runCommand<SummarizeThreadResult>(uid, "summarize_thread", { comicId, weekOf }, 240_000, { ephemeral: true }),
    send: async (to, msg, opts) => {
      const r = await runCommand<{ body?: string } | null>(uid, "send_message", sendPayload(to, msg, opts), 180_000);
      return { body: r?.body ?? msg.body };
    },
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
  // A couple of spread-out times so the day separators show up.
  void now;
  return out;
}

export function demoSource(get: () => DemoData): ChatSource {
  const local = new Map<string, ThreadMessage[]>();
  const all = () => {
    const d = get();
    const base = demoConversations(d);
    for (const [id, extra] of local) base.set(id, [...(base.get(id) ?? []), ...extra].sort((a, b) => a.at - b.at));
    return base;
  };
  const snippet = (m: ThreadMessage) => (m.kind === "poll" && m.poll ? `Poll: ${m.poll.question}` : m.text).replace(/\s+/g, " ").slice(0, 80);
  return {
    demo: true,
    list: async () => {
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
          lastMessage: { id: last.id, type: "chat", body: snippet(last), fromMe: last.fromMe, timestamp: Math.floor(last.at / 1000) },
        });
      }
      return { threads: matchThreads(chats, d.comics), at: Date.now() };
    },
    thread: async (comicId, before) => {
      const rows = (all().get(comicId) ?? []).filter((m) => (before ? m.at < before : true));
      return { comicId, chatId: comicId, messages: rows.slice(-50), hasMore: rows.length > 50, at: Date.now() };
    },
    summarize: async (comicId) => {
      const d = get();
      const req = d.requests.find((r) => r.comicId === comicId);
      const msgs = all().get(comicId) ?? [];
      const theirs = [...msgs].reverse().find((m) => !m.fromMe);
      const show = d.shows.find((s) => req && req.intent.preferredDays.includes(s.weekday)) ?? d.shows[0];
      return {
        summary: req ? `${req.comicName.split(/\s+/)[0]} asked for a spot${req.intent.preferredDays.length ? " on their preferred day" : ""}. Sample summary: the demo has no model.` : "Sample summary: the demo has no model.",
        suggestedReply: "Thanks! I'll check the lineup and confirm soon.",
        actions: theirs && show ? [{ kind: "place", showId: show.id, evidence: theirs.text.slice(0, 120), told: false }] : [],
        model: "demo/sample",
        at: Date.now(),
      };
    },
    send: async (to, msg) => {
      const m: ThreadMessage = {
        id: `local-${Date.now()}`,
        at: Date.now(),
        fromMe: true,
        kind: msg.kind === "poll" ? "poll" : msg.kind === "location" ? "location" : "text",
        text: msg.kind === "poll" ? `Poll: ${msg.poll?.question ?? ""}` : msg.kind === "location" ? "Location: venue pin" : msg.body,
        ...(msg.kind === "poll" && msg.poll ? { poll: { question: msg.poll.question, options: msg.poll.options.filter((o) => o.trim()), multi: msg.poll.multi } } : {}),
        ...(msg.kind === "location" ? { pin: { name: "Venue pin" } } : {}),
      };
      local.set(to.id, [...(local.get(to.id) ?? []), m]);
      return { body: msg.body };
    },
  };
}
