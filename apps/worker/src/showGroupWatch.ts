// The curator's own show groups: a comic on tonight's (or the next) lineup writes "running late", "can't make it", "reached" in
// the group, and the lineup shows a pill for it (packages/shared/src/showWatch.ts has every rule; this file is the plumbing).
//
// Privacy, in the order things happen to a message:
//   1. only a group that is one of this curator's active shows' groups, and only while Settings → Watch show groups is on;
//   2. never-read people and groups are skipped before anything else;
//   3. a keyword check on the text, locally: no keyword, no model, nothing stored;
//   4. the writer must be a comic on that show's current or next lineup: anyone else's message is dropped unread;
//   5. only then the model (the curator's AI policy decides which), and only a structured event is kept: Slot.live.
import type WAWebJS from "whatsapp-web.js";
import {
  LIVE_SCHEMA,
  buildLivePrompt,
  cancelDecision,
  etaFromText,
  formatTime,
  liveExpireAt,
  liveNoticeText,
  liveSnippet,
  localParts,
  mergeLive,
  parseLiveRead,
  pickWatchLineup,
  prefilter,
  rulesRead,
  showWatchOf,
  worthRaising,
  type Comic,
  type Lineup,
  type LiveRead,
  type Show,
  type SlotLive,
} from "@spot/shared";
import { col, db, expireAt } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { isNeverRead } from "./neverRead.ts";
import { generateJson } from "./llm.ts";
import { lidToPhoneIds } from "./chatNames.ts";
import { notify } from "./notify.ts";

/** A message older than this is a catch-up after a restart, not news. */
const STALE_MS = 15 * 60_000;
/** How long the model gets before the keywords read the message instead. */
const AI_BUDGET_MS = Number(process.env.NBS_SHOW_WATCH_AI_BUDGET_MS ?? 20_000);
const ATTACH_EVERY_MS = 10_000;
const SWEEP_EVERY_MS = 10 * 60_000;
const NOTICE_DAYS = 14;

const attached = new WeakSet<WAWebJS.Client>();
const chains = new Map<string, Promise<unknown>>();

function attach(uid: string, client: WAWebJS.Client) {
  if (attached.has(client)) return;
  attached.add(client);
  client.on("message", (msg) => {
    // Cheap gates first, no text involved: a group message from someone else, in a show's group, with the watch on.
    if (!msg.from.endsWith("@g.us") || msg.fromMe || msg.isStatus || msg.type !== "chat") return;
    const { settings, shows } = watchUser(uid);
    if (!showWatchOf(settings).enabled) return;
    const show = shows.find((s) => s.active && s.groupId === msg.from);
    if (!show) return;
    const next = (chains.get(uid) ?? Promise.resolve()).catch(() => undefined).then(() => handle(uid, client, msg, show));
    chains.set(uid, next);
    next.catch((e) => console.error(`[show-watch] ${uid} couldn't read a message`, e));
  });
}

/** Gives every ready WhatsApp session the listener (a restarted session is a new client), and clears pills once their show is over. */
export function startShowGroupWatch(uids: () => Iterable<string>) {
  setInterval(() => {
    for (const uid of uids()) {
      const client = sessions.get(uid);
      if (client) attach(uid, client);
    }
  }, ATTACH_EVERY_MS).unref();
  setInterval(() => {
    for (const uid of uids()) void sweep(uid).catch((e) => console.error("[show-watch] sweep", e));
  }, SWEEP_EVERY_MS).unref();
}

/** Who wrote it, as a lineup comic: the sender's id, or the phone id behind an @lid, matched against the slots (and the comics' chat ids). */
async function senderOnLineup(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message, lineup: Lineup): Promise<{ comicId: string; comic?: Comic } | null> {
  const raw = msg.author ?? msg.from;
  const ids = new Set([raw]);
  if (raw.endsWith("@lid")) {
    const phone = (await lidToPhoneIds(client, [raw])).get(raw);
    if (phone) ids.add(phone);
  }
  const direct = lineup.slots.find((s) => ids.has(s.comicId));
  if (direct) return { comicId: direct.comicId, comic: (await col(uid, "comics").doc(direct.comicId).get()).data() as Comic | undefined };
  if (!lineup.slots.length) return null;
  const snaps = await db.getAll(...lineup.slots.map((s) => col(uid, "comics").doc(s.comicId)));
  for (const s of snaps) {
    const c = s.data() as Comic | undefined;
    if (c && (ids.has(c.chatId ?? ""))) return { comicId: c.id ?? s.id, comic: c };
  }
  return null;
}

