// What the server did for one lineup, as a list for the Lineup page, and the state pill a show card carries.
// Most of it is read from fields that already exist (sent, groupSync, cleanup, outcome, offers, the show's scheduled posts).
// What nothing recorded (confirmations, updates, group posts, the group update, with their failures) the worker appends to the
// lineup's capped `activity` array. Pure rules; the web renders them and the worker writes the entries.
import { clampDays, addDays } from "./groupPosts.ts";
import { criteriaSummary, hasCriteria } from "./groupPostCriteria.ts";
import type { GroupPost } from "./groupPosts.ts";
import { formatDate, formatTime } from "./week.ts";
import type { Lineup, Show, SpotOffer } from "./types.ts";

export const ACTIVITY_CAP = 50;

/** What a scheduled group post is called in a sentence. */
export const POST_LABEL: Record<GroupPost["template"], string> = { groupLineup: "lineup post", groupVenue: "venue post", groupReminder: "reminder", groupPocs: "POC post", groupReachEarly: "reach-on-time post", groupPoster: "poster post", groupBusking: "busking notice", groupCleanup: "after-show message", groupThanks: "thank-you", groupDidntHappen: "mic-didn't-happen note", groupCancelled: "cancellation note", groupRepeat: "repeat-next-week note", groupSignups: "sign-ups post", groupLatecomers: "call-time reminder", custom: "scheduled post" };

/** One thing the worker did for a lineup. Stored on the lineup doc, newest last, capped. */
export interface ActivityEntry {
  at: number;
  kind: "confirmations" | "updates" | "sync" | "post" | "lineup_post";
  tone: "done" | "failed" | "info";
  text: string;
  /** Extra lines under the text (who it failed for). */
  detail?: string[];
  /** The scheduled post this is about. */
  ref?: string;
}

/** Add an entry, dropping the oldest past the cap. Never mutates. */
export function appendActivity(list: ActivityEntry[] | null | undefined, entry: ActivityEntry, cap = ACTIVITY_CAP): ActivityEntry[] {
  return [...(list ?? []), entry].slice(-cap);
}

export type ActivityIcon = "send" | "group" | "post" | "offer" | "mic" | "cleanup" | "out";
export type ActivityTone = "done" | "failed" | "scheduled" | "info";

