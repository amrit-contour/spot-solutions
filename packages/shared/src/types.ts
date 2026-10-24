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
}

export interface Comic {
  id: string; // whatsapp id, e.g. 919876543210@c.us
  name: string;
  phone: string;
  tier: Tier;
  notes?: string;
  lastPerformedWeek?: string | null; // weekOf key
  regularOf?: string[]; // show ids
}

export interface Intent {
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
  status: "draft" | "confirmed" | "cancelled";
  sentAt?: number | null;
  groupSync?: GroupSyncPlan | null;
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
