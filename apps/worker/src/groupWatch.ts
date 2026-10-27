// Nothing BOT Comedy, group side: reads new messages in the WhatsApp groups the comic chose to watch (users/{uid}/watchedGroups) and
// turns them into spot alerts (+ a push), closures, curator schedule updates and opening notices. See docs/plans/comic-app.md.
//
// Privacy: a message is looked at only if its group is in watchedGroups: that check is the first thing that happens, before the text,
// the author or anything else is read. Messages that aren't one of the four kinds are dropped without being stored. What is kept
// is the parsed fields and a short quote, never the chat.
import type WAWebJS from "whatsapp-web.js";
import { mergeRegulars, type RegularSpot } from "@spot/shared";
import {
  alertAsk,
  alertExpiry,
  alertIdFor,
  alertPatchForReply,
  alertTakesReply,
  alertPush,
  alertToClose,
  alertsClosedByRanges,
  applyClosureToRoom,
  applyScheduleToRoom,
  clashNote,
  localParts,
  mentionsAsNames,
  rangeSummary,
  scheduleSummary,
  shortQuote,
  worthReading,
  interpret,
  type AskReply,
  type Comic,
  type Curator,
  type GroupMsg,
  type GroupUpdate,
  type Person,
  type Reading,
  type Room,
  type RoomHistory,
  type RoomPick,
  type SpotAlert,
  type WatchedGroup,
  type MySpot,
} from "@spot/shared";
import { col, FieldValue, userRef } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { generateJson } from "./llm.ts";
import { lidToPhoneIds, resolveNames } from "./chatNames.ts";
import { asMessageLike } from "./chats.ts";
import { deliverDraft } from "./deliver.ts";
import { notifyComic } from "./notify.ts";
import { buildGroupPrompt, GROUP_SCHEMA, readWithFallback, readGroupMessage } from "./groupRead.ts";

/** A message older than this isn't news (a catch-up after a restart): an offer from an hour ago is gone. */
const STALE_MS = 15 * 60_000;
/** How long the model gets before the rules read the message instead. An offer can't wait minutes. */
const AI_BUDGET_MS = Number(process.env.NBS_GROUP_AI_BUDGET_MS ?? 20_000);
/** The background room lookup after a fast push can take as long as the model needs. */
const ENRICH_BUDGET_MS = Number(process.env.NBS_GROUP_ENRICH_MS ?? 90_000);
const ATTACH_EVERY_MS = 10_000;
const SWEEP_EVERY_MS = 60_000;
const KEEP_ALERTS_DAYS = 3;
const KEEP_UPDATES_DAYS = 14;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------------------
// Which groups are watched
// ---------------------------------------------------------------------------------------------------------------------------

interface Watch {
  groups: Map<string, WatchedGroup>;
  unsub: () => void;
}
const watches = new Map<string, Watch>();

function watchGroups(uid: string): Watch {
  let w = watches.get(uid);
  if (w) return w;
  const groups = new Map<string, WatchedGroup>();
  const unsub = col(uid, "watchedGroups").onSnapshot(
    (q) => {
      groups.clear();
      for (const d of q.docs) groups.set(d.id, { ...(d.data() as WatchedGroup), id: d.id });
    },
    (e) => console.error(`[groups] ${uid} watchedGroups listener`, e),
  );
  w = { groups, unsub };
  watches.set(uid, w);
  return w;
}

/** Is this one of the groups the comic picked? The only gate in front of everything below. */
export const isWatched = (uid: string, groupId: string) => watches.get(uid)?.groups.get(groupId);

// ---------------------------------------------------------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------------------------------------------------------

const attached = new WeakSet<WAWebJS.Client>();
const chains = new Map<string, Promise<unknown>>();

function attach(uid: string, client: WAWebJS.Client) {
  if (attached.has(client)) return;
  attached.add(client);
  watchGroups(uid);
  client.on("message", (msg) => {
    // 1. Watched group or nothing: no other chat is ever opened here.
    if (!msg.from.endsWith("@g.us") || msg.fromMe) return;
    const group = isWatched(uid, msg.from);
    if (!group) return;
    if (msg.type !== "chat" || !msg.body?.trim() || msg.isStatus) return;
    if (Date.now() - msg.timestamp * 1000 > STALE_MS) return;
    if (!worthReading(msg.body)) return;
    // One at a time per account, in order: "Closed" must be read after the offer it closes.
    const next = (chains.get(uid) ?? Promise.resolve()).catch(() => undefined).then(() => handle(uid, client, msg, group));
    chains.set(uid, next);
    next.catch((e) => console.error(`[groups] ${uid} couldn't read a message`, e));
  });
}

