// "Send only if…" for scheduled group posts: a post goes out only when its criteria hold at send time (the show happened, the lineup
// is full, it repeats next week…). All criteria are optional and combined with AND. Pure rules, no I/O: the worker evaluates them
// when a post comes due and records why one was skipped; the app writes the one-line summary from the same words.
import type { GroupPost } from "./groupPosts.ts";
import type { Lineup } from "./types.ts";

/** What the show has to be: a confirmed lineup, one that happened, one that didn't (the mic was canned), or one called off in advance. */
export type ShowStatusCriterion = "confirmed" | "happened" | "didnt_happen" | "cancelled";

export interface PostCriteria {
  /** Missing: any show that isn't off (a called-off or canned show gets no posts, as before). */
  show?: ShowStatusCriterion;
  /** At least this many comics on the lineup. */
  minComics?: number;
  /** Every spot on the lineup is filled. */
  full?: boolean;
  /** true: the same lineup repeats next week. false: it doesn't. */
  repeats?: boolean;
  /** Hours to wait for an answer that isn't in yet ("did it happen?", "repeating?") before skipping. Default 6. */
  waitHours?: number;
}

/** What to do after a post goes out. Never silent: removal goes through the group review, or runs by itself only when the show's cleanup is on auto. */
export interface PostAfter {
  /** Remove this week's comics from the group (regulars, POCs, co-hosts and admins stay). */
  removeComics?: boolean;
}

export const DEFAULT_WAIT_HOURS = 6;
export const MAX_WAIT_HOURS = 20;
/** The last minute of the day a held post is still decided: posts only run on their own day, so a wait can't carry past it. */
const DAY_END_MIN = 23 * 60 + 30;

export const SHOW_STATUS_OPTIONS: { value: ShowStatusCriterion; label: string; short: string }[] = [
  { value: "confirmed", label: "Lineup is confirmed", short: "the lineup is confirmed" },
  { value: "happened", label: "It happened", short: "it happened" },
  { value: "didnt_happen", label: "It didn't happen", short: "it didn't happen" },
  { value: "cancelled", label: "Called off before it started", short: "it was called off" },
];

export const hasCriteria = (c: PostCriteria | null | undefined): c is PostCriteria =>
  Boolean(c && (c.show || c.minComics || c.full || c.repeats !== undefined));

/** "Only send when…" is on for a post when it carries any criterion. Posts with none (the old "Any show that's on" and nothing else) are off. */
export const criteriaOn = (post: { criteria?: PostCriteria | null }) => hasCriteria(post.criteria);

/** What switching "Only send when…" on starts from: the ready-made template's own criteria, else "the lineup is confirmed". */
export function seedCriteria(template: GroupPost["template"], previous?: PostCriteria | null): PostCriteria {
  if (hasCriteria(previous)) return previous;
  return { ...(TEMPLATE_CRITERIA[template] ?? { show: "confirmed" as ShowStatusCriterion}) };
}

/** The post's criteria after the switch is flipped: off drops them all (the default rule applies), on seeds some. */
export const toggleCriteria = (post: Pick<GroupPost, "template" | "criteria">, on: boolean, remembered?: PostCriteria | null): PostCriteria | null => (on ? seedCriteria(post.template, remembered ?? post.criteria) : null);

/** The one muted line shown when "Only send when…" is off. */
export const DEFAULT_RULE_LINE = "Skipped if the show is called off or didn't happen.";

/** Drops empty values so a post carries only what is set (Firestore doesn't take undefined). */
export function cleanCriteria(c: PostCriteria | null | undefined): PostCriteria | null {
  if (!c) return null;
  const out: PostCriteria = {};
  if (c.show) out.show = c.show;
  if (c.minComics && c.minComics > 0) out.minComics = Math.round(c.minComics);
  if (c.full) out.full = true;
  if (c.repeats !== undefined && c.repeats !== null) out.repeats = c.repeats;
  if (hasCriteria(out) && c.waitHours && c.waitHours !== DEFAULT_WAIT_HOURS) out.waitHours = Math.min(MAX_WAIT_HOURS, Math.max(1, Math.round(c.waitHours)));
  return hasCriteria(out) ? out : null;
}