export interface ActivityRow {
  key: string;
  /** Epoch ms; null for a row that is still to come, or whose time was never recorded (then `day` may say which day). */
  at: number | null;
  /** The day it happened, when only the day is known (YYYY-MM-DD). */
  day?: string;
  /** For something still to come: "Tue 18:00". */
  when?: string;
  icon: ActivityIcon;
  tone: ActivityTone;
  text: string;
  detail?: string[];
  action?: "retry_cleanup";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayMs = (day: string) => Date.parse(`${day}T12:00:00Z`);
const STORED_ICON: Record<ActivityEntry["kind"], ActivityIcon> = { confirmations: "send", updates: "send", sync: "group", post: "post", lineup_post: "post" };

export interface ActivityInput {
  lineup?: Lineup | null;
  show: Show;
  /** Offers for this lineup. */
  offers?: SpotOffer[];
  /** Today and now in the curator's time zone. */
  now: { date: string; time: string };
  nameOf: (comicId: string) => string;
}

/** The list for a lineup's Activity section: oldest first, then what is still scheduled. */
export function lineupActivity({ lineup, show, offers = [], now, nameOf }: ActivityInput): ActivityRow[] {
  const dated: ActivityRow[] = [];
  const ahead: (ActivityRow & { sort: string })[] = [];
  const stored = lineup?.activity ?? [];
  const has = (kind: ActivityEntry["kind"]) => stored.some((e) => e.kind === kind);

  stored.forEach((e, i) => dated.push({ key: `s${i}`, at: e.at, icon: STORED_ICON[e.kind], tone: e.tone, text: e.text, ...(e.detail?.length ? { detail: e.detail } : {}) }));

  if (lineup) {
    // Older lineups never recorded these: read them from what the lineup itself keeps.
    if (lineup.sentAt && !has("confirmations") && !lineup.backfilled) {
      const n = Object.keys(lineup.sent ?? {}).length;
      dated.push({ key: "confirm", at: lineup.sentAt, icon: "send", tone: "done", text: n ? `Confirmations sent to ${plural(n, "comic")}` : "Lineup confirmed" });
    }
    const gs = lineup.groupSync;
    if (gs?.status === "pending") dated.push({ key: "sync-pending", at: null, icon: "group", tone: "scheduled", text: `Group update ready to review: ${gs.toAdd.length} to add, ${gs.toRemove.length} to remove` });
    else if (gs?.status === "error") dated.push({ key: "sync-error", at: null, icon: "group", tone: "failed", text: "The group update failed", detail: gs.error ? [gs.error] : undefined });
    else if (gs?.status === "done" && gs.results && !has("sync")) {
      const r = Object.values(gs.results);
      const count = (k: string) => r.filter((x) => x === k).length;
      const parts = [count("added") && `${count("added")} added`, count("invited") && `${count("invited")} invited`, count("removed") && `${count("removed")} removed`].filter(Boolean);
      const failed = count("failed");
      dated.push({ key: "sync", at: lineup.showDaySyncedOn ? dayMs(lineup.showDaySyncedOn) : null, day: lineup.showDaySyncedOn ?? undefined, icon: "group", tone: failed ? "failed" : "done", text: `Group updated${parts.length ? `: ${parts.join(", ")}` : ", no changes"}${failed ? `. ${plural(failed, "person", "people")} couldn't be updated` : ""}` });
    }
    for (const d of lineup.dropped ?? []) dated.push({ key: `drop-${d.comicId}`, at: d.at, icon: "out", tone: "info", text: `${nameOf(d.comicId)} dropped out` });

    if (lineup.micCheckSentOn) dated.push({ key: "mic", at: dayMs(lineup.micCheckSentOn), day: lineup.micCheckSentOn, icon: "mic", tone: "done", text: "Asked if the show happened" });
    if (lineup.outcome) dated.push({ key: "outcome", at: lineup.micCheckSentOn ? dayMs(lineup.micCheckSentOn) + 1 : null, day: lineup.micCheckSentOn ?? undefined, icon: "mic", tone: lineup.outcome === "happened" ? "done" : "failed", text: lineup.outcome === "happened" ? "Answer: it happened" : "Answer: it didn't happen" });

    const c = lineup.cleanup;
    if (c) {
      const left = c.pending ?? [];
      if (c.status === "asked") dated.push({ key: "cleanup", at: c.at, icon: "cleanup", tone: "scheduled", text: c.reason === "repeat" ? "Waiting for you: repeat next week? That decides whether the group is cleared" : c.reason === "canned" ? "Waiting for you: clear the group, even though the show didn't happen?" : "Waiting for you: clear the group for next week?" });
      else if (c.status === "done") dated.push({ key: "cleanup", at: c.at, icon: "cleanup", tone: "done", text: `Cleared the group: removed ${c.removed ?? 0}`, detail: c.skipped ? [`${plural(c.skipped, "member")} left alone because they couldn't be identified`] : undefined });
      else if (c.status === "partial") {
        const next = c.retryAt ? `Trying again ${new Date(c.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not retrying any more. Remove them by hand, or retry now";
        dated.push({ key: "cleanup", at: c.at, icon: "cleanup", tone: "failed", text: `Cleared the group except ${left.length}: removed ${c.removed ?? 0}`, detail: [...left.map((p) => `${p.name ?? `+${p.id.split("@")[0]}`}: ${p.reason}`), next], action: "retry_cleanup" });
      } else if (c.status === "kept") dated.push({ key: "cleanup", at: c.at, icon: "cleanup", tone: "info", text: "Kept everyone in the group" });
      else if (c.status === "skipped") dated.push({ key: "cleanup", at: c.at, icon: "cleanup", tone: "info", text: "Skipped clearing the group: it wasn't done in time" });
    }

    for (const o of offers.filter((x) => x.lineupId === lineup.id)) {
      const who = o.comicName;
      const text =
        o.status === "pending" ? `Offered ${who} the spot, waiting for a reply` :
        o.status === "accepted" ? `${who} took the offered spot` :
        o.status === "declined" ? `${who} passed on the offered spot` :
        o.status === "interested" ? `${who} is interested in the offered spot` :
        o.status === "full" ? `${who} said yes, but the spot was already filled` :
        `No reply from ${who}: the offer expired`;
      dated.push({ key: `offer-${o.id}`, at: o.sentAt, icon: "offer", tone: o.status === "pending" ? "scheduled" : o.status === "accepted" ? "done" : "info", text, ...(o.reply ? { detail: [`"${o.reply}"`] } : {}) });
    }
  }

  // Scheduled group posts: still to come, or posted before the app recorded each one.
  const off = lineup?.status === "cancelled" || lineup?.status === "canned" || lineup?.backfilled;
  const showDate = lineup?.date;
  if (showDate && show.groupId && !lineup?.backfilled) {
    for (const post of show.groupPosts ?? []) {
      if (!post.enabled) continue;
      // A show that is off gets no posts, except the ones written for that ("only if it didn't happen").
      if (off && !post.criteria?.show) continue;
      const day = addDays(showDate, -clampDays(post.daysBefore));
      const label = POST_LABEL[post.template];
      const recorded = stored.some((e) => (e.kind === "post" || e.kind === "lineup_post") && e.ref === post.id);
      if (show.groupPostsSent?.[post.id] === showDate) {
        if (!recorded) dated.push({ key: `post-${post.id}`, at: dayMs(day), day, icon: "post", tone: "done", text: `Posted the ${label} in the group` });
      } else if (show.groupPostStatus?.[post.id]?.state === "waiting" && show.groupPostStatus[post.id].showDate === showDate) {
        ahead.push({ key: `post-${post.id}`, at: null, when: "Waiting", sort: `${day} ${post.time}`, icon: "post", tone: "scheduled", text: `The ${label}: ${show.groupPostStatus[post.id].text}` });
      } else if (`${day} ${post.time}` > `${now.date} ${now.time}`) {
        const when = `${day === now.date ? "Today" : formatDate(day)} ${formatTime(post.time)}`;
        ahead.push({ key: `post-${post.id}`, at: null, when, sort: `${day} ${post.time}`, icon: "post", tone: "scheduled", text: `The ${label} goes out${hasCriteria(post.criteria) ? `, ${criteriaSummary(post.criteria)}` : ""}` });
      }
    }
  }

  dated.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  ahead.sort((a, b) => a.sort.localeCompare(b.sort));
  return [...dated, ...ahead.map(({ sort: _s, ...r }) => r)];
}

export type ShowStateKind = "upcoming" | "today" | "done" | "didnt" | "recorded" | "called_off" | "past";

export interface ShowState {
  kind: ShowStateKind;
  label: string;
  /** The card starts collapsed: the show is over (or never will happen). */
  over: boolean;
}

/** The pill a show card carries. `showDate` is this week's date for the show; `today` the curator's local date. */
export function showState(lineup: Pick<Lineup, "status" | "outcome" | "backfilled"> | null | undefined, showDate: string, today: string): ShowState {
  const passed = showDate < today;
  if (lineup?.backfilled) return { kind: "recorded", label: "Recorded", over: true };
  if (lineup?.status === "canned") return { kind: "didnt", label: "Didn't happen", over: true };
  if (lineup?.status === "cancelled") return { kind: "called_off", label: "Called off", over: passed };
  if (lineup?.outcome === "happened") return { kind: "done", label: "Done", over: true };
  if (passed) return lineup?.status === "confirmed" ? { kind: "done", label: "Done", over: true } : { kind: "past", label: "Past show", over: true };
  if (showDate === today) return { kind: "today", label: "Today", over: false };
  return { kind: "upcoming", label: "Upcoming", over: false };
}
