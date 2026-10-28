// Membership check for a spot ping (see packages/shared/src/membership.ts): on the lineup? in the show's group?
// Group membership is read from the cached list on the show doc; nothing here asks WhatsApp per message.
import type WAWebJS from "whatsapp-web.js";
import {
  AUTO_ACK_MAX_AGE_MS,
  INTENT_THRESHOLD,
  checkShows,
  holdReasonFor,
  membershipDecision,
  targetShows,
  type Comic,
  type ComicAction,
  type HoldReason,
  type InboundMessage,
  type Intent,
  type Lineup,
  type MembershipDecision,
  type SpotRequest,
} from "@spot/shared";
import { col } from "./firebase.ts";
import { watchUser } from "./userData.ts";
import { composeDraft, deliverDraft } from "./deliver.ts";
import { greetFor } from "./greet.ts";

export interface MembershipOutcome {
  /** Case 1: handled here (confirmed), no request is created. */
  done: boolean;
  /** Cases 2, 3 and unknown: the hold to put on the request. */
  hold: HoldReason | null;
  holdNote: string | null;
  /** A regular of a show the ping is about: skips the performed-recently hold. */
  regular: boolean;
  decision: MembershipDecision | null;
}

const NONE: MembershipOutcome = { done: false, hold: null, holdNote: null, regular: false, decision: null };

/** One "you're already on" reply per person, show and date: a follow-up burst doesn't get a second one. */
const confirmedFor = new Map<string, number>();
const CONFIRM_ONCE_MS = 6 * 3600_000;

interface Burst {
  messages: InboundMessage[];
  contact: { id: string; chatId: string; name: string; phone: string; nameSource: NonNullable<Comic["nameSource"]>; isBusiness: boolean };
  quiet?: boolean;
}

const actionId = (p: Burst) => `m_${p.messages[0].id}`.replace(/[^\w-]/g, "_").slice(0, 300);

/** The decision for a spot ask, or null when it doesn't apply (not a clear spot ask, banned/ignored/host, no active show). Shared by live intake and the history scan. */
export async function decideMembership(uid: string, intent: Intent, known: Comic | undefined, contact: { id: string; chatId: string; name: string; phone: string }, week: string): Promise<MembershipDecision | null> {
  if (!intent.isSpotRequest || intent.confidence < INTENT_THRESHOLD || known?.list) return null;
  const targets = targetShows(watchUser(uid).shows, intent);
  if (!targets.length) return null;
  const lineups = (await col(uid, "lineups").where("weekOf", "==", week).get()).docs.map((d) => d.data() as Lineup);
  const comic = known ?? { id: contact.id, chatId: contact.chatId, name: contact.name, phone: contact.phone, tier: "open" as const, regularOf: [] as string[] };
  return membershipDecision(checkShows({ comic, shows: targets, lineups, week, now: Date.now() }));
}

/**
 * Decide for a spot ping. Skipped (normal flows) for non-spot messages, business accounts, banned/ignored/host comics,
 * requests the curator already settled or released, and when no show is active.
 */