/** "only if it happened · at least 4 comics", or "" when the post always goes. */
export function criteriaSummary(c: PostCriteria | null | undefined): string {
  if (!hasCriteria(c)) return "";
  const parts: string[] = [];
  if (c.show) parts.push(SHOW_STATUS_OPTIONS.find((o) => o.value === c.show)!.short);
  if (c.minComics) parts.push(`at least ${c.minComics} comic${c.minComics === 1 ? "" : "s"}`);
  if (c.full) parts.push("the lineup is full");
  if (c.repeats === true) parts.push("the lineup repeats next week");
  if (c.repeats === false) parts.push("the lineup doesn't repeat");
  return `only if ${parts.join(" and ")}`;
}

/** What the worker knows when a post comes due. */
export interface CriteriaFacts {
  /** This show date's lineup, or null when there is none. */
  lineup: Pick<Lineup, "status" | "outcome" | "slots" | "repeatNext"> | null;
  /** Spots the show has. */
  slotCount: number;
  /** Mic checks are on: only then does an outcome get asked, so only then is "happened" a thing to wait for. */
  micCheckOn: boolean;
  /** Minutes since the post was due (0 at its time). */
  overdueMin: number;
}

export type Verdict =
  | { go: true }
  /** Skip for good (the post is marked as done for this show date). `reason` is what the app shows: "Skipped: show didn't happen". */
  | { go: false; hold: false; reason: string }
  /** Not decidable yet: try again on the next tick, up to the wait limit. `reason` is what the app shows: "Waiting for 'did it happen'". */
  | { go: false; hold: true; reason: string };

/** Minutes the post is overdue: how long past its send time (the day it goes out on) it is now. */
export function minutesOverdue(post: Pick<GroupPost, "time">, now: { time: string }): number {
  const m = (t: string) => {
    const [h, mm] = t.split(":").map(Number);
    return (h || 0) * 60 + (mm || 0);
  };
  return Math.max(0, m(now.time) - m(post.time));
}

/** How long this post waits for an answer: its setting, but never past the end of its own day. */
export function waitMinutes(post: Pick<GroupPost, "time" | "criteria">): number {
  const [h, m] = post.time.split(":").map(Number);
  const left = Math.max(0, DAY_END_MIN - ((h || 0) * 60 + (m || 0)));
  return Math.min(left, (post.criteria?.waitHours ?? DEFAULT_WAIT_HOURS) * 60);
}

const skip = (reason: string): Verdict => ({ go: false, hold: false, reason: `Skipped: ${reason}` });
const hold = (reason: string): Verdict => ({ go: false, hold: true, reason });

/**
 * Decide a due post. Without a show-status criterion nothing changes from before: a show that is called off or didn't happen
 * gets no posts. With criteria, every one has to hold. An answer that isn't in yet (did it happen, is it repeating, is the lineup
 * confirmed) holds the post until the wait runs out, then it is skipped (a repeat question left unanswered counts as "no").
 */
