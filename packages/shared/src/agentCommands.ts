// More of what the curator can tell the agent number (docs/agent.md), kept apart from agent.ts:
//   - offers: "offer Rahul a spot on Monday" (a normal offer, the person is asked), and "add Rahul to Monday directly" /
//     "Rahul already agreed for Monday" (no offer: straight onto the lineup with the confirmation, like the app's "Already agreed");
//   - members (admins only): "who's waiting to join?", "approve Priya", "decline Priya";
//   - the guard: nobody is added to or taken off a past (or backfilled) show from WhatsApp.
// Pure. agent.ts calls into this at run time (the two import each other, but never while loading).
import { DAY_NAMES, dateInWeek, formatDate, formatTime } from "./week.ts";
import { OFFER_POLL_OPTIONS, greetName, messageRich, renderRich } from "./messages.ts";
import { choosePending, confirmPending, describePlan, matchPeople, maskPhone, type ActionPlan, type AgentIntent, type PersonRef, type PlanPerson, type Planned } from "./agent.ts";
import type { Lineup, Settings, Show } from "./types.ts";

// ---------------------------------------------------------------- reading the words

const DAY_TOKEN = /^(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|today|tomorrow)$/;

/** "rahul monday" → person "rahul", day "monday": the day starts at the last day word. Null when there is none. */
function splitPersonDay(rest: string): { person: string; day: string } | null {
  const words = rest.split(" ").filter(Boolean);
  let at = -1;
  words.forEach((w, i) => {
    if (DAY_TOKEN.test(w)) at = i;
  });
  if (at < 1) return null;
  return { person: words.slice(0, at).join(" "), day: words.slice(at).join(" ") };
}

