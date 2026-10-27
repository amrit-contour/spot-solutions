// Watching the curator's own show groups: a comic on tonight's lineup writes "running late", "can't make it", "reached" in the
// group, and the lineup shows a pill for it. Pure rules, so each step is tested without WhatsApp or a model:
//   1. prefilter: cheap keywords (English + Hinglish) decide whether a message is worth a model call at all;
//   2. parse: the model's JSON (kind, quote, confidence) is checked against the real message;
//   3. eta: "10 mins", "by 8:40", "aadha ghanta" turn into a clock time, by rules, never by the model;
//   4. mergeLive: one message updates one pill (a replay changes nothing; an unhandled cancel isn't buried by a "late");
//   5. cancelDecision: whether a cancel may run the existing cancellation flow by itself, or only suggest it.
//
// Privacy: nothing about a group is stored except `Slot.live` (who it is on, the kind, an ETA, when, the message id and a short
// snippet of that one message). Chat that isn't one of these is never kept.
import { localParts, zonedToMs } from "./groupAlerts.ts";

export type LiveKind = "late" | "cancel" | "swap" | "here" | "question";
export const LIVE_KINDS: LiveKind[] = ["late", "cancel", "swap", "here", "question"];

/** What the watch noticed about one comic on one lineup. Stored on the slot as `live`. */
export interface SlotLive {
  kind: LiveKind;
  /** "HH:MM" in the curator's timezone, when they said when they'd arrive. */
  eta?: string | null;
  /** When the message was written (ms). */
  at: number;
  /** The WhatsApp message id: a second read of the same message never changes or repeats anything. */
  msgId: string;
  /** A short quote of that one message. */
  snippet: string;
  /** How sure the read was (0 to 1). */
  confidence?: number;
  /** The pill goes away after this (ms): a few hours after the show starts. */
  expireAt: number;
  /** The curator tapped Ignore. The pill is hidden, but the record stays so the same message isn't raised again. */
  handled?: "ignored";
}

/** Settings → Watch show groups. */
export interface ShowWatchSettings {
  /** Master switch. Off: no show group message is looked at. */
  enabled: boolean;
  /** Which kinds raise a pill and a notice. */
  kinds: Record<LiveKind, boolean>;
}

export const DEFAULT_SHOW_WATCH: ShowWatchSettings = { enabled: false, kinds: { late: true, cancel: true, swap: false, here: false, question: false } };

/** Fills in what an older settings doc is missing. */
export function showWatchOf(s: { showWatch?: Partial<ShowWatchSettings> | null } | null | undefined): ShowWatchSettings {
  const w = s?.showWatch;
  return { enabled: Boolean(w?.enabled ?? DEFAULT_SHOW_WATCH.enabled), kinds: { ...DEFAULT_SHOW_WATCH.kinds, ...w?.kinds } };
}

