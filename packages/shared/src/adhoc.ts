// Ad hoc spots: last-minute offers to one or more comics, and the cooldown that holds back recent performers. Pure rules.
import { shiftWeek } from "./week.ts";
import type { Comic, RuleSettings, SpotOffer } from "./types.ts";

/** What a yes to this offer does: book it now, or wait for the curator to pick (a round of several with auto-add off). */
export function onYes(offer: Pick<SpotOffer, "round">, roundOffers: Pick<SpotOffer, "status">[]): "book" | "pick" | "full" {
  const r = offer.round;
  if (!r || r.size <= 1) return "book";
  const booked = roundOffers.filter((o) => o.status === "accepted").length;
  if (booked >= r.slots) return "full";
  return r.autoAdd ? "book" : "pick";
}

/** After a booking, has this round filled its slots? Then the rest of it closes. */
export const roundFilled = (offer: Pick<SpotOffer, "round">, roundOffers: Pick<SpotOffer, "status">[]) =>
  Boolean(offer.round) && roundOffers.filter((o) => o.status === "accepted").length >= (offer.round?.slots ?? 1);

export const COOLDOWN_MAX_WEEKS = 8;
export const cooldownWeeks = (rules: Pick<RuleSettings, "cooldownWeeks">) => Math.max(1, Math.min(COOLDOWN_MAX_WEEKS, Math.round(rules.cooldownWeeks ?? 1)));

/**
 * The spot that puts them in the cooldown for `week`: a show they did (not ad hoc) in the `weeks` weeks before it.
 * Falls back to lastPerformedWeek for comics with no history yet.
 */
export function recentSpot(comic: Pick<Comic, "history" | "lastPerformedWeek"> | null | undefined, week: string, weeks: number): { date: string; showName: string } | null {
  if (!comic) return null;
  const from = shiftWeek(week, -weeks);
  const hit = (comic.history ?? []).find((h) => h.status === "confirmed" && !h.adhoc && h.date >= from && h.date < week);
  if (hit) return { date: hit.date, showName: hit.showName };
  if (!comic.history?.length && comic.lastPerformedWeek && comic.lastPerformedWeek >= from && comic.lastPerformedWeek < week) return { date: comic.lastPerformedWeek, showName: "a show" };
  return null;
}

/** Words for the held reply: when they were last up, and when to ask again. */
export function cooldownWords(spotDate: string, week: string, weeks: number, fmt: (iso: string) => string): { lastWhen: string; askAgain: string } {
  const lastWeekStart = shiftWeek(week, -1);
  const lastWhen = spotDate >= lastWeekStart ? "last week" : `on ${fmt(spotDate)}`;
  // They can ask again the week after the cooldown since that spot runs out.
  const spotWeek = mondayOf(spotDate);
  const again = shiftWeek(spotWeek, weeks + 1);
  const askAgain = again <= shiftWeek(week, 1) ? "next week" : `from the week of ${fmt(again)}`;
  return { lastWhen, askAgain };
}

const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/** "Added Rahul to Monday Mic directly": the Updates entry for comics added without an offer. */
export function directNotice(names: string[], showName: string, opts: DirectOptions = {}): string {
  const who = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const off = [opts.confirm === false && "no confirmation sent", opts.addToGroup === false && "not added to the group"].filter(Boolean).join(", ");
  return `Added ${who} to ${showName} directly${off ? ` (${off})` : ""}`;
}

/** What a direct add also does. Both default to on: the confirmation message goes out and they join the show's group. */
export interface DirectOptions {
  confirm?: boolean;
  addToGroup?: boolean;
}

/** In words, for the agent's "yes?" question and the app: "gets your confirmation and is added to the show's group", "no message, not added to the group". */
export function directEffects(o: DirectOptions = {}): string {
  const msg = o.confirm === false ? "no message is sent" : "they get your confirmation message";
  const grp = o.addToGroup === false ? "they aren't added to the group" : "they join the show's group";
  return `${msg}, ${grp}`;
}

/** Who a direct add puts on the lineup, who is already there, and how far over the show's slot count it goes. Cooldown never applies. */
export function directPlan(onLineup: string[], picks: string[], slotCount: number): { add: string[]; already: string[]; over: number } {
  const on = new Set(onLineup);
  const unique = [...new Set(picks)];
  const add = unique.filter((id) => !on.has(id));
  return { add, already: unique.filter((id) => on.has(id)), over: Math.max(0, onLineup.length + add.length - slotCount) };
}
