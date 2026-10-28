import { DAY_NAMES, INTENT_TAGS, INTENT_TAG_HELP, type AiSettings, type Intent, type IntentKind, type IntentTag, type SenderFacts, type Show, type Venue, type Weekday } from "@spot/shared";
import { generateJson } from "./llm.ts";

const KINDS: IntentKind[] = ["spot_request", "cancel_spot", "status_query", "last_spot_query", "show_info", "other"];

const SCHEMA = {
  type: "object",
  properties: {
    evidence: { type: "string" },
    kind: { type: "string", enum: KINDS },
    is_spot_request: { type: "boolean" },
    confidence: { type: "number" },
    preferred_days: { type: "array", items: { type: "string", enum: [...DAY_NAMES] } },
    show_hint: { type: "string" },
    venue_id: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: [...INTENT_TAGS] } },
    note: { type: "string" },
  },
  required: ["evidence", "kind", "is_spot_request", "confidence", "preferred_days", "venue_id", "tags", "note"],
};

/** What the app knows besides the messages: the curator's venues and facts about the sender. */
export interface ClassifyContext {
  venues?: Venue[];
  sender?: SenderFacts;
}

type PromptShow = Pick<Show, "name" | "weekday" | "startTime"> & Partial<Pick<Show, "venueId" | "active">>;

function venueSection(shows: PromptShow[], venues: Venue[]) {
  if (!shows.length) return "- (no shows configured)";
  const lines: string[] = [];
  const used = new Set<string>();
  for (const v of venues) {
    const here = shows.filter((s) => s.venueId === v.id);
    if (!here.length) continue;
    used.add(v.id);
    const aliases = (v.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    lines.push(`- venue_id "${v.id}": ${v.name}${v.area ? `, area ${v.area}` : ""}${aliases.length ? `, also called: ${aliases.join(", ")}` : ""}`);
    for (const s of here) lines.push(`    - ${s.name} (${DAY_NAMES[s.weekday]} ${s.startTime})`);
  }
  const loose = shows.filter((s) => !s.venueId || !used.has(s.venueId));
  for (const s of loose) lines.push(`- ${s.name} (${DAY_NAMES[s.weekday]} ${s.startTime})`);
  return lines.join("\n");
}

function senderSection(f: SenderFacts) {
  const lines = [
    `- On the curator's roster: ${f.onRoster ? "yes" : "no"}`,
    `- Saved name: ${f.savedName ?? "none"}`,
    `- Past spots here: ${f.pastSpots}${f.lastSpotDate ? `, last on ${f.lastSpotDate}` : ""}`,
    `- Earlier requests in other weeks: ${f.priorRequests}`,
    `- Experience tags: ${((f.tags ?? []).join(", ")) || "none"}`,
    `- Performed last week: ${f.performedLastWeek ? "yes" : "no"}`,
  ];
  return lines.join("\n");
}

export function buildPrompt(messages: string[], shows: PromptShow[], venues: Venue[] = [], sender?: SenderFacts) {
  const tagList = INTENT_TAGS.map((t) => `- ${t}: ${INTENT_TAG_HELP[t]}`).join("\n");
  return `You help a stand-up comedy open-mic curator triage WhatsApp DMs.
Comics ask for a "spot" (a slot to perform) in many ways: English, Hindi, Kannada or Hinglish, slang, indirect hints. Examples of spot requests:
"bro any spot this monday?", "bhai tuesday ka mic hai kya", "can I come up next week", "put me down for mon pls", "is there space on the lineup".
NOT spot requests: bank/UPI/bill/OTP/delivery/promo notifications, property or job listings, forwarded links, casual chat, memes, audience questions (tickets, entry fee, bringing friends to WATCH a show), payment talk, replies like "thanks"/"ok" with no ask.

The curator's venues and shows (use these exact venue ids):
${venueSection(shows, venues)}
${
    sender
      ? `
Facts about the sender, from the app (these are known, not guesses):
${senderSection(sender)}
Do not judge whether this person is new or experienced. The app already knows. Never write "new comic", "new face" or similar in the note.
`
      : ""
  }
Messages from one person, oldest first (read them together as one conversation):
${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}

Comics who already have a spot may also write about it:
- cancel_spot: they want to drop out ("can't make it monday", "cancel my spot", "something came up, have to back out").
- status_query: they ask if/when they are on this week ("am I up this week?", "did I get a spot?").
- last_spot_query: they ask when they last performed here.
Anyone may ask about the mic itself:
- show_info: where or when the mic happens, venue, timings, location ("where is the mic?", "what time does it start?").
Asking whether a spot or slot is free ("spot available at Bloom 9 pm today?", "any slot tonight?") is spot_request, not show_info.

Think step by step:
1. kind: one of spot_request, cancel_spot, status_query, last_spot_query, show_info, other.
2. evidence: copy the exact words that show that kind (the ask, the cancellation, the question). For "other" use "".
3. is_spot_request: true ONLY if kind is spot_request and evidence is non-empty. Mentioning a show, thanking, paying or praising is NOT asking.
4. preferred_days: only days they literally name (mon, monday, tue, "kal" etc). If they name none, []. If they say any day works, list every show day.
5. venue_id: if a message names one of the venues above, its area or one of its aliases (even loosely, like "bloom" or "indira nagar"), give that venue's id. A word that matches a venue or area is the place, not a nickname or a person. If no venue is mentioned, "".
6. tags: zero or more of these labels, only when the messages clearly say so. When unsure, leave it out.
${tagList}
7. note: an objective summary of what they asked for, nothing else.

Reply ONLY with JSON:
{"evidence": "...", "kind": "...", "is_spot_request": boolean, "confidence": 0..1, "preferred_days": [...], "show_hint": "show name or empty", "venue_id": "venue id or empty", "tags": [...], "note": "<=12 word summary of the ask, e.g. 'wants Monday, asks for an early slot'"}`;
}

const norm = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

/** The model must quote the ask. If its "evidence" isn't actually in the messages, it made it up. */
export function evidenceIsReal(evidence: string, messages: string[]) {
  const ev = norm(evidence);
  if (!ev) return false;
  const text = norm(messages.join(" "));
  if (text.includes(ev)) return true;
  const words = ev.split(" ").filter((w) => w.length > 1);
  const hits = words.filter((w) => text.includes(w)).length;
  return words.length > 0 && hits / words.length >= 0.75;
}

/** The app knows whether someone is new. Drop any clause where the model claims it anyway. */
const NEWNESS = /\b(new|first[- ]time)\s+(comic|comedian|face|performer|artist|talent|joiner|to (the )?(scene|mic|us|here|bangalore))\b|\bnewcomer\b|\bnew here\b/i;
export function cleanNote(note: unknown) {
  const kept = String(note ?? "")
    .split(/(?<=[,;.])\s+|\s+-\s+/)
    .filter((c) => c.trim() && !NEWNESS.test(c));
  const out = kept.join(" ").replace(/[,;]\s*$/, "").trim();
  return out || null;
}

/** Keep only tags from the fixed list, once each. */
export function validTags(raw: unknown): IntentTag[] {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()))].filter((t): t is IntentTag => (INTENT_TAGS as readonly string[]).includes(t));
}

