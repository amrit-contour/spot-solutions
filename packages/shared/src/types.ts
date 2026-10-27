// Firestore document shapes. Everything lives under users/{uid}/...
import type { GroupPost } from "./groupPosts.ts";
import type { GroupCleanup, LineupCleanup } from "./groupCleanup.ts";
import type { ActivityEntry } from "./lineupActivity.ts";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export type Tier = "open" | "regular" | "featured";

export type SessionStatus = "idle" | "starting" | "qr" | "authenticated" | "ready" | "disconnected" | "error";

/** Written on a planned shutdown (update or restart) so the apps say "back in a minute" instead of "offline". See connection.ts restartingNow. */
export interface RestartMarker {
  at: number;
  reason: "update" | "restart";
  /** After this with no heartbeat the apps fall back to offline. */
  until: number;
}

/** A server's own internet was down and has just come back: Firestore writes failed from `downFrom` until `since`. The apps say "Server lost internet 03:30-03:36". */
export interface NetOutage {
  ok: boolean;
  /** When the server was back online. */
  since: number;
  /** When its writes started failing. */
  downFrom?: number;
}

export interface SessionState {
  status: SessionStatus;
  qr?: string | null;
  phone?: string | null;
  pushName?: string | null;
  lastSeen?: number; // epoch ms, worker heartbeat (0 after a clean shutdown)
  /** A planned restart or update is under way; cleared when the session is ready again. */
  restarting?: RestartMarker | null;
  /** The server's most recent internet outage (written when it recovers; apps show it for a few hours). */
  net?: NetOutage | null;
  aliveAt?: number; // last time the worker was processing messages; survives shutdown
  error?: string | null;
  /** The WhatsApp page answers ("ok", or missing), stopped answering and is being restarted, or kept failing and was given up. `error` says why. */
  health?: "ok" | "unresponsive" | "failing";
}

export interface Settings {
  ack: { enabled: boolean; template: string };
  /** attachLocation: send the venue pin after the confirmation. */
  confirm: { template: string; attachLocation?: boolean };
  /** Sent to a comic taken off a lineup that was already confirmed. */
  cancelSpot: { template: string };
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
  /** afterHours: ask this long after the show starts (missing: 2). `time` is the old "ask from" clock time and is no longer used.
   * rate: after a yes, ask how each comic did (missing: on). */
  /** The curator's own performance tags for the post-show review, added to the built-in set. */
  reviewTags?: string[];
  micCheck: { enabled: boolean; time: string; whatsapp: boolean; afterHours?: number; rate?: boolean };
  /** Group where hosts/POCs vote on which shows they can take. */
  hostPoll: { groupId: string | null };
  /** autoAdd: in an offer to several comics, the first yeses fill the slots. Off: yeses come to Updates and you pick. An offer
   * to one comic always books on yes. Missing means on. */
  offers: { expiryHours: number; autoAdd?: boolean };
  /** Write comic names to the curator's Google Contacts (done in the browser, with the curator's own Google token). */
  googleContacts: { enabled: boolean };
  /** Curator's rewrites of the other messages (see MESSAGE_TYPES). Missing keys use the default. */
  messages?: Partial<Record<import("./messages.ts").MessageKey, import("./messages.ts").MessageOverride>>;
  /** Write outgoing messages in the curator's own voice (see voice.ts). Off by default. */
  voice?: import("./voice.ts").VoiceSettings;
  /** Saved replies the curator can drop into any message box. */
  snippets?: import("./messages.ts").Snippet[];
  /** Tell comics held by the request window or last-week rule why. Banned, ignored and hosts never get a reply. */
  /** Tell held comics why. mode "review" drafts the reply in Updates instead of sending it (missing: send). */
  heldReplies?: { enabled: boolean; mode?: "send" | "review" };
  /** Check waiting requests against your own WhatsApp replies. auto: apply clear ones without asking. */
  followUp?: { enabled: boolean; auto: boolean };
  /** Days "Scan past messages" looks back by default (1 to 21). Missing counts as 7. */
  scanDays?: number;
  /** Data retention. Missing on older docs: closedRequestsWeeks counts as 8. */
  retention?: { closedRequestsWeeks: number };
  /** App look, per user. Missing counts as "nbc" (demo sandboxes count as "classic"). */
  appearance?: { brand: "nbc" | "classic" };
  /** The agent number: a second WhatsApp that talks only to you (agent.ts). Missing counts as DEFAULT_SETTINGS.agent. */
  agent?: AgentSettings;
  /** People and groups whose messages are skipped before anything is read, stored or sent to the AI (neverRead.ts). */
  neverRead?: import("./neverRead.ts").NeverReadEntry[];
  /** "Never read any group": every group chat is skipped except the curator's show groups and Comedy's watched groups. Missing counts as off. */
  neverReadAllGroups?: boolean;
}