const clean = (s: string) => s.replace(/^the\s+/, "").trim();
/** "Priya's request", "the request from Priya", "priya to join" → "priya". */
const memberName = (s: string) =>
  s
    .replace(/^(?:the\s+)?(?:access\s+|join\s+)?request\s+(?:from|of|for)\s+/, "")
    .replace(/(?:'s| s)?\s+(?:access\s+|join\s+)?request$/, "")
    .replace(/\s+(?:to join|to get in|into nothing bot|in)$/, "")
    .trim();

/**
 * The phrasings for offers and members, matched without a model. `l` is already trimmed and lower-cased (parseRules in agent.ts).
 * Null when it isn't one of them.
 */
export function parseExtraRules(l: string): AgentIntent | null {
  let m: RegExpMatchArray | null;

  // Members (admins). Questions about them are read-only.
  const aboutShows = /\b(?:sun|mon|tue|wed|thu|fri|sat)\w*\b|\b(?:today|tomorrow|mic|show|line ?up|group|spot|slot)s?\b/.test(l);
  if (
    (!aboutShows && /\b(?:waiting|wants?|asked|asking|pending|trying|new)\b.*\b(?:to join|join(?:ing)?|get in|access|membership|approval)\b/.test(l)) ||
    /\b(?:join|access|membership|signup|sign-up) requests?\b|^(?:pending|new|waiting) (?:members?|access|requests?)$|^members? (?:waiting|pending)$/.test(l)
  ) {
    return { name: "members_waiting" };
  }
  if ((m = l.match(/^(?:please )?(?:approve|admit)\s+(.+)$/)) || (m = l.match(/^(?:please )?let\s+(.+?)\s+(?:in|join)$/))) {
    const person = memberName(m[1]!);
    return person ? { name: "approve_member", person } : null;
  }
  if ((m = l.match(/^(?:please )?(?:decline|reject|deny)\s+(.+)$/))) {
    const person = memberName(m[1]!);
    return person ? { name: "decline_member", person } : null;
  }

  // Direct adds: no offer, they go straight on the lineup (and get your confirmation).
  if ((m = l.match(/^(?:please )?(?:add|put|place|book)\s+(.+?)\s+(?:to|on|in|into|for)\s+(.+?)\s+(?:directly|straight(?: away| on)?|right away|without (?:an )?offer)$/)) || (m = l.match(/^(?:please )?(?:add|put|place|book)\s+(.+?)\s+directly\s+(?:to|on|in|into|for)\s+(.+)$/))) {
    return { name: "offer", person: m[1], day: clean(m[2]!), direct: true };
  }
  if ((m = l.match(/^(?!(?:mark|set|add|remove|confirm|put|place|book)\b)(.+?)\s+(?:has |have |had |is )?(?:already )?(?:agreed|said yes)\s+(?:to |for |on |in )?(.+)$/))) {
    return { name: "offer", person: m[1], day: clean(m[2]!), direct: true };
  }

  // Offers: the person is asked and added when they say yes.
  if (
    (m = l.match(/^(?:please )?offer\s+(.+?)\s+(?:an? |the )?(?:open |ad ?hoc |last[ -]minute )?(?:spot|slot|set)\s+(?:on|for|in|at)\s+(.+)$/)) ||
    (m = l.match(/^(?:please )?give\s+(.+?)\s+(?:an? |the )(?:open |ad ?hoc |last[ -]minute )?(?:spot|slot|set)\s+(?:on|for|in|at)\s+(.+)$/)) ||
    (m = l.match(/^(?:please )?(?:give|offer)\s+(.+?)\s+(?:an? )?ad ?hoc(?:\s+(?:spot|slot|set))?\s+(?:on|for|in|at)\s+(.+)$/)) ||
    (m = l.match(/^(?:please )?offer\s+(.+?)\s+(?:on|for)\s+(.+)$/))
  ) {
    return { name: "offer", person: m[1], day: clean(m[2]!), direct: false };
  }
  if ((m = l.match(/^(?:please )?offer\s+(?:the\s+)?(.+?)\s+(?:spot|slot)\s+to\s+(.+)$/))) return { name: "offer", person: m[2], day: clean(m[1]!), direct: false };
  if ((m = l.match(/^(?:please )?(?:give|offer)\s+(.+?)\s+(?:as\s+)?(?:an?\s+)?ad ?hoc(?:\s+(?:spot|slot|set))?$/))) {
    const s = splitPersonDay(m[1]!);
    if (s) return { name: "offer", person: s.person, day: s.day, direct: false };
  }
  return null;
}

// ---------------------------------------------------------------- the past-show guard

/**
 * Why a past or backfilled show can't be changed from WhatsApp, or null when it can. A show whose date has passed (or that was
 * recorded afterwards) is history: who performed is fixed in the app with "Record who performed", never by chat.
 */
export function pastShowReason(o: { showName: string; date: string; backfilled?: boolean; today?: string; what: "add" | "remove" | "offer" }): string | null {
  const past = Boolean(o.backfilled) || (o.today !== undefined && o.date < o.today);
  if (!past) return null;
  const doing = o.what === "add" ? "add anyone to it" : o.what === "remove" ? "take anyone off it" : "offer it to anyone";
  return `${o.showName} on ${formatDate(o.date)} is a past show, so I won't ${doing}. To fix who performed, use *Record who performed* in the app.`;
}

// ---------------------------------------------------------------- offers

export interface OfferCtx {
  show: Show;
  person: PlanPerson;
  lineup?: Pick<Lineup, "slots" | "status"> & Partial<Pick<Lineup, "date" | "backfilled">>;
  /** Every lineup of the week, to warn when they're already on another show. */
  lineups: (Pick<Lineup, "showId" | "slots" | "status">)[];
  shows: Pick<Show, "id" | "name">[];
  week: string;
  today?: string;
  direct: boolean;
  primaryReady: boolean;
}

/** One show and one person for an offer: either why not, or the plan and the sentence the curator replies yes to. */
export function planOfferFor(c: OfferCtx): { fail: string } | { plan: ActionPlan; summary: string } {
  const { show: s, person: p } = c;
  const date = c.lineup?.date ?? dateInWeek(c.week, s.weekday);
  const past = pastShowReason({ showName: s.name, date, backfilled: c.lineup?.backfilled, today: c.today, what: c.direct ? "add" : "offer" });
  if (past) return { fail: past };
  if (c.lineup?.status === "cancelled" || c.lineup?.status === "canned") return { fail: `${s.name} is called off this week.` };
  const filled = c.lineup?.slots.length ?? 0;
  if (c.lineup?.slots.some((x) => x.comicId === p.id)) return { fail: `${p.name} is already on ${s.name}.` };
  if (!c.primaryReady) return { fail: `Your own WhatsApp isn't connected right now, so I can't message ${greetName(p.name)}.` };
  if (!c.direct && p.banned) return { fail: `${p.name} is on your Banned list, so I won't offer them a spot.` };
  if (!c.direct && filled >= s.slotCount) return { fail: `${s.name} is full (${filled} of ${s.slotCount}). If ${greetName(p.name)} already agreed, say "add ${greetName(p.name).toLowerCase()} to ${DAY_NAMES[s.weekday].toLowerCase()} directly".` };

  const notes: string[] = [];
  if (c.direct && filled >= s.slotCount) notes.push(`${s.name} has ${s.slotCount} ${s.slotCount === 1 ? "spot" : "spots"} and ${filled} ${filled === 1 ? "is" : "are"} filled, so this puts it ${filled + 1 - s.slotCount} over.`);
  const other = c.lineups.filter((l) => l.showId !== s.id && l.status !== "cancelled" && l.status !== "canned" && l.slots.some((x) => x.comicId === p.id)).map((l) => c.shows.find((x) => x.id === l.showId)?.name).filter(Boolean);
  if (other.length) notes.push(`${greetName(p.name)} is also on ${other.join(" and ")} this week.`);
  if (c.direct && p.banned) notes.push("They're on your Banned list.");

  const plan: ActionPlan = { type: "offer", showId: s.id, comicId: p.id, comicName: p.name, phone: p.phone, direct: c.direct };
  return { plan, summary: [describePlan(plan, { show: s, week: c.week }), ...notes].join(" ") };
}

/** The offer message for one comic, exactly as the app's offer sheet builds it from the curator's own "Spot offer" template. */
export function offerPayload(settings: Pick<Settings, "messages">, show: Pick<Show, "name" | "weekday" | "startTime">, week: string, venueName: string | undefined, comicName: string): { body: string; rich: { kind: "text" | "poll"; body: string; poll?: { question: string; options: string[]; multi: false } } } {
  const vars = { show: show.name, venue: venueName, day: DAY_NAMES[show.weekday], date: formatDate(dateInWeek(week, show.weekday)), time: formatTime(show.startTime), name: greetName(comicName) };
  const m = renderRich(messageRich(settings, "offer"), vars);
  if (m.kind === "poll" && m.poll) return { body: m.body, rich: { kind: "poll", body: m.body, poll: { question: m.poll.question, options: [...OFFER_POLL_OPTIONS], multi: false } } };
  return { body: m.body, rich: { kind: "text", body: m.body } };
}

export const describeOffer = (plan: Extract<ActionPlan, { type: "offer" }>, when: string): string =>
  plan.direct
    ? `Add ${plan.comicName} (${maskPhone(plan.phone || plan.comicId.split("@")[0])}) to ${when} directly? No offer is sent: they go straight onto the lineup, get your confirmation message and join the show's group.`
    : `Offer ${plan.comicName} (${maskPhone(plan.phone || plan.comicId.split("@")[0])}) the spot on ${when}, from your own WhatsApp? If they say yes they're added and get your confirmation; if it fills up first they're told it's gone.`;

// ---------------------------------------------------------------- members (admins)

export interface AccessRow {
  uid: string;
  name?: string | null;
  email?: string | null;
  status: "pending" | "approved" | "removed";
  requestedAt: number;
}

export const accessName = (r: Pick<AccessRow, "name" | "email">) => (r.name ?? "").trim() || (r.email ?? "").split("@")[0] || "Someone";
const accessLabel = (r: Pick<AccessRow, "name" | "email">) => `${accessName(r)}${r.email ? ` (${r.email})` : ""}`;

export const NOT_ADMIN = "Only admins can approve or decline people. Ask an admin, or an admin can do it on the admin page.";

/** "Waiting to join Nothing BOT:" with each person's name and email, oldest first. */
export function formatMembersWaiting(rows: AccessRow[]): string {
  const pending = rows.filter((r) => r.status === "pending").sort((a, b) => a.requestedAt - b.requestedAt);
  if (!pending.length) return "Nobody is waiting to join.";
  const shown = pending.slice(0, 12).map((r) => `• ${accessLabel(r)}`);
  return `${pending.length} waiting to join:\n${shown.join("\n")}${pending.length > 12 ? `\n…and ${pending.length - 12} more.` : ""}\nReply *approve ${accessName(pending[0]!).split(" ")[0]}* or *decline ${accessName(pending[0]!).split(" ")[0]}*.`;
}

/**
 * "approve Priya" / "decline Priya": who it is, and what happens. Admin only; approving also respects the curator limit (each member
 * gets a WhatsApp session on the server), the same checks as the admin page. Several matches become a numbered list.
 */
export function planMember(intent: AgentIntent, rows: AccessRow[], o: { admin: boolean; approved: number; max: number; now: number }): Planned {
  if (!o.admin) return { reply: NOT_ADMIN };
  const approving = intent.name === "approve_member";
  const people: (PersonRef & { row: AccessRow })[] = rows.map((r) => ({ id: r.uid, name: `${accessName(r)} ${r.email ?? ""}`.trim(), phone: "", row: r }));
  // Waiting people first; only when nobody waiting fits is anyone else considered, so "approve Priya" never picks a member over a request.
  let found = matchPeople(intent.person ?? "", people.filter((p) => p.row.status === "pending"));
  if (!found.length) found = matchPeople(intent.person ?? "", people);
  if (!found.length) return { reply: `I couldn't find anyone called "${intent.person}". Say *who's waiting to join* to see the requests.` };
  const choices: { label: string; plan: ActionPlan; summary: string }[] = [];
  const fail: string[] = [];
  for (const f of found) {
    const r = f.row;
    const who = accessLabel(r);
    if (approving && r.status === "approved") fail.push(`${who} is already a member.`);
    else if (!approving && r.status === "approved") fail.push(`${who} is already a member. To remove a member, use the admin page.`);
    else if (!approving && r.status === "removed") fail.push(`${who} was already declined or removed.`);
    else if (approving && o.approved >= o.max) fail.push(`You're at the limit of ${o.max} curators, so I can't approve ${accessName(r)}. Raise the limit or remove someone on the admin page first.`);
    else {
      const plan: ActionPlan = { type: "member", uid: r.uid, name: accessName(r), email: r.email ?? "", decision: approving ? "approved" : "removed" };
      const extra = approving ? ` They get their own WhatsApp session on the server (${o.approved + 1} of ${o.max} places).${r.status === "removed" ? " They were removed before." : ""}` : " They can't use the apps; you can restore them on the admin page.";
      choices.push({ label: accessLabel(r), plan, summary: `${approving ? "Approve" : "Decline"} ${who}?${extra}` });
    }
  }
  if (!choices.length) return { reply: [...new Set(fail)].join("\n") };
  if (choices.length === 1) return { pending: confirmPending(choices[0]!.plan, choices[0]!.summary, o.now) };
  return { pending: choosePending("Which one did you mean?", choices, o.now) };
}
