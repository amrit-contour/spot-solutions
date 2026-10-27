// One export for the Rooms menu: CSV or JSON, all rooms or some, and (JSON only) private notes for a full backup.
import type { Roster } from "./rooms.ts";
import { toCsv, toRosterJson } from "./rosterIO.ts";

export interface ExportOptions {
  format: "csv" | "json";
  /** Only these rooms; undefined is every room. */
  roomIds?: ReadonlySet<string>;
  /** JSON only: keep private notes, role and spots (a backup you can restore). A CSV is always the shareable fields. */
  full?: boolean;
  /** YYYY-MM-DD for the file name. */
  stamp: string;
  exportedAt?: number;
}

export interface ExportFile { filename: string; text: string; type: string }

/** The file for these options, or null when nothing would be in it. Curators are cut down to the ones the chosen rooms use. */
export function buildExport(roster: Roster, o: ExportOptions): ExportFile | null {
  const rooms = o.roomIds ? roster.rooms.filter((r) => o.roomIds!.has(r.id)) : roster.rooms;
  if (!rooms.length) return null;
  const used = new Set(rooms.flatMap((r) => r.shows.flatMap((s) => s.days.flatMap((d) => d.curatorIds))));
  const picked: Roster = { rooms, curators: o.roomIds ? roster.curators.filter((c) => used.has(c.id)) : roster.curators };
  const base = `nothing-bot-rooms-${o.stamp}${o.roomIds ? "-selected" : ""}`;
  if (o.format === "csv") return { filename: `${base}.csv`, text: toCsv(picked), type: "text/csv" };
  const full = Boolean(o.full);
  return { filename: `${base}${full ? "-backup" : ""}.json`, text: toRosterJson(picked, { exportedAt: o.exportedAt ?? Date.now(), full }), type: "application/json" };
}