/** What the agent number may do for you. Linking it is the opt-in; these switch each part off again. */
export interface AgentSettings {
  /** Master switch: off and the agent stays linked but silent and deaf. */
  enabled: boolean;
  /** Tell you about mic checks, new requests, follow-ups, offer outcomes and warnings. */
  notify: boolean;
  /** Answer your questions ("Monday lineup?"). */
  answer: boolean;
  /** Do things you ask, after you reply yes. */
  actions: boolean;
  /** One morning message with today and what needs you. */
  digest: boolean;
  /** HH:MM in your timezone. */
  digestTime: string;
  /** Anyone else who messages the agent gets one polite line. Off by default (they get nothing). */
  politeNote: boolean;
  /** Name people in lists as real WhatsApp mentions (tappable, shown as their name). Off: plain first names. Default on. */
  agentTagPeople?: boolean;
  /** Ask yes/no and pick-one questions as WhatsApp polls you tap (typing the answer still works). Off: plain text questions. Default on. */
  agentPolls?: boolean;
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
  /** interested: said yes in an offer round where you pick (it waits in Updates). */
  status: "pending" | "accepted" | "declined" | "expired" | "full" | "interested";
  sentAt: number;
  /**
   * The ad hoc request this offer is part of: the same slot(s) offered to `size` comics at once, filling `slots`.
   * autoAdd: the first yeses are booked; off: yeses wait in Updates for you to pick. A round of one always books on yes.
   * The round is simply every offer with this id. Missing on offers sent one at a time before rounds existed.
   */
  round?: { id: string; size: number; slots: number; autoAdd: boolean } | null;
  expiresAt: number;
  reply?: string | null;
  /** Sent as a poll: the poll message's id and its options (first books the spot, second passes). */
  pollMessageId?: string;
  pollOptions?: string[];
  /** Sent after the curator agreed to go over the slot count: a yes books them even when the show is full. */
  overfill?: boolean;
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
  /** Hold requests from comics who performed recently (see cooldownWeeks). Ad hoc spots never count. */
  skipLastWeek: boolean;
  /** How far back "recently" goes, in weeks (1 = last week only, the old rule). Missing means 1. */
  cooldownWeeks?: number;
  /** A comic sits on at most one show a week: placing them moves them off the other. Off (missing) by default.
   * POCs, regulars and co-hosts can always be on several shows. */
  onePerWeek?: boolean;
}

/** Why a request was held back instead of landing in Asked. */
export type HoldReason = "midweek" | "last_week" | "banned" | "ignored" | "host";

export type ComicList = "banned" | "ignored" | "host";

/** Did a comic turn up? Missing means they showed up. */
export type Attendance = "showed" | "late" | "no_show" | "cancelled" | "swapped";

export interface SpotHistoryEntry {
  date: string; // YYYY-MM-DD of the show
  showId: string;
  showName: string;
  status: "confirmed" | "cancelled" | "canned";
  /** An ad hoc spot: shown in history, ignored by the cooldown. */
  adhoc?: boolean;
  /** How they did, 1 (rough) to 5 (killed it), as the curator rated it after the show. Kept with the spot. */
  rating?: number | null;
  /** The curator's short note on how they did (kept with the spot, shown in spot history). */
  note?: string | null;
  /** Turned up late, no-show, cancelled in advance or gave the spot away. Missing: showed up. */
  attendance?: Attendance | null;
  /** How they did, as tags (Killed, Hack, Went over time, or the curator's own). */
  tags?: string[] | null;
}

