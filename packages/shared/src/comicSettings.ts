// users/{uid}.comicSettings: what the comic chose in Nothing BOT Comedy's Settings. The rules that read it live here so the app and the
// worker agree (and so they are tested): which pushes are on, and when asks start going out.

/** The push kinds a comic can switch off, as stored in comicSettings.push. */
export type ComicPushKey = "spotAlert" | "askOpen" | "askClosing" | "askReply" | "opening";
export type ComicPushPrefs = Partial<Record<ComicPushKey, boolean>>;

export const COMIC_PUSH_KEYS: readonly ComicPushKey[] = ["spotAlert", "askOpen", "askClosing", "askReply", "opening"];

/** The kind a push carries (notifyComic's `kind`) to the setting that controls it. A kind not listed here is never switched off. */
export const COMIC_PUSH_KEY_OF: Record<string, ComicPushKey> = {
  spot_alert: "spotAlert",
  ask_open: "askOpen",
  ask_closing: "askClosing",
  ask_reply: "askReply",
  spot_opening: "opening",
};

/** Is this kind of push on? Everything is on until the comic switches it off. */
export function comicPushOn(settings: { push?: ComicPushPrefs } | null | undefined, kind: string): boolean {
  const key = COMIC_PUSH_KEY_OF[kind];
  return !key || settings?.push?.[key] !== false;
}

/** When asks start going out each ping day, if the comic doesn't say: 9 AM. */
export const DEFAULT_ASK_SEND_FROM = "09:00";

/** "HH:MM" (24 h) when valid, else the default. Also accepts "9:00". */
export function askSendFromOf(settings: { askSendFrom?: string } | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(settings?.askSendFrom?.trim() ?? "");
  if (!m) return DEFAULT_ASK_SEND_FROM;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? DEFAULT_ASK_SEND_FROM : `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** "Send in my voice" for a new ask: on unless the comic switched it off in Settings. */
export const askVoiceDefault = (settings: { askVoice?: boolean } | null | undefined): boolean => settings?.askVoice !== false;
