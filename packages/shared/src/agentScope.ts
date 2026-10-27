// Which apps an account uses, and so what the agent number does for it:
//   "If a user uses only Curate, the agent only does curation work. Only Comedy, only comedy work. Both, both."
// agentScope reads facts about the account (see ScopeFacts) and is the one place that decides. chooseSide settles, for an account that
// uses both, which side a message belongs to (deterministic cues first; the model only when nothing matches; one short question when
// it could be either). Pure: the worker, the apps' help cards and the tests all share it.
import { COMIC_HELP_TEXT } from "./comicAgent.ts";
import { HELP_TEXT } from "./agent.ts";

export interface AgentScope {
  curate: boolean;
  comedy: boolean;
}
export type Side = "curate" | "comedy";

/** What is known about an account. Each is "does at least one exist". */
export interface ScopeFacts {
  /** users/{uid}/shows, venues or lineups: Curate's own data. */
  shows?: boolean;
  venues?: boolean;
  lineups?: boolean;
  /** A device registered by the Curate app (devices with no app, or app other than "comic"). */
  curateDevice?: boolean;
  /** users/{uid}/rooms: Comedy's own data. */
  rooms?: boolean;
  /** users/{uid}.comicSettings exists (the Comedy app wrote it). */
  comicSettings?: boolean;
  /** A device registered by the Comedy app (app: "comic"). */
  comicDevice?: boolean;
}

/**
 * curate: has shows, venues or lineups, or has signed into the Curate app (a push device). comedy: has rooms, comic settings or has
 * signed into the Comedy app. An account that shows neither (a brand-new one) is treated as Curate: the agent existed there first.
 * Same inference as the admin Members list (functions/src/adminsStore.ts), plus devices.
 */
export function agentScope(f: ScopeFacts): AgentScope {
  const curate = Boolean(f.shows || f.venues || f.lineups || f.curateDevice);
  const comedy = Boolean(f.rooms || f.comicSettings || f.comicDevice);
  return curate || comedy ? { curate, comedy } : { curate: true, comedy: false };
}

export const scopeBoth = (s: AgentScope) => s.curate && s.comedy;

// ---------------------------------------------------------------- the words each side owns

