// "Opening soon" notices from a group ("ministry spots open by 3:15", "website is open"): what to do with one. Pure, so it is tested
// without a worker. The reading itself is in groupAlerts.ts (`interpret`, kind "opening_notice"); this decides, for a room the comic
// asks, when to push, what the push says, and how the roster's ask window for that date changes.
import { isPaused, localDate, type Room, type RoomNote, type RoomShow, type ShowOpening } from "./rooms.ts";
import { localParts, zonedToMs, type GroupUpdate, type ParsedOpening } from "./groupAlerts.ts";

/** The shows of a room the comic asks (not the ones they curate themselves, not paused that day). Named `showId` narrows it to one. */
export function askedShows(room: Room, date: string, showId?: string): RoomShow[] {
  return room.shows.filter((s) => s.myRole !== "curator" && !isPaused(room, s, date) && (!showId || s.id === showId));
}

/** How to book at a room, from its notes: "Book on the website (ministryofcomedy.in/mics). Needs the site password: ask a regular." */
export function howToBook(room: Pick<Room, "notes">, websiteSaid: boolean): string {
  const bits: string[] = [];
  for (const n of room.notes ?? []) {
    const t = noteHow(n);
    if (t) bits.push(t);
  }
  if (!bits.length && websiteSaid) bits.push("Book on the website");
  return bits.join(" ");
}

function noteHow(n: RoomNote): string {
  const tail = n.text ? ` ${n.text.replace(/\.?$/, ".")}` : "";
  switch (n.kind) {
    case "website": return `Book on the website${n.url ? ` (${n.url.replace(/^https?:\/\/(www\.)?/, "")})` : ""}.${tail}`;
    case "instagram": return `Ask on Instagram${n.handle ? ` @${n.handle}` : ""}.${tail}`;
    case "walk_in": return `Walk in.${tail}`;
    case "check_bms": return `Check BookMyShow.${tail}`;
    case "fcfs": return `First come, first served.${tail}`;
    default: return n.text ? n.text.replace(/\.?$/, ".") : "";
  }
}

export interface OpeningPlan {
  /** The room is in the roster and has a show the comic asks: worth a push and a roster update. */
  asks: boolean;
  /** ms: when to push (now, if it is open already). */
  pushAt?: number;
  /** ms: the end of the day the notice is for. */
  expiresAt: number;
  push?: { title: string; body: string };
  /** The shows whose window moves. */
  showIds: string[];
  /** HH:MM the spots open at (the time said, or the minute it was read when it only says "is open"). */
  openAt: string;
}

/**
 * Decide what a read opening notice does. A room the comic doesn't have, or only curates, gets no push and no roster change (the
 * notice stays a heads-up). Otherwise: push at the opening time ("Ministry of Comedy spots are open now" + how to book from the
 * room's notes), and the ask window of that date starts then. A time that has passed pushes at once; a notice for a day that is
 * over does nothing.
 */
export function planOpening(o: Pick<ParsedOpening, "openAt" | "website" | "date" | "showId">, room: Room | undefined, tz: string, now: number): OpeningPlan | null {
  const { date } = o;
  const expiresAt = zonedToMs(date, "23:59", tz);
  if (expiresAt <= now) return null;
  const shows = room ? askedShows(room, date, o.showId) : [];
  const openAt = o.openAt ?? localParts(now, tz).time;
  if (!room || !shows.length) return { asks: false, expiresAt, showIds: [], openAt };
  const openMs = o.openAt ? zonedToMs(date, o.openAt, tz) : now;
  const how = howToBook(room, o.website);
  return {
    asks: true,
    pushAt: Math.max(openMs, now),
    expiresAt,
    push: { title: `${room.name} spots are open now`, body: how || "Ask the curator now." },
    showIds: shows.map((s) => s.id),
    openAt,
  };
}

/** The room with this date's opening time on the shows it moves. Dates that have passed are dropped. Everything else is left as it is. */
export function applyOpeningToRoom(room: Room, o: { date: string; openAt: string; showIds: string[]; groupId?: string; messageId?: string }, now: number, tz: string): Room {
  const today = localDate(new Date(now), tz);
  return {
    ...room,
    shows: room.shows.map((s) => {
      const keep = (s.openings ?? []).filter((x) => x.date >= today && x.date !== o.date);
      if (!o.showIds.includes(s.id)) return keep.length === (s.openings ?? []).length ? s : { ...s, openings: keep.length ? keep : undefined };
      const opening: ShowOpening = { date: o.date, at: o.openAt, source: "group_message", ...(o.groupId ? { groupId: o.groupId } : {}), ...(o.messageId ? { messageId: o.messageId } : {}), appliedAt: now };
      return { ...s, openings: [...keep, opening] };
    }),
  };
}

/** Key for "the same notice twice": same room and day, and the same opening time. */
export const openingKey = (u: Pick<GroupUpdate, "roomId" | "opening">) => `${u.roomId ?? ""}|${u.opening?.date ?? ""}|${u.opening?.openAt ?? "now"}`;

/** What an opening update means for the ones already stored: a repeat is dropped, a different time for the same room and day replaces. */
export function reconcileOpening(next: Pick<GroupUpdate, "roomId" | "opening">, existing: Pick<GroupUpdate, "id" | "kind" | "roomId" | "opening" | "pushedAt" | "status">[]): { duplicate: boolean; supersede: string[] } {
  const sameDay = existing.filter((e) => e.kind === "opening" && e.roomId === next.roomId && e.opening?.date === next.opening?.date && e.status !== "dismissed");
  if (sameDay.some((e) => openingKey(e) === openingKey(next))) return { duplicate: true, supersede: [] };
  return { duplicate: false, supersede: sameDay.map((e) => e.id) };
}

/** Pushes that are due: scheduled, not sent, not cancelled, and not so late that the moment has gone (`graceMs`). */
export function openingsDue(updates: GroupUpdate[], now: number, graceMs = 20 * 60_000): { fire: GroupUpdate[]; missed: GroupUpdate[] } {
  const due = updates.filter((u) => u.kind === "opening" && u.pushAt && !u.pushedAt && u.status !== "dismissed" && u.pushAt <= now && (u.expiresAt ?? Infinity) > now);
  return { fire: due.filter((u) => now - u.pushAt! <= graceMs), missed: due.filter((u) => now - u.pushAt! > graceMs) };
}

/** Opening items whose day is over clear themselves. */
export const openingsExpired = (updates: GroupUpdate[], now: number) => updates.filter((u) => u.kind === "opening" && u.expiresAt && u.expiresAt <= now && (u.status === "info" || u.status === "pending"));
