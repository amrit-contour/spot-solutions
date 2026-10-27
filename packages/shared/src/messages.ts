// Every message Nothing BOT Curate can send a comic, beyond the four with their own settings
// (ack, confirm, cancelSpot, reject). Each has a default; the curator can rewrite any of them in
// Settings → Messages, and saved snippets (custom templates) can be dropped into any reply box.
import { renderTemplate, type TemplateVars } from "./template.ts";
import type { Settings } from "./types.ts";

export type MessageKey =
  | "onboard"
  | "offer"
  | "offerFull"
  | "cancelDone"
  | "cancelNone"
  | "statusConfirmed"
  | "statusPencilled"
  | "statusNone"
  | "showInfo"
  | "lastSpot"
  | "heldWindow"
  | "heldLastWeek"
  | "groupWelcome"
  | "groupLineup"
  | "groupVenue"
  | "groupReminder"
  | "groupPocs"
  | "groupReachEarly"
  | "groupPoster"
  | "groupBusking"
  | "groupCleanup";

export type MessageGroup = "replies" | "offers" | "held" | "group";

export interface MessageType {
  key: MessageKey;
  group: MessageGroup;
  label: string;
  /** When it goes out, in plain words. */
  when: string;
  default: string;
  /** Variables this message can use on top of {{name}}. */
  vars: readonly string[];
  /** Sample values for the preview, on top of SAMPLE_VARS. */
  sample?: TemplateVars;
  /** What this message is when the curator hasn't changed it. Missing: text. */
  defaultKind?: MessageKind;
  defaultPoll?: PollSpec;
  /** Sends the venue pin after the text unless the curator turns it off. */
  defaultAttachLocation?: boolean;
  /** Goes to a group, so there is no {{name}}. */
  toGroup?: boolean;
}

/** An offer poll: the first option books the spot, the second passes. */
export const OFFER_POLL_OPTIONS = ["Yes, I'll take it", "Pass"] as const;

const SHOW_VARS = ["show", "venue", "day", "date", "time"] as const;
const GROUP_VARS = [...SHOW_VARS, "mapsLink"] as const;