async function read(uid: string, text: string, show: Show, tz: string, now: number): Promise<{ read: LiveRead | null; rulesOnly: boolean }> {
  const { settings } = watchUser(uid);
  const p = localParts(now, tz);
  const prompt = buildLivePrompt(text, { show: show.name, startTime: formatTime(show.startTime), now: `${p.date} ${formatTime(p.time)}` });
  try {
    const { text: raw } = await Promise.race([
      generateJson(uid, settings.ai, prompt, LIVE_SCHEMA),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${Math.round(AI_BUDGET_MS / 1000)}s`)), AI_BUDGET_MS).unref()),
    ]);
    return { read: parseLiveRead(raw, text), rulesOnly: false };
  } catch (e) {
    // No model (policy, down, slow): the keywords read it, and are never sure enough to act on their own.
    console.warn(`[show-watch] ${uid} model unavailable (${(e as Error).message}); the keywords read it`);
    return { read: rulesRead(text), rulesOnly: true };
  }
}

async function handle(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message, show: Show) {
  // 2. Never read: before the text is looked at.
  if (await isNeverRead(uid, client, msg.from, msg.author)) return;
  const text = msg.body?.trim();
  if (!text) return;
  const at = msg.timestamp * 1000;
  if (Date.now() - at > STALE_MS) return;
  // 3. Keywords only: nothing is asked of a model, and nothing is kept, for chat.
  if (!prefilter(text).length) return;

  const { settings } = watchUser(uid);
  const watch = showWatchOf(settings);
  const tz = settings.timezone;
  const today = localParts(Date.now(), tz).date;
  // 4. Tonight's lineup (or the next one), and the writer must be on it.
  const lineups = (await col(uid, "lineups").where("showId", "==", show.id).get()).docs.map((d) => d.data() as Lineup);
  const lineup = pickWatchLineup(lineups, today);
  if (!lineup) return;
  const who = await senderOnLineup(uid, client, msg, lineup);
  if (!who) return;

  // 5. Read it.
  const { read: got, rulesOnly } = await read(uid, text, show, tz, Date.now());
  if (!got || !worthRaising(got, watch)) return;

  const name = who.comic?.name ?? `+${who.comicId.split("@")[0]}`;
  const eta = got.kind === "late" ? etaFromText(text, at, tz, show.startTime) : null;
  const live: SlotLive = {
    kind: got.kind,
    ...(eta && { eta }),
    at,
    msgId: msg.id._serialized,
    snippet: liveSnippet(text),
    confidence: Math.round(got.confidence * 100) / 100,
    expireAt: liveExpireAt(lineup.date, show.startTime, tz, at),
  };

  // One message, one pill: written in a transaction against the lineup as it is now.
  const ref = col(uid, "lineups").doc(lineup.id);
  const applied = await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data() as Lineup | undefined;
    const i = cur?.slots.findIndex((s) => s.comicId === who.comicId) ?? -1;
    if (!cur || i < 0) return false;
    const merged = mergeLive(cur.slots[i].live, live);
    if (!merged) return false;
    tx.update(ref, { slots: cur.slots.map((s, j) => (j === i ? { ...s, live: merged } : s)) });
    return true;
  });
  if (!applied) return;

  // Cancel: the existing automatic cancellation, when the curator has it on and this is clear enough; otherwise it only suggests.
  const decision = got.kind === "cancel" ? cancelDecision({ watch, selfService: settings.selfService, read: got, rulesOnly, text, age: Date.now() - at, upcoming: lineup.date >= today }) : "suggest";
  let auto = false;
  let removedFromGroup = false;
  if (decision === "auto") {
    try {
      const { dropFromLineup } = await import("./commands.ts");
      await dropFromLineup(uid, client, who.comicId, lineup.id);
      auto = true;
      removedFromGroup = Boolean(show.groupId) && lineup.date === today;
    } catch (e) {
      console.error(`[show-watch] ${uid} couldn't remove ${name} automatically`, e);
    }
  }

  const etaLabel = eta ? formatTime(eta) : undefined;
  const line = liveNoticeText({ name, kind: got.kind, show: show.name, etaLabel, snippet: live.snippet, auto, removedFromGroup });
  // One notice per message: re-reading the same message (a retry, a catch-up) finds it there and stops. Kind "lineup" is what the agent number forwards.
  const noticeId = `live_${live.msgId}`.replace(/[^\w-]/g, "_").slice(0, 200);
  const created = await col(uid, "notices")
    .doc(noticeId)
    .create({ level: "info", kind: "lineup", text: line, createdAt: Date.now(), read: false, expireAt: expireAt(NOTICE_DAYS), link: "/lineup", linkLabel: "Open lineup" })
    .then(() => true)
    .catch(() => false);
  if (created) void notify(uid, "show_live", line).catch(() => undefined);
  console.log(`[show-watch] ${uid} ${name} on ${show.name}: ${got.kind} (${got.confidence})${auto ? " removed automatically" : ""}`);
}

/** Takes `live` off slots whose show is over: a quote of a group message isn't kept longer than the pill needs it. */
async function sweep(uid: string) {
  const now = Date.now();
  const { settings } = watchUser(uid);
  // Only the last ten days of lineups: a pill never outlives its show by more than hours.
  const since = localParts(now - 10 * 86_400_000, settings.timezone).date;
  const docs = (await col(uid, "lineups").where("date", ">=", since).get()).docs.filter((d) => (d.data() as Lineup).slots?.some((s) => s.live && now >= s.live.expireAt));
  for (const d of docs) {
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(d.ref)).data() as Lineup | undefined;
      if (!cur?.slots.some((s) => s.live && now >= s.live.expireAt)) return;
      tx.update(d.ref, { slots: cur.slots.map(({ live, ...s }) => (live && now >= live.expireAt ? s : live ? { ...s, live } : s)) });
    });
  }
}
