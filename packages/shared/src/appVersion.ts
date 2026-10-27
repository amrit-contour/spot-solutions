// App version logic shared by both web apps: what version is running, what is deployed, and when to tell the user.
// Pure functions only (no DOM), so the decisions are testable; the hook that uses them is @spot/ui's useAppUpdate.

export interface VersionInfo {
  /** Git short SHA of the build (suffixed "+" for a build from a tree with uncommitted changes). */
  version: string;
  /** ISO timestamp of the build. */
  builtAt: string;
}

/** Builds served by `vite dev` are not releases: they never ask to update. */
export const DEV_VERSION = "dev";

/** Reads a /version.json body. Anything else (an HTML fallback page, a 404 body, junk) is null. */
export function parseVersionInfo(raw: unknown): VersionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const { version, builtAt } = raw as Record<string, unknown>;
  if (typeof version !== "string" || !version.trim()) return null;
  return { version: version.trim(), builtAt: typeof builtAt === "string" ? builtAt : "" };
}

/** True when the deployed build is a different release from the one running. */
export function isUpdateAvailable(running: VersionInfo, served: VersionInfo | null): boolean {
  if (!served) return false;
  if (running.version === DEV_VERSION || served.version === DEV_VERSION) return false;
  return served.version !== running.version;
}

/** "27 Oct, 6:40 PM" (adds the year when it is not the current one). Empty for a missing or bad timestamp. */
export function formatBuiltAt(iso: string, now: Date = new Date(), locale = "en-AU", timeZone?: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  const tz = timeZone ? { timeZone } : {};
  const date = d.toLocaleDateString(locale, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}), ...tz });
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", hour12: true, ...tz }).replace(/\s?(am|pm)/i, (_, m: string) => ` ${m.toUpperCase()}`);
  return `${date}, ${time}`;
}

/** "Version 46fe7dd · 27 Oct, 6:40 PM". */
export function versionLabel(info: VersionInfo, now?: Date, locale?: string, timeZone?: string): string {
  const when = formatBuiltAt(info.builtAt, now, locale, timeZone);
  return `Version ${info.version}${when ? ` · ${when}` : ""}`;
}

export type UpdatePromptDecision = "show" | "defer" | "skip";

/**
 * Whether to show the "new version is ready" prompt now. Once per version; never while the user is typing
 * (defer: try again when the input loses focus).
 */
export function updatePromptDecision(o: { available: boolean; version: string | null; promptedFor: string | null; inputFocused: boolean }): UpdatePromptDecision {
  if (!o.available || !o.version || o.promptedFor === o.version) return "skip";
  return o.inputFocused ? "defer" : "show";
}

/** Focus and visibility fire together on resume; skip a check if one just ran (or is running). */
export function shouldCheckNow(o: { lastCheckedAt: number | null; now: number; minGapMs?: number; checking?: boolean }): boolean {
  if (o.checking) return false;
  return o.lastCheckedAt == null || o.now - o.lastCheckedAt >= (o.minGapMs ?? 5_000);
}

/** True for the elements a person types into (so a prompt or reload never interrupts them). */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "image", "color"].includes((el.type ?? "text").toLowerCase());
}
