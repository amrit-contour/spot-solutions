// Demo sandbox cloning: the template account is seeded once, so every week-dated value in it is moved
// to the current week when a visitor's copy is made. Pure, so it can be tested without Firestore.
import { shiftWeek } from "./week.ts";

export interface DemoDoc {
  id: string;
  data: Record<string, unknown>;
}

/** Template documents by collection name (users/{template}/{collection}). */
export type DemoData = Record<string, DemoDoc[]>;

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_PREFIX = /^\d{4}-\d{2}-\d{2}(?=_)/;

type Rec = Record<string, unknown>;
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => typeof x === "object" && x !== null) : []);

/** The week the template was seeded for: its newest request week, else its newest lineup week. */
export function demoTemplateWeek(data: DemoData): string | null {
  for (const coll of ["requests", "lineups"]) {
    const weeks = (data[coll] ?? []).map((d) => d.data.weekOf).filter((w): w is string => typeof w === "string" && DATE.test(w));
    if (weeks.length) return weeks.reduce((a, b) => (b > a ? b : a));
  }
  return null;
}

/** The newest epoch-millisecond field the template shows as a relative time. */
function newestTimestamp(data: DemoData): number {
  let max = 0;
  const see = (v: unknown) => typeof v === "number" && v > max && (max = v);
  for (const docs of Object.values(data)) {
    for (const { data: d } of docs) {
      see(d.createdAt);
      see(d.updatedAt);
      recs(d.messages).forEach((m) => see(m.at));
    }
  }
  return max;
}

export interface ShiftOptions {
  /** The current lineup week (Monday, YYYY-MM-DD) the copy should be populated for. */
  toWeek: string;
  /** Time of the copy, epoch ms. */
  now: number;
  /** When the template was seeded; defaults to its newest timestamp. Relative times keep their age. */
  templateAt?: number;
}

/**
 * Move a template to `toWeek`. Week keys, dates and ids that embed a week move by whole weeks; timestamps move
 * so the template's newest activity lands at `now`'s distance from `templateAt` (a "10h ago" request stays recent).
 * Returns the data unchanged when the template has no weeks to anchor on.
 */
export function shiftDemoData(data: DemoData, { toWeek, now, templateAt }: ShiftOptions): DemoData {
  const from = demoTemplateWeek(data);
  if (!from) return data;
  const weeks = Math.round((Date.parse(toWeek) - Date.parse(from)) / (7 * DAY));
  const dt = now - (templateAt ?? newestTimestamp(data));

  const date = <T>(v: T): T => (typeof v === "string" && DATE.test(v) ? (shiftWeek(v, weeks) as T) : v);
  const ts = <T>(v: T): T => (typeof v === "number" ? ((v + dt) as T) : v);
  const id = (v: string) => v.replace(WEEK_PREFIX, (w) => shiftWeek(w, weeks));
  const only = (o: Rec, keys: string[], f: (v: never) => unknown): Rec => {
    const out = { ...o };
    for (const k of keys) if (k in out) out[k] = f(out[k] as never);
    return out;
  };
  const str = (v: unknown) => (typeof v === "string" ? id(v) : v);

  const doc = (coll: string, d: Rec): Rec => {
    switch (coll) {
      case "comics": {
        const out = only(d, ["lastPerformedWeek"], date);
        if (Array.isArray(d.history)) out.history = recs(d.history).map((h) => only(h, ["date"], date));
        return out;
      }
      case "requests": {
        const out = only(d, ["id", "weekOf"], (v: string) => (DATE.test(v) ? date(v) : id(v)));
        for (const k of ["ackedAt", "rejectedAt", "createdAt", "updatedAt"]) if (k in out) out[k] = ts(out[k]);
        if (Array.isArray(d.messages)) out.messages = recs(d.messages).map((m) => only(m, ["at"], ts));
        return out;
      }
      case "lineups": {
        const out = only(d, ["id"], id);
        for (const k of ["weekOf", "date", "showDaySyncedOn", "micCheckSentOn"]) if (k in out) out[k] = date(out[k]);
        if ("sentAt" in out) out.sentAt = ts(out.sentAt);
        if (Array.isArray(d.dropped)) out.dropped = recs(d.dropped).map((x) => only(x, ["at"], ts));
        return out;
      }
      case "actions": {
        const out = only(d, ["weekOf"], date);
        for (const k of ["createdAt", "updatedAt"]) if (k in out) out[k] = ts(out[k]);
        if ("lineupId" in out) out.lineupId = str(out.lineupId);
        return out;
      }
      case "notices":
        return only(d, ["createdAt"], ts);
      default:
        return d;
    }
  };

  return Object.fromEntries(Object.entries(data).map(([coll, docs]) => [coll, docs.map((x) => ({ id: coll === "requests" || coll === "lineups" ? id(x.id) : x.id, data: doc(coll, x.data) }))]));
}
