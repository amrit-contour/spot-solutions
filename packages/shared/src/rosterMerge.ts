// Merge with review: what a published roster changes in mine (diffRosters), and taking the picked changes (applyMerge).
// Rooms, shows and curators are matched by id first, then by name (+ area), so rosters made independently still line up.
// Only picked fields are touched: my notes, role, closures, asks and spots are never overwritten.
import {
  curatorKey, roomKey, shareable, shareableCurator, shareableDay, shareableShow, showKey,
  type Curator, type CuratorShared, type DayPlan, type Limit, type Room, type RoomShared, type Roster, type SharedRoster, type RoomShow, type ShowShared,
} from "./rooms.ts";
import { DAY_SHORT } from "./week.ts";

export interface RosterChange {
  /** Stable key: what the importer ticks. Same for the same change however many times the diff is run. */
  id: string;
  op: "added" | "changed" | "removed";
  level: "room" | "show" | "curator";
  /** Room / show ids in MY roster when matched there, else the published ones. */
  roomId?: string;
  showId?: string;
  curatorId?: string;
  /** Room/show: a field name, or `days.<weekday 0-6>`. Curator: phone / instagram. Absent for a whole room or show. */
  field?: string;
  /** "Comedy Square · Mic · Mon". */
  label: string;
  before?: unknown;
  after?: unknown;
}