/** A comic asked something other than a spot: drafted reply waiting for the curator. */
export interface ComicAction {
  id: string;
  kind: "cancel_spot" | "status_query" | "last_spot_query" | "show_info" | "onboard" | "follow_up" | "held";
  comicId: string;
  comicName: string;
  weekOf: string;
  message: string;
  draft: string;
  /** The draft goes out as more than text: a poll, a pin, or a pin after the text. */
  rich?: { kind: import("./messages.ts").MessageKind; poll?: import("./messages.ts").PollSpec; attachLocation?: boolean; venueId?: string | null };
  /** For cancel_spot: which lineup the comic is in. */
  lineupId?: string | null;
  status: "pending" | "sent" | "dismissed";
  createdAt: number;
  /** When the curator ignored it in the app (cleared again by Undo). */
  dismissedAt?: number;
  /** follow_up: what the curator's own WhatsApp reply to a waiting request seems to say. */
  followUp?: FollowUpSuggestion;
}

/** Read from the curator's own reply to someone still Waiting. Applied from Updates, or straight away on Auto. */
export interface FollowUpSuggestion {
  requestId: string;
  action: "place" | "close_declined";
  showId: string | null;
  showName: string | null;
  /** The show has a group and they aren't in it yet: applying adds them. */
  addToGroup: boolean;
  confidence: "high" | "low";
  reason: string;
  /** The curator's words it was read from. */
  evidence: string;
}

/** What a notice is about, so the agent number only forwards the ones that matter ("offer" outcomes, "lineup" changes, "server" moves). */
export type NoticeKind = "offer" | "lineup" | "server" | "access";

export interface AppNotice {
  id: string;
  level: "info" | "warn";
  /** Set by the worker on notices the agent number forwards. */
  kind?: NoticeKind;
  text: string;
  /** Kind "access": what the agent number says instead of `text` (it carries the reply commands). */
  agentText?: string;
  /** In the app's Updates only, never forwarded to the agent number (an in-progress retry). */
  quiet?: boolean;
  /** Where the card's button goes in the app (e.g. "/admin"), and what it says. */
  link?: string;
  linkLabel?: string;
  createdAt: number;
  read: boolean;
  /** When the curator dismissed it in the app (cleared again by Undo). */
  dismissedAt?: number;
}

export interface Venue {
  id: string;
  name: string;
  area?: string;
  mapsLink?: string;
  /** Pin for location messages, in decimal degrees. Both or neither. */
  lat?: number;
  lng?: number;
  /** Google place id and address from the place search (the card shows them). */
  placeId?: string;
  address?: string;
  /** Other names comics use for this place ("bloom", "indira nagar"). Shown to the model. */
  aliases?: string[];
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
  /**
   * When the group gets updated. "manual": only when the curator taps Sync group.
   * "confirm": review it right after confirming or sending updates. "show_day": automatically on the day.
   * Missing means "confirm" (what shows did before the choice existed); see groupModeOf.
   */
  groupMode?: GroupMode;
  showDaySyncTime?: string; // "12:00"
  postLineupToGroup?: boolean;
  /** Messages sent to the group on a schedule (lineup, venue pin, reminders). See groupPosts.ts. */
  groupPosts?: GroupPost[];
  /** Post id → the show date it last went out for, so each goes once per show. Written by the worker. */
  groupPostsSent?: Record<string, string> | null;
  /** Points of contact who run the mic. They always stay in the group and can be tagged with {{pocs}}. Comic ids. */
  pocs?: string[];
  /** The day-after cleanup of the group. See groupCleanup.ts. */
  cleanup?: GroupCleanup;
  /** Last members read from the group, so the lineup page can show them instantly. Written by the worker. */
  groupMembers?: GroupMembersCache | null;
}

export type GroupMode = "manual" | "confirm" | "show_day";

/** One person in a show's WhatsApp group (the curator excluded). */
export interface GroupMember {
  /** Comic id (phone-based) when the number is known, else the raw @lid. */
  id: string;
  name: string;
  isAdmin: boolean;
  /** The other ids WhatsApp knows them by (the raw @lid next to a phone id), so they match a roster entry kept under the other one. */
  alt?: string[];
}