export function evaluatePost(post: Pick<GroupPost, "time" | "daysBefore" | "criteria">, f: CriteriaFacts): Verdict {
  const c = post.criteria;
  const l = f.lineup;
  const off = l?.status === "cancelled" ? "cancelled" : l?.status === "canned" || l?.outcome === "canned" ? "canned" : null;
  const expired = f.overdueMin >= waitMinutes(post);

  if (!c?.show) {
    if (off === "cancelled") return skip("show was called off");
    if (off === "canned") return skip("show didn't happen");
  }

  if (c?.show) {
    const wait = (what: string, giveUp: string) => (expired ? skip(giveUp) : hold(what));
    switch (c.show) {
      case "cancelled":
        if (l?.status !== "cancelled") return skip(off === "canned" ? "show didn't happen (it wasn't called off)" : "show wasn't called off");
        break;
      case "didnt_happen":
        if (off === "cancelled") return skip("show was called off (it didn't just not happen)");
        if (!off) {
          if (l?.outcome === "happened") return skip("show happened");
          if (!l || l.status !== "confirmed") return skip("no lineup for this show");
          const v = wait(`Waiting for "did it happen"`, `no answer to "did it happen" in ${hoursText(post)}`);
          if (!v.go) return v;
        }
        break;
      case "happened":
        if (off === "cancelled") return skip("show was called off");
        if (off === "canned") return skip("show didn't happen");
        if (!l || l.status !== "confirmed") return skip("no confirmed lineup for this show");
        // Without mic checks nobody is asked, so a confirmed show counts as having happened once it is over.
        if (l.outcome !== "happened" && !(post.daysBefore < 0 && !f.micCheckOn)) {
          const v = wait(`Waiting for "did it happen"`, `no answer to "did it happen" in ${hoursText(post)}`);
          if (!v.go) return v;
        }
        break;
      case "confirmed":
        if (off === "cancelled") return skip("show was called off");
        if (off === "canned") return skip("show didn't happen");
        if (!l || l.status !== "confirmed") {
          const v = wait("Waiting for the lineup to be confirmed", `lineup wasn't confirmed in ${hoursText(post)}`);
          if (!v.go) return v;
        }
        break;
    }
  }

  const n = l?.slots.length ?? 0;
  if (c?.minComics && n < c.minComics) return skip(`only ${n} comic${n === 1 ? "" : "s"} (needs ${c.minComics})`);
  if (c?.full && !(f.slotCount > 0 && n >= f.slotCount)) return skip("lineup isn't full");

  if (c?.repeats !== undefined) {
    // Only a show that didn't happen has a question to answer; for any other show "repeats" is plainly no.
    const asked = l?.status === "canned" || l?.outcome === "canned";
    const answered = !asked || l?.repeatNext !== undefined && l?.repeatNext !== null;
    if (!answered && !expired) return hold(`Waiting for "repeating next week?"`);
    const repeats = asked && l?.repeatNext === true;
    if (c.repeats && !repeats) return skip(answered ? "lineup doesn't repeat next week" : `no answer to "repeating next week?" in ${hoursText(post)}`);
    if (!c.repeats && repeats) return skip("lineup repeats next week");
  }
  return { go: true };
}

const hoursText = (post: Pick<GroupPost, "time" | "criteria">) => {
  const h = Math.round(waitMinutes(post) / 60);
  return h >= 1 ? `${h}h` : "time";
};

// ---- Templates ----

/** The criteria a new post of this template starts with. The curator can change them. */
export const TEMPLATE_CRITERIA: Partial<Record<GroupPost["template"], PostCriteria>> = {
  groupThanks: { show: "happened" },
  groupDidntHappen: { show: "didnt_happen", repeats: false },
  groupCancelled: { show: "cancelled" },
  groupRepeat: { show: "didnt_happen", repeats: true },
  groupSignups: { show: "happened" },
  groupLatecomers: { show: "confirmed" },
};

/** One line for a "Send only if" chip or an activity row: "Waiting for…" or "Skipped: …" for the latest run. */
export interface GroupPostStatus {
  /** The show date the run was for. */
  showDate: string;
  state: "waiting" | "skipped" | "sent";
  /** "Waiting for "did it happen"" / "Skipped: show didn't happen". */
  text: string;
  at: number;
}

/** The status worth showing next to a post: the latest run's, unless a later show date has gone out since. */
export function postStatusToShow(status: GroupPostStatus | null | undefined, sentFor: string | null | undefined): GroupPostStatus | null {
  if (!status || status.state === "sent") return null;
  if (sentFor && sentFor > status.showDate) return null;
  return status;
}