/** Pill wording, shared by the lineup, the day card and the notices. `etaLabel` is "8:40 PM". */
export function liveLabel(l: Pick<SlotLive, "kind" | "eta">, etaLabel?: string): string {
  switch (l.kind) {
    case "late": return l.eta && etaLabel ? `Running late · ETA ${etaLabel}` : "Running late";
    case "cancel": return "Wants to cancel";
    case "swap": return "Asked to swap";
    case "here": return "Here ✓";
    case "question": return "Asked you something";
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// 1. Prefilter
// ---------------------------------------------------------------------------------------------------------------------------

/** Lowercase, no accents, no punctuation: "Can't" and "cant" and "can’t" are one word. Apostrophes vanish so "can't" becomes "cant". */
export const normaliseText = (t: string) =>
  t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’`]/g, "").replace(/[^\p{L}\p{N}:.? ]/gu, " ").replace(/\s+/g, " ").trim();

const PATTERNS: Record<LiveKind, RegExp[]> = {
  late: [
    /\blate\b/, /\b(stuck|struck|caught) in (the )?(traffic|jam)\b/, /\btraffic\b/, /\bon my way\b/, /\bomw\b/, /\bon the way\b/,
    /\b(reaching|reach|be there|be there in|there in|coming)\b.*\b(\d+ ?(min|mins|minutes|m)|half an hour|an hour|hour)\b/, /\b\d{1,3} ?(min|mins|minutes)\b/,
    /\bthoda (late|der)\b/, /\bder (ho|hogi|hoga|lag)/, /\blate ho\b/, /\braste mein\b/, /\brastey? mein\b/, /\b(jam|traffic) mein\b/, /\bpahunch (raha|rahi|rha|rhi)\b/, /\bpohoch (raha|rahi)\b/, /\baa raha\b|\baa rahi\b|\baa rha\b/, /\bpaanch min\b|\bdus min\b/,
  ],
  cancel: [
    /\bcancel/, /\bcant make it\b/, /\bwont (be able|make it)\b/, /\bunable to (come|make|perform|attend)\b/, /\b(have|had|got|need) to (drop|back out|pull out|skip)\b/, /\bdrop(ping)? (out|my spot|my slot)\b/, /\bdrop\b/,
    /\b(back|pull) out\b/, /\bnot coming\b/, /\bnot able to (come|make)\b/, /\bremove me\b/, /\btake me off\b/, /\bskip (tonight|today)\b/, /\bgive up my (spot|slot)\b/,
    /\bnahi aa (paunga|paungi|sakta|sakti|pa)\b/, /\bnahi aa paunga\b/, /\bnahin aa/, /\bnahi ho (payega|paayega|paega)\b/, /\bmujhse nahi\b/, /\bnahi (aaunga|aaungi|aa raha|aa rahi)\b/, /\bmain nahi aa\b/, /\bnahi pahunch/,
  ],
  swap: [/\bswap\b/, /\bswitch (spots?|slots?|with)\b/, /\bexchange\b/, /\bgive my (spot|slot)\b/, /\bmy (spot|slot) to\b/, /\banyone (want|wants|can take)\b.*\b(spot|slot)\b/, /\b(earlier|later) (slot|spot)\b/, /\bslot change\b/, /\bchange (my )?(slot|spot|order)\b/, /\bcan someone take my\b/, /\bapni (spot|slot)\b/],
  here: [/\b(im|i m|i am) (here|at the venue|outside|inside)\b/, /\bhere now\b/, /\breached\b/, /\barrived\b/, /\bat the (venue|mic|place)\b/, /\bpahunch (gaya|gayi|gaye)\b/, /\baa gaya\b|\baa gayi\b/, /\bpohoch (gaya|gayi)\b/, /\boutside the (venue|place)\b/],
  question: [/\bwhat time\b/, /\bwhich slot\b/, /\bwhats my (slot|order|number)\b/, /\bwhen do i (go|perform)\b/, /\bhow many minutes\b/, /\bset length\b/, /\bmy (slot|order|turn)\b/, /\bkab (jaana|jana|hai)\b/, /\bkitne (min|minute)/],
};

/** Past 600 characters it's an announcement or a forward, not someone telling the curator about themselves. */
const MAX_LEN = 600;

/** Which kinds a message could be, by keywords only. Empty means no model is asked. Order is by how much the curator needs to know. */
export function prefilter(text: string): LiveKind[] {
  if (!text || text.length > MAX_LEN) return [];
  const t = normaliseText(text);
  if (!t) return [];
  const order: LiveKind[] = ["cancel", "late", "swap", "here", "question"];
  return order.filter((k) => PATTERNS[k].some((r) => r.test(t)));
}

const NEGATED_CANCEL = /\b(not|dont|never|no need to|nahi karna|mat|wont|isnt|arent)\s+(be |to |going to )?(cancel|cancelling|canceling|dropping|drop)\b|\bnot (cancel|dropping)/;
const CONDITIONAL = /\b(if|agar|incase|in case|should i|can i|may i|could i|kya|what if|how do i|how to|policy|is it ok|is it okay)\b/;

/** A plain, firm cancellation: no question mark, no "if", no "don't cancel". The only wording that may ever run the flow by itself. */
export function strongCancel(text: string): boolean {
  if (!text || text.length > 300 || text.includes("?")) return false;
  const t = normaliseText(text);
  if (NEGATED_CANCEL.test(t) || CONDITIONAL.test(t)) return false;
  return PATTERNS.cancel.some((r) => r.test(t));
}

// ---------------------------------------------------------------------------------------------------------------------------
// 2. The model's answer
// ---------------------------------------------------------------------------------------------------------------------------

export const LIVE_SCHEMA = {
  type: "object",
  properties: {
    evidence: { type: "string" },
    kind: { type: "string", enum: ["late", "cancel", "swap", "here", "question", "other"] },
    confidence: { type: "number" },
  },
  required: ["evidence", "kind", "confidence"],
};

const EXAMPLES: [string, { kind: string; confidence: number }][] = [
  ["bro stuck in traffic, 15 mins late", { kind: "late", confidence: 0.95 }],
  ["thoda late ho jaunga, 8:40 tak pahunchunga", { kind: "late", confidence: 0.92 }],
  ["sorry guys I can't make it tonight, family emergency", { kind: "cancel", confidence: 0.95 }],
  ["aaj nahi aa paunga bhai, please remove my name", { kind: "cancel", confidence: 0.93 }],
  ["can someone take my spot? I want the later slot", { kind: "swap", confidence: 0.85 }],
  ["reached the venue", { kind: "here", confidence: 0.9 }],
  ["what time am I going on?", { kind: "question", confidence: 0.8 }],
  ["the last show was so good, 10 minutes of pure fun", { kind: "other", confidence: 0.9 }],
  ["I'm not cancelling, don't worry", { kind: "other", confidence: 0.9 }],
];

/** The prompt for one message from one comic. Short, with examples: small local models read this too. */
export function buildLivePrompt(text: string, ctx: { show: string; startTime: string; now: string }): string {
  const t = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return `You read one message that a comic on tonight's lineup wrote in the WhatsApp group of a stand-up open mic. English, Hindi or Hinglish. Decide what it tells the curator.

kind is exactly one of:
- late: they are running late or on their way ("stuck in traffic", "10 mins late", "thoda late").
- cancel: they cannot perform and want out ("can't make it", "cancel my spot", "nahi aa paunga", "drop me").
- swap: they want to swap, give away or change their slot ("can someone take my spot", "can I go earlier").
- here: they have arrived ("reached", "I'm here").
- question: they ask the curator about their own slot, order or timing.
- other: anything else: chat, jokes, praise, a question to the whole group, someone else's news, "not cancelling", a hypothetical. When unsure, other.

evidence: copy the exact words that show the kind. For "other" use "".
confidence: 0 to 1. Use 0.9 or more only when the words are plain and are about the writer themselves.

The show is ${ctx.show}, starting ${ctx.startTime}. It is ${ctx.now} now.

${EXAMPLES.map(([m, a]) => `Message: ${m}\nAnswer: ${JSON.stringify({ evidence: a.kind === "other" ? "" : m.slice(0, 40), ...a })}`).join("\n\n")}

Message: ${t}
Reply ONLY with JSON: {"evidence": "...", "kind": "...", "confidence": 0..1}`;
}

export interface LiveRead {
  kind: LiveKind;
  confidence: number;
}

const words = (t: string) => normaliseText(t).split(" ").filter((w) => w.length > 1);

/** The model must quote the message. A quote that isn't in it means the model made it up. */
function evidenceIsReal(evidence: string, text: string): boolean {
  const ev = words(evidence);
  if (!ev.length) return false;
  const have = normaliseText(text);
  return ev.filter((w) => have.includes(w)).length / ev.length >= 0.75;
}

/** The model's answer, checked against the message. null: "other", not JSON, an unknown kind, or a quote that isn't in the message. */
export function parseLiveRead(raw: string, text: string): LiveRead | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model didn't answer in JSON");
  const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const kind = o.kind as LiveKind | "other";
  if (!LIVE_KINDS.includes(kind as LiveKind)) return null;
  if (!evidenceIsReal(String(o.evidence ?? ""), text)) return null;
  return { kind: kind as LiveKind, confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)) };
}

/** When the model can't answer (slow, down, policy): the keywords read it, and are never sure enough to act. */
export const RULES_CONFIDENCE = 0.6;
export function rulesRead(text: string): LiveRead | null {
  const [kind] = prefilter(text);
  if (!kind) return null;
  // A cancel needs the firm wording even to be suggested without a model.
  if (kind === "cancel" && !strongCancel(text)) return null;
  return { kind, confidence: RULES_CONFIDENCE };
}

// ---------------------------------------------------------------------------------------------------------------------------
// 3. ETA
// ---------------------------------------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (mins: number) => `${pad(Math.floor((((mins % 1440) + 1440) % 1440) / 60))}:${pad((((mins % 1440) + 1440) % 1440) % 60)}`;
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * When they said they'd arrive, as "HH:MM" in `tz`: "10 mins" is counted from when they wrote it ("at"); "by 8:40" or "at 9" is a clock time
 * (am or pm guessed from the show: an evening show means pm). null when they gave no time. `showStart` is the show's "HH:MM".
 */
export function etaFromText(text: string, at: number, tz: string, showStart?: string): string | null {
  const t = normaliseText(text);
  const now = localParts(at, tz).time;
  // A clock time: 8:40, 8.40, 8:40pm, "by 9", "at 9pm", "9 baje".
  const clock = t.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/) ?? t.match(/\b(?:by|at|around|till|until|before|tak)\s+(\d{1,2})()\s*(am|pm)?\b/) ?? t.match(/\b(\d{1,2})()\s*(am|pm)\b/) ?? t.match(/\b(\d{1,2})()\s*(baje)\b/);
  if (clock) {
    let h = Number(clock[1]);
    const m = clock[2] ? Number(clock[2]) : 0;
    const mer = clock[3] === "am" || clock[3] === "pm" ? clock[3] : null;
    if (h > 23 || m > 59) return null;
    if (mer === "pm" && h < 12) h += 12;
    else if (mer === "am" && h === 12) h = 0;
    else if (!mer && h >= 1 && h <= 11) {
      // No am/pm: the evening is the likelier reading when the show or the message is in the afternoon or later.
      const eve = (showStart ? minutesOf(showStart) >= 12 * 60 : false) || minutesOf(now) >= 12 * 60;
      if (eve) h += 12;
    }
    return `${pad(h)}:${pad(m)}`;
  }
  // A length of time from when they wrote it.
  let add: number | null = null;
  const mins = t.match(/\b(\d{1,3}) ?(min|mins|minute|minutes|m)\b/);
  const hrs = t.match(/\b(\d{1,2}(?:\.\d)?) ?(hr|hrs|hour|hours|ghanta|ghante)\b/);
  if (mins) add = Number(mins[1]);
  else if (/\b(half an hour|aadha ghanta|adha ghanta|half hour)\b/.test(t)) add = 30;
  else if (hrs) add = Math.round(Number(hrs[1]) * 60);
  else if (/\b(an hour|ek ghanta)\b/.test(t)) add = 60;
  else if (/\bpaanch min|\bpanch min/.test(t)) add = 5;
  else if (/\bdus min/.test(t)) add = 10;
  if (add == null || add <= 0 || add > 360) return null;
  return hhmm(minutesOf(now) + add);
}

// ---------------------------------------------------------------------------------------------------------------------------
// 4. One message, one pill
// ---------------------------------------------------------------------------------------------------------------------------

/** How long after the show starts the pill stays. */
export const LIVE_TTL_AFTER_START_MS = 6 * 3_600_000;

/** When the pill for a message about the show on `date` at `startTime` goes away. Never before the message itself plus an hour. */
export function liveExpireAt(date: string, startTime: string, tz: string, at: number): number {
  return Math.max(zonedToMs(date, startTime, tz) + LIVE_TTL_AFTER_START_MS, at + 3_600_000);
}

/** Is there a pill to show right now? Ignored and expired ones are not. */
export function liveActive(live: SlotLive | null | undefined, now: number): live is SlotLive {
  return Boolean(live && !live.handled && now < live.expireAt);
}

/**
 * What a slot's `live` becomes when `next` is read. null: leave it as it is (and say nothing). The rules:
 * - the same message again, or an older one, changes nothing (a catch-up or a retry can't make a second pill or a second notice);
 * - a newer message from the same comic replaces it: a new ETA updates the pill; "reached" clears "late";
 * - a cancel nobody has dealt with isn't buried by a later "late", "swap" or question; only "here" (they came after all) replaces it.
 */
export function mergeLive(cur: SlotLive | null | undefined, next: SlotLive): SlotLive | null {
  if (!cur) return next;
  if (cur.msgId === next.msgId) return null;
  if (next.at < cur.at) return null;
  if (cur.kind === "cancel" && !cur.handled && next.kind !== "here" && next.kind !== "cancel") return null;
  return next;
}

// ---------------------------------------------------------------------------------------------------------------------------
// 5. Cancelling
// ---------------------------------------------------------------------------------------------------------------------------

/** At or above this, with a firm wording, and the curator's automatic cancellation on, a cancel runs the flow itself. */
export const AUTO_CANCEL_CONFIDENCE = 0.85;
/** Below this a read is noise: nothing is stored and nobody is told. Between this and the one above, the curator is told and chooses. */
export const NOTIFY_CONFIDENCE = 0.5;
/** Only a message this fresh may act on its own: a replayed one never does. Same limit as the automatic acknowledgement. */
export const AUTO_CANCEL_MAX_AGE_MS = 10 * 60_000;

export interface CancelInput {
  watch: ShowWatchSettings;
  /** The existing setting: Settings → Rules & replies. A cancellation frees the slot automatically only when both are on. */
  selfService: { enabled: boolean; autoSend: boolean };
  read: LiveRead;
  /** True when the keywords read it because the model couldn't. */
  rulesOnly: boolean;
  text: string;
  /** The message's age in ms. */
  age: number;
  /** The lineup is still going ahead (not called off, not already over). */
  upcoming: boolean;
}

export type CancelDecision = "auto" | "suggest" | "ignore";

/**
 * What to do with a cancel. "auto" runs the existing cancellation flow (off the lineup, out of the group by its own rules, the curator told).
 * "suggest" shows the pill with Remove / Ignore. "ignore" is not worth showing. Every guard must hold for "auto".
 */
export function cancelDecision(i: CancelInput): CancelDecision {
  if (i.read.kind !== "cancel" || !i.watch.enabled || !i.watch.kinds.cancel) return "ignore";
  if (i.read.confidence < NOTIFY_CONFIDENCE) return "ignore";
  const auto =
    i.selfService.enabled &&
    i.selfService.autoSend &&
    !i.rulesOnly &&
    i.upcoming &&
    i.read.confidence >= AUTO_CANCEL_CONFIDENCE &&
    i.age >= 0 &&
    i.age <= AUTO_CANCEL_MAX_AGE_MS &&
    strongCancel(i.text);
  return auto ? "auto" : "suggest";
}

/** Should this read raise anything at all? The kind's switch, and the floor. */
export function worthRaising(read: LiveRead, watch: ShowWatchSettings): boolean {
  return watch.enabled && watch.kinds[read.kind] && read.confidence >= NOTIFY_CONFIDENCE;
}

/** A short quote of the message: one line, no newlines, capped. */
export function liveSnippet(text: string, max = 140): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The notice text: who, what, which show, and the quote. */
export function liveNoticeText(o: { name: string; kind: LiveKind; show: string; etaLabel?: string; snippet: string; auto?: boolean; removedFromGroup?: boolean }): string {
  const q = `"${o.snippet}"`;
  switch (o.kind) {
    case "late": return `${o.name} is running late for ${o.show}${o.etaLabel ? ` (ETA ${o.etaLabel})` : ""}: ${q}`;
    case "cancel": return o.auto ? `${o.name} said they can't make it, so they were taken off ${o.show}${o.removedFromGroup ? " and out of the group" : ""}. A slot is open: ${q}` : `${o.name} wants to cancel their spot on ${o.show}. Open the lineup to remove them or ignore: ${q}`;
    case "swap": return `${o.name} asked to swap their slot on ${o.show}: ${q}`;
    case "here": return `${o.name} is at the venue for ${o.show}.`;
    case "question": return `${o.name} asked about their slot on ${o.show}: ${q}`;
  }
}

/** The lineup a message is about: this show's earliest one on or after today that is still going ahead. */
export function pickWatchLineup<L extends { date: string; status: string; backfilled?: boolean }>(lineups: L[], today: string): L | null {
  const open = lineups.filter((l) => l.date >= today && (l.status === "draft" || l.status === "confirmed") && !l.backfilled);
  return open.sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
}
