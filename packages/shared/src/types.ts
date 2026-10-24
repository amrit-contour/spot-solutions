// Firestore document shapes. Everything lives under users/{uid}/...

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export type Tier = "open" | "regular" | "featured";

export type SessionStatus = "idle" | "starting" | "qr" | "authenticated" | "ready" | "disconnected" | "error";

export interface SessionState {
  status: SessionStatus;
  qr?: string | null;
  phone?: string | null;
  pushName?: string | null;
  lastSeen?: number; // epoch ms, worker heartbeat
  error?: string | null;
}

export interface Settings {
  ack: { enabled: boolean; template: string };
  confirm: { template: string };
  reject: { enabled: boolean; template: string };
  model: { provider: "ollama" | "gemini"; name: string; fallback: boolean };
  ignoreGroups: boolean;
  timezone: string; // IANA, e.g. Asia/Kolkata
  debounceSeconds: number;
  rules: RuleSettings;
  selfService: { enabled: boolean; autoSend: boolean };
  /** Ask comics you haven't saved who they are (V1 new-contact flow). */
  onboarding: { enabled: boolean };
  /** Morning after a show, ask whether it happened. */
  micCheck: { enabled: boolean; time: string; whatsapp: boolean };
  /** Group where hosts/POCs vote on which shows they can take. */
  hostPoll: { groupId: string | null };
  offers: { expiryHours: number };
}

export interface ComicProfile {
  scene?: string | null;
  years?: number | null;
  travelling?: boolean | null;
}

/** A curator-initiated "want this spot?" message. */
export interface SpotOffer {
  id: string;
  comicId: string;
  comicName: string;
  weekOf: string;
  showId: string;
  lineupId: string;
  status: "pending" | "accepted" | "declined" | "expired" | "full";
  sentAt: number;
  expiresAt: number;
  reply?: string | null;
}

/** Host availability poll for one week. */
export interface HostPoll {
  id: string; // weekOf
  weekOf: string;
  groupId: string;
  messageId: string;
  options: { name: string; showId: string }[];
  /** comic id (or raw voter id if unknown) → show ids they can do */
  votes: Record<string, string[]>;
  voterNames: Record<string, string>;
  sentAt: number;
}

export interface RuleSettings {
  /** Only accept requests inside this weekly window; others are held as mid-week asks. */
  window: { enabled: boolean; startDay: Weekday; startTime: string; endDay: Weekday; endTime: string };
  /** Hold requests from comics who performed last week. */
  skipLastWeek: boolean;
}

/** Why a request was held back instead of landing in Asked. */
export type HoldReason = "midweek" | "last_week" | "banned" | "ignored" | "host";

export type ComicList = "banned" | "ignored" | "host";

export interface SpotHistoryEntry {
  date: string; // YYYY-MM-DD of the show
  showId: string;
  showName: string;
  status: "confirmed" | "cancelled" | "canned";
}

/** A comic asked something other than a spot: drafted reply waiting for the curator. */
export interface ComicAction {
  id: string;
  kind: "cancel_spot" | "status_query" | "last_spot_query" | "show_info" | "onboard";
  comicId: string;
  comicName: string;
  weekOf: string;
  message: string;
  draft: string;
  /** For cancel_spot: which lineup the comic is in. */
  lineupId?: string | null;
  status: "pending" | "sent" | "dismissed";
  createdAt: number;
}

export interface AppNotice {
  id: string;
  level: "info" | "warn";
  text: string;
  createdAt: number;
  read: boolean;
}

export interface Venue {
  id: string;
  name: string;
  area?: string;
  mapsLink?: string;
}

export interface Show {
  id: string;
  name: string;
  venueId: string;
  weekday: Weekday;
  startTime: string; // "20:00"
  slotCount: number;
  includeSlotTime: boolean;
  defaultMinutes?: number;
  active: boolean;
  groupId?: string | null;
  regulars: string[]; // comic ids that stay in the group
  protected: string[]; // never removed (co-hosts etc.)
  /** "confirm": review the group right after confirming. "show_day": update it automatically on the day. */
  groupMode?: "confirm" | "show_day";
  showDaySyncTime?: string; // "12:00"
  postLineupToGroup?: boolean;
}

export interface Comic {
  id: string; // stable id: phone-based (919876543210@c.us) when known, else the @lid
  chatId?: string; // the JID WhatsApp actually delivers to (often @lid on current WhatsApp)
  name: string;
  /** Where `name` came from. Only "manual" names are left alone when WhatsApp data changes. */
  nameSource?: "contact" | "whatsapp" | "number" | "manual";
  phone: string;
  tier: Tier;
  notes?: string;
  lastPerformedWeek?: string | null; // weekOf key
  regularOf?: string[]; // show ids
  list?: ComicList | null;
  history?: SpotHistoryEntry[]; // newest first, capped
  onboarding?: "asked" | "done" | null;
  profile?: ComicProfile;
}

export type IntentKind = "spot_request" | "cancel_spot" | "status_query" | "last_spot_query" | "show_info" | "other";

export interface Intent {
  kind?: IntentKind;
  isSpotRequest: boolean;
  confidence: number; // 0..1
  preferredDays: Weekday[];
  preferredShowHint?: string | null;
  note?: string | null;
  model?: string;
}

export interface InboundMessage {
  id: string;
  body: string;
  at: number;
}

export type RequestStatus = "new" | "acked" | "assigned" | "confirmed" | "rejected" | "dismissed";

export interface SpotRequest {
  id: string;
  comicId: string;
  comicName: string;
  weekOf: string;
  messages: InboundMessage[];
  intent: Intent;
  status: RequestStatus;
  ackedAt?: number | null;
  rejectedAt?: number | null;
  hold?: HoldReason | null;
  /** Curator chose to let a held request through. */
  holdOverridden?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Slot {
  comicId: string;
  minutes?: number | null;
}

export interface GroupSyncPlan {
  status: "computing" | "pending" | "applying" | "done" | "error";
  toAdd: string[];
  toRemove: string[];
  kept: string[];
  results?: Record<string, "added" | "removed" | "invited" | "failed">;
  error?: string | null;
}

export interface Lineup {
  id: string; // `${weekOf}_${showId}`
  weekOf: string;
  showId: string;
  date: string; // YYYY-MM-DD
  slots: Slot[];
  /** cancelled = called off in advance; canned = it was meant to happen but didn't. */
  status: "draft" | "confirmed" | "cancelled" | "canned";
  sentAt?: number | null;
  groupSync?: GroupSyncPlan | null;
  /** Comics who dropped out after confirmation. */
  dropped?: { comicId: string; at: number }[];
  /** Date the show-day group update ran, so it happens once. */
  showDaySyncedOn?: string | null;
  /** Answer to the morning-after check. */
  outcome?: "happened" | "canned" | null;
  micCheckSentOn?: string | null;
}

export interface GroupInfo {
  id: string;
  name: string;
  participants: number;
  isAdmin: boolean;
}

export type CommandType =
  | "connect"
  | "logout"
  | "list_groups"
  | "send_confirmations"
  | "send_rejections"
  | "send_action"
  | "send_offer"
  | "send_host_poll"
  | "plan_group_sync"
  | "sync_group"
  | "send_message";

export interface Command {
  type: CommandType;
  payload?: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  error?: string | null;
  createdAt: number;
}
