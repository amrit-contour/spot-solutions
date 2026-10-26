// Pure rules for the reset and data-management tools, shared by the app (client writes) and the worker (admin deletes).
import type { Comic, Lineup, RequestStatus, Show, SpotHistoryEntry, SpotRequest } from "./types.ts";
import { shiftWeek } from "./week.ts";

/** The read-only template account that demo sandboxes are copied from. Never deleted. */
export const DEMO_SOURCE_UID = "demo-curator";

/** Every collection under users/{uid} the app and worker use. */
export const USER_COLLECTIONS = ["venues", "shows", "comics", "requests", "lineups", "actions", "notices", "offers", "polls", "groups", "commands", "session", "secrets", "contactsImport"] as const;

export type DataScope = "requests" | "lineups" | "comics" | "history" | "everything";

export const SCOPE_LABEL: Record<DataScope, string> = {
  requests: "Requests",
  lineups: "Lineups",
  comics: "Comics",
  history: "History (actions, notices, offers and polls)",
  everything: "Everything",
};

const SCOPE_COLLECTIONS: Record<Exclude<DataScope, "everything">, string[]> = {
  requests: ["requests"],
  lineups: ["lineups"],
  comics: ["comics"],
  history: ["actions", "notices", "offers", "polls"],
};

/** Collections a scope deletes. "everything" is every known collection; the worker also sweeps unknown ones and the profile doc. */
export function collectionsForScope(scope: DataScope): string[] {
  return scope === "everything" ? [...USER_COLLECTIONS] : [...SCOPE_COLLECTIONS[scope]];
}

export const isDataScope = (v: unknown): v is DataScope => typeof v === "string" && (v === "everything" || Object.hasOwn(SCOPE_COLLECTIONS, v));

/** Anonymous demo sandboxes: users docs flagged `demo: true`, minus the source copy. */
export function demoSandboxIds(users: { id: string; demo?: unknown; email?: unknown }[]): string[] {
  // A sandbox never has an email; one that does is a real account that must not be wiped.
  return users.filter((u) => u.demo === true && u.id !== DEMO_SOURCE_UID && !u.email).map((u) => u.id);
}

/** Sandboxes older than this are deleted by the worker's daily job. */
export const DEMO_SANDBOX_MAX_AGE_DAYS = 7;

/** Sandbox ids (same rules as demoSandboxIds) whose copy was made (demoClonedAt, else createdAt) more than `days` ago. No timestamp: kept. */
export function expiredSandboxIds(users: { id: string; demo?: unknown; email?: unknown; demoClonedAt?: unknown; createdAt?: unknown }[], now: number, days = DEMO_SANDBOX_MAX_AGE_DAYS): string[] {
  const cutoff = now - days * DAY_MS;
  const stamp = (u: { demoClonedAt?: unknown; createdAt?: unknown }) => (typeof u.demoClonedAt === "number" ? u.demoClonedAt : typeof u.createdAt === "number" ? u.createdAt : null);
  const ids = new Set(demoSandboxIds(users));
  return users.filter((u) => ids.has(u.id) && (stamp(u) ?? Infinity) < cutoff).map((u) => u.id);
}

// ---- Retention ----

export const DAY_MS = 24 * 60 * 60_000;

/** How long Firestore TTL (field `expireAt`, a Timestamp) keeps each kind of short-lived document. Policies: deploy/setup-cost-controls.sh. */
export const TTL_DAYS = {
  commands: 7, // users/{uid}/commands and servers/{id}/commands (one collection group: both use this)
  notices: 30,
  contactsImport: 1,
  invites: 30,
} as const;
export const ttlMs = (days: number, now = Date.now()) => now + days * DAY_MS;

/** What the curator calls "Closed" on the Requests page: dismissed, or turned down with a regret message. */
export const CLOSED_STATUSES: readonly RequestStatus[] = ["dismissed", "rejected"];
/** Retention also removes confirmed requests: once a week is long gone, they are finished too. */
export const RETENTION_STATUSES: readonly RequestStatus[] = [...CLOSED_STATUSES, "confirmed"];

export const isClosedRequest = (r: Pick<SpotRequest, "status">) => CLOSED_STATUSES.includes(r.status);

export const DEFAULT_CLOSED_REQUESTS_WEEKS = 8;
export const MAX_CLOSED_REQUESTS_WEEKS = 520;

/** settings.retention.closedRequestsWeeks: 8 when unset or invalid, 0 keeps them forever. */
export function closedRequestsWeeks(settings: { retention?: { closedRequestsWeeks?: unknown } } | undefined | null): number {
  const v = settings?.retention?.closedRequestsWeeks;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_CLOSED_REQUESTS_WEEKS ? v : DEFAULT_CLOSED_REQUESTS_WEEKS;
}

/**
 * Requests the daily job deletes: closed (dismissed, rejected) or confirmed ones whose week is more than `weeks` weeks
 * before `currentWeek` (Monday ISO dates). `weeks` 0 keeps everything. Open and placed requests are never selected.
 */
