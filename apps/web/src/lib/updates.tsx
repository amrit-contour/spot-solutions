// Everything on the Requests page that is not a spot request: replies to send, new faces, mic checks and server notices.
// One provider so the nav badge and the Updates panel share the same three subscriptions.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { deleteField, orderBy, updateDoc, where, writeBatch } from "firebase/firestore";
import { toast } from "sonner";
import { localNow, type AppNotice, type ComicAction, type Lineup } from "@spot/shared";
import { useApp } from "./app";
import { useCollection, userDoc } from "./data";
import { db } from "./firebase";

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
  /** "Who are you?" drafts for people who are not in your contacts. */
  onboarding: ComicAction[];
  /** Notices from comics who introduced themselves. */
  introductions: Introduction[];
  /** Confirmed shows in the past with no answer yet. */
  micChecks: Lineup[];
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
  const today = localNow(new Date(), settings.timezone).date;

  const value = useMemo<UpdatesState>(() => {
    const replies = actions.data.filter((a) => a.kind !== "onboard");
    const onboarding = actions.data.filter((a) => a.kind === "onboard");
    const introductions: Introduction[] = [];
    const server: AppNotice[] = [];
    for (const n of [...notices.data].sort((a, b) => b.createdAt - a.createdAt)) {
      const intro = parseIntroduction(n);
      if (intro) introductions.push(intro);
      else server.push(n);
    }
    const micChecks = settings.micCheck.enabled ? confirmed.data.filter((l) => !l.outcome && l.date && l.date < today && shows.some((s) => s.id === l.showId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5) : [];
    const total = replies.length + onboarding.length + introductions.length + micChecks.length + server.length;
    const needsYou = total - server.filter((n) => n.level !== "warn").length;
    return { loading: actions.loading || notices.loading || confirmed.loading, replies, onboarding, introductions, micChecks, server, total, needsYou };
  }, [actions, notices, confirmed, settings.micCheck.enabled, today, shows]);

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