export const MESSAGE_TYPES: readonly MessageType[] = [
  {
    key: "onboard",
    group: "replies",
    label: "Who are you?",
    when: "Drafted when someone you haven't saved asks for a spot (if “Ask new faces who they are” is on).",
    default: "Hey {{name}}! Don't think I have you saved yet 🙂 Could you tell me your full name, which comedy scene you're from, and how long you've been doing comedy? Also, are you travelling?",
    vars: [],
  },
  {
    key: "cancelDone",
    group: "replies",
    label: "Drop-out, confirmed",
    when: "A booked comic says they can't make it.",
    default: "Okay {{name}}, I've cancelled your spot for {{show}}, {{day}} {{date}} at {{time}}. See you next time! 🫡",
    vars: SHOW_VARS,
  },
  {
    key: "cancelNone",
    group: "replies",
    label: "Drop-out, no spot",
    when: "Someone cancels but isn't on any lineup this week.",
    default: "Hey {{name}}, you don't have a spot this week, so there's nothing to cancel.",
    vars: [],
  },
  {
    key: "statusConfirmed",
    group: "replies",
    label: "Am I up? (confirmed)",
    when: "They ask if they're on, and their lineup is confirmed.",
    default: "Yes {{name}}! You're on {{show}}, {{day}} {{date}} at {{time}}.",
    vars: SHOW_VARS,
  },
  {
    key: "statusPencilled",
    group: "replies",
    label: "Am I up? (pencilled in)",
    when: "They're on a lineup you haven't confirmed yet.",
    default: "You're pencilled in, {{name}}, but the lineup isn't final yet. I'll confirm soon.",
    vars: SHOW_VARS,
  },
  {
    key: "statusNone",
    group: "replies",
    label: "Am I up? (no spot)",
    when: "They aren't on any lineup this week.",
    default: "You don't have a spot this week yet, {{name}}. I'll let you know once the lineup is out.",
    vars: [],
  },
  {
    key: "showInfo",
    group: "replies",
    label: "Where and when",
    when: "They ask about timings or the venue. {{shows}} lists every active show.",
    default: "Hey {{name}}! Here's where and when:\n{{#shows}}{{shows}}{{/shows}}{{^shows}}I'll share the details soon.{{/shows}}",
    vars: ["shows"],
    sample: { shows: "• Monday Mic: Mondays at 8:30 PM, The Laugh Store (Indiranagar)\n• Tuesday Mic: Tuesdays at 8:00 PM, Bloom" },
  },
  {
    key: "lastSpot",
    group: "replies",
    label: "When was my last spot?",
    when: "They ask when they last performed.",
    default: "{{#lastShow}}Your last spot was {{lastShow}} on {{lastDate}}.{{/lastShow}}{{^lastShow}}I don't have a record of your last spot yet.{{/lastShow}}",
    vars: ["lastShow", "lastDate"],
    sample: { lastShow: "Monday Mic", lastDate: "20 Oct" },
  },
  {
    key: "offer",
    group: "offers",
    label: "Spot offer",
    when: "You offer an open slot from the lineup. A “yes” books it.",
    default: "Hey {{name}}! A spot just opened up: {{show}}, {{day}} {{date}} at {{time}}. Want it? Reply *yes* or *no*.",
    vars: SHOW_VARS,
    // A poll by default: one tap books it. The text above is what goes out if the curator switches to Text,
    // and a typed yes or no is still understood after a poll.
    defaultKind: "poll",
    defaultPoll: { question: "{{name}}, a spot just opened up: {{show}}, {{day}} {{date}} at {{time}}. Want it?", options: [...OFFER_POLL_OPTIONS], multi: false },
  },
  {
    key: "offerFull",
    group: "offers",
    label: "Offer taken",
    when: "They said yes, but the slot filled first.",
    default: "Ah, sorry {{name}}! That spot just got filled. I'll keep you in mind for the next one 🙏",
    vars: [],
  },
  {
    key: "heldWindow",
    group: "held",
    label: "Outside the request window",
    when: "They asked before requests opened (Request rules → window).",
    default: "Hey {{name}}! Spot requests for the week open {{opens}}. Ping me then 🙏",
    vars: ["opens"],
    sample: { opens: "Saturday 3:00 PM" },
  },
  {
    key: "heldLastWeek",
    group: "held",
    label: "Performed recently",
    when: "They did a spot within your cooldown (Request rules → Hold recent comics). Ad hoc spots don't count.",
    default: "Hey {{name}}, you were up {{lastWhen}}, so I'm giving others a turn this time. Ask me again {{askAgain}}!",
    vars: ["lastWhen", "askAgain", "lastShow", "lastDate"],
    sample: { lastWhen: "last week", askAgain: "next week", lastShow: "Monday Mic", lastDate: "20 Oct" },
  },
  {
    key: "groupWelcome",
    group: "group",
    label: "Group invite note",
    when: "Shown with the invite when someone can't be added to a show's group directly.",
    default: "You're on for {{show}}!",
    vars: ["show"],
  },
  {
    key: "groupLineup",
    group: "group",
    label: "Lineup post",
    when: "Posted in the show's group at the time you schedule. Waits for a confirmed lineup.",
    default: "*{{show}}: the lineup* 🎤\n{{day}} {{date}}, {{time}} at {{venue}}\n\n{{lineup}}\n\nPlease reach 30 minutes early.",
    vars: [...GROUP_VARS, "lineup", "count"],
    sample: { lineup: "1. Rohan\n2. Priya\n3. Karthik", count: 3 },
    toGroup: true,
  },
  {
    key: "groupVenue",
    group: "group",
    label: "Venue and location",
    when: "Posted in the show's group at the time you schedule, with the venue's map pin.",
    default: "📍 See you at *{{venue}}* {{#mapsLink}}\n{{mapsLink}}{{/mapsLink}}\nShow starts {{time}}.",
    vars: GROUP_VARS,
    defaultAttachLocation: true,
    toGroup: true,
  },
  {
    key: "groupReminder",
    group: "group",
    label: "Show reminder",
    when: "Posted in the show's group at the time you schedule, usually the day before.",
    default: "Reminder: *{{show}}* is on {{day}} {{date}} at {{time}}, {{venue}}. Can't make it? Tell me today so someone else gets the spot 🙏",
    vars: GROUP_VARS,
    toGroup: true,
  },
  {
    key: "groupPocs",
    group: "group",
    label: "Who the POCs are",
    when: "Posted in the show's group at the time you schedule. {{pocs}} tags each POC so they get notified.",
    default: "For *{{show}}* on {{day}}, your POCs are {{pocs}}. Reach out to them for anything about the night 🙌",
    vars: [...GROUP_VARS, "pocs"],
    sample: { pocs: "@Amrit, @Kashni" },
    toGroup: true,
  },
  {
    key: "groupReachEarly",
    group: "group",
    label: "Reach on time",
    when: "Posted in the show's group at the time you schedule, usually on the show day.",
    default: "Hey everyone! *{{show}}* starts at {{time}} today. Please reach {{venue}} 30 minutes early so we can start on time ⏰",
    vars: GROUP_VARS,
    toGroup: true,
  },
  {
    key: "groupPoster",
    group: "group",
    label: "Share the poster",
    when: "Posted in the show's group at the time you schedule, once the poster is out.",
    default: "The poster for *{{show}}* ({{day}} {{date}}) is out! Please share it on your Instagram stories and tag the venue 🙏",
    vars: GROUP_VARS,
    toGroup: true,
  },
  {
    key: "groupBusking",
    group: "group",
    label: "Busking notice",
    when: "Posted in the show's group at the time you schedule, before the show.",
    default: "Busking today before *{{show}}*! Please reach {{venue}} early and help bring the crowd in. Show starts {{time}} 📣",
    vars: GROUP_VARS,
    toGroup: true,
  },
  {
    key: "groupCleanup",
    group: "group",
    label: "After the show",
    when: "Sent in the group the day after the show, right before the group is cleared for next week (if cleanup is on).",
    default: "Thank you all for *{{show}}* yesterday! 🙏 Clearing the group for next week's lineup. See you at the next one.",
    vars: GROUP_VARS,
    toGroup: true,
  },
];