/** Only an id the curator actually has counts; anything else is a guess. */
export function validVenueId(raw: unknown, venueIds: string[]) {
  const id = String(raw ?? "").trim();
  return id && venueIds.includes(id) ? id : null;
}

/**
 * Words a real spot ask almost always carries: the ask itself, a day, or one of the curator's venues.
 * A small model sometimes calls unrelated chat (rent, money, family, other languages) a spot request
 * with high confidence; without one of these, it can only ever land in Maybe.
 */
const SPOT_WORDS = /\b(spots?|slots?|mic|open ?mic|line ?up|sets?|perform\w*|stage|gig|show|chance|space|book(ing)?|put me|come up|try out|minutes?|mins?|mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|today|tonight|tomorrow|tmrw|tmr|aaj|kal|parso|weekend|next week|this week)\b/i;
export function hasSpotSignal(messages: string[], venueTerms: string[] = []) {
  const text = norm(messages.join(" "));
  if (SPOT_WORDS.test(text)) return true;
  return venueTerms.some((t) => {
    const v = norm(t);
    return v.length >= 3 && new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  });
}
/** "is a spot available at 9 today?" is asking for a spot, even though it names a place and a time. */
const ASKS_FOR_SPOT = /\b(spots?|slots?)\b/i;

/** Most a request with no spot word, day or venue in it can score: the bottom of Maybe. */
export const NO_SIGNAL_CAP = 0.45;

