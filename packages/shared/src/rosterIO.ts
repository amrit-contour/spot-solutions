// Export / import of a roster: a versioned JSON file, and a flat CSV (one row per show-day, easy in Excel / Sheets).
// Exports keep shareable fields only (see shareable()); `full: true` in JSON is a backup that keeps the private ones too.
import {
  newRoomId, shareableRoster, slug, curatorKey,
  type AskRule, type Closure, type Curator, type CuratorShared, type DayPlan, type Limit, type MyRole, type Pin, type Room, type RoomNote,
  type RoomShared, type Roster, type SharedRoster, type RoomShow, type ShowShared,
} from "./rooms.ts";
import { DAY_SHORT } from "./week.ts";
import type { Weekday } from "./types.ts";

export const ROSTER_FORMAT = "nbc-roster";
export const ROSTER_VERSION = 1;

export class RosterFormatError extends Error {}

export interface RosterFileMeta {
  title?: string;
  city?: string;
  exportedAt?: number;
  version: number;
}

// ---------------------------------------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------------------------------------

export function toRosterJson(roster: Roster | SharedRoster, opts: { title?: string; city?: string; exportedAt?: number; full?: boolean } = {}): string {
  const body = opts.full ? roster : shareableRoster(roster);
  return JSON.stringify({ format: ROSTER_FORMAT, version: ROSTER_VERSION, exportedAt: opts.exportedAt ?? Date.now(), title: opts.title, city: opts.city, rooms: body.rooms, curators: body.curators }, null, 2);
}

const KINDS = ["same_day", "day_before", "weekday", "start_of_week", "start_of_month", "they_reach_out", "fcfs", "walk_in", "website", "instagram"];
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
const weekday = (v: unknown): Weekday | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6 ? (v as Weekday) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function readRule(v: unknown): AskRule | undefined {
  const o = obj(v);
  if (!o || typeof o.kind !== "string" || !KINDS.includes(o.kind)) return undefined;
  const rule: Record<string, unknown> = { kind: o.kind };
  if (o.morning === true) rule.morning = true;
  if (o.kind === "weekday") {
    const d = weekday(o.day);
    if (d === undefined) return undefined;
    rule.day = d;
  }
  if (o.kind === "start_of_week" && weekday(o.day) !== undefined) rule.day = o.day;
  if (str(o.note)) rule.note = str(o.note);
  return rule as AskRule;
}

function readDay(v: unknown): DayPlan | null {
  const o = obj(v);
  const wd = weekday(o?.weekday);
  if (!o || wd === undefined) return null;
  const d: DayPlan = { weekday: wd, curatorIds: strs(o.curatorIds) };
  if (strs(o.times).length) d.times = strs(o.times);
  if (o.theyReachOut === true) d.theyReachOut = true;
  const si = obj(o.standIn);
  if (si && str(si.curatorId) && str(si.until)) d.standIn = { curatorId: str(si.curatorId)!, until: str(si.until)! };
  const rule = readRule(o.askRule);
  if (rule) d.askRule = rule;
  if (str(o.note)) d.note = str(o.note);
  return d;
}

function readShow(v: unknown): RoomShow | null {
  const o = obj(v);
  if (!o || !str(o.id) || !str(o.name)) return null;
  const type = o.type === "show" || o.type === "both" ? o.type : "mic";
  const cadence = o.cadence === "daily" || o.cadence === "monthly" ? o.cadence : "weekly";
  const s: RoomShow = {
    id: str(o.id)!, name: str(o.name)!, type, cadence, times: strs(o.times),
    days: (Array.isArray(o.days) ? o.days : []).map(readDay).filter((d): d is DayPlan => d !== null),
  };
  const mw = Array.isArray(o.monthlyWeeks) ? o.monthlyWeeks.filter((n): n is number => typeof n === "number") : [];
  if (mw.length) s.monthlyWeeks = mw;
  const rule = readRule(o.askRule);
  if (rule) s.askRule = rule;
  if (strs(o.tags).length) s.tags = strs(o.tags);
  if (str(o.note)) s.note = str(o.note);
  // Private fields: only present in a full backup.
  if (o.myRole === "regular" || o.myRole === "curator") s.myRole = o.myRole as MyRole;
  if (str(o.pausedUntil)) s.pausedUntil = str(o.pausedUntil);
  if (str(o.myNotes)) s.myNotes = str(o.myNotes);
  const closures = (Array.isArray(o.closures) ? o.closures : []).flatMap((c): Closure[] => {
    const co = obj(c);
    if (!co || !str(co.until)) return [];
    return [{ ...co, until: str(co.until)!, source: co.source === "group_message" ? "group_message" : "manual" } as Closure];
  });
  if (closures.length) s.closures = closures;
  return s;
}

