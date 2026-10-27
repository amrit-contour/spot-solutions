// Everything on the Requests page that is not a spot request: replies to send, new faces, mic checks and server notices.
// One provider so the nav badge and the Updates panel share the same three subscriptions.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { deleteField, orderBy, updateDoc, where, writeBatch } from "firebase/firestore";
import { toast } from "sonner";
import { localNow, type AppNotice, type ComicAction, type Lineup, type SpotOffer } from "@spot/shared";
import { useApp } from "./app";
import { useCollection, userDoc } from "./data";
import { db } from "@spot/ui/firebase";

export interface Introduction {
  notice: AppNotice;
  name: string;
  /** "from Pune", "2 yrs in comedy", "travelling" */
  bits: string[];
}

export interface UpdatesState {
  loading: boolean;
  /** Cancellations and questions with a drafted reply. */
  replies: ComicAction[];
  /** You already answered them in WhatsApp: apply it. */
  followUps: ComicAction[];
  /** "Who are you?" drafts for people who are not in your contacts. */
  onboarding: ComicAction[];
  /** Notices from comics who introduced themselves. */
  introductions: Introduction[];
  /** Confirmed shows in the past with no answer yet. */
  micChecks: Lineup[];
  /** "Clear the group?" questions from the day-after cleanup. */
  cleanups: Lineup[];
  /** Ad hoc rounds where you pick: everyone who said yes, by round. */
  adhoc: SpotOffer[][];
  /** System notices. */
  server: AppNotice[];
  /** Everything open. */
  total: number;
  /** What needs the curator: all of it except plain "info" server notices. */
  needsYou: number;
}

const INTRO = /^(.+?) introduced themselves(?:: (.+?))?\.(?:\s|$)/;

/** Intro notices carry no kind field, so they are told apart by their text (written in apps/worker/src/replies.ts). */
export function parseIntroduction(n: AppNotice): Introduction | null {
  const m = INTRO.exec(n.text);
  if (!m) return null;
  return { notice: n, name: m[1], bits: m[2] ? m[2].split(", ") : [] };
}

const Ctx = createContext<UpdatesState | null>(null);

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const { uid, week, shows, settings } = useApp();
  const actions = useCollection<ComicAction>(uid, "actions", [where("weekOf", "==", week), where("status", "==", "pending"), orderBy("createdAt", "desc")], week);
  const notices = useCollection<AppNotice>(uid, "notices", [where("read", "==", false)]);
  const confirmed = useCollection<Lineup>(uid, "lineups", [where("status", "==", "confirmed")]);
  const asked = useCollection<Lineup>(uid, "lineups", [where("cleanup.status", "in", ["asked", "partial"])]);
  const interested = useCollection<SpotOffer>(uid, "offers", [where("status", "==", "interested")]);
  const today = localNow(new Date(), settings.timezone).date;

  const value = useMemo<UpdatesState>(() => {
    const replies = actions.data.filter((a) => a.kind !== "onboard" && a.kind !== "follow_up");
    const followUps = actions.data.filter((a) => a.kind === "follow_up" && a.followUp);
    const onboarding = actions.data.filter((a) => a.kind === "onboard");
    const introductions: Introduction[] = [];
    const server: AppNotice[] = [];
    for (const n of [...notices.data].sort((a, b) => b.createdAt - a.createdAt)) {
      const intro = parseIntroduction(n);
      if (intro) introductions.push(intro);
      else server.push(n);
    }
    const micChecks = settings.micCheck.enabled ? confirmed.data.filter((l) => !l.outcome && !l.backfilled && l.date && l.date < today && shows.some((s) => s.id === l.showId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5) : [];
    // "asked": waiting for an answer. "partial": a pass left people in the group (shown with who and why); one that is still running has nobody pending yet.
    const cleanups = asked.data.filter((l) => shows.some((s) => s.id === l.showId) && (l.cleanup?.status === "asked" || Boolean(l.cleanup?.pending?.length))).sort((a, b) => b.date.localeCompare(a.date));
    const rounds = new Map<string, SpotOffer[]>();
    for (const o of interested.data) if (o.round) rounds.set(o.round.id, [...(rounds.get(o.round.id) ?? []), o]);
    const adhoc = [...rounds.values()].sort((a, b) => b[0].sentAt - a[0].sentAt);
    const total = replies.length + followUps.length + onboarding.length + introductions.length + micChecks.length + cleanups.length + adhoc.length + server.length;
    const needsYou = total - server.filter((n) => n.level !== "warn").length;
    return { loading: actions.loading || notices.loading || confirmed.loading, replies, followUps, onboarding, introductions, micChecks, cleanups, adhoc, server, total, needsYou };
  }, [actions, notices, confirmed, asked, interested, settings.micCheck.enabled, today, shows]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUpdates() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUpdates outside provider");
  return v;
}

/* ---------- Writes (same documents and fields as before, plus dismissedAt) ---------- */

export function dismissAction(uid: string, a: ComicAction) {
  void updateDoc(userDoc(uid, "actions", a.id), { status: "dismissed", dismissedAt: Date.now() });
  toast("Dismissed", { description: a.comicName, action: { label: "Undo", onClick: () => void updateDoc(userDoc(uid, "actions", a.id), { status: "pending", dismissedAt: deleteField() }) } });
}

export function dismissNotice(uid: string, n: AppNotice, quiet = false) {
  void updateDoc(userDoc(uid, "notices", n.id), { read: true, dismissedAt: Date.now() });
  if (quiet) return;
  toast("Dismissed", { action: { label: "Undo", onClick: () => void updateDoc(userDoc(uid, "notices", n.id), { read: false, dismissedAt: deleteField() }) } });
}

export function dismissNotices(uid: string, list: AppNotice[]) {
  const batch = writeBatch(db);
  const at = Date.now();
  for (const n of list) batch.update(userDoc(uid, "notices", n.id), { read: true, dismissedAt: at });
  void batch.commit();
  toast(`Dismissed ${list.length}`, {
    action: {
      label: "Undo",
      onClick: () => {
        const undo = writeBatch(db);
        for (const n of list) undo.update(userDoc(uid, "notices", n.id), { read: false, dismissedAt: deleteField() });
        void undo.commit();
      },
    },
  });
}

export function answerMicCheck(uid: string, l: Lineup, outcome: "happened") {
  void updateDoc(userDoc(uid, "lineups", l.id), { outcome });
  toast("Saved", { description: "Marked as happened", action: { label: "Undo", onClick: () => void updateDoc(userDoc(uid, "lineups", l.id), { outcome: deleteField() }) } });
}

/** Updates → Clear all: dismiss every reply, new-face, follow-up and server card at once (mic checks need an answer). */
export function clearAll(uid: string, actions: ComicAction[], notices: AppNotice[]) {
  if (!actions.length && !notices.length) return;
  const at = Date.now();
  const batch = writeBatch(db);
  for (const a of actions) batch.update(userDoc(uid, "actions", a.id), { status: "dismissed", dismissedAt: at });
  for (const n of notices) batch.update(userDoc(uid, "notices", n.id), { read: true, dismissedAt: at });
  void batch.commit();
  toast(`Cleared ${actions.length + notices.length}`, {
    action: {
      label: "Undo",
      onClick: () => {
        const undo = writeBatch(db);
        for (const a of actions) undo.update(userDoc(uid, "actions", a.id), { status: "pending", dismissedAt: deleteField() });
        for (const n of notices) undo.update(userDoc(uid, "notices", n.id), { read: false, dismissedAt: deleteField() });
        void undo.commit();
      },
    },
  });
}
