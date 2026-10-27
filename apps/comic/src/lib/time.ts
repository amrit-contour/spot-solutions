// Small time words for the comic app. Pure.
import { DAY_NAMES, formatDate, formatTime, weekdayOf } from "@spot/shared";

/** "5 min ago", "2 h ago", "yesterday", "3 days ago". */
export function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "Thu 29 Oct". */
export const shortDate = (date: string) => `${DAY_NAMES[weekdayOf(date)].slice(0, 3)} ${formatDate(date)}`;

/** "Thu 29 Oct, 8:00 PM" (no time: just the date). */
export const dateTime = (date: string, time?: string) => (time ? `${shortDate(date)}, ${formatTime(time)}` : shortDate(date));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "October 2026". */
export const monthLabel = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
