// Firestore document shapes. Everything lives under users/{uid}/...

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export type Tier = "open" | "regular" | "featured";

export type SessionStatus = "idle" | "starting" | "qr" | "authenticated" | "ready" | "disconnected" | "error";

export interface SessionState {
  status: SessionStatus;
  qr?: string | null;
  phone?: string | null;
  pushName?: string | null;
  lastSeen?: number; // epoch ms, worker heartbeat (0 after a clean shutdown)
  aliveAt?: number; // last time the worker was processing messages; survives shutdown
  error?: string | null;
}

export interface Settings {
  ack: { enabled: boolean; template: string };
  confirm: { template: string };
  reject: { enabled: boolean; template: string };
  /** @deprecated read `ai`; kept so older docs still load. */
  model?: { provider: "ollama" | "gemini"; name: string; fallback: boolean };
  ai: AiSettings;
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
  /** Write comic names to the curator's Google Contacts (done in the browser, with the curator's own Google token). */
  googleContacts: { enabled: boolean };
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
  | "list_models"
  | "list_gemini_models"
  | "test_ai"
  | "pull_model"
  | "plan_group_sync"
  | "sync_group"
  | "pull_group_members"
  | "list_contacts"
  | "move_account"
  | "send_message";

export interface Command {
  type: CommandType;
  payload?: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  error?: string | null;
  createdAt: number;
}

export type AiProvider = "ollama" | "gemini";
export interface AiRoute {
  provider: AiProvider;
  model: string;
}
export interface AiSettings {
  primary: AiRoute;
  fallback: AiRoute | null;
  /** Where chats may be read: see AiPolicy in fleet.ts. Missing means DEFAULT_AI_POLICY. */
  policy?: import("./fleet.ts").AiPolicy;
}

/** users/{uid}/secrets/ai. Write-only from the app; only the worker reads it. */
export interface AiSecrets {
  geminiKey?: string | null;
}

/** users/{uid}.aiKeys: safe-to-show summary of what's stored in secrets. */
export interface AiKeyStatus {
  gemini?: { set: boolean; last4?: string | null; updatedAt?: number } | null;
}

/** servers/{id}: a worker machine's heartbeat, readable by its admins. */
export interface ServerStatus {
  id: string;
  hostname: string;
  platform: string; // "linux", "win32", "darwin"
  osRelease: string;
  arch: string;
  version: string; // git sha or package version
  startedAt: number;
  lastSeen: number;
  cpu: { model: string; cores: number; load1: number; usage: number }; // usage 0..1
  memory: { total: number; free: number; process: number };
  disk?: { total: number; free: number } | null;
  ollama: { up: boolean; url: string; models: { name: string; size: number }[]; loaded: string[] };
  geminiServerKey: boolean;
  sessions: { uid: string; email?: string | null; name?: string | null; status: string; phone?: string | null }[];
  counters: { messagesIn: number; classified: number; sent: number; errors: number };
  admins: string[]; // lower-case emails
  logs?: string[]; // most recent last
  /** Fleet capacity (docs/fleet.md). Missing on servers older than the fleet release. */
  fleet?: import("./fleet.ts").FleetCapacity;
}

/** servers/{id}/commands/{cmd}: admin actions from the app's Server page. */
export interface ServerCommand {
  type: "restart_worker" | "restart_ollama" | "delete_user_data" | "remove_user" | "wipe_demo";
  /** delete_user_data / remove_user / wipe_demo: see AdminDataPayload. */
  payload?: Record<string, unknown>;
  result?: unknown;
  status: "pending" | "running" | "done" | "error";
  by: string;
  error?: string | null;
  createdAt: number;
}

/** access/{uid}: who may use this Spot Solutions install. Created "pending" on first sign-in. */
export interface AccessEntry {
  uid: string;
  email: string | null;
  name: string | null;
  photo?: string | null;
  status: "pending" | "approved" | "removed";
  requestedAt: number;
  decidedAt?: number | null;
  decidedBy?: string | null;
}

/** config/access: written by the worker from SPOT_ADMIN_EMAILS; maxCurators editable by admins. */
export interface AccessConfig {
  admins: string[];
  maxCurators: number;
}