export async function checkMembership(opts: { uid: string; client: WAWebJS.Client; p: Burst; intent: Intent; known: Comic | undefined; existing: SpotRequest | undefined; locked: boolean; week: string }): Promise<MembershipOutcome> {
  const { uid, client, p, intent, known, existing, locked, week } = opts;
  if (p.contact.isBusiness || locked || existing?.holdOverridden) return NONE;
  const { venues, shows, settings } = watchUser(uid);
  const decision = await decideMembership(uid, intent, known, p.contact, week);
  if (!decision) return NONE;
  const fresh = Date.now() - Math.max(...p.messages.map((m) => m.at)) < AUTO_ACK_MAX_AGE_MS;

  if (decision.kind === "normal") return { ...NONE, regular: decision.regular, decision };
  const c = decision.check;
  const show = shows.find((s) => s.id === c.showId);
  const venue = venues.find((v) => v.id === show?.venueId);
  const name = await greetFor(client, known ?? { id: p.contact.id, chatId: p.contact.chatId, name: p.contact.nameSource === "number" ? "" : p.contact.name, nameSource: p.contact.nameSource });
  const vars = { name, show: c.showName, venue: venue?.name, day: c.day, date: c.date, time: show?.startTime };

  if (decision.kind === "confirmed") {
    const key = `${uid}|${p.contact.id}|${c.showId}|${c.date}`;
    if (p.quiet || !fresh || Date.now() - (confirmedFor.get(key) ?? 0) < CONFIRM_ONCE_MS) return { ...NONE, done: true, decision };
    confirmedFor.set(key, Date.now());
    const { draft, rich } = await composeDraft(uid, "alreadyOn", vars, venue);
    if (settings.selfService.autoSend) {
      await deliverDraft(uid, client, known?.chatId ?? p.contact.chatId, draft, rich);
      console.log(`[member] told ${p.contact.name} they're already on ${c.showName}`);
    } else {
      await col(uid, "actions").doc(actionId(p)).create(action(p, week, "status_query", draft, rich, "Already on the lineup and in the group")).catch(() => undefined);
    }
    return { ...NONE, done: true, decision };
  }

  const hold = holdReasonFor(decision) as HoldReason;
  return { done: false, hold, holdNote: decision.reason, regular: false, decision };
}

/** After the request is saved: the drafted reply for the curator (never sent on its own), and the group add suggestion. */
export async function afterMembershipHold(opts: { uid: string; client: WAWebJS.Client; p: Burst; week: string; outcome: MembershipOutcome; known: Comic | undefined }) {
  const { uid, client, p, week, outcome } = opts;
  const d = outcome.decision;
  if (!d || d.kind === "normal" || d.kind === "confirmed" || d.kind === "hold_unknown") return;
  const { shows, venues } = watchUser(uid);
  const show = shows.find((s) => s.id === d.check.showId);
  const venue = venues.find((v) => v.id === show?.venueId);
  const name = await greetFor(client, opts.known ?? { id: p.contact.id, chatId: p.contact.chatId, name: p.contact.nameSource === "number" ? "" : p.contact.name, nameSource: p.contact.nameSource });
  const key = d.kind === "hold_in_group" ? "heldInGroup" : "heldOnLineup";
  const { draft, rich } = await composeDraft(uid, key, { name, show: d.check.showName, venue: venue?.name, day: d.check.day, date: d.check.date, time: show?.startTime }, venue);
  const reason = d.kind === "hold_on_lineup" ? `${d.reason}. A group add is suggested on the ${d.check.showName} lineup.` : d.reason;
  await col(uid, "actions").doc(actionId(p)).create(action(p, week, "held", draft, rich, reason)).catch(() => undefined);
  // Suggest the add: the usual group sync plan (review and apply on the lineup). Nothing is added automatically.
  if (d.kind === "hold_on_lineup" && !p.quiet && show?.groupId) {
    const id = `${week}_${show.id}`;
    const l = (await col(uid, "lineups").doc(id).get()).data() as Lineup | undefined;
    if (l && !l.backfilled && l.groupSync?.status !== "computing" && l.groupSync?.status !== "applying") {
      const { runHandler } = await import("./commands.ts");
      await runHandler("plan_group_sync", uid, { lineupId: id }).catch((e) => console.error(`[member] group plan for ${id} failed`, e));
    }
  }
}

function action(p: Burst, week: string, kind: ComicAction["kind"], draft: string, rich: ComicAction["rich"] | undefined, reason: string): Omit<ComicAction, "id"> {
  return {
    kind,
    comicId: p.contact.id,
    comicName: p.contact.name,
    weekOf: week,
    message: p.messages.map((m) => m.body).join("\n"),
    draft,
    ...(rich && { rich }),
    reason,
    lineupId: null,
    status: "pending",
    createdAt: Date.now(),
  };
}