export function requestsToExpire<T extends Pick<SpotRequest, "weekOf" | "status">>(requests: T[], currentWeek: string, weeks: number): T[] {
  if (!(weeks > 0)) return [];
  const cutoff = shiftWeek(currentWeek, -weeks);
  return requests.filter((r) => RETENTION_STATUSES.includes(r.status) && r.weekOf < cutoff);
}

/** Requests from weeks before `beforeWeek` (Monday ISO dates compare as strings). */
export function oldRequests<T extends Pick<SpotRequest, "weekOf">>(requests: T[], beforeWeek: string): T[] {
  return requests.filter((r) => r.weekOf < beforeWeek);
}

export interface LineupResetPlan {
  lineupId: string;
  showId: string;
  /** Comics taken off the lineup. */
  cleared: number;
  /** Comics were already told. Needs a second confirmation. */
  confirmed: boolean;
  lineupPatch: Partial<Lineup>;
  requestResets: { id: string; status: RequestStatus }[];
  /** Comics whose "performed" mark and history entry for this week's confirmation are undone. */
  comicPatches: { id: string; patch: Partial<Pick<Comic, "lastPerformedWeek" | "history">> }[];
}

type ComicState = Pick<Comic, "id" | "lastPerformedWeek" | "history">;

/** Back to the waiting state a request had before it was placed (matches unplacing a comic on the board). */
const waiting = (r: Pick<SpotRequest, "ackedAt">): RequestStatus => (r.ackedAt ? "acked" : "new");

/**
 * Clear a lineup's slots and put its comics' requests back to waiting. Nothing is sent.
 * Null when there is nothing to clear. A confirmed lineup also goes back to draft.
 */
export function planLineupReset(lineup: Lineup, requests: Pick<SpotRequest, "id" | "comicId" | "weekOf" | "status" | "ackedAt">[], comics: ComicState[] = []): LineupResetPlan | null {
  if (!lineup.slots.length) return null;
  const confirmed = lineup.status === "confirmed";
  const onLineup = new Set(lineup.slots.map((s) => s.comicId));
  const requestResets = requests
    .filter((r) => r.weekOf === lineup.weekOf && onLineup.has(r.comicId) && (r.status === "assigned" || (confirmed && r.status === "confirmed")))
    .map((r) => ({ id: r.id, status: waiting(r) }));
  return {
    lineupId: lineup.id,
    showId: lineup.showId,
    cleared: lineup.slots.length,
    confirmed,
    lineupPatch: confirmed ? { slots: [], status: "draft", sentAt: null, sent: null, groupSync: null, groupLeaving: null, dropped: [], showDaySyncedOn: null, micCheckSentOn: null, outcome: null } : { slots: [] },
    requestResets,
    comicPatches: confirmed ? unconfirmComics(lineup, comics) : [],
  };
}

/** Confirming marks each comic as performed that week and logs a 'confirmed' history entry; take both back. */
function unconfirmComics(lineup: Lineup, comics: ComicState[]): LineupResetPlan["comicPatches"] {
  const slotIds = new Set(lineup.slots.map((s) => s.comicId));
  const weekEnd = shiftWeek(lineup.weekOf, 1);
  const isThis = (h: SpotHistoryEntry) => h.status === "confirmed" && h.showId === lineup.showId && h.date >= lineup.weekOf && h.date < weekEnd;
  return comics.flatMap((c) => {
    if (!slotIds.has(c.id)) return [];
    const patch: Partial<Pick<Comic, "lastPerformedWeek" | "history">> = {};
    if (c.lastPerformedWeek === lineup.weekOf) patch.lastPerformedWeek = null;
    if (c.history?.some(isThis)) patch.history = c.history.filter((h) => !isThis(h));
    return Object.keys(patch).length ? [{ id: c.id, patch }] : [];
  });
}

/** Plans for a whole week. Called-off lineups (cancelled, canned) and lineups of inactive shows are left alone. */
export function planWeekReset(
  lineups: Lineup[],
  requests: Pick<SpotRequest, "id" | "comicId" | "weekOf" | "status" | "ackedAt">[],
  shows: Pick<Show, "id" | "active">[],
  comics: ComicState[] = [],
): LineupResetPlan[] {
  const active = new Set(shows.filter((s) => s.active).map((s) => s.id));
  return lineups.filter((l) => l.status !== "cancelled" && l.status !== "canned" && active.has(l.showId)).flatMap((l) => planLineupReset(l, requests, comics) ?? []);
}

/** Admin data commands (servers/{id}/commands). `dryRun` only counts. */
export interface AdminDataPayload {
  uid?: string;
  scope?: DataScope;
  /** Typed confirmation: must equal the target curator's email. */
  confirmEmail?: string;
  dryRun?: boolean;
}

export interface AdminDataResult {
  /** Documents deleted, or that would be (dryRun), per collection. */
  counts: Record<string, number>;
  total: number;
  /** Users affected: 1 for a curator, the number of sandboxes for a wipe. */
  users: number;
  dryRun: boolean;
}
