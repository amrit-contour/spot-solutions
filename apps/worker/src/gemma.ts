import { GoogleGenAI } from "@google/genai";
import { DAY_NAMES, type Intent, type Settings, type Show, type Weekday } from "@spot/shared";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 90_000);
const GEMINI_MODEL = process.env.GEMINI_GEMMA_MODEL ?? "gemma-3-27b-it";

const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const SCHEMA = {
  type: "object",
  properties: {
    evidence: { type: "string" },
    is_spot_request: { type: "boolean" },
    confidence: { type: "number" },
    preferred_days: { type: "array", items: { type: "string", enum: [...DAY_NAMES] } },
    show_hint: { type: "string" },
    note: { type: "string" },
  },
  required: ["evidence", "is_spot_request", "confidence", "preferred_days", "note"],
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

Think step by step:
1. evidence: copy the exact words where they ask to perform / get a slot. If there are none, use "".
2. is_spot_request: true ONLY if evidence is non-empty. Mentioning a show, thanking, paying or praising is NOT asking.
3. preferred_days: only days they literally name (mon, monday, tue, "kal" etc). If they name none, []. If they say any day works, list every show day.

Reply ONLY with JSON:
{"evidence": "...", "is_spot_request": boolean, "confidence": 0..1, "preferred_days": [...], "show_hint": "show name or empty", "note": "<=12 word summary for the curator, e.g. 'wants Monday, trying new 5'"}`;
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
  if (o.is_spot_request && !evidenceIsReal(String(o.evidence ?? ""), messages)) {
    o.is_spot_request = false;
    o.note = "No actual ask found in the messages";
  }
  const days = (Array.isArray(o.preferred_days) ? o.preferred_days : [])
    .map((d) => DAY_NAMES.findIndex((n) => n.toLowerCase() === String(d).toLowerCase()))
    .filter((d) => d >= 0) as Weekday[];
  const confidence = Math.max(0, Math.min(1, Number(o.confidence) || 0));
  return {
    isSpotRequest: Boolean(o.is_spot_request),
    confidence: o.is_spot_request ? confidence : Math.min(confidence, 0.3),
    preferredDays: [...new Set(days)],
    preferredShowHint: o.show_hint ? String(o.show_hint) : null,
    note: o.note ? String(o.note) : null,
    model,
  };
}

// Models whose Ollama build rejects JSON-schema output; we parse free text for these.
const noSchema = new Set<string>();

async function viaOllama(prompt: string, model: string, messages: string[]): Promise<Intent> {
  const call = (structured: boolean) =>
    fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        ...(structured ? { format: SCHEMA } : {}),
        keep_alive: "24h",
        options: { temperature: 0 },
        messages: [{ role: "user", content: prompt }],
      }),
    });
  let res = await call(!noSchema.has(model));
  if (res.status === 501 && !noSchema.has(model)) {
    noSchema.add(model);
    res = await call(false);
  }
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { message: { content: string } };
  return parseIntent(data.message.content, `ollama/${model}`, messages);
}

async function viaGemini(prompt: string, messages: string[]): Promise<Intent> {
  if (!gemini) throw new Error("GEMINI_API_KEY not set");
  const res = await gemini.models.generateContent({ model: GEMINI_MODEL, contents: prompt, config: { temperature: 0 } });
  return parseIntent(res.text ?? "", `gemini/${GEMINI_MODEL}`, messages);
}

// Ollama runs one generation at a time; queue here so a catch-up burst doesn't pile into timeouts.
let gate: Promise<unknown> = Promise.resolve();
export function classify(messages: string[], shows: Show[], model: Settings["model"]): Promise<Intent> {
  const run = gate.catch(() => undefined).then(() => classifyNow(messages, shows, model));
  gate = run;
  return run;
}

async function classifyNow(messages: string[], shows: Show[], model: Settings["model"]): Promise<Intent> {
  // Long automated messages (bills, OTPs, listings) confuse small models; a spot ask is never an essay.
  const trimmed = messages.map((m) => (m.length > 400 ? `${m.slice(0, 400)}…` : m));
  const prompt = buildPrompt(trimmed, shows);
  if (model.provider === "gemini") return viaGemini(prompt, trimmed);
  try {
    return await viaOllama(prompt, model.name, trimmed);
  } catch (err) {
    if (!model.fallback || !gemini) throw err;
    console.warn("[gemma] local model failed, falling back to Gemini API:", (err as Error).message);
    return viaGemini(prompt, trimmed);
  }
}

export async function ollamaHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}