/** Cues that a message is about the comic's own side: rooms, asks to curators, my spots, alerts, regulars. */
const COMEDY_CUES: RegExp[] = [
  /\bmy spots?\b/,
  /\bi(?:'ve| have)? (?:got|have|did|played|got booked|booked)\b.*\b(?:spot|mic|set|open mic|slot)\b/,
  /\b(?:i got|i have|got) a (?:spot|mic|slot)\b/,
  /\bdid i (?:do|play|get)\b/,
  /\bregulars?\b/,
  /\b(?:spot )?alerts?\b/,
  /\bopen spots?\b/,
  /^ask for (?:it|that|this)\b/,
  /^(?:ask|skip|pause|unpause|resume|reopen)\b/,
  /\b(?:closed|paused) (?:this|next) week\b/,
  /\bhow many (?:spots|mics|sets)\b/,
  /\bslot at\b/,
  /\bcurators?\b/,
  /\brooms?\b/,
  /\bnumber\b.*\d{6,}|\d{6,}.*\bnumber\b/,
];
/** Cues that a message is about the curator's side: lineups, requests, confirming, groups, mic checks. */
const CURATE_CUES: RegExp[] = [
  /\bline ?ups?\b/,
  /\bwho(?:'s| is| are| all)? waiting\b|\bwaiting list\b|\bwaitlist\b/,
  /\bconfirm(?:ed|ations?)?\b/,
  /\brequests?\b/,
  /\bmic checks?\b/,
  /\bgroup\b/,
  /\bwho (?:has |have )?(?:asked|requested|wants|messaged)\b/,
  /\blast (?:perform|play)/,
  /\b(?:did ?n'?t|did not|not) happen|\bhappened\b|\bcalled off\b|\bcanned\b/,
  /\b(?:add|put|place|book|remove|drop|pull)\b.+\b(?:to|on|in|into|from|off|out of)\b.+\b(?:mon|tue|wed|thu|fri|sat|sun)/,
  /\bwho(?:'s| is| are)? (?:on|playing|performing)\b/,
];

const hit = (cues: RegExp[], t: string) => cues.some((r) => r.test(t));
const norm = (text: string) => text.toLowerCase().replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();

export type SideCue = Side | "both" | null;
/** Which side's words the message uses. "both" when it uses words of each. */
export function cueSide(text: string): SideCue {
  const t = norm(text);
  const co = hit(COMEDY_CUES, t);
  const cu = hit(CURATE_CUES, t);
  return co && cu ? "both" : co ? "comedy" : cu ? "curate" : null;
}

export type SideChoice = Side | "ask" | "model";

/**
 * For an account that uses both apps: which side owns this message.
 *  - words only one side uses decide it;
 *  - else, if only one side's rules can read it, that side;
 *  - else, if both can (or both sets of words appear), ask once;
 *  - else neither read it: "model" (the model reads it, curate first, then comedy).
 */
export function chooseSide(text: string, reads: { curate: boolean; comedy: boolean }): SideChoice {
  const c = cueSide(text);
  if (c === "curate" || c === "comedy") return c;
  if (c === "both") return reads.curate && !reads.comedy ? "curate" : reads.comedy && !reads.curate ? "comedy" : "ask";
  if (reads.curate && reads.comedy) return "ask";
  if (reads.curate) return "curate";
  if (reads.comedy) return "comedy";
  return "model";
}

export const SIDE_QUESTION = "Your lineup (Curate) or your own spots (Comedy)?\n1. Curate\n2. Comedy\nReply 1 or 2, or *no* to cancel. (Open for 10 minutes.)";
export const SIDE_TTL_MS = 10 * 60_000;

/** A reply to SIDE_QUESTION: 1 / 2, or the word. null when it's something else (a new message). "cancel" for a no. */
export function parseSideChoice(text: string): Side | "cancel" | null {
  const t = norm(text).replace(/[.!)]+$/, "");
  if (/^(?:1|curate|curation|lineup|my lineup|shows?)$/.test(t)) return "curate";
  if (/^(?:2|comedy|comic|spots?|my spots?|rooms?)$/.test(t)) return "comedy";
  if (/^(?:no|n|nope|cancel|never ?mind|stop)$/.test(t)) return "cancel";
  return null;
}

/** The side a pending question was asked on, kept with the question so a "yes" can never be read by the other side. */
export interface SideAsk {
  text: string;
  createdAt: number;
  expiresAt: number;
  pollId?: string;
}

// ---------------------------------------------------------------- per-scope texts

const body = (s: string) => s.replace(/^[^\n]*\n\n/, "");

/** "What can I do": only the apps this account uses. */
export function agentHelpText(scope: AgentScope): string {
  if (scope.curate && scope.comedy) {
    return `I look after both your Curate shows and your Comedy rooms here. Say it either way; if I can't tell which you mean, I'll ask.\n\n*CURATE (your shows)*\n${body(HELP_TEXT)}\n\n*COMEDY (your own spots)*\n${body(COMIC_HELP_TEXT)}`;
  }
  return scope.comedy ? COMIC_HELP_TEXT : HELP_TEXT;
}

export const NOT_USING_COMEDY = "That's a Nothing BOT Comedy thing, and you're not using Comedy yet. Open the Comedy app to set it up. Here's what I can do for your shows:\n\n";
export const NOT_USING_CURATE = "That's a Nothing BOT Curate thing (lineups, requests, confirmations), and you're not using Curate. Here's what I can do for your rooms and spots:\n\n";

/** The lines the apps' help cards show about the other app. */
export const OTHER_APP_NOTE = {
  comedy: "You also use Nothing BOT Curate, so its commands work here too: “Monday lineup?”, “who's waiting?”, “confirm Monday”, “add Rohan to Tuesday”. If a message could mean either, the agent asks.",
  curate: "You also use Nothing BOT Comedy, so its commands work here too: “I got a spot at Banter tonight”, “ask TAG for Monday”, “any open spots now?”, “how many spots this month?”. If a message could mean either, the agent asks.",
} as const;
