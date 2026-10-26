// The agent number (docs/agent.md): a second WhatsApp account that talks ONLY to the curator's own number.
// Everything here is pure: who it obeys, what a message means, the "reply yes" state machine, and the texts it sends.
// The worker (agent*.ts) does the Firestore and WhatsApp side. The model never writes an answer: it only maps free text to
// one of the intents below, and every fact in a reply comes from data through the formatters in this file.
import { DAY_NAMES, DAY_SHORT, dateInWeek, formatDate, formatTime } from "./week.ts";
import type { Comic, Lineup, Show, SpotRequest, Venue, Weekday } from "./types.ts";

// ---- identity of the second session (it rides on the account's lease; see docs/fleet.md) ----

export const AGENT_SUFFIX = "_agent";
/** Vault / profile id of an account's agent session: `session-{uid}_agent`, `vault/{uid}_agent/`, `vaultKeys/{uid}_agent`. */
export const agentVaultId = (uid: string) => `${uid}${AGENT_SUFFIX}`;
/** Which account (and which of its two sessions) a vault id belongs to. */
export function splitVaultId(id: string): { uid: string; agent: boolean } {
  return id.endsWith(AGENT_SUFFIX) && id.length > AGENT_SUFFIX.length ? { uid: id.slice(0, -AGENT_SUFFIX.length), agent: true } : { uid: id, agent: false };
}

// ---- limits ----

/** A change the agent proposed is only done if you reply yes within this long. */
export const AGENT_CONFIRM_TTL_MS = 10 * 60_000;
/** Messages the agent starts on its own (notices, digest) per rolling hour; replies to you have a separate, higher cap. */
export const AGENT_UNPROMPTED_PER_HOUR = 12;
export const AGENT_REPLIES_PER_HOUR = 60;
/** New-request / notice batching: send after this much quiet, but never hold something longer than the max. */
export const AGENT_BATCH_QUIET_MS = 45_000;
export const AGENT_BATCH_MAX_MS = 5 * 60_000;

/** Rolling-window rate limit. `sent` is the timestamps of earlier sends; returns whether one more is allowed and the pruned list. */
export function rateCheck(sent: number[], now: number, max: number, windowMs = 3_600_000): { ok: boolean; sent: number[] } {
  const kept = sent.filter((t) => now - t < windowMs);
  return { ok: kept.length < max, sent: kept };
}

// ---- who it obeys ----

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Is this message from the curator's own number? `from` is the WhatsApp id it arrived from. A phone-based id (`@c.us`) is compared
 * directly; a `@lid` id only counts when the worker resolved it to the phone number it belongs to (`resolvedPhone`). Groups,
 * broadcasts and status updates never count. With no known curator phone nothing counts.
 */
export function senderIsCurator(o: { from: string; resolvedPhone?: string | null; curatorPhone?: string | null; fromMe?: boolean }): boolean {
  if (o.fromMe) return false;
  const phone = digits(o.curatorPhone ?? "");
  if (phone.length < 6) return false;
  const from = o.from ?? "";
  if (from.endsWith("@g.us") || from.includes("broadcast") || from.endsWith("@newsletter")) return false;
  if (from.endsWith("@c.us")) return digits(from.split("@")[0]) === phone;
  if (from.endsWith("@lid")) return o.resolvedPhone ? digits(o.resolvedPhone.split("@")[0]) === phone : false;
  return false;
}

/** "+91 98•••12": enough to recognise a number in a confirmation, not enough to copy it. */
export function maskPhone(phone: string | null | undefined): string {
  const d = digits(phone ?? "");
  if (d.length < 8) return d ? `+${d}` : "";
  if (d.length >= 11) {
    const nat = d.slice(-10);
    return `+${d.slice(0, d.length - 10)} ${nat.slice(0, 2)}•••${nat.slice(-2)}`;
  }
  return `+${d.slice(0, 2)}•••${d.slice(-2)}`;
}

// ---- yes / no (strict: these gate real changes) ----