export const MESSAGE_GROUPS: { id: MessageGroup; label: string }[] = [
  { id: "replies", label: "Replies to comics" },
  { id: "offers", label: "Spot offers" },
  { id: "held", label: "Held requests" },
  { id: "group", label: "Show groups" },
];

export const messageType = (key: MessageKey) => MESSAGE_TYPES.find((m) => m.key === key)!;

export type MessageKind = "text" | "poll" | "location";

export interface PollSpec {
  question: string;
  options: string[];
  /** Voters can pick more than one option. */
  multi: boolean;
}

/** One outgoing message: text, a poll, or a venue pin; any text can also be followed by the pin. */
export interface RichMessage {
  kind: MessageKind;
  body: string;
  poll?: PollSpec;
  /** Send the venue's location pin after the text. Skipped silently when the venue has no coordinates. */
  attachLocation?: boolean;
}

/** What Settings.messages stores per message. Older docs hold a plain string, which means text. */
export type MessageOverride = string | RichMessage;

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 12;
export const POLL_QUESTION_MAX = 255;
export const POLL_OPTION_MAX = 100;

/** Read a stored message of any age (string, object, or nothing) into the current shape. */
export function normalizeMessage(raw: unknown, fallback: RichMessage = { kind: "text", body: "" }): RichMessage {
  if (typeof raw === "string") return raw.trim() ? { kind: "text", body: raw } : fallback;
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Partial<RichMessage>;
  const kind: MessageKind = o.kind === "poll" || o.kind === "location" ? o.kind : "text";
  const body = typeof o.body === "string" ? o.body : "";
  if (kind === "text" && !body.trim()) return fallback;
  const poll = o.poll && typeof o.poll === "object" ? { question: String(o.poll.question ?? ""), options: Array.isArray(o.poll.options) ? o.poll.options.map(String) : [], multi: Boolean(o.poll.multi) } : undefined;
  return { kind, body, ...(kind === "poll" && { poll: poll ?? { question: "", options: ["", ""], multi: false } }), ...(o.attachLocation && kind === "text" && { attachLocation: true }) };
}

/** Why a poll can't be sent, in words for the curator, or null when it's fine. Variables are checked as written. */
export function pollProblem(p: PollSpec | undefined | null): string | null {
  if (!p) return "Add a question and at least two options.";
  if (!p.question.trim()) return "Add a question for the poll.";
  if (p.question.length > POLL_QUESTION_MAX) return `The question is over ${POLL_QUESTION_MAX} characters.`;
  const opts = p.options.map((o) => o.trim()).filter(Boolean);
  if (opts.length < POLL_MIN_OPTIONS) return `A poll needs at least ${POLL_MIN_OPTIONS} options.`;
  if (opts.length > POLL_MAX_OPTIONS) return `A poll can have at most ${POLL_MAX_OPTIONS} options.`;
  if (opts.some((o) => o.length > POLL_OPTION_MAX)) return `Options can be up to ${POLL_OPTION_MAX} characters.`;
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return "Two options are the same.";
  return null;
}