export function parseIntent(raw: string, model: string, messages: string[], venueIds: string[] = [], venueTerms: string[] = []): Intent {
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const o = JSON.parse(json) as Record<string, unknown>;
  let kind = (KINDS.includes(o.kind as IntentKind) ? o.kind : o.is_spot_request ? "spot_request" : "other") as IntentKind;
  // Every kind except "other" needs a real quote from the messages, or we treat it as noise.
  if (kind !== "other" && !evidenceIsReal(String(o.evidence ?? ""), messages)) {
    kind = "other";
    o.note = "No actual ask found in the messages";
  }
  // The model sometimes files a spot ask as "where/when" because it names a venue and a time.
  if (kind === "show_info" && messages.some((m) => ASKS_FOR_SPOT.test(m))) {
    kind = "spot_request";
    o.confidence = Math.max(Number(o.confidence) || 0, 0.7);
  }
  o.is_spot_request = kind === "spot_request";
  const days = (Array.isArray(o.preferred_days) ? o.preferred_days : [])
    .map((d) => DAY_NAMES.findIndex((n) => n.toLowerCase() === String(d).toLowerCase()))
    .filter((d) => d >= 0) as Weekday[];
  let confidence = Math.max(0, Math.min(1, Number(o.confidence) || 0));
  const signal = hasSpotSignal(messages, venueTerms);
  if (kind === "spot_request" && !signal) {
    confidence = Math.min(confidence, NO_SIGNAL_CAP);
    o.note = "No spot, day or venue mentioned: check it";
  }
  const quoted = kind !== "other";
  return {
    kind,
    venueId: quoted ? validVenueId(o.venue_id, venueIds) : null,
    tags: quoted ? validTags(o.tags) : [],
    isSpotRequest: Boolean(o.is_spot_request),
    confidence: o.is_spot_request ? confidence : Math.min(confidence, 0.3),
    preferredDays: [...new Set(days)],
    preferredShowHint: o.show_hint ? String(o.show_hint) : null,
    note: cleanNote(o.note),
    model,
  };
}

/** Classify one comic's burst of messages. `uid` picks whose Gemini key to use. */
export async function classify(uid: string | null, messages: string[], shows: Show[], ai: AiSettings, ctx: ClassifyContext = {}): Promise<Intent> {
  // Long automated messages (bills, OTPs, listings) confuse small models; a spot ask is never an essay.
  const trimmed = messages.map((m) => (m.length > 400 ? `${m.slice(0, 400)}…` : m));
  const venues = ctx.venues ?? [];
  const { text, model } = await generateJson(uid, ai, buildPrompt(trimmed, shows, venues, ctx.sender), SCHEMA);
  const venueTerms = venues.flatMap((v) => [v.name, v.area ?? "", ...(v.aliases ?? [])]).filter(Boolean);
  return parseIntent(text, model, trimmed, venues.map((v) => v.id), venueTerms);
}

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    scene: { type: "string" },
    years: { type: "number" },
    travelling: { type: "boolean" },
  },
  required: ["name", "scene", "years", "travelling"],
};

/** Pull name / home scene / years doing comedy / travelling out of a reply to the onboarding question. */
export async function extractProfile(uid: string | null, messages: string[], ai: AiSettings) {
  const text = messages.map((m) => (m.length > 500 ? m.slice(0, 500) : m)).join("\n");
  const prompt = `A stand-up comic replied to "What's your name, which comedy scene are you from, how long have you been doing comedy, and are you travelling?".
Their reply:
${text}

Return ONLY JSON: {"name": "full name or empty", "scene": "city/scene or empty", "years": number of years doing comedy (months as a fraction, 0 if unknown), "travelling": true if visiting from another city}.
Use only what they actually said. Never invent a name.`;
  const { text: raw } = await generateJson(uid, ai, prompt, PROFILE_SCHEMA);
  const o = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  const scene = String(o.scene ?? "").trim();
  const years = Number(o.years);
  return {
    // Only trust a name that actually appears in what they wrote.
    name: name && norm(text).includes(norm(name).split(" ")[0]) ? name : null,
    scene: scene || null,
    years: Number.isFinite(years) && years > 0 ? Math.round(years * 10) / 10 : null,
    travelling: typeof o.travelling === "boolean" ? o.travelling : null,
  };
}
