import { DAY_NAMES, type AiSettings, type Intent, type IntentKind, type Show, type Weekday } from "@spot/shared";
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
    note: { type: "string" },
  },
  required: ["evidence", "kind", "is_spot_request", "confidence", "preferred_days", "note"],
};

export function buildPrompt(messages: string[], shows: Pick<Show, "name" | "weekday" | "startTime">[]) {
  const showList = shows.length
    ? shows.map((s) => `- ${s.name} (${DAY_NAMES[s.weekday]} ${s.startTime})`).join("\n")
    : "- (no shows configured)";
  return `You help a stand-up comedy open-mic curator in Bangalore triage WhatsApp DMs.
Comics ask for a "spot" (a slot to perform) in many ways: English, Hindi, Kannada or Hinglish, slang, indirect hints. Examples of spot requests:
"bro any spot this monday?", "bhai tuesday ka mic hai kya, naya 5 hai", "can I come up next week", "put me down for mon pls", "is there space on the lineup".
NOT spot requests: bank/UPI/bill/OTP/delivery/promo notifications, property or job listings, forwarded links, casual chat, memes, audience questions (tickets, entry fee, bringing friends to WATCH a show), payment talk, replies like "thanks"/"ok" with no ask.

Shows this week:
${showList}

Messages from one person, oldest first (read them together as one conversation):
${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}

Comics who already have a spot may also write about it:
- cancel_spot: they want to drop out ("can't make it monday", "cancel my spot", "something came up, have to back out").
- status_query: they ask if/when they are on this week ("am I up this week?", "did I get a spot?").
- last_spot_query: they ask when they last performed here.
Anyone may ask about the mic itself:
- show_info: where or when the mic happens, venue, timings, location ("where is the mic?", "what time does it start?").

Think step by step:
1. kind: one of spot_request, cancel_spot, status_query, last_spot_query, show_info, other.
2. evidence: copy the exact words that show that kind (the ask, the cancellation, the question). For "other" use "".
3. is_spot_request: true ONLY if kind is spot_request and evidence is non-empty. Mentioning a show, thanking, paying or praising is NOT asking.
4. preferred_days: only days they literally name (mon, monday, tue, "kal" etc). If they name none, []. If they say any day works, list every show day.

Reply ONLY with JSON:
{"evidence": "...", "kind": "...", "is_spot_request": boolean, "confidence": 0..1, "preferred_days": [...], "show_hint": "show name or empty", "note": "<=12 word summary for the curator, e.g. 'wants Monday, trying new 5'"}`;
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

function parseIntent(raw: string, model: string, messages: string[]): Intent {
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const o = JSON.parse(json) as Record<string, unknown>;
  let kind = (KINDS.includes(o.kind as IntentKind) ? o.kind : o.is_spot_request ? "spot_request" : "other") as IntentKind;
  // Every kind except "other" needs a real quote from the messages, or we treat it as noise.
  if (kind !== "other" && !evidenceIsReal(String(o.evidence ?? ""), messages)) {
    kind = "other";
    o.note = "No actual ask found in the messages";
  }
  o.is_spot_request = kind === "spot_request";
  const days = (Array.isArray(o.preferred_days) ? o.preferred_days : [])
    .map((d) => DAY_NAMES.findIndex((n) => n.toLowerCase() === String(d).toLowerCase()))
    .filter((d) => d >= 0) as Weekday[];
  const confidence = Math.max(0, Math.min(1, Number(o.confidence) || 0));
  return {
    kind,
    isSpotRequest: Boolean(o.is_spot_request),
    confidence: o.is_spot_request ? confidence : Math.min(confidence, 0.3),
    preferredDays: [...new Set(days)],
    preferredShowHint: o.show_hint ? String(o.show_hint) : null,
    note: o.note ? String(o.note) : null,
    model,
  };
}

/** Classify one comic's burst of messages. `uid` picks whose Gemini key to use. */
export async function classify(uid: string | null, messages: string[], shows: Show[], ai: AiSettings): Promise<Intent> {
  // Long automated messages (bills, OTPs, listings) confuse small models; a spot ask is never an essay.
  const trimmed = messages.map((m) => (m.length > 400 ? `${m.slice(0, 400)}…` : m));
  const { text, model } = await generateJson(uid, ai, buildPrompt(trimmed, shows), SCHEMA);
  return parseIntent(text, model, trimmed);
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
