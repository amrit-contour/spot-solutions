// "Your voice": messages written the way the curator writes, instead of the same template for everyone.
// The server reads only the curator's own sent messages, the model sums them up as a short profile plus
// a few real examples, and every outgoing message is then drafted from the facts + that profile, with the
// curator's template as the guide. A draft that drops or changes a fact is thrown away and the template goes out.
import type { MessageKey } from "./messages.ts";

export interface VoiceProfile {
  /** A few sentences on how they write, editable in Settings. */
  summary: string;
  /** Real messages they sent, picked to show their range. */
  examples: string[];
  learnedAt: number;
  /** How many of their messages the profile was built from. */
  sampleCount: number;
}

export interface VoiceSettings {
  enabled: boolean;
  profile?: VoiceProfile | null;
}

/** Messages that can be written in the curator's voice. Group invite notes stay as typed. */
export type VoiceKind = "ack" | "confirm" | "cancelSpot" | "reject" | Exclude<MessageKey, "groupWelcome">;

export const VOICE_SAMPLE_CAP = 300;
export const VOICE_EXAMPLE_CAP = 15;

const URL_RE = /https?:\/\/\S+/gi;
const PHONE_RE = /\+?\d[\d\s-]{8,}\d/g;

/**
 * Pick the curator's sent messages worth learning from: real sentences, not links, OTP-ish numbers,
 * forwards or one-word replies. Newest first, deduped, phone numbers masked, capped.
 */
export function pickVoiceSamples(messages: { body: string; at: number }[], cap = VOICE_SAMPLE_CAP): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...messages].sort((a, b) => b.at - a.at)) {
    const body = m.body.replace(URL_RE, "").replace(PHONE_RE, "<number>").trim();
    if (body.length < 8 || body.length > 400) continue;
    if (!/\p{L}{2,}/u.test(body)) continue;
    if ((body.match(/\p{L}+/gu) ?? []).length < 2) continue;
    const key = body.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(body);
    if (out.length >= cap) break;
  }
  return out;
}

/** The facts a drafted message has to carry, exactly. */
export type VoiceFacts = Partial<Record<"name" | "show" | "venue" | "day" | "date" | "time" | "minutes" | "mapsLink" | "opens" | "lastShow" | "lastDate" | "shows", string | number | null>>;

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
const numbers = (s: string) => s.match(/\d+/g) ?? [];

/**
 * Why a drafted message can't be used, or null when it's fine.
 * Every fact the template mentions must appear verbatim; no new numbers or links may appear;
 * the draft can't balloon past the template.
 */
export function voiceDraftProblem(draft: string, template: string, facts: VoiceFacts): string | null {
  const d = draft.trim();
  if (!d) return "empty";
  if (d.length > Math.max(template.length * 2, 240)) return "too long";
  // "27th Oct" counts as "27 Oct".
  const fd = fold(d).replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  const tf = fold(template);
  for (const [k, v] of Object.entries(facts)) {
    if (v === null || v === undefined || v === "" || k === "name" || k === "shows") continue;
    const val = String(v);
    // Only facts the template actually used have to be there.
    if (!tf.includes(fold(val))) continue;
    if (k === "time") {
      // "8:30 PM" may be written "8:30 pm" or "8:30PM".
      const core = val.replace(/\s*(am|pm)$/i, "");
      if (!fd.includes(fold(core))) return `missing ${k}`;
      continue;
    }
    if (!fd.includes(fold(val))) return `missing ${k}`;
  }
  // No invented numbers (dates, times, minutes, prices) or links.
  const allowed = new Set([...numbers(template), ...Object.values(facts).flatMap((v) => (v === null || v === undefined ? [] : numbers(String(v))))]);
  for (const n of numbers(d.replace(URL_RE, ""))) if (!allowed.has(n)) return `new number ${n}`;
  const links = d.match(URL_RE) ?? [];
  for (const l of links) if (!template.includes(l.replace(/[).,!]+$/, ""))) return "new link";
  return null;
}

