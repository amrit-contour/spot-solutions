// Pure rules for the reset and data-management tools, shared by the app (client writes) and the worker (admin deletes).
import type { Lineup, RequestStatus, SpotRequest } from "./types.ts";

/** The read-only template account that demo sandboxes are copied from. Never deleted. */
export const DEMO_SOURCE_UID = "demo-curator";

/** Every collection under users/{uid} the app and worker use. */
export const USER_COLLECTIONS = ["venues", "shows", "comics", "requests", "lineups", "actions", "notices", "offers", "polls", "groups", "commands", "session", "secrets"] as const;

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
export function demoSandboxIds(users: { id: string; demo?: unknown }[]): string[] {
  return users.filter((u) => u.demo === true && u.id !== DEMO_SOURCE_UID).map((u) => u.id);
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
}

/** Back to the waiting state a request had before it was placed (matches unplacing a comic on the board). */
const waiting = (r: Pick<SpotRequest, "ackedAt">): RequestStatus => (r.ackedAt ? "acked" : "new");

/**
 * Clear a lineup's slots and put its comics' requests back to waiting. Nothing is sent.
 * Null when there is nothing to clear. A confirmed lineup also goes back to draft.
 */
export function planLineupReset(lineup: Lineup, requests: Pick<SpotRequest, "id" | "comicId" | "weekOf" | "status" | "ackedAt">[]): LineupResetPlan | null {
  if (!lineup.slots.length) return null;
  const confirmed = lineup.status === "confirmed";
  const comics = new Set(lineup.slots.map((s) => s.comicId));
  const requestResets = requests
    .filter((r) => r.weekOf === lineup.weekOf && comics.has(r.comicId) && (r.status === "assigned" || (confirmed && r.status === "confirmed")))
    .map((r) => ({ id: r.id, status: waiting(r) }));
  return {
    lineupId: lineup.id,
    showId: lineup.showId,
    cleared: lineup.slots.length,
    confirmed,
    lineupPatch: confirmed ? { slots: [], status: "draft", sentAt: null, groupSync: null, dropped: [] } : { slots: [] },
    requestResets,
  };
}

export function planWeekReset(lineups: Lineup[], requests: Pick<SpotRequest, "id" | "comicId" | "weekOf" | "status" | "ackedAt">[]): LineupResetPlan[] {
  return lineups.flatMap((l) => planLineupReset(l, requests) ?? []);
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