function readLimit(v: unknown): Limit | null {
  const o = obj(v);
  if (!o || (o.scope !== "room" && o.scope !== "show")) return null;
  const l: Limit = { scope: o.scope };
  if (str(o.showId)) l.showId = str(o.showId);
  for (const k of ["perDay", "perWeek", "perMonth"] as const) if (num(o[k]) !== undefined) l[k] = num(o[k]);
  if (o.unlimited === true) l.unlimited = true;
  return l;
}

function readNote(v: unknown): RoomNote | null {
  const o = obj(v);
  if (!o || typeof o.kind !== "string" || !["instagram", "website", "walk_in", "check_bms", "fcfs", "other"].includes(o.kind)) return null;
  const n: RoomNote = { kind: o.kind as RoomNote["kind"] };
  for (const k of ["handle", "url", "text"] as const) if (str(o[k])) n[k] = str(o[k]);
  return n;
}

function readRoom(v: unknown): Room {
  const o = obj(v);
  if (!o || !str(o.id) || !str(o.name)) throw new RosterFormatError("A room is missing its id or name.");
  const r: Room = {
    id: str(o.id)!, name: str(o.name)!, area: str(o.area) ?? "", city: str(o.city) ?? "",
    aliases: strs(o.aliases), tags: strs(o.tags),
    notes: (Array.isArray(o.notes) ? o.notes : []).map(readNote).filter((n): n is RoomNote => n !== null),
    limits: (Array.isArray(o.limits) ? o.limits : []).map(readLimit).filter((l): l is Limit => l !== null),
    shows: (Array.isArray(o.shows) ? o.shows : []).map(readShow).filter((s): s is RoomShow => s !== null),
  };
  if (str(o.brand)) r.brand = str(o.brand);
  const pin = obj(o.pin);
  if (pin && num(pin.lat) !== undefined && num(pin.lng) !== undefined) {
    const p: Pin = { lat: num(pin.lat)!, lng: num(pin.lng)! };
    if (str(pin.mapsUrl)) p.mapsUrl = str(pin.mapsUrl);
    if (str(pin.label)) p.label = str(pin.label);
    r.pin = p;
  }
  if (str(o.myNotes)) r.myNotes = str(o.myNotes);
  if (str(o.pausedUntil)) r.pausedUntil = str(o.pausedUntil);
  return r;
}

function readCurator(v: unknown): Curator {
  const o = obj(v);
  if (!o || !str(o.id) || !str(o.name)) throw new RosterFormatError("A curator is missing its id or name.");
  const c: Curator = { id: str(o.id)!, name: str(o.name)! };
  for (const k of ["phone", "instagram", "notes", "comicId"] as const) if (str(o[k])) c[k] = str(o[k]);
  return c;
}

/** Read a file made by toRosterJson. Unknown fields are dropped; a newer version than this app knows is refused. */
export function fromRosterJson(text: string): { roster: Roster; meta: RosterFileMeta } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RosterFormatError("That isn't a roster file (not valid JSON).");
  }
  const o = obj(raw);
  if (!o || o.format !== ROSTER_FORMAT) throw new RosterFormatError("That isn't a Nothing BOT roster file.");
  const version = num(o.version);
  if (version === undefined || version < 1) throw new RosterFormatError("This roster file has no version.");
  if (version > ROSTER_VERSION) throw new RosterFormatError(`This roster file is from a newer app (version ${version}). Update the app and try again.`);
  // Future: migrate older versions here, one step at a time.
  const roster: Roster = {
    rooms: (Array.isArray(o.rooms) ? o.rooms : []).map(readRoom),
    curators: (Array.isArray(o.curators) ? o.curators : []).map(readCurator),
  };
  return { roster, meta: { title: str(o.title), city: str(o.city), exportedAt: num(o.exportedAt), version } };
}

// ---------------------------------------------------------------------------------------------------------------------------
// CSV: one row per show-day
// ---------------------------------------------------------------------------------------------------------------------------