interface Op {
  change: RosterChange;
  apply(draft: Roster): void;
}

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
/** JSON with sorted keys and without empty values, so equal things compare equal however they were built. */
function stable(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([, val]) => !empty(val) && val !== false)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, walk(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(walk(v)) ?? "null";
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const ROOM_FIELDS = ["name", "brand", "area", "city", "pin", "aliases", "tags", "notes", "limits"] as const;
const SHOW_FIELDS = ["name", "type", "cadence", "monthlyWeeks", "times", "askRule", "tags", "note"] as const;
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function matchBy<M, P>(mine: M[], pub: P[], id: (x: M | P) => string, key: (x: M | P) => string): { pairs: [M | undefined, P][]; removed: M[] } {
  const used = new Set<M>();
  const pairs: [M | undefined, P][] = [];
  for (const p of pub) {
    const hit = mine.find((m) => !used.has(m) && id(m) === id(p)) ?? mine.find((m) => !used.has(m) && key(m) === key(p));
    if (hit) used.add(hit);
    pairs.push([hit, p]);
  }
  return { pairs, removed: mine.filter((m) => !used.has(m)) };
}

const roomMatch = (mine: Room[], pub: RoomShared[]) => matchBy<Room, RoomShared>(mine, pub, (r) => r.id, (r) => roomKey(r));
const showMatch = (mine: RoomShow[], pub: ShowShared[]) => matchBy<RoomShow, ShowShared>(mine, pub, (s) => s.id, (s) => showKey(s));
const curatorMatch = (mine: Curator[], pub: CuratorShared[]) => matchBy<Curator, CuratorShared>(mine, pub, (c) => c.id, (c) => curatorKey(c));

/** Readable form of a day for the review screen, with curator names rather than ids. */
function dayView(d: DayPlan | undefined, curators: { id: string; name: string }[]) {
  if (!d) return undefined;
  return { times: d.times, curators: d.curatorIds.map((id) => curators.find((c) => c.id === id)?.name ?? id), theyReachOut: d.theyReachOut, askRule: d.askRule, note: d.note };
}

/** Make sure a published curator exists in the draft (matched by name); returns the id to use there. */
function ensureCurator(draft: Roster, pubCurators: CuratorShared[], pubId: string): string {
  const p = pubCurators.find((c) => c.id === pubId);
  if (!p) return pubId;
  const hit = draft.curators.find((c) => c.id === p.id && curatorKey(c) === curatorKey(p)) ?? draft.curators.find((c) => curatorKey(c) === curatorKey(p));
  if (hit) return hit.id;
  let id = p.id;
  for (let n = 2; draft.curators.some((c) => c.id === id); n++) id = `${p.id}-${n}`;
  draft.curators.push({ ...shareableCurator(p), id });
  return id;
}

const remapDay = (draft: Roster, pubCurators: CuratorShared[], d: DayPlan): DayPlan => {
  const day = shareableDay(d);
  day.curatorIds = day.curatorIds.map((id) => ensureCurator(draft, pubCurators, id));
  return day;
};
const remapShow = (draft: Roster, pubCurators: CuratorShared[], s: ShowShared): ShowShared => {
  const show = shareableShow(s);
  show.days = s.days.map((d) => remapDay(draft, pubCurators, d));
  return show;
};

function plan(mine: Roster, pub: SharedRoster): Op[] {
  const ops: Op[] = [];
  const { pairs, removed } = roomMatch(mine.rooms, pub.rooms);

  for (const [m, p] of pairs) {
    const rk = roomKey(m ?? p);
    if (!m) {
      ops.push({
        change: { id: `room:${rk}`, op: "added", level: "room", roomId: p.id, label: p.name, after: shareable(p) },
        apply(d) {
          const room = shareable(p) as Room;
          room.shows = p.shows.map((s) => remapShow(d, pub.curators, s));
          let id = p.id;
          for (let n = 2; d.rooms.some((r) => r.id === id); n++) id = `${p.id}-${n}`;
          d.rooms.push({ ...room, id });
        },
      });
      continue;
    }
    const roomId = m.id;
    const showMap = new Map<string, string>(); // published show id -> mine
    const sm = showMatch(m.shows, p.shows);
    for (const [ms, ps] of sm.pairs) if (ms) showMap.set(ps.id, ms.id);
    const remapLimits = (ls: Limit[]) => ls.map((l) => (l.showId && showMap.has(l.showId) ? { ...l, showId: showMap.get(l.showId) } : l));

    for (const f of ROOM_FIELDS) {
      const before = m[f];
      const after = f === "limits" ? remapLimits(p.limits) : p[f];
      if (same(before, after)) continue;
      ops.push({
        change: { id: `room:${rk}#${f}`, op: "changed", level: "room", roomId, field: f, label: `${m.name} · ${f}`, before: clone(before), after: clone(after) },
        apply(d) {
          const r = d.rooms.find((x) => x.id === roomId);
          if (!r) return;
          const rec = r as unknown as Record<string, unknown>;
          const v = clone(after);
          if (f === "brand" || f === "pin") {
            if (empty(v)) delete rec[f];
            else rec[f] = v;
          } else rec[f] = v ?? (Array.isArray(m[f]) ? [] : v);
        },
      });
    }

    for (const [ms, ps] of sm.pairs) {
      const sk = showKey(ms ?? ps);
      if (!ms) {
        ops.push({
          change: { id: `show:${rk}/${sk}`, op: "added", level: "show", roomId, showId: ps.id, label: `${m.name} · ${ps.name}`, after: shareableShow(ps) },
          apply(d) {
            const r = d.rooms.find((x) => x.id === roomId);
            if (!r) return;
            const s = remapShow(d, pub.curators, ps) as RoomShow;
            let id = s.id;
            for (let n = 2; r.shows.some((x) => x.id === id); n++) id = `${s.id}-${n}`;
            r.shows.push({ ...s, id });
          },
        });
        continue;
      }
      const showId = ms.id;
      const where = `${m.name} · ${ms.name}`;
      for (const f of SHOW_FIELDS) {
        if (same(ms[f], ps[f])) continue;
        ops.push({
          change: { id: `show:${rk}/${sk}#${f}`, op: "changed", level: "show", roomId, showId, field: f, label: `${where} · ${f}`, before: clone(ms[f]), after: clone(ps[f]) },
          apply(d) {
            const s = d.rooms.find((x) => x.id === roomId)?.shows.find((x) => x.id === showId);
            if (!s) return;
            const rec = s as unknown as Record<string, unknown>;
            const v = clone(ps[f]);
            if (empty(v) && !["name", "type", "cadence", "times"].includes(f)) delete rec[f];
            else rec[f] = v ?? [];
          },
        });
      }
      // Days compare by who is on them (names), so differing curator ids don't read as changes.
      const names = (d: DayPlan | undefined, cs: { id: string; name: string }[]) => dayView(d, cs.map((c) => ({ id: c.id, name: curatorKey(c) })));
      for (let wd = 0; wd < 7; wd++) {
        const md = ms.days.find((d) => d.weekday === wd);
        const pd = ps.days.find((d) => d.weekday === wd);
        if (!md && !pd) continue;
        if (md && pd && same(names(md, mine.curators), names(pd, pub.curators))) continue;
        const op = !md ? "added" : !pd ? "removed" : "changed";
        ops.push({
          change: {
            id: `show:${rk}/${sk}#days.${wd}`, op, level: "show", roomId, showId, field: `days.${wd}`, label: `${where} · ${DAY_SHORT[wd]}`,
            before: dayView(md, mine.curators), after: dayView(pd, pub.curators),
          },
          apply(d) {
            const s = d.rooms.find((x) => x.id === roomId)?.shows.find((x) => x.id === showId);
            if (!s) return;
            const rest = s.days.filter((x) => x.weekday !== wd);
            const kept = s.days.find((x) => x.weekday === wd);
            s.days = pd ? [...rest, { ...remapDay(d, pub.curators, pd), ...(kept?.standIn ? { standIn: kept.standIn } : {}) }] : rest;
            s.days.sort((a, b) => a.weekday - b.weekday);
          },
        });
      }
    }
    for (const ms of sm.removed) {
      ops.push({
        change: { id: `show:${rk}/${showKey(ms)}`, op: "removed", level: "show", roomId, showId: ms.id, label: `${m.name} · ${ms.name}`, before: shareableShow(ms) },
        apply(d) {
          const r = d.rooms.find((x) => x.id === roomId);
          if (!r) return;
          r.shows = r.shows.filter((x) => x.id !== ms.id);
          r.limits = r.limits.filter((l) => l.showId !== ms.id);
        },
      });
    }
  }

  for (const m of removed) {
    ops.push({
      change: { id: `room:${roomKey(m)}`, op: "removed", level: "room", roomId: m.id, label: m.name, before: shareable(m) },
      apply(d) {
        d.rooms = d.rooms.filter((r) => r.id !== m.id);
      },
    });
  }

  // Curators in both: a changed number or Instagram handle. A published roster that lacks one never wipes mine.
  for (const [mc, pc] of curatorMatch(mine.curators, pub.curators).pairs) {
    if (!mc) continue;
    for (const f of ["phone", "instagram"] as const) {
      if (!pc[f] || pc[f] === mc[f]) continue;
      ops.push({
        change: { id: `curator:${curatorKey(mc)}#${f}`, op: "changed", level: "curator", curatorId: mc.id, field: f, label: `${mc.name} · ${f}`, before: mc[f], after: pc[f] },
        apply(d) {
          const c = d.curators.find((x) => x.id === mc.id);
          if (c) c[f] = pc[f];
        },
      });
    }
  }
  return ops;
}

/** What the published roster would change in mine: added / changed / removed per room, show, field, weekday and curator. */
export const diffRosters = (mine: Roster, published: SharedRoster): RosterChange[] => plan(mine, published).map((o) => o.change);

/** Everything: "replace all". */
export const allChangeIds = (changes: RosterChange[]) => changes.map((c) => c.id);

/** Take the picked changes (ids from diffRosters) into a copy of mine. Unknown ids are ignored. */
export function applyMerge(mine: Roster, published: SharedRoster, picks: Iterable<string>): Roster {
  const want = new Set(picks);
  const draft = clone(mine);
  const ops = plan(mine, published).filter((o) => want.has(o.change.id));
  // Additions and edits first, removals last, so a pick order can't matter.
  for (const o of ops.filter((x) => x.change.op !== "removed")) o.apply(draft);
  for (const o of ops.filter((x) => x.change.op === "removed")) o.apply(draft);
  return draft;
}