const KIND_GOAL: Record<VoiceKind, string> = {
  ack: "Tell them you got their spot request and will confirm later. Don't promise a spot or say when.",
  confirm: "Confirm their spot with every detail below.",
  cancelSpot: "Tell them, kindly, that you've had to take them off the lineup.",
  reject: "Tell them, kindly, there's no spot for them this week.",
  onboard: "Ask who they are: full name, comedy scene, how long they've done comedy, and if they're travelling.",
  offer: "Offer them the open spot below and ask them to reply yes or no.",
  offerFull: "Tell them the spot filled before they replied.",
  cancelDone: "Confirm you've cancelled their spot below.",
  cancelNone: "Tell them they don't have a spot this week, so there's nothing to cancel.",
  statusConfirmed: "Tell them yes, they're on, with the details below.",
  statusPencilled: "Tell them they're pencilled in but the lineup isn't final yet.",
  statusNone: "Tell them they don't have a spot yet and you'll tell them when the lineup is out.",
  showInfo: "Share where and when the shows are, keeping the list exactly as given.",
  lastSpot: "Tell them when their last spot was, exactly as given.",
  heldWindow: "Tell them requests for the week aren't open yet and when they open.",
  heldLastWeek: "Tell them they performed last week so you're giving others a turn, and to ask next week.",
};

/** The prompt for one message. `reference` is the curator's template, already filled in. */
export function buildVoicePrompt(opts: { kind: VoiceKind; profile: VoiceProfile; reference: string; comicName: string; facts?: VoiceFacts }) {
  const { kind, profile, reference, comicName } = opts;
  // Facts the reference actually uses, spelled out so a small model keeps them.
  const facts = Object.entries(opts.facts ?? {})
    .filter(([k, v]) => k !== "name" && k !== "shows" && v !== null && v !== undefined && v !== "" && fold(reference).includes(fold(String(v))))
    .map(([k, v]) => `${k}: ${v}`);
  const examples = profile.examples.slice(0, VOICE_EXAMPLE_CAP).map((e) => `- ${e.replace(/\n/g, " ")}`).join("\n");
  return `You write WhatsApp messages for a stand-up comedy open-mic curator, in their own voice, to a comic.

How the curator writes:
${profile.summary}

Real messages they sent (for STYLE ONLY: their days, times, shows and names are about other occasions and must never appear in this message):
${examples}

Goal: ${KIND_GOAL[kind]}
The comic's first name: ${comicName}

The curator's own version of this message (keep every fact in it exactly, including dates, times, show and venue names, links and list lines):
"""
${reference}
"""

These facts must appear exactly as written, character for character:
${facts.map((f) => `- ${f}`).join("\n") || "- (none)"}

Rewrite it so it sounds like the curator wrote it just now: their greetings, their mix of languages, their emoji habits, their length.
Rules: keep every fact exactly as written; add no new facts, numbers, dates, times or links; don't make promises the original doesn't; keep it about as long as the original or shorter; no hashtags; never mention AI.
Return ONLY JSON: {"message": "the WhatsApp message"}`;
}

/** The prompt that turns their sent messages into a profile. */
export function buildLearnPrompt(samples: string[]) {
  const list = samples.map((s, i) => `${i}: ${s.replace(/\n/g, " ")}`).join("\n");
  return `These are WhatsApp messages a stand-up comedy open-mic curator sent to comics and in their show groups.

${list}

Describe how this person writes, so someone else could write new messages exactly like them. Cover: how they greet people, their language mix (English, Hindi, Kannada, Hinglish...), slang and pet words, emoji (which and how often), punctuation and capitalisation, typical length, tone (warm, blunt, jokey), and how they sign off. 4 to 8 short sentences, concrete, with tiny quoted examples of their phrasing. Describe style only: no names, phone numbers or private details.

Also pick up to ${VOICE_EXAMPLE_CAP} message numbers that best show their style across different situations (confirming, declining, updating, chatting). Skip messages with private details.

Return ONLY JSON: {"summary": "...", "examples": [numbers]}`;
}

/**
 * Was this sent by the app from one of the templates? Their fixed words show up in order,
 * which a message the curator typed almost never does. Keeps old app sends out of the voice profile.
 */
export function looksLikeTemplate(body: string, templates: string[]) {
  const words = (s: string) => fold(s).match(/\p{L}{3,}/gu) ?? [];
  const b = words(body);
  if (!b.length) return false;
  for (const t of templates) {
    const fixed = words(t.replace(/\{\{[^}]*\}\}/g, " "));
    if (fixed.length < 4) continue;
    let j = 0;
    for (const w of b) if (w === fixed[j]) j++;
    if (j / fixed.length >= 0.7) return true;
  }
  return false;
}