/** The poll as WhatsApp wants it: trimmed, no blanks, no repeats. */
export function cleanPoll(p: PollSpec): PollSpec {
  const seen = new Set<string>();
  const options = p.options.map((o) => o.trim().slice(0, POLL_OPTION_MAX)).filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
  return { question: p.question.trim().slice(0, POLL_QUESTION_MAX), options: options.slice(0, POLL_MAX_OPTIONS), multi: p.multi };
}

/** What to save for a message: a plain string while it's just text (so older apps still read it), an object otherwise. */
export function storeMessage(m: RichMessage): MessageOverride {
  if (m.kind === "text" && !m.attachLocation) return m.body;
  return { kind: m.kind, body: m.body, ...(m.kind === "poll" && m.poll && { poll: { ...m.poll, options: m.poll.options.map((o) => o.trim()).filter(Boolean) } }), ...(m.kind === "text" && m.attachLocation && { attachLocation: true }) };
}

/** The curator's version of a message (or the default) in full. */
export function messageRich(settings: Pick<Settings, "messages">, key: MessageKey): RichMessage {
  const t = messageType(key);
  const fallback: RichMessage = { kind: t.defaultKind ?? "text", body: t.default, ...(t.defaultPoll && { poll: t.defaultPoll }), ...(t.defaultAttachLocation && { attachLocation: true }) };
  return normalizeMessage(settings.messages?.[key], fallback);
}

/** The text of a message, whatever its kind. */
export function messageTemplate(settings: Pick<Settings, "messages">, key: MessageKey): string {
  return messageRich(settings, key).body.trim() || messageType(key).default;
}

export function renderMessage(settings: Pick<Settings, "messages">, key: MessageKey, vars: TemplateVars): string {
  return renderTemplate(messageTemplate(settings, key), vars);
}

/** Fill in the variables in everything a message says: text, poll question, poll options. */
export function renderRich(msg: RichMessage, vars: TemplateVars): RichMessage {
  const out: RichMessage = { ...msg, body: renderTemplate(msg.body, vars) };
  if (msg.poll) out.poll = cleanPoll({ ...msg.poll, question: renderTemplate(msg.poll.question, vars), options: msg.poll.options.map((o) => renderTemplate(o, vars)) });
  return out;
}

/** What an offer poll vote means: true takes the spot, false passes, null is nothing (a vote taken back). */
export function offerVote(selected: string[], options: readonly string[]): boolean | null {
  if (!selected.length) return null;
  const yes = options[0]?.toLowerCase();
  const no = options[1]?.toLowerCase();
  const picks = selected.map((s) => s.toLowerCase());
  if (yes && picks.includes(yes) && !(no && picks.includes(no))) return true;
  if (no && picks.includes(no) && !(yes && picks.includes(yes))) return false;
  return null;
}

/** A saved reply the curator can drop into any message box. Older ones have only a body (text). */
export interface Snippet {
  id: string;
  title: string;
  body: string;
  kind?: MessageKind;
  poll?: PollSpec;
  attachLocation?: boolean;
}

/** A snippet as a message. */
export const snippetRich = (s: Snippet): RichMessage => normalizeMessage({ kind: s.kind, body: s.body, poll: s.poll, attachLocation: s.attachLocation }, { kind: "text", body: s.body });

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "sir", "bro", "bhai", "anna", "the", "its", "it's", "im", "i'm"]);

/**
 * The first name to greet someone by, from whatever name we have for them.
 * Skips emoji, honorifics and initials; a phone number or empty name gives "" (render it as "there").
 */
export function firstName(full: string | null | undefined): string {
  if (!full) return "";
  const t = full.normalize("NFKC").trim();
  if (!t || /^[+\d\s()-]+$/.test(t)) return "";
  const words = t
    .split(/[\s_|/,·•-]+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'.]+$/gu, "").replace(/\.+$/, ""))
    .filter((w) => /\p{L}/u.test(w));
  const pick = words.find((w) => w.length > 1 && !HONORIFICS.has(w.toLowerCase())) ?? words[0] ?? "";
  if (!pick) return "";
  // "ROHAN" or "rohan" → "Rohan"; leave mixed case ("McKenzie") alone.
  return pick === pick.toUpperCase() || pick === pick.toLowerCase() ? pick[0].toUpperCase() + pick.slice(1).toLowerCase() : pick;
}

/** {{name}} for a template: the first name, or "there" when we don't know it ("Hey there!"). */
export const greetName = (full: string | null | undefined) => firstName(full) || "there";