export const CSV_COLUMNS = [
  "room", "room_id", "brand", "area", "city", "aliases", "tags", "lat", "lng", "maps_url", "place", "room_notes", "limits",
  "show", "show_id", "type", "cadence", "monthly_weeks", "show_times", "show_tags", "show_ask_rule", "show_note",
  "day", "times", "curators", "curator_phones", "curator_instagram", "they_reach_out", "ask_rule", "day_note",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type RosterRow = Record<CsvColumn, string>;

const LIST = "; ";
const DAY_CODES = DAY_SHORT.map((d) => d.toLowerCase());

export function encodeRule(rule: AskRule | undefined): string {
  if (!rule) return "";
  const parts: string[] = [rule.kind];
  if (rule.kind === "weekday") parts.push(DAY_CODES[rule.day]!);
  if (rule.kind === "start_of_week" && rule.day !== undefined) parts.push(DAY_CODES[rule.day]!);
  if ("morning" in rule && rule.morning) parts.push("morning");
  return parts.join(" ") + (rule.note ? ` | ${rule.note}` : "");
}

export function decodeRule(text: string): AskRule | undefined {
  const [head = "", ...noteParts] = text.split("|");
  const note = noteParts.join("|").trim() || undefined;
  const [kind, ...rest] = head.trim().toLowerCase().split(/\s+/);
  if (!kind || !KINDS.includes(kind)) return undefined;
  const morning = rest.includes("morning");
  const day = rest.map((w) => DAY_CODES.indexOf(w.slice(0, 3))).find((i) => i >= 0) as Weekday | undefined;
  let rule: Record<string, unknown> = { kind };
  if (kind === "weekday") {
    if (day === undefined) return undefined;
    rule.day = day;
  }
  if (kind === "start_of_week" && day !== undefined) rule.day = day;
  if (morning && ["same_day", "day_before", "weekday"].includes(kind)) rule.morning = true;
  if (note) rule = { ...rule, note };
  return rule as AskRule;
}

const blankRow = (): RosterRow => Object.fromEntries(CSV_COLUMNS.map((c) => [c, ""])) as RosterRow;

/** The flat row model: room and show columns repeat on every day row. Only shareable fields. */
export function toRows(roster: Roster | SharedRoster): RosterRow[] {
  const shared = shareableRoster(roster);
  const cur = (id: string) => shared.curators.find((c) => c.id === id);
  const rows: RosterRow[] = [];
  for (const room of shared.rooms) {
    const base = blankRow();
    Object.assign(base, {
      room: room.name, room_id: room.id, brand: room.brand ?? "", area: room.area, city: room.city,
      aliases: room.aliases.join(LIST), tags: room.tags.join(LIST),
      lat: room.pin ? String(room.pin.lat) : "", lng: room.pin ? String(room.pin.lng) : "", maps_url: room.pin?.mapsUrl ?? "", place: room.pin?.label ?? "",
      room_notes: room.notes.length ? JSON.stringify(room.notes) : "", limits: room.limits.length ? JSON.stringify(room.limits) : "",
    });
    if (!room.shows.length) rows.push(base);
    for (const show of room.shows) {
      const sh: RosterRow = {
        ...base, show: show.name, show_id: show.id, type: show.type, cadence: show.cadence, monthly_weeks: (show.monthlyWeeks ?? []).join(LIST),
        show_times: show.times.join(LIST), show_tags: (show.tags ?? []).join(LIST), show_ask_rule: encodeRule(show.askRule), show_note: show.note ?? "",
      };
      if (!show.days.length) rows.push(sh);
      for (const d of show.days) {
        const cs = d.curatorIds.map(cur);
        rows.push({
          ...sh, day: DAY_SHORT[d.weekday]!, times: (d.times ?? []).join(LIST),
          curators: cs.map((c, i) => c?.name ?? d.curatorIds[i]!).join(LIST),
          curator_phones: cs.some((c) => c?.phone) ? cs.map((c) => c?.phone ?? "").join(LIST) : "",
          curator_instagram: cs.some((c) => c?.instagram) ? cs.map((c) => c?.instagram ?? "").join(LIST) : "",
          they_reach_out: d.theyReachOut ? "yes" : "", ask_rule: encodeRule(d.askRule), day_note: d.note ?? "",
        });
      }
    }
  }
  return rows;
}

const split = (s: string) => s.split(";").map((x) => x.trim()).filter(Boolean);
const json = <T>(s: string): T[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

/** Rows back into a roster (shareable fields). Rows without ids get them from the names. Curators not on any day aren't in a CSV. */
export function fromRows(rows: Partial<RosterRow>[]): Roster {
  const rooms = new Map<string, RoomShared>();
  const curators = new Map<string, CuratorShared>();
  const showByKey = new Map<string, ShowShared>();
  for (const row of rows) {
    const get = (c: CsvColumn) => (row[c] ?? "").trim();
    if (!get("room")) continue;
    const rkey = get("room_id") || `${slug(get("room"))}|${slug(get("area"))}`;
    let room = rooms.get(rkey);
    if (!room) {
      const lat = Number(get("lat"));
      const lng = Number(get("lng"));
      room = {
        id: get("room_id") || newRoomId(get("room"), get("area")), name: get("room"), area: get("area"), city: get("city"),
        aliases: split(get("aliases")), tags: split(get("tags")), notes: json<RoomNote>(get("room_notes")), limits: json<Limit>(get("limits")), shows: [],
      };
      if (get("brand")) room.brand = get("brand");
      if (get("lat") && get("lng") && Number.isFinite(lat) && Number.isFinite(lng)) {
        room.pin = { lat, lng, ...(get("maps_url") && { mapsUrl: get("maps_url") }), ...(get("place") && { label: get("place") }) };
      }
      rooms.set(rkey, room);
    }
    if (!get("show") && !get("show_id")) continue;
    const skey = `${rkey}/${get("show_id") || slug(get("show"))}`;
    let show = showByKey.get(skey);
    if (!show) {
      const name = get("show") || get("show_id");
      const type = get("type") === "show" || get("type") === "both" ? (get("type") as "show" | "both") : "mic";
      show = {
        id: get("show_id") || slug(name) || type, name, type,
        cadence: get("cadence") === "daily" || get("cadence") === "monthly" ? (get("cadence") as "daily" | "monthly") : "weekly",
        times: split(get("show_times")), days: [],
      };
      const mw = split(get("monthly_weeks")).map(Number).filter((n) => Number.isInteger(n));
      if (mw.length) show.monthlyWeeks = mw;
      if (split(get("show_tags")).length) show.tags = split(get("show_tags"));
      const rule = decodeRule(get("show_ask_rule"));
      if (rule) show.askRule = rule;
      if (get("show_note")) show.note = get("show_note");
      showByKey.set(skey, show);
      room.shows.push(show);
    }
    const di = DAY_CODES.indexOf(get("day").toLowerCase().slice(0, 3));
    if (di < 0) continue;
    const names = split(get("curators"));
    const phones = get("curator_phones").split(";").map((x) => x.trim());
    const instas = get("curator_instagram").split(";").map((x) => x.trim());
    const day: DayPlan = { weekday: di as Weekday, curatorIds: [] };
    names.forEach((name, i) => {
      const key = curatorKey({ name });
      if (!key) return;
      const c = curators.get(key) ?? { id: key, name };
      if (phones[i] && !c.phone) c.phone = phones[i];
      if (instas[i] && !c.instagram) c.instagram = instas[i];
      curators.set(key, c);
      day.curatorIds.push(c.id);
    });
    if (split(get("times")).length) day.times = split(get("times"));
    if (get("they_reach_out")) day.theyReachOut = true;
    const rule = decodeRule(get("ask_rule"));
    if (rule) day.askRule = rule;
    if (get("day_note")) day.note = get("day_note");
    show.days.push(day);
  }
  return shareableRoster({ rooms: [...rooms.values()], curators: [...curators.values()] }) as Roster;
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
export function readCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(roster: Roster | SharedRoster): string {
  return [CSV_COLUMNS.join(","), ...toRows(roster).map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

/** Headers are matched by name, in any order; unknown columns are ignored. */
export function fromCsv(text: string): Roster {
  const [head, ...body] = readCsvRows(text);
  if (!head) return { rooms: [], curators: [] };
  const idx = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  if (!idx.includes("room")) throw new RosterFormatError("This CSV has no \"room\" column.");
  return fromRows(body.map((cells) => Object.fromEntries(idx.map((h, i) => [h, cells[i] ?? ""])) as Partial<RosterRow>));
}
