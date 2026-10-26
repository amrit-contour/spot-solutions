// Editing helpers for rooms: ids, blanks, validation. Pure.
import { newRoomId, roomKey, slug, type Curator, type Limit, type Room, type RoomShow, type Weekday } from "@spot/shared";
export type { Curator, Room, RoomShow };

/** An id that isn't taken: `base`, then `base-2`, `base-3`... */
export function uniqueId(base: string, taken: Iterable<string>) {
  const used = new Set(taken);
  const root = base || "item";
  let id = root;
  for (let n = 2; used.has(id); n++) id = `${root}-${n}`;
  return id;
}

export const newCuratorId = (name: string, existing: string[]) => uniqueId(slug(name), existing);
export const newRoomIdFor = (name: string, area: string, existing: string[]) => uniqueId(newRoomId(name, area), existing);

export const blankRoom = (city = "Bengaluru"): Room => ({ id: "", name: "", area: "", city, aliases: [], tags: [], notes: [], limits: [], shows: [] });

export const blankShow = (existing: RoomShow[]): RoomShow => ({
  id: uniqueId("mic", existing.map((s) => s.id)),
  name: "Mic",
  type: "mic",
  cadence: "weekly",
  times: ["21:00"],
  days: [{ weekday: 1 as Weekday, curatorIds: [] }],
});

export function validateCurator(c: Curator): string | null {
  if (!c.name.trim()) return "Give the curator a name.";
  if (c.phone) {
    const digits = c.phone.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15 || /[^\d\s+()\-.]/.test(c.phone)) return "That number doesn't look right. Use digits only, like +91 98765 43210.";
  }
  return null;
}

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Plain-language problems with a show; empty means good to save. */
export function validateShow(show: RoomShow): string[] {
  const out: string[] = [];
  if (!show.name.trim()) out.push("Give the show a name, like Mic or Late show.");
  if (show.days.length === 0) out.push("Pick at least one day this runs on.");
  const everyDayHasTimes = show.days.length > 0 && show.days.every((d) => d.times?.length);
  if (show.times.length === 0 && !everyDayHasTimes) out.push("Add a start time.");
  const all = [...show.times, ...show.days.flatMap((d) => d.times ?? [])];
  if (all.some((t) => !timeRe.test(t))) out.push("One of the times isn't valid.");
  if (new Set(show.times).size !== show.times.length) out.push("The same start time is listed twice.");
  if (show.cadence === "monthly" && !show.monthlyWeeks?.length) out.push("Pick which weeks of the month it runs, like 1st and 3rd.");
  for (const rule of [show.askRule, ...show.days.map((d) => d.askRule)]) {
    if (rule && (rule.kind === "weekday") && rule.day === undefined) out.push("Pick the weekday to ask on.");
  }
  return out;
}

export function validateLimit(l: Limit, shows: RoomShow[]): string | null {
  if (l.scope === "show" && !shows.some((s) => s.id === l.showId)) return "Pick which show the limit is for.";
  if (!l.unlimited && !l.perDay && !l.perWeek && !l.perMonth) return "Set a limit per day, week or month, or mark it as no limit.";
  return null;
}

/** Plain-language problems with a room; empty means good to save. */
export function validateRoom(room: Room, others: Room[]): string[] {
  const out: string[] = [];
  if (!room.name.trim()) out.push("Give the room a name.");
  if (!room.area.trim()) out.push("Add the area, like Indiranagar, so rooms group neatly.");
  if (!room.city.trim()) out.push("Add the city.");
  if (room.name.trim() && others.some((r) => r.id !== room.id && roomKey(r) === roomKey(room))) out.push(`You already have ${room.name.trim()} in ${room.area.trim() || "that area"}.`);
  if (room.pin && !(Math.abs(room.pin.lat) <= 90 && Math.abs(room.pin.lng) <= 180)) out.push("The map pin isn't a real place.");
  for (const n of room.notes) {
    if (n.kind === "instagram" && !n.handle?.trim()) out.push("An Instagram note needs the handle.");
    if (n.kind === "website" && !n.url?.trim()) out.push("A website note needs the address.");
  }
  for (const l of room.limits) {
    const p = validateLimit(l, room.shows);
    if (p) out.push(p);
  }
  for (const s of room.shows) for (const p of validateShow(s)) out.push(`${s.name || "A show"}: ${p}`);
  return [...new Set(out)];
}