export interface GroupMembersCache {
  groupId: string;
  at: number; // epoch ms
  members: GroupMember[];
  /** The group's invite code (admins only), for opening it in WhatsApp: https://chat.whatsapp.com/<code>. */
  inviteCode?: string;
}

export interface Comic {
  id: string; // stable id: phone-based (919876543210@c.us) when known, else the @lid
  chatId?: string; // the JID WhatsApp actually delivers to (often @lid on current WhatsApp)
  /** Other ids WhatsApp has known this person by (left behind when a duplicate doc was merged into this one), so their messages still land here. */
  aliases?: string[];
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
  /** WhatsApp profile picture URL (they expire), or "none" when the person hides it. See profilePics.ts. */
  photoUrl?: string | null;
  /** When photoUrl was last fetched (ms). */
  photoAt?: number | null;
}

export type IntentKind = "spot_request" | "cancel_spot" | "status_query" | "last_spot_query" | "show_info" | "other";

/** Fixed labels Gemma may attach to a request (see requestTags.ts). */
export type IntentTag = "new_material" | "flexible_days" | "specific_time" | "longer_set" | "travelling" | "bringing_audience" | "first_time_here";

export interface Intent {
  /** Venue the message points at (a venue id), when it names one. */
  venueId?: string | null;
  tags?: IntentTag[];
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
  /** Set by "Clear closed": a closed request hidden from the list (kept for history, cooldowns and stats). Only counts while the request is closed. */
  clearedAt?: number | null;
  hold?: HoldReason | null;
  /** Settled by a recorded past spot (backfill); set so removing that spot can reopen it. */
  backfilledAt?: number;
  /** Curator chose to let a held request through. */
  holdOverridden?: boolean;
  /**
   * How to reach them. Unsure (Maybe) asks don't add anyone to Comics; placing one on a lineup does, from this.
   */
  contact?: { chatId: string; phone: string; nameSource: NonNullable<Comic["nameSource"]> } | null;
  /** Newest of the curator's own replies the follow-up check has already read (epoch ms). */
  followUpReplyAt?: number | null;
  /** When the comic was told why their request was held (heldReplies). Once per request. */
  heldRepliedAt?: number | null;
  /** Stamped once by the worker: this request created the comic, so they weren't on the roster before. */
  firstContact?: boolean;
  /** Stamped once by the worker: requests this comic made in earlier weeks. */
  priorRequests?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Slot {
  comicId: string;
  minutes?: number | null;
  /** A last-minute spot (booked through an offer, or added after the lineup was confirmed). Kept in history; never holds them back. */
  adhoc?: boolean;
  /** Recorded afterwards for a show that had already happened: never messaged, never synced to the group. */
  backfill?: boolean;
  /** Added directly with "Send them a confirmation" off: nobody has told them yet. Cleared by the lineup's record of what was sent. */
  notTold?: boolean;
  /** Added directly with "Add them to the show's group" off: automatic group syncs leave them out; a sync you press adds them. */
  noGroup?: boolean;
  /** How they did on the night, 1 to 5 (the curator's rating after the show). */
  rating?: number | null;
  /** A short note on how they did, next to the rating. */
  note?: string | null;
  attendance?: Attendance | null;
  tags?: string[] | null;
}

/** How the room felt, a light optional tag on a show review. */
export type CrowdLevel = "quiet" | "good" | "packed";

/** The curator's review of a show after it happened. Every part is optional; `at` is when it was last saved. */
export interface ShowReview {
  /** Overall, 1 (rough) to 5 (killed it). */
  rating?: number | null;
  /** Free text: the crowd, sound, anything worth remembering. */
  notes?: string | null;
  crowd?: CrowdLevel | null;
  at: number;
}

export interface GroupSyncPlan {
  status: "computing" | "pending" | "applying" | "done" | "error";
  toAdd: string[];
  toRemove: string[];
  kept: string[];
  results?: Record<string, "added" | "removed" | "invited" | "failed">;
  /** On the lineup with an invite link out, not yet in the group (id -> when it was sent). Not in `toAdd`. */
  invited?: Record<string, number>;
  /** Invited more than a day ago and still not in: also in `toAdd`, offered as "Resend invite". */
  lapsed?: string[];
  error?: string | null;
}

/** What a comic was last told about their spot. Keyed by comic id; written by the worker when it sends. */
export interface SentSpot {
  at: number;
  /** Set length they were told, or null when it wasn't mentioned. */
  minutes: number | null;
  /** Position (0-based) on the lineup when they were told. */
  order: number;
}
export type SentMap = Record<string, SentSpot>;

export interface Lineup {
  id: string; // `${weekOf}_${showId}`
  weekOf: string;
  showId: string;
  date: string; // YYYY-MM-DD
  slots: Slot[];
  /** cancelled = called off in advance; canned = it was meant to happen but didn't. */
  status: "draft" | "confirmed" | "cancelled" | "canned";
  sentAt?: number | null;
  /** Per comic, what was last sent. Edits after confirming are diffed against this. */
  sent?: SentMap | null;
  groupSync?: GroupSyncPlan | null;
  /** Comics sent a WhatsApp invite link to the group who haven't joined (id -> sent at). Dropped once they're in, or after a day they're offered again. */
  groupInvites?: Record<string, number> | null;
  /** Members the curator marked to leave the group on the next sync, even if they'd normally stay (admins). */
  groupLeaving?: string[] | null;
  /** Comics who dropped out after confirmation. */
  dropped?: { comicId: string; at: number }[];
  /** Date the show-day group update ran, so it happens once. */
  showDaySyncedOn?: string | null;
  /** Answer to the morning-after check. */
  outcome?: "happened" | "canned" | null;
  /** The day-after group cleanup for this show date. */
  cleanup?: LineupCleanup | null;
  /** POCs, regulars, co-hosts and group admins were put on this lineup when it was first opened. Not redone after you remove someone. */
  defaultsSeeded?: boolean;
  micCheckSentOn?: string | null;
  /** Date the agent asked for ratings, so it asks once. */
  ratingAskedOn?: string | null;
  /** The curator said skip: nobody asks again for this show. */
  ratingsSkipped?: boolean;
  /** The curator's review of the show itself (overall rating, crowd, notes). Comics' ratings and notes live on the slots. */
  review?: ShowReview | null;
  /** Date the agent asked how the show was overall, so it asks once. */
  reviewAskedOn?: string | null;
  /** A past show recorded after the fact. History only: the worker never messages, syncs, asks or posts for it. */
  backfilled?: boolean;
  /** What the worker did for this lineup that nothing else records (confirmations, updates, group update, group posts). Newest last, capped at 50. */
  activity?: ActivityEntry[];
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
  | "send_lineup_updates"
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
  | "list_group_members"
  | "list_contacts"
  | "move_account"
  | "reclassify_requests"
  | "scan_history"
  | "reconcile_waiting"
  | "apply_reconcile"
  | "learn_voice"
  | "apply_follow_up"
  | "connect_agent"
  | "logout_agent"
  | "test_agent"
  | "send_format_samples"
  | "preview_voice"
  | "send_message"
  | "list_threads"
  | "get_thread"
  | "get_media"
  | "react_message"
  | "send_media"
  | "summarize_thread"
  | "list_voice_sources"
  | "parse_roster"
  | "cleanup_group"
  | "settle_round"
  | "send_ask"
  | "ask_for_spot"
  | "profile_pics"
  | "merge_comics";

export interface Command {
  type: CommandType;
  payload?: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  error?: string | null;
  createdAt: number;
  /** summarize_thread: what the worker is doing now ("Reading 28 messages…"), written while it runs. */
  stage?: string;
  /** scan_history: written by the worker while it runs. */
  progress?: { chats: number; done: number; found: number };
  /** learn_voice: written by the worker while it reads. */
  voiceProgress?: { stage: "reading" | "learning"; chats: number; done: number; samples: number };
  /** scan_history: the curator sets this to stop it. */
  cancel?: boolean;
  /** Firestore Timestamp (TTL policy, deploy/setup-cost-controls.sh). Typed loosely: shared code never imports an SDK. */
  expireAt?: unknown;
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
  /** Set by the worker when a configured local model wasn't installed and the setting was changed to one that is. */
  autoSwitched?: { from: string; to: string; at: number; server: string };
  /**
   * The curator chose to keep `model` although it isn't installed (Undo of an auto-switch, or picked on purpose). The worker never
   * saves another model over it; it only substitutes at run time. Cleared when the model gets installed or another is picked.
   */
  keepMissing?: { model: string; at: number };
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
  /** client_email of the key this server runs with (null for application-default credentials). */
  serviceAccount?: string | null;
  platform: string; // "linux", "win32", "darwin"
  osRelease: string;
  arch: string;
  version: string; // git sha or package version
  startedAt: number;
  lastSeen: number;
  /** This server's most recent internet outage, once it recovered (see NetOutage). */
  net?: NetOutage | null;
  cpu: { model: string; cores: number; load1: number; usage: number }; // usage 0..1
  memory: { total: number; free: number; process: number };
  /** The server's local console: LAN addresses, its .local name and access code (admins only). */
  console?: { port: number; ips: string[]; host: string; token: string | null };
  disk?: { total: number; free: number } | null;
  ollama: { up: boolean; url: string; models: { name: string; size: number }[]; loaded: string[] };
  geminiServerKey: boolean;
  sessions: { uid: string; email?: string | null; name?: string | null; status: string; phone?: string | null }[];
  counters: { messagesIn: number; classified: number; sent: number; errors: number };
  /** Last 24 h at a glance (rides on the heartbeat; the full live view is in the server's own console). Missing on older servers. */
  live?: { accounts: number; ready: number; in24h: number; spot24h: number; sent24h: number; err24h: number; queue: number };
  admins: string[]; // lower-case emails
  logs?: string[]; // most recent last; only written while someone is watching (logsWanted)
  /** Set by the Server page (ms) while its log section is open, refreshed every minute. The worker sends logs only while it is fresh. */
  logsWanted?: number;
  /** Fleet capacity (docs/fleet.md). Missing on servers older than the fleet release. */
  fleet?: import("./fleet.ts").FleetCapacity;
  /** A planned restart or update is under way (cleared by the next heartbeat). */
  restarting?: RestartMarker | null;
  /** An update the server is running or just ran (written by the worker; see apps/worker/console/update.mjs). */
  update?: { state: "updating" | "error"; target: string | null; from: string; startedAt: number; error?: string };
}

/** servers/{id}/commands/{cmd}: admin actions from the app's Server page. */
export interface ServerCommand {
  type: "restart_worker" | "restart_ollama" | "update_server" | "delete_user_data" | "remove_user" | "wipe_demo";
  /** delete_user_data / remove_user / wipe_demo: see AdminDataPayload. */
  payload?: Record<string, unknown>;
  result?: unknown;
  status: "pending" | "running" | "done" | "error";
  by: string;
  error?: string | null;
  createdAt: number;
  /** Firestore Timestamp (TTL, deploy/setup-cost-controls.sh). */
  expireAt?: unknown;
}

/** access/{uid}: who may use this Nothing BOT Curate install. Created "pending" on first sign-in. */
export interface AccessEntry {
  uid: string;
  email: string | null;
  name: string | null;
  photo?: string | null;
  status: "pending" | "approved" | "removed";
  requestedAt: number;
  decidedAt?: number | null;
  decidedBy?: string | null;
  /** Written by the worker: why a pending request is waiting (an invite that could not be used yet). */
  note?: string | null;
}

/** invites/{emailLower}: an admin invited this address; the worker approves a matching verified sign-in. */
export interface Invite {
  createdBy: string;
  createdAt: number;
  /** Firestore Timestamp, 30 days after creation (TTL, deploy/setup-cost-controls.sh). */
  expireAt: unknown;
}

/** config/access: written by the worker from NBS_ADMIN_EMAILS; maxCurators editable by admins. */
export interface AccessConfig {
  admins: string[];
  maxCurators: number;
}
