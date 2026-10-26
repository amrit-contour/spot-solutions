// "Your voice": learn how the curator writes from their own sent messages, then write each outgoing
// message that way. The template is always the safety net: if the model is off, slow, or its draft drops
// or changes a fact, the template text goes out instead.
import type WAWebJS from "whatsapp-web.js";
import {
  SAMPLE_VARS,
  VOICE_EXAMPLE_CAP,
  buildLearnPrompt,
  buildVoicePrompt,
  looksLikeTemplate,
  messageTemplate,
  MESSAGE_TYPES,
  pickVoiceSamples,
  renderTemplate,
  voiceDraftProblem,
  type Settings,
  type VoiceFacts,
  type VoiceKind,
  type VoiceProfile,
} from "@spot/shared";
import { col, userRef } from "./firebase.ts";
import { generateJson } from "./llm.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";

const MAX_DM_CHATS = 80;
const PER_CHAT = 60;
const DRAFT_TIMEOUT_MS = 30_000;

const LEARN_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" }, examples: { type: "array", items: { type: "integer" } } },
  required: ["summary", "examples"],
};
const DRAFT_SCHEMA = { type: "object", properties: { message: { type: "string" } }, required: ["message"] };

/** Every template the app sends, so messages it sent before don't get learned as "the curator's voice". */
function allTemplates(settings: Settings) {
  return [settings.ack.template, settings.confirm.template, settings.cancelSpot.template, settings.reject.template, ...MESSAGE_TYPES.map((m) => messageTemplate(settings, m.key))];
}

/** Read the curator's own sent messages (DMs and show groups) and build their voice profile. */
export async function learnVoice(uid: string, _payload: Record<string, unknown>, commandId?: string) {
  const client = sessions.require(uid);
  const { settings, shows } = watchUser(uid);
  const cmdRef = commandId ? col(uid, "commands").doc(commandId) : null;
  const progress = (p: { stage: "reading" | "learning"; chats: number; done: number; samples: number }) => cmdRef?.update({ voiceProgress: p }).catch(() => undefined);

  const me = client.info?.wid?._serialized;
  const groupIds = new Set(shows.map((s) => s.groupId).filter(Boolean) as string[]);
  const all = await client.getChats();
  const dms = all
    .filter((c) => !c.isGroup && !c.isReadOnly && ["c.us", "lid"].includes(c.id.server) && c.id._serialized !== me)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_DM_CHATS);
  const chats = [...all.filter((c) => c.isGroup && groupIds.has(c.id._serialized)), ...dms];

  const templates = allTemplates(settings);
  const mine: { body: string; at: number }[] = [];
  for (const [i, chat] of chats.entries()) {
    const msgs = await chat.fetchMessages({ limit: PER_CHAT }).catch(() => [] as WAWebJS.Message[]);
    for (const m of msgs) {
      if (!m.fromMe || m.type !== "chat" || m.isForwarded || !m.body) continue;
      if (looksLikeTemplate(m.body, templates)) continue;
      mine.push({ body: m.body, at: m.timestamp * 1000 });
    }
    if (i % 5 === 0) await progress({ stage: "reading", chats: chats.length, done: i + 1, samples: mine.length });
  }

  const samples = pickVoiceSamples(mine);
  if (samples.length < 10) throw new Error(`Only found ${samples.length} messages you wrote. Send a few more to comics, then try again.`);
  await progress({ stage: "learning", chats: chats.length, done: chats.length, samples: samples.length });

  const { text, model } = await generateJson(uid, settings.ai, buildLearnPrompt(samples), LEARN_SCHEMA);
  const o = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { summary?: unknown; examples?: unknown };
  const summary = String(o.summary ?? "").trim().slice(0, 1500);
  if (!summary) throw new Error("The model didn't describe your style. Try again.");
  const picked = (Array.isArray(o.examples) ? o.examples : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < samples.length)
    .map((n) => samples[n]);
  // Pad with varied lengths if the model picked too few.
  const examples = [...new Set([...picked, ...samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / VOICE_EXAMPLE_CAP)) === 0)])].slice(0, VOICE_EXAMPLE_CAP);

  const profile: VoiceProfile = { summary, examples, learnedAt: Date.now(), sampleCount: samples.length };
  await userRef(uid).set({ settings: { voice: { enabled: settings.voice?.enabled ?? false, profile } } }, { merge: true });
  console.log(`[voice] learned from ${samples.length} messages (${model})`);
  return { samples: samples.length, examples: examples.length, model };
}

/**
 * The message to send: in the curator's voice when that's on and the draft passes the fact check,
 * otherwise `reference` (their template, filled in) unchanged.
 */
export async function inVoice(uid: string, kind: VoiceKind, reference: string, facts: VoiceFacts): Promise<string> {
  const { settings } = watchUser(uid);
  const profile = settings.voice?.enabled ? settings.voice.profile : null;
  if (!profile?.summary || !reference.trim()) return reference;
  try {
    const draft = await draftOnce(uid, settings, profile, kind, reference, facts);
    return draft ?? reference;
  } catch (e) {
    console.warn(`[voice] ${kind}: using the template (${(e as Error).message})`);
    return reference;
  }
}

async function draftOnce(uid: string, settings: Settings, profile: VoiceProfile, kind: VoiceKind, reference: string, facts: VoiceFacts) {
  const prompt = buildVoicePrompt({ kind, profile, reference, comicName: String(facts.name ?? "there"), facts });
  // Two tries: a small local model sometimes drops a fact on the first go.
  for (const temperature of [0.8, 0.5]) {
    const run = generateJson(uid, settings.ai, prompt, DRAFT_SCHEMA, { temperature });
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("model too slow")), DRAFT_TIMEOUT_MS));
    const { text } = await Promise.race([run, timeout]);
    const o = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { message?: unknown };
    const draft = String(o.message ?? "").trim();
    const problem = voiceDraftProblem(draft, reference, facts);
    if (!problem) return draft;
    console.warn(`[voice] ${kind}: draft rejected (${problem})`);
  }
  return null;
}

/** Settings → Your voice → Try it: three drafts of one message with sample details, plus the template version. */
export async function previewVoice(uid: string, { kind }: Record<string, unknown>) {
  const { settings } = watchUser(uid);
  const profile = settings.voice?.profile;
  if (!profile?.summary) throw new Error("Learn your voice first.");
  const k = (String(kind ?? "confirm") as VoiceKind);
  const template = k === "ack" ? settings.ack.template : k === "confirm" ? settings.confirm.template : k === "cancelSpot" ? settings.cancelSpot.template : k === "reject" ? settings.reject.template : messageTemplate(settings, k);
  const sample = MESSAGE_TYPES.find((m) => m.key === k)?.sample ?? {};
  const facts = { ...SAMPLE_VARS, ...sample } as VoiceFacts;
  const reference = renderTemplate(template, facts as Record<string, string | number>);
  const drafts: { text: string; problem: string | null }[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      const { text } = await generateJson(uid, settings.ai, buildVoicePrompt({ kind: k, profile, reference, comicName: String(facts.name), facts }), DRAFT_SCHEMA, { temperature: 0.8 });
      const t = String((JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { message?: unknown }).message ?? "").trim();
      drafts.push({ text: t, problem: voiceDraftProblem(t, reference, facts) });
    } catch (e) {
      drafts.push({ text: "", problem: (e as Error).message });
    }
  }
  return { reference, drafts };
}