const YES = /^(yes|y|yeah|yep|yup|ya|ok|okay|sure|confirm|confirmed|do it|go ahead|go for it|please do|haan|ha|han)\b[\s.!,]*(please|pls|thanks|thank you)?[\s.!]*$/;
const NO = /^(no|n|nope|nah|cancel|stop|dont|don't|do not|never mind|nevermind|leave it|nahi|nahin|no thanks)\b[\s.!,]*$/;

export function strictYes(text: string): boolean {
  return YES.test(text.toLowerCase().trim());
}
export function strictNo(text: string): boolean {
  return NO.test(text.toLowerCase().trim());
}

/**
 * A reply to "Did Monday Mic happen?": yes or no, or the plain facts ("it happened", "didn't happen"). Deliberately narrow: this runs
 * on any short message while a mic check is open, so "no one asked for Tuesday" must not count as a no.
 */
export function micAnswer(text: string): boolean | null {
  const t = text.toLowerCase().trim().replace(/[.!\s]+$/g, "");
  if (strictYes(t) || /^(it |the show |the mic )?(happened|did happen|went well|went ahead|was great)$/.test(t)) return true;
  if (strictNo(t) || /^(it |the show |the mic )?(didn'?t happen|did not happen|never happened|not happened|was cancell?ed|was canned|got cancell?ed|got canned)$/.test(t)) return false;
  return null;
}

// ---- time and day words ----

/** "9 PM", "9:30pm", "21:00", "9" (a show time with no am/pm is taken as evening) → "HH:MM". Null when it isn't a time. */
export function parseClock(text: string): string | null {
  const m = text.toLowerCase().trim().match(/^(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[3]?.[0];
  if (min > 59 || h > 24) return null;
  if (suffix === "p" && h < 12) h += 12;
  else if (suffix === "a" && h === 12) h = 0;
  else if (!suffix && !m[2] && h >= 1 && h <= 11) h += 12; // "9" alone: a show, so evening
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const WEEKDAY_WORDS: Record<string, Weekday> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

// ---- intents ----

export type AgentIntentName =
  | "lineup" | "waiting" | "pending_confirm" | "asked" | "last_performed" | "help"
  | "add" | "remove" | "confirm" | "outcome" | "retime"
  | "unknown";

export const QUESTION_INTENTS: readonly AgentIntentName[] = ["lineup", "waiting", "pending_confirm", "asked", "last_performed", "help"];
export const ACTION_INTENTS: readonly AgentIntentName[] = ["add", "remove", "confirm", "outcome", "retime"];
export const INTENT_NAMES: readonly AgentIntentName[] = [...QUESTION_INTENTS, ...ACTION_INTENTS, "unknown"];

export interface AgentIntent {
  name: AgentIntentName;
  /** The day / show the message points at, in the curator's words ("monday", "bloom thursday"). */
  day?: string;
  /** A comic's name, in the curator's words. */
  person?: string;
  /** retime: the new time, as HH:MM. */
  time?: string;
  /** outcome: did it happen. */
  happened?: boolean;
}

const strip = (t: string) => t.trim().replace(/[?!.\s]+$/g, "").replace(/\s+/g, " ");

/**
 * The obvious phrasings, matched without a model (instant, and works when the AI is down). Returns null when it isn't one of
 * them: the worker then asks the model to map the text to an intent (still never to an answer).
 */
export function parseIntentByRules(raw: string): AgentIntent | null {
  const t = strip(raw);
  const l = t.toLowerCase();
  if (!l) return null;
  let m: RegExpMatchArray | null;

  if (/^(help|\?|menu|commands|what can you do|what do you do|hi|hello|hey)$/.test(l)) return { name: "help" };
  if (/\bwho(?:'s| is| are| all)?\s+waiting\b|\bwaiting list\b|\bwaitlist\b|^waiting$/.test(l)) return { name: "waiting" };
  if (/what(?:'s| is)?\s+(?:is\s+)?left to confirm|what(?:'s| is)?\s+(?:still\s+)?(?:un|not\s)confirmed|\bunconfirmed\b|what needs confirm|what do i (?:still )?need to confirm/.test(l)) return { name: "pending_confirm" };

  if ((m = l.match(/^who (?:has |have )?(?:asked|requested|wants|want|messaged|dm'?d|is asking|is requesting)\s*(?:for\s+)?(.+)$/))) return { name: "asked", day: m[1] };
  if ((m = l.match(/^(?:when|what day) did (.+?) (?:last )?(?:perform|play|do a (?:spot|show|set)|go on|get a spot|have a spot|do)(?: here)?$/))) return { name: "last_performed", person: m[1] };
  if ((m = l.match(/^(.+?)(?:'s| s) last (?:spot|show|set|gig|performance)$/))) return { name: "last_performed", person: m[1] };

  if ((m = l.match(/^(?:mark|set)\s+(.+?)\s+(?:as\s+)?(did ?n'?t happen|did not happen|not happened|cancelled|canceled|canned|called off|happened|did happen)$/)) || (m = l.match(/^(.+?)\s+(did ?n'?t happen|did not happen|was cancelled|was canceled|was canned|happened|did happen)$/))) {
    const neg = /n'?t|not|cancel|cann|called off/.test(m[2]);
    return { name: "outcome", day: m[1].replace(/^the\s+/, ""), happened: !neg };
  }
  if ((m = l.match(/^(?:please )?(?:confirm|send confirmations? (?:for|to)|send out)\s+(.+)$/))) return { name: "confirm", day: m[1].replace(/^(?:the|for)\s+/, "") };
  if ((m = l.match(/^(?:please )?(?:add|put|place|book)\s+(.+?)\s+(?:to|on|in|for|into)\s+(.+)$/))) return { name: "add", person: m[1], day: m[2].replace(/^the\s+/, "") };
  if ((m = l.match(/^(?:please )?(?:remove|drop|take|pull)\s+(.+?)\s+(?:from|off|out of)\s+(.+)$/))) return { name: "remove", person: m[1], day: m[2].replace(/^the\s+/, "") };

  // "Bloom moved Thursday to 9 PM", "thursday starts at 9", "move thursday to 9:30pm"
  if ((m = l.match(/^(?:please )?(?:move|shift|push|change)\s+(.+?)\s+(?:to|at)\s+(.+)$/)) || (m = l.match(/^(.+?)\s+(?:moved|shifted|pushed|changed|now starts?|starts?)\s*(.*?)\s*(?:to|at)\s+(.+)$/))) {
    const timeText = m[m.length - 1];
    const time = parseClock(timeText);
    const target = m.length === 3 ? m[1] : `${m[1]} ${m[2]}`.trim();
    if (time && target) return { name: "retime", day: target, time };
  }

  // "Monday lineup", "lineup for monday", "lineup", "who's on monday", "who is on tuesday"
  if ((m = l.match(/^(?:what(?:'s| is) )?(?:the )?(.+?)\s+line ?up$/)) || (m = l.match(/^line ?up(?:\s+(?:for|of|on))?\s*(.*)$/)) || (m = l.match(/^who(?:'s| is| are)?\s+(?:on|playing|performing|in)\s+(?:the\s+)?(.+)$/))) {
    return { name: "lineup", day: (m[1] ?? "").replace(/^the\s+/, "").trim() || undefined };
  }
  return null;
}

/** The JSON the model fills in for free text. It extracts; it never answers. */
export const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...INTENT_NAMES] },
    day: { type: "string" },
    person: { type: "string" },
    time: { type: "string" },
    happened: { type: "boolean" },
  },
  required: ["intent", "day", "person", "time", "happened"],
};

/** Checks whatever the model returned and turns it into an intent; anything off becomes "unknown". */
export function normalizeRawIntent(raw: unknown): AgentIntent {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim());
    } catch {
      return { name: "unknown" };
    }
  }
  if (!v || typeof v !== "object") return { name: "unknown" };
  const o = v as Record<string, unknown>;
  const name = INTENT_NAMES.find((n) => n === o.intent);
  if (!name || name === "unknown") return { name: "unknown" };
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 80) : undefined);
  const out: AgentIntent = { name };
  const day = s(o.day);
  const person = s(o.person);
  if (day) out.day = day;
  if (person) out.person = person;
  if (name === "retime") {
    const time = typeof o.time === "string" ? parseClock(o.time) : null;
    if (!time || !day) return { name: "unknown" };
    out.time = time;
  }
  if (name === "outcome") {
    if (typeof o.happened !== "boolean" || !day) return { name: "unknown" };
    out.happened = o.happened;
  }
  if ((name === "add" || name === "remove") && (!person || !day)) return { name: "unknown" };
  if (name === "confirm" && !day) return { name: "unknown" };
  if (name === "last_performed" && !person) return { name: "unknown" };
  if (name === "asked" && !day) return { name: "unknown" };
  return out;
}

export function intentPrompt(text: string, shows: { name: string; weekday: Weekday; venue?: string }[]) {
  const showLines = shows.length ? shows.map((s) => `- ${s.name} (${DAY_NAMES[s.weekday]}${s.venue ? `, ${s.venue}` : ""})`).join("\n") : "- (no shows)";
  return `You turn one WhatsApp message from a comedy-show curator to their assistant into JSON. Do NOT answer it. Only pick what they mean.

intent is one of:
- lineup: who is on a show ("Monday lineup?", "who's on Tuesday")
- waiting: who is waiting for a spot this week
- pending_confirm: which shows are not confirmed yet
- asked: who asked for a show or day ("who asked for Tuesday?")
- last_performed: when a comic last performed ("when did Rohan last perform?")
- add: put a comic on a show ("add Rohan to Tuesday")
- remove: take a comic off a show
- confirm: send the confirmations for a show
- outcome: say a show happened or did not happen
- retime: a show's start time changed ("Bloom moved Thursday to 9 PM")
- help: asks what you can do
- unknown: anything else

Fields: day = the day or show they point at, in their own words (empty if none); person = a comic's name (empty if none); time = a clock time like "9 PM" (empty if none); happened = true or false for outcome, else false.

Their shows:
${showLines}

Message: """${text.slice(0, 400)}"""`;
}

// ---- resolving words to shows and people ----

type ShowLike = Pick<Show, "id" | "name" | "weekday" | "venueId"> & Partial<Pick<Show, "active" | "startTime" | "slotCount">>;

export type ShowMatch<S extends ShowLike> = { kind: "ok"; show: S } | { kind: "ambiguous"; shows: S[] } | { kind: "none" };

/**
 * "monday", "bloom thursday", "tomorrow", "the mic": which show. Day words and name words both count; the shows that
 * match the most win. Several winners means the curator has to choose.
 */
export function resolveShow<S extends ShowLike>(text: string | undefined, shows: S[], venues: Pick<Venue, "id" | "name" | "aliases">[], todayWeekday: Weekday): ShowMatch<S> {
  const active = shows.filter((s) => s.active !== false);
  const t = norm(text ?? "");
  if (!t) return active.length === 1 ? { kind: "ok", show: active[0] } : active.length ? { kind: "ambiguous", shows: active } : { kind: "none" };
  const words = t.split(" ");
  const days = new Set<Weekday>();
  for (const w of words) if (w in WEEKDAY_WORDS) days.add(WEEKDAY_WORDS[w]);
  if (words.includes("today")) days.add(todayWeekday);
  if (words.includes("tomorrow")) days.add(((todayWeekday + 1) % 7) as Weekday);
  const GENERIC = new Set(["show", "mic", "open", "night", "the", "a", "for", "on", "of", "today", "tomorrow", "lineup", "line", "up"]);
  const scored = active.map((s) => {
    let score = 0;
    if (days.has(s.weekday)) score += 2;
    const names = [norm(s.name), ...(venues.find((v) => v.id === s.venueId) ? [norm(venues.find((v) => v.id === s.venueId)!.name), ...(venues.find((v) => v.id === s.venueId)!.aliases ?? []).map(norm)] : [])];
    for (const n of names) {
      if (n && t.includes(n)) score += 3;
      else for (const nw of n.split(" ")) if (nw.length >= 3 && !GENERIC.has(nw) && words.includes(nw)) score += 1;
    }
    return { s, score };
  });
  // A day word that matches no show is a "none", not a guess.
  const best = Math.max(0, ...scored.map((x) => x.score));
  if (best === 0) return { kind: "none" };
  const top = scored.filter((x) => x.score === best).map((x) => x.s);
  return top.length === 1 ? { kind: "ok", show: top[0] } : { kind: "ambiguous", shows: top };
}

export interface PersonRef {
  id: string;
  name: string;
  phone: string;
}

/** Everyone whose name fits `query`, best fit first (at most `limit`). Exact beats first-name beats part-of-name. */
export function matchPeople<P extends PersonRef>(query: string, people: P[], limit = 6): P[] {
  const q = norm(query);
  if (!q) return [];
  const qd = digits(query);
  if (qd.length >= 6) {
    const byPhone = people.filter((p) => digits(p.phone).endsWith(qd) || digits(p.id.split("@")[0]).endsWith(qd));
    if (byPhone.length) return byPhone.slice(0, limit);
  }
  const qt = q.split(" ");
  const scored = people.map((p) => {
    const n = norm(p.name);
    const nt = n.split(" ");
    let score = 0;
    if (n === q) score = 100;
    else if (qt.every((w) => nt.some((x) => x === w))) score = 85;
    else if (qt.every((w) => nt.some((x) => x.startsWith(w)))) score = 70;
    else if (n.startsWith(q)) score = 60;
    else if (n.includes(q)) score = 40;
    return { p, score };
  });
  const best = Math.max(0, ...scored.map((x) => x.score));
  if (!best) return [];
  return scored.filter((x) => x.score === best).map((x) => x.p).slice(0, limit);
}

// ---- plans, and the "reply yes" state machine ----

export type ActionPlan =
  | { type: "add"; showId: string; comicId: string; comicName: string; phone: string }
  | { type: "remove"; showId: string; comicId: string; comicName: string; phone: string }
  | { type: "confirm"; showId: string; lineupId: string }
  | { type: "outcome"; showId: string; lineupId: string; outcome: "happened" | "canned" }
  | { type: "retime"; showId: string; startTime: string }
  /** Asked by the day-after cleanup: yes clears the group, no keeps everyone for next week. */
  | { type: "cleanup"; showId: string; lineupId: string };

export type PendingAction =
  | { stage: "confirm"; plan: ActionPlan; summary: string; createdAt: number; expiresAt: number }
  | { stage: "choose"; choices: { label: string; plan: ActionPlan; summary: string }[]; prompt: string; createdAt: number; expiresAt: number };

export const confirmPending = (plan: ActionPlan, summary: string, now: number): PendingAction => ({ stage: "confirm", plan, summary, createdAt: now, expiresAt: now + AGENT_CONFIRM_TTL_MS });
export const choosePending = (prompt: string, choices: { label: string; plan: ActionPlan; summary: string }[], now: number): PendingAction => ({ stage: "choose", choices, prompt, createdAt: now, expiresAt: now + AGENT_CONFIRM_TTL_MS });

/** "Reply yes", or a numbered list. */
export const askText = (p: PendingAction): string =>
  p.stage === "confirm" ? `${p.summary}\nReply *yes* to do it, or *no* to cancel. (Open for 10 minutes.)` : `${p.prompt}\n${p.choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n")}\nReply with a number, or *no* to cancel.`;

export type StepResult =
  | { type: "none" }
  | { type: "expired" }
  | { type: "execute"; plan: ActionPlan }
  | { type: "chosen"; pending: PendingAction }
  | { type: "reprompt"; text: string }
  | { type: "cancel" }
  | { type: "drop" };

/**
 * What the curator's next message does to what's waiting for an answer:
 * yes runs the change; a number picks from a list (and then asks for yes); no cancels; late answers do nothing;
 * anything else is a new request (the old one is dropped, never run).
 */
export function stepPending(pending: PendingAction | null | undefined, text: string, now: number): StepResult {
  if (!pending) return { type: "none" };
  if (now > pending.expiresAt) return { type: "expired" };
  const t = text.trim();
  if (pending.stage === "confirm") {
    if (strictYes(t)) return { type: "execute", plan: pending.plan };
    if (strictNo(t)) return { type: "cancel" };
    return { type: "drop" };
  }
  if (strictNo(t)) return { type: "cancel" };
  const m = t.match(/^(?:no\.?\s*)?(\d{1,2})[.)]?$/);
  if (m) {
    const c = pending.choices[Number(m[1]) - 1];
    if (!c) return { type: "reprompt", text: `Pick a number from 1 to ${pending.choices.length}, or reply *no* to cancel.` };
    return { type: "chosen", pending: confirmPending(c.plan, c.summary, now) };
  }
  return { type: "drop" };
}

export interface PlanWorld {
  shows: Show[];
  venues: Pick<Venue, "id" | "name" | "aliases">[];
  week: string;
  todayWeekday: Weekday;
  lineups: (Pick<Lineup, "showId" | "slots" | "status"> & Partial<Pick<Lineup, "id" | "sent" | "outcome">>)[];
}
export type PlanPerson = PersonRef & { banned?: boolean };
export interface Planned {
  /** Said to the curator instead of asking (nothing to do, or couldn't find it). */
  reply?: string;
  /** Waiting for a yes (or a number). */
  pending?: PendingAction;
}

/**
 * What the curator asked for, resolved against their data and turned into what the agent repeats back. Pure: nothing is written, and
 * every refusal ("already on it", "full", "not confirmed") happens here, before it ever asks for a yes. Several matches (two shows
 * on one day, two people with one first name) become a numbered list covering every combination.
 */
export function planAction(intent: AgentIntent, w: PlanWorld, people: PlanPerson[], o: { primaryReady: boolean; now: number }): Planned {
  if (!w.shows.length) return { reply: "You don't have any active shows yet." };
  const m = resolveShow(intent.day, w.shows, w.venues, w.todayWeekday);
  if (m.kind === "none") return { reply: `I couldn't match "${intent.day}" to one of your shows. Your shows: ${w.shows.map((s) => `${s.name} (${DAY_NAMES[s.weekday]})`).join(", ")}.` };
  const candidates = m.kind === "ok" ? [m.show] : m.shows;
  const lineupOf = (s: Show) => w.lineups.find((l) => l.showId === s.id);
  const choices: { label: string; plan: ActionPlan; summary: string }[] = [];
  const fail: string[] = [];
  const ctx = (s: Show, extra: Partial<Parameters<typeof describePlan>[1]> = {}) => ({ show: s, week: w.week, ...extra });

  if (intent.name === "add" || intent.name === "remove") {
    const found = matchPeople(intent.person ?? "", people);
    if (!found.length) return { reply: `I couldn't find anyone called "${intent.person}".` };
    for (const s of candidates) {
      const l = lineupOf(s);
      for (const p of found) {
        const on = Boolean(l?.slots.some((x) => x.comicId === p.id));
        const label = `${p.name} → ${showLabel(s, w.week)}`;
        const confirmed = l?.status === "confirmed";
        if (intent.name === "add") {
          if (on) fail.push(`${p.name} is already on ${s.name}.`);
          else if (l?.status === "cancelled" || l?.status === "canned") fail.push(`${s.name} is called off this week.`);
          else if ((l?.slots.length ?? 0) >= s.slotCount) fail.push(`${s.name} is full (${s.slotCount} of ${s.slotCount}).`);
          else {
            const plan: ActionPlan = { type: "add", showId: s.id, comicId: p.id, comicName: p.name, phone: p.phone };
            choices.push({ label, plan, summary: describePlan(plan, ctx(s, { alreadyConfirmed: confirmed })) + ((p as PlanPerson).banned ? " They're on your Banned list." : "") });
          }
        } else if (!on) fail.push(`${p.name} isn't on ${s.name}.`);
        else {
          const plan: ActionPlan = { type: "remove", showId: s.id, comicId: p.id, comicName: p.name, phone: p.phone };
          choices.push({ label, plan, summary: describePlan(plan, ctx(s, { alreadyConfirmed: confirmed })) });
        }
      }
    }
  } else if (intent.name === "confirm") {
    for (const s of candidates) {
      const l = lineupOf(s);
      if (!l || !l.slots.length) fail.push(`Nobody is placed on ${s.name} yet.`);
      else if (l.status === "confirmed") fail.push(`${s.name} is already confirmed. If you changed it since, use Send updates in the app.`);
      else if (l.status === "cancelled" || l.status === "canned") fail.push(`${s.name} is called off this week.`);
      else if (!o.primaryReady) fail.push("Your own WhatsApp isn't connected right now, so I can't send confirmations.");
      else {
        // Same rule as the Confirm button: people you already told by hand are skipped.
        const told = new Set(Object.keys(l.sent ?? {}));
        const already = l.slots.filter((x) => told.has(x.comicId)).length;
        const plan: ActionPlan = { type: "confirm", showId: s.id, lineupId: l.id ?? "" };
        choices.push({ label: showLabel(s, w.week), plan, summary: describePlan(plan, ctx(s, { filled: l.slots.length - already, told: already })) });
      }
    }
  } else if (intent.name === "outcome") {
    for (const s of candidates) {
      const l = lineupOf(s);
      const outcome = intent.happened ? "happened" : "canned";
      if (!l || l.status !== "confirmed") fail.push(`${s.name} isn't confirmed, so there's nothing to mark.`);
      else if (l.outcome === outcome) fail.push(`${s.name} is already marked that way.`);
      else {
        const plan: ActionPlan = { type: "outcome", showId: s.id, lineupId: l.id ?? "", outcome };
        choices.push({ label: showLabel(s, w.week), plan, summary: describePlan(plan, ctx(s)) });
      }
    }
  } else if (intent.name === "retime" && intent.time) {
    for (const s of candidates) {
      if (s.startTime === intent.time) fail.push(`${s.name} already starts at that time.`);
      else {
        const plan: ActionPlan = { type: "retime", showId: s.id, startTime: intent.time };
        choices.push({ label: showLabel(s, w.week), plan, summary: describePlan(plan, ctx(s)) });
      }
    }
  }

  if (!choices.length) return { reply: [...new Set(fail)].join("\n") || "I couldn't work that out." };
  if (choices.length === 1) return { pending: confirmPending(choices[0].plan, choices[0].summary, o.now) };
  if (choices.length > 6) return { reply: "That matches too many things. Say which show and which person, for example: add Rohan Mehta to Monday." };
  return { pending: choosePending("Which one did you mean?", choices, o.now) };
}

// ---- views the formatters read (plain data, so tests need no Firestore) ----

export interface ShowDay {
  showId: string;
  showName: string;
  weekday: Weekday;
  date: string;
  time: string;
  slotCount: number;
  status: Lineup["status"] | "none";
  /** Names in slot order. */
  names: string[];
}

export function showDay(show: Pick<Show, "id" | "name" | "weekday" | "startTime" | "slotCount">, week: string, lineup: Pick<Lineup, "slots" | "status"> | undefined, nameOf: (comicId: string) => string): ShowDay {
  return {
    showId: show.id,
    showName: show.name,
    weekday: show.weekday,
    date: dateInWeek(week, show.weekday),
    time: show.startTime,
    slotCount: show.slotCount,
    status: lineup?.status ?? "none",
    names: (lineup?.slots ?? []).map((s) => nameOf(s.comicId)),
  };
}

const STATUS_WORD: Record<ShowDay["status"], string> = { none: "not started", draft: "not confirmed yet", confirmed: "confirmed", cancelled: "called off", canned: "didn't happen" };
const head = (d: ShowDay) => `*${d.showName}*, ${DAY_SHORT[d.weekday]} ${formatDate(d.date)} · ${formatTime(d.time)}`;

export function formatLineup(d: ShowDay): string {
  if (d.status === "cancelled" || d.status === "canned") return `${head(d)}\n${STATUS_WORD[d.status]}.`;
  const list = d.names.length ? d.names.map((n, i) => `${i + 1}. ${n}`).join("\n") : "Nobody yet.";
  return `${head(d)} (${STATUS_WORD[d.status]}, ${d.names.length} of ${d.slotCount})\n${list}`;
}

export function formatPendingConfirm(days: ShowDay[]): string {
  const open = days.filter((d) => d.status === "draft" || d.status === "none");
  if (!open.length) return "Everything this week is confirmed or called off.";
  return `Not confirmed yet:\n${open.map((d) => `• ${d.showName}, ${DAY_SHORT[d.weekday]} ${formatDate(d.date)}: ${d.names.length ? `${d.names.length} of ${d.slotCount} placed` : "nobody placed"}`).join("\n")}`;
}

export interface WaitingPerson {
  name: string;
  /** What they asked for, e.g. "Mon, Tue". */
  days?: string;
}

export function formatWaiting(waiting: WaitingPerson[], max = 12): string {
  if (!waiting.length) return "Nobody is waiting this week.";
  const shown = waiting.slice(0, max).map((w) => `• ${w.name}${w.days ? ` (${w.days})` : ""}`);
  const more = waiting.length > max ? `\n…and ${waiting.length - max} more.` : "";
  return `${waiting.length} waiting this week:\n${shown.join("\n")}${more}`;
}

export function formatAsked(label: string, people: WaitingPerson[], max = 12): string {
  if (!people.length) return `Nobody asked for ${label} this week.`;
  const shown = people.slice(0, max).map((w) => `• ${w.name}`);
  return `${people.length} asked for ${label}:\n${shown.join("\n")}${people.length > max ? `\n…and ${people.length - max} more.` : ""}`;
}

export function formatLastPerformed(name: string, last: { showName: string; date: string } | null, today: string): string {
  if (!last) return `${name} hasn't performed here yet.`;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last.date}T00:00:00Z`)) / 86_400_000);
  return `${name} last performed on ${formatDate(last.date)} (${days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`}) at ${last.showName}.`;
}

export const HELP_TEXT = `I can tell you and do things for you here.

*Ask me*
• Monday lineup?
• Who's waiting?
• What's left to confirm?
• Who asked for Tuesday?
• When did Rohan last perform?

*Tell me* (I'll repeat it back and wait for your yes)
• Add Rohan to Tuesday
• Remove Rohan from Monday
• Confirm Monday
• Mark Monday happened (or didn't happen)
• Bloom moved Thursday to 9 PM`;

/** "Which one?" lists for ambiguous shows and people. */
export const showLabel = (s: Pick<Show, "name" | "weekday" | "startTime">, week: string) => `${s.name}, ${DAY_SHORT[s.weekday]} ${formatDate(dateInWeek(week, s.weekday))} · ${formatTime(s.startTime)}`;
export const personLabel = (p: PersonRef) => `${p.name} (${maskPhone(p.phone || p.id.split("@")[0])})`;

/** The sentence the curator replies yes to. Built from resolved data only. */
export function describePlan(plan: ActionPlan, c: { show: Pick<Show, "name" | "weekday" | "startTime" | "slotCount">; week: string; told?: number; filled?: number; alreadyConfirmed?: boolean; oldTime?: string }): string {
  const when = `${c.show.name}, ${DAY_SHORT[c.show.weekday]} ${formatDate(dateInWeek(c.week, c.show.weekday))}`;
  switch (plan.type) {
    case "add":
      return `Add ${plan.comicName} (${maskPhone(plan.phone || plan.comicId.split("@")[0])}) to ${when}?${c.alreadyConfirmed ? " It's already confirmed, so they won't be told until you send updates in the app." : ""}`;
    case "remove":
      return `Remove ${plan.comicName} (${maskPhone(plan.phone || plan.comicId.split("@")[0])}) from ${when}?${c.alreadyConfirmed ? " It's already confirmed; they won't be told until you send updates in the app." : ""}`;
    case "confirm":
      return `Send confirmations for ${when} to ${c.filled ?? 0} ${c.filled === 1 ? "person" : "people"}${c.told ? ` (${c.told} already told, skipped)` : ""} from your own WhatsApp?`;
    case "outcome":
      return plan.outcome === "happened" ? `Mark ${when} as happened?` : `Mark ${when} as didn't happen? Everyone on it loses that spot from their history.`;
    case "cleanup":
      return `Clear the ${c.show.name} group for next week? POCs, regulars, co-hosts and admins stay.`;
    case "retime":
      return `Change ${c.show.name} (${DAY_NAMES[c.show.weekday]}) from ${c.oldTime ? formatTime(c.oldTime) : formatTime(c.show.startTime)} to ${formatTime(plan.startTime)}? Comics already confirmed won't be told automatically.`;
  }
}

// ---- notices and the digest ----

export interface NotifyItem {
  kind: "mic" | "request" | "followup" | "notice" | "warn";
  text: string;
}

/** Several things that happened close together become one message. New requests are counted, not listed one by one. */
export function composeNotifyBatch(items: NotifyItem[]): string | null {
  if (!items.length) return null;
  const lines: string[] = [];
  const reqs = items.filter((i) => i.kind === "request");
  if (reqs.length) {
    const names = reqs.map((r) => r.text);
    const shown = names.slice(0, 5).join(", ");
    lines.push(reqs.length === 1 ? `New spot request: ${shown}.` : `${reqs.length} new spot requests: ${shown}${names.length > 5 ? `, +${names.length - 5} more` : ""}.`);
  }
  const fu = items.filter((i) => i.kind === "followup");
  if (fu.length) lines.push(fu.length === 1 ? `Follow-up to check in the app: ${fu[0].text}` : `${fu.length} follow-ups to check in the app: ${fu.map((f) => f.text).join("; ")}`);
  for (const i of items) if (i.kind === "notice") lines.push(i.text);
  for (const i of items) if (i.kind === "warn") lines.push(`Heads up: ${i.text}`);
  for (const i of items) if (i.kind === "mic") lines.push(i.text);
  const out = lines.join("\n\n");
  return out.length > 1500 ? `${out.slice(0, 1480)}…` : out;
}

export interface DigestInput {
  /** YYYY-MM-DD in the curator's timezone. */
  today: string;
  todayShows: ShowDay[];
  tomorrowShows: ShowDay[];
  waiting: WaitingPerson[];
  /** Things in the app's Updates tab. */
  updates: number;
  /** Shows later this week that aren't confirmed. */
  unconfirmed: ShowDay[];
}

/** The morning message, or null when there's nothing to say (the agent then stays quiet). */
export function composeDigest(d: DigestInput): string | null {
  const parts: string[] = [];
  for (const s of d.todayShows) {
    if (s.status === "cancelled" || s.status === "canned") continue;
    const list = s.names.length ? s.names.map((n, i) => `${i + 1}. ${n}`).join("\n") : "Nobody placed yet.";
    parts.push(`*Today: ${s.showName}* · ${formatTime(s.time)} (${STATUS_WORD[s.status]}, ${s.names.length} of ${s.slotCount})\n${list}`);
  }
  if (d.waiting.length) parts.push(`*Waiting this week (${d.waiting.length}):* ${d.waiting.slice(0, 6).map((w) => w.name).join(", ")}${d.waiting.length > 6 ? `, +${d.waiting.length - 6} more` : ""}`);
  const needs: string[] = [];
  if (d.updates) needs.push(`${d.updates} ${d.updates === 1 ? "item" : "items"} in Updates`);
  for (const s of d.unconfirmed.slice(0, 3)) needs.push(`${s.showName} (${DAY_SHORT[s.weekday]}) isn't confirmed`);
  if (needs.length) parts.push(`*Needs you:* ${needs.join("; ")}`);
  for (const s of d.tomorrowShows) {
    if (s.status === "cancelled" || s.status === "canned") continue;
    parts.push(`*Tomorrow: ${s.showName}* · ${formatTime(s.time)} (${STATUS_WORD[s.status]}, ${s.names.length} of ${s.slotCount})`);
  }
  return parts.length ? `Good morning. Here's your day.\n\n${parts.join("\n\n")}` : null;
}

/** Digest timing: due once per local day, from the chosen time on, and not at all if it's already more than `maxLateMin` past (a late link or restart must not send "good morning" in the afternoon). */
export function digestDue(o: { now: { date: string; time: string }; digestTime: string; lastDigestOn?: string | null; maxLateMin?: number }): boolean {
  if (o.now.time < o.digestTime || o.lastDigestOn === o.now.date) return false;
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return mins(o.now.time) - mins(o.digestTime) <= (o.maxLateMin ?? 240);
}

/** The first week-days a request asks for, for "Rohan (Mon, Tue)". */
export function requestDays(r: Pick<SpotRequest, "intent">): string | undefined {
  const days = r.intent?.preferredDays ?? [];
  return days.length ? days.map((d) => DAY_SHORT[d]).join(", ") : undefined;
}

export type { Comic };