/** Called from the scheduler: gives every ready WhatsApp session its group listener (a restarted session is a new client). */
export function startGroupWatch(uids: () => Iterable<string>) {
  setInterval(() => {
    for (const uid of uids()) {
      const client = sessions.get(uid);
      if (client) attach(uid, client);
    }
  }, ATTACH_EVERY_MS).unref();
  let lastTidy = 0;
  setInterval(() => {
    for (const uid of uids()) {
      if (!watches.has(uid)) continue;
      void expireAlerts(uid).catch((e) => console.error("[groups] sweep", e));
      if (Date.now() - lastTidy > 30 * 60_000) void tidy(uid).catch((e) => console.error("[groups] tidy", e));
    }
    if (Date.now() - lastTidy > 30 * 60_000) lastTidy = Date.now();
  }, SWEEP_EVERY_MS).unref();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reading one message
// ---------------------------------------------------------------------------------------------------------------------------

async function handle(uid: string, client: WAWebJS.Client, wa: WAWebJS.Message, group: WatchedGroup) {
  const { settings } = watchUser(uid);
  const [roomSnap, curatorSnap, comicSnap, userSnap, pickSnap, alertSnap] = await Promise.all([
    col(uid, "rooms").get(), col(uid, "curators").get(), col(uid, "comics").get(), userRef(uid).get(), col(uid, "roomPicks").get(), col(uid, "spotAlerts").get(),
  ]);
  const rooms = roomSnap.docs.map((d) => ({ ...(d.data() as Room), id: d.id }));
  const curators = curatorSnap.docs.map((d) => ({ ...(d.data() as Curator), id: d.id }));
  const comics = comicSnap.docs.map((d) => ({ ...(d.data() as Comic), id: d.id }));
  const user = userSnap.data() ?? {};
  const selfId = (user.selfId as string | undefined) ?? client.info?.wid?._serialized;

  // Who wrote it and who is tagged: ids mapped to phones where WhatsApp will say, then names.
  const like = asMessageLike(wa);
  const rawIds = [like.author ?? "", ...(like.mentionedIds ?? [])].filter(Boolean);
  const lids = await lidToPhoneIds(client, rawIds);
  const names = await resolveNames(uid, client, rawIds, comics, [], { lids });
  const person = (raw: string): Person => ({ id: lids.get(raw) ?? raw, name: names.get(raw) ?? names.get(lids.get(raw) ?? "") });
  const mentioned = (like.mentionedIds ?? []).map(person);
  let quotedMessageId: string | undefined;
  if (wa.hasQuotedMsg) quotedMessageId = (await wa.getQuotedMessage().catch(() => null))?.id?._serialized;

  const msg: GroupMsg = {
    id: wa.id._serialized,
    groupId: wa.from,
    groupName: group.name,
    text: mentionsAsNames(wa.body, mentioned.map((m, i) => ({ id: like.mentionedIds?.[i] ?? m.id, name: m.name }))).slice(0, 1200),
    at: wa.timestamp * 1000,
    sender: person(like.author ?? ""),
    mentioned,
    quotedMessageId,
  };

  const now = Date.now();
  const tz = settings.timezone;
  const parts = localParts(now, tz);
  const directory: Person[] = comics.map((c) => ({ id: c.chatId ?? c.id, name: c.name }));
  // What settles "Comedy Theatre" when it fits two rooms: what the comic picked for this group and poster, and where this group's offers usually are.
  const history: RoomHistory = {
    picks: pickSnap.docs.map((d) => d.data() as RoomPick),
    alerts: alertSnap.docs.map((d) => d.data() as Pick<SpotAlert, "groupId" | "roomId">).map((a) => ({ groupId: a.groupId, roomId: a.roomId })),
  };
  const ctx = { rooms, curators, directory, selfId, tz, now, history };

  const ask = async () => (await generateJson(uid, settings.ai, buildGroupPrompt(msg, rooms, parts), GROUP_SCHEMA)).text;
  // Rules first: a message that is plainly an offer (or a closure) is applied and pushed at once, with no model in the way.
  // Anything doubtful (schedules, opening notices, odd wording) goes to the model, with the rules as the slow-model fallback.
  const result = await readGroupMessage(ask, msg, ctx, AI_BUDGET_MS, user.comicSettings?.alertRules);
  const { reading, path, why } = result;
  const how = path === "rules-fast" ? `rules-fast ${result.score}%` : `${path} (score ${result.score}%${why ? `: ${why}` : ""})`;
  console.log(`[groups] ${uid} ${group.name}: ${reading.kind} (${how})`);
  if (reading.kind === "other") return; // not stored, not logged beyond the kind

  const auto = group.autoApply ?? Boolean(user.comicSettings?.autoApplyGroupUpdates);
  await apply(uid, msg, reading, { auto, rooms, curators, tz, now, score: result.offerScore, scoreParts: result.offerParts });
  // Pushed on the rules alone but the room wasn't matched: let the model fill it in on the stored alert, later and quietly (no second push).
  if (path === "rules-fast" && reading.kind === "spot_offer" && !reading.offer.roomId) void enrichRoom(uid, msg, rooms, parts, ask, ctx);
}

/** Background: ask the model which room a fast-pushed alert is about and update the stored alert. Never pushes, never throws. */
async function enrichRoom(uid: string, msg: GroupMsg, rooms: Room[], parts: ReturnType<typeof localParts>, ask: () => Promise<string>, ctx: Parameters<typeof interpret>[2]) {
  try {
    const { read, by } = await readWithFallback(ask, msg, ENRICH_BUDGET_MS);
    if (by !== "model" || read.kind !== "spot_offer") return;
    const r = interpret(read, msg, ctx);
    if (r.kind !== "spot_offer" || (!r.offer.roomId && !r.offer.roomName && !r.offer.roomCandidates)) return;
    const ref = col(uid, "spotAlerts").doc(alertIdFor(msg.groupId, msg.id));
    const cur = (await ref.get()).data() as SpotAlert | undefined;
    if (!cur || cur.roomId) return;
    await ref.update(stripUndefined({ roomId: r.offer.roomId, roomName: r.offer.roomName, showId: r.offer.showId, roomCandidates: r.offer.roomId ? null : r.offer.roomCandidates, roomWhy: r.offer.roomWhy }));
    console.log(`[groups] ${uid} alert room filled in by the model: ${r.offer.roomName}`);
  } catch (e) {
    console.error(`[groups] ${uid} room enrichment failed`, (e as Error).message);
  }
}

interface ApplyCtx {
  auto: boolean;
  rooms: Room[];
  curators: Curator[];
  tz: string;
  now: number;
  /** The rules' offer score and what made it, kept on the alert. */
  score?: number;
  scoreParts?: Record<string, number>;
}

async function apply(uid: string, msg: GroupMsg, reading: Reading, c: ApplyCtx) {
  switch (reading.kind) {
    case "spot_offer":
      return offerAlert(uid, msg, reading.offer, c);
    case "closure":
      return closure(uid, msg, reading.closure, c);
    case "opening_notice":
      return opening(uid, msg, reading.opening, c);
    case "schedule_update":
      return schedule(uid, msg, reading.schedule, c);
    default:
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Spot offers: write the alert, push at once
// ---------------------------------------------------------------------------------------------------------------------------

async function offerAlert(uid: string, msg: GroupMsg, o: Extract<Reading, { kind: "spot_offer" }>["offer"], c: ApplyCtx) {
  const expiresAt = alertExpiry(o, c.tz, msg.at);
  if (expiresAt <= c.now) return; // already over: nothing to ask for
  const id = alertIdFor(msg.groupId, msg.id);
  const alert: SpotAlert = {
    id,
    groupId: msg.groupId,
    groupName: msg.groupName,
    messageId: msg.id,
    poster: msg.sender,
    text: shortQuote(msg.text),
    roomId: o.roomId,
    roomName: o.roomName,
    roomCandidates: o.roomCandidates,
    roomWhy: o.roomWhy,
    showId: o.showId,
    date: o.date,
    times: o.times,
    reachBy: o.reachBy,
    contact: o.contact,
    busking: o.busking || undefined,
    long: o.long || undefined,
    score: c.score,
    scoreParts: c.scoreParts && Object.keys(c.scoreParts).length ? c.scoreParts : undefined,
    expiresAt,
    status: "new",
    receivedAt: c.now,
  };
  // The only filter: a spot that clashes in time with one already booked is kept, flagged, and not pushed.
  const stored = (await col(uid, "mySpots").where("date", "==", o.date).get()).docs.map((d) => ({ ...(d.data() as MySpot), id: d.id }));
  // Regular spots are computed, not stored one per date: fold that date's occurrences in.
  const regulars = (await col(uid, "regularSpots").get()).docs.map((d) => ({ ...(d.data() as RegularSpot), id: d.id }));
  const spots = mergeRegulars(stored, regulars, o.date, o.date);
  const clash = clashNote(alert, spots);
  if (clash) alert.clash = clash;
  try {
    await col(uid, "spotAlerts").doc(id).create(stripUndefined(alert));
  } catch (e) {
    if ((e as { code?: number }).code === 6) return; // ALREADY_EXISTS: this message was handled already
    throw e;
  }
  if (clash) return;
  const text = alertPush(alert, spots, localParts(c.now, c.tz).date);
  const sent = await notifyComic(uid, { kind: "spot_alert", ...text, path: `/alerts?alert=${encodeURIComponent(id)}`, alertId: id, ttlSec: (expiresAt - c.now) / 1000 });
  console.log(`[groups] ${uid} spot alert pushed to ${sent} device(s)`);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Closures
// ---------------------------------------------------------------------------------------------------------------------------

const liveAlerts = async (uid: string, groupId: string) =>
  (await col(uid, "spotAlerts").where("groupId", "==", groupId).get()).docs.map((d) => ({ ...(d.data() as SpotAlert), id: d.id }));

async function closure(uid: string, msg: GroupMsg, cl: Extract<Reading, { kind: "closure" }>["closure"], c: ApplyCtx) {
  const alerts = await liveAlerts(uid, msg.groupId);
  const target = alertToClose(alerts, { groupId: msg.groupId, posterId: msg.sender.id, quotedMessageId: msg.quotedMessageId, roomId: cl.roomId, now: c.now });
  const closedIds = new Set<string>();
  const closeAlert = async (a: SpotAlert) => {
    if (closedIds.has(a.id)) return;
    closedIds.add(a.id);
    await col(uid, "spotAlerts").doc(a.id).update({ status: "closed", closedAt: c.now });
  };
  if (target) await closeAlert(target);

  // "Over" with no days only closes that poster's alert. Days or a week name a period the show is full for.
  const roomId = cl.roomId ?? (cl.ranges.length ? target?.roomId : undefined);
  if (!cl.ranges.length || !roomId) return;
  for (const a of alertsClosedByRanges(alerts, roomId, cl.ranges, c.now)) await closeAlert(a);
  const room = c.rooms.find((r) => r.id === roomId);
  if (!room) return;
  const summary = `${room.name} is full: ${rangeSummary(cl.ranges)}`;
  const update = baseUpdate(msg, "closure", { roomId, roomName: room.name, summary, closure: { ranges: cl.ranges, showId: target?.showId }, now: c.now });
  if (c.auto) {
    await col(uid, "rooms").doc(room.id).set(stripUndefined(applyClosureToRoom(room, cl.ranges, { groupId: msg.groupId, messageId: msg.id, at: c.now, showId: target?.showId }) as unknown as object) as object);
    await saveUpdate(uid, { ...update, status: "applied", auto: true, appliedAt: c.now });
  } else await saveUpdate(uid, update);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Opening notices and curator schedules
// ---------------------------------------------------------------------------------------------------------------------------

async function opening(uid: string, msg: GroupMsg, o: Extract<Reading, { kind: "opening_notice" }>["opening"], c: ApplyCtx) {
  if (!o.roomId && !o.roomName) return;
  // Nothing in the roster to change: it is a heads-up, shown until cleared.
  await saveUpdate(uid, baseUpdate(msg, "opening", { roomId: o.roomId, roomName: o.roomName, summary: o.summary, opening: { openAt: o.openAt, website: o.website }, now: c.now, status: "info" }));
}

async function schedule(uid: string, msg: GroupMsg, s: Extract<Reading, { kind: "schedule_update" }>["schedule"], c: ApplyCtx) {
  const room = c.rooms.find((r) => r.id === s.roomId);
  if (!room) return; // a schedule for a room the comic doesn't have: nothing to apply it to
  const summary = `${room.name} curators: ${scheduleSummary(s.entries)}`;
  const update = baseUpdate(msg, "schedule", { roomId: room.id, roomName: room.name, summary, schedule: { entries: s.entries }, now: c.now });
  if (c.auto) {
    const out = applyScheduleToRoom(room, c.curators, s.entries);
    await col(uid, "rooms").doc(room.id).set(stripUndefined(out.room as unknown as object) as object);
    const known = new Set(c.curators.map((x) => x.id));
    for (const cur of out.curators) if (!known.has(cur.id)) await col(uid, "curators").doc(cur.id).set(stripUndefined({ ...cur, id: undefined }) as object);
    await saveUpdate(uid, { ...update, status: "applied", auto: true, appliedAt: c.now });
  } else await saveUpdate(uid, update);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Review items
// ---------------------------------------------------------------------------------------------------------------------------

function baseUpdate(
  msg: GroupMsg,
  kind: GroupUpdate["kind"],
  f: Pick<GroupUpdate, "summary" | "roomId" | "roomName" | "closure" | "schedule" | "opening"> & { now: number; status?: GroupUpdate["status"] },
): GroupUpdate {
  const { now, status, ...rest } = f;
  return { id: alertIdFor(msg.groupId, msg.id), kind, groupId: msg.groupId, groupName: msg.groupName, messageId: msg.id, poster: msg.sender, text: shortQuote(msg.text, 200), status: status ?? "pending", receivedAt: now, ...rest };
}

async function saveUpdate(uid: string, u: GroupUpdate) {
  await col(uid, "groupUpdates").doc(u.id).set(stripUndefined(u));
}

function stripUndefined<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------------------------------------------------------

/** Offers nobody acted on are marked over once their time has passed. */
async function expireAlerts(uid: string) {
  const snap = await col(uid, "spotAlerts").where("status", "==", "new").get();
  const now = Date.now();
  await Promise.all(snap.docs.filter((d) => (d.data().expiresAt as number) <= now).map((d) => d.ref.update({ status: "expired" })));
}

/** Old alerts and cleared updates go: this is a live list, not an archive of the group. */
async function tidy(uid: string) {
  const now = Date.now();
  const alerts = await col(uid, "spotAlerts").get();
  await Promise.all(alerts.docs.filter((d) => (d.data().expiresAt as number) < now - KEEP_ALERTS_DAYS * DAY_MS).map((d) => d.ref.delete()));
  const updates = await col(uid, "groupUpdates").get();
  await Promise.all(updates.docs.filter((d) => d.data().status !== "pending" && (d.data().receivedAt as number) < now - KEEP_UPDATES_DAYS * DAY_MS).map((d) => d.ref.delete()));
}

// ---------------------------------------------------------------------------------------------------------------------------
// "Ask for it": the command
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * ask_for_spot { alertId, body }: DMs the alert's contact with the (editable) text the comic confirmed, then marks the alert asked.
 * There is no limit or cooldown check: a spot offered in a group is ad hoc and the comic decides. A closed or ended one is refused
 * unless `force`, so a late tap doesn't message someone about a spot that is gone.
 */
export async function askForSpot(uid: string, payload: Record<string, unknown>) {
  const alertId = String(payload.alertId ?? "");
  const body = String(payload.body ?? "").trim().slice(0, 1000);
  const time = typeof payload.time === "string" && /^\d{2}:\d{2}$/.test(payload.time) ? payload.time : undefined;
  if (!alertId) throw new Error("Which spot? The alert is missing.");
  if (!body) throw new Error("Write a message first.");
  const ref = col(uid, "spotAlerts").doc(alertId);
  const alert = (await ref.get()).data() as SpotAlert | undefined;
  if (!alert) throw new Error("That alert is gone. Open spots stay for a few hours only.");
  if (!payload.force) {
    if (alert.status === "closed") throw new Error("They closed it in the group. Send anyway if you think there is still room.");
    if (alert.status === "expired" || alert.expiresAt <= Date.now()) throw new Error("That one has ended. Send anyway if you still want to try.");
  }
  const client = sessions.require(uid);
  const sent = await deliverDraft(uid, client, alert.contact.id, body);
  const now = Date.now();
  // A reply that comes in later must not be missed: the ask is what the 10-minute reply reader looks at. Asking again restarts it.
  const ask = alertAsk({ ...alert, id: alertId }, { body, time, now, chatId: (sent as { to?: string } | undefined)?.to ?? alert.contact.id, messageId: sent?.id?._serialized });
  await col(uid, "asks").doc(ask.id).set(stripUndefined(ask));
  await ref.update({ status: "asked", askedAt: now, askText: body, reply: FieldValue.delete() });
  return { sentTo: alert.contact.name ?? alert.contact.id };
}

/** A read reply to a group-alert ask: the alert shows it (and is "got" or "declined"), unless the comic already dismissed the alert. */
export async function applyAlertReply(uid: string, alertId: string, reply: AskReply) {
  const ref = col(uid, "spotAlerts").doc(alertId);
  const alert = (await ref.get()).data() as SpotAlert | undefined;
  if (!alert || !alertTakesReply(alert)) return;
  await ref.update(stripUndefined(alertPatchForReply(reply)));
}
