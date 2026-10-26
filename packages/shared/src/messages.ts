// Every message Spot Solutions can send a comic, beyond the four with their own settings
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
  | "groupWelcome";

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
}

const SHOW_VARS = ["show", "venue", "day", "date", "time"] as const;

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
    label: "Performed last week",
    when: "They were up last week and “Hold last week's comics” is on.",
    default: "Hey {{name}}, you were up last week, so I'm giving others a turn this time. Ask me again next week!",
    vars: [],
  },
  {
    key: "groupWelcome",
    group: "group",
    label: "Group invite note",
    when: "Shown with the invite when someone can't be added to a show's group directly.",
    default: "You're on for {{show}}!",
    vars: ["show"],
  },
];

export const MESSAGE_GROUPS: { id: MessageGroup; label: string }[] = [
  { id: "replies", label: "Replies to comics" },
  { id: "offers", label: "Spot offers" },
  { id: "held", label: "Held requests" },
  { id: "group", label: "Show groups" },
];

export const messageType = (key: MessageKey) => MESSAGE_TYPES.find((m) => m.key === key)!;

/** The curator's version of a message, or the default. */
export function messageTemplate(settings: Pick<Settings, "messages">, key: MessageKey): string {
  return settings.messages?.[key]?.trim() || messageType(key).default;
}

export function renderMessage(settings: Pick<Settings, "messages">, key: MessageKey, vars: TemplateVars): string {
  return renderTemplate(messageTemplate(settings, key), vars);
}

/** A saved reply the curator can drop into any message box. */
export interface Snippet {
  id: string;
  title: string;
  body: string;
}

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
