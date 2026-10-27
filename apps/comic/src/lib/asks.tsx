// The comic's asks, spots and ask message, behind one small interface so the pages don't care where they live:
// Firestore (users/{uid}/asks, /mySpots and the user doc's `comic`) in the app, or memory for the dev-only demo routes.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { deleteDoc, deleteField, doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { db } from "@spot/ui/firebase";
import { DEFAULT_ASK_TEMPLATE, DEFAULT_SETTINGS, cleanNotes, isoAddDays, localDate, planAsks, spotFromAsk, type Ask, type MySpot, type PlannedAsk, type Room } from "@spot/shared";
import { useCollection, userDoc } from "./data";
import { plain, useRoster } from "./roster";
import { runCommand } from "./commands";

export const TZ = DEFAULT_SETTINGS.timezone;

export interface AsksStore {
  asks: Ask[];
  spots: MySpot[];
  /** The comic's own ask message, or the default. */
  template: string;
  loading: boolean;
  /** Save a draft (the message, the voice choice) without sending. */
  saveAsk(ask: Ask): Promise<void>;
  /** Save the draft, then have the worker send it from the comic's WhatsApp. Resolves once it has gone. */
  sendAsk(ask: Ask): Promise<void>;
  /** "Not this one": it is not offered again. */
  skipAsk(a: PlannedAsk, draft: Ask): Promise<void>;
  /** The comic's own call on a sent ask. "waiting" puts a wrongly read reply back to waiting. */
  answerAsk(ask: Ask, decision: "got_it" | "declined" | "waiting", room?: Pick<Room, "name">): Promise<void>;
  saveSpot(spot: MySpot): Promise<void>;
  deleteSpot(id: string): Promise<void>;
  saveTemplate(template: string): Promise<void>;
}

const Ctx = createContext<AsksStore | null>(null);
export const useAsks = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useAsks needs an AsksProvider");
  return s;
};
export function AsksProvider({ store, children }: { store: AsksStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T) => plain(rest);
const skippedDoc = (a: PlannedAsk, draft: Ask): Ask => ({ ...draft, id: a.id, status: "expired", skipped: true });

/** Fields a decision clears or sets, shared by both stores. */
function decide(ask: Ask, decision: "got_it" | "declined" | "waiting", now: number): Partial<Ask> | "reset" {
  if (decision === "waiting") return "reset";
  return { status: decision, evidence: { text: "You marked it yourself", at: now }, ...(ask.lastReply ? { lastReply: { ...ask.lastReply, unsure: false } } : {}) };
}

/** The signed-in comic's asks and spots, live from Firestore. */
export function useFirestoreAsks(uid: string): AsksStore {
  const asks = useCollection<Ask>(uid, "asks");
  const spots = useCollection<MySpot>(uid, "mySpots");
  const [template, setTemplate] = useState<string>(DEFAULT_ASK_TEMPLATE);
  const [userLoaded, setUserLoaded] = useState(false);
  useEffect(
    () =>
      onSnapshot(
        doc(db, "users", uid),
        (s) => {
          const t = (s.data()?.comic as { askTemplate?: string } | undefined)?.askTemplate;
          setTemplate(t?.trim() ? t : DEFAULT_ASK_TEMPLATE);
          setUserLoaded(true);
        },
        () => setUserLoaded(true),
      ),
    [uid],
  );
  return useMemo<AsksStore>(
    () => ({
      asks: asks.data,
      spots: spots.data,
      template,
      loading: asks.loading || spots.loading || !userLoaded,
      saveAsk: (ask) => setDoc(userDoc(uid, "asks", ask.id), withoutId(ask), { merge: true }),
      async sendAsk(ask) {
        await setDoc(userDoc(uid, "asks", ask.id), withoutId(ask), { merge: true });
        await runCommand(uid, "send_ask", { askId: ask.id });
      },
      skipAsk: (a, draft) => setDoc(userDoc(uid, "asks", a.id), withoutId(skippedDoc(a, draft)), { merge: true }),
      async answerAsk(ask, decision, room) {
        const patch = decide(ask, decision, Date.now());
        const ref = userDoc(uid, "asks", ask.id);
        if (patch === "reset") {
          await updateDoc(ref, { status: "sent", evidence: deleteField(), lastReply: deleteField() });
          await deleteDoc(userDoc(uid, "mySpots", `ask_${ask.id}`)).catch(() => undefined);
          return;
        }
        if (decision === "got_it") await setDoc(userDoc(uid, "mySpots", `ask_${ask.id}`), withoutId(spotFromAsk(ask, room, ask.lastReply?.time, Date.now())), { merge: true });
        await updateDoc(ref, plain(patch));
      },
      saveSpot: (spot) => setDoc(userDoc(uid, "mySpots", spot.id), withoutId({ ...spot, notes: cleanNotes(spot.notes) }), { merge: false }),
      deleteSpot: (id) => deleteDoc(userDoc(uid, "mySpots", id)),
      saveTemplate: (t) => setDoc(doc(db, "users", uid), { comic: { askTemplate: t.trim() === DEFAULT_ASK_TEMPLATE ? deleteField() : t.trim() } }, { merge: true }),
    }),
    [uid, asks.data, asks.loading, spots.data, spots.loading, template, userLoaded],
  );
}

/** Asks and spots held in memory (the dev-only demo routes). Nothing is saved anywhere; "send" just marks the ask sent. */
export function useMemoryAsks(initial: { asks: Ask[]; spots: MySpot[] }): AsksStore {
  const [asks, setAsks] = useState(initial.asks);
  const [spots, setSpots] = useState(initial.spots);
  const [template, setTemplate] = useState(DEFAULT_ASK_TEMPLATE);
  const upsert = <T extends { id: string }>(list: T[], x: T) => (list.some((y) => y.id === x.id) ? list.map((y) => (y.id === x.id ? x : y)) : [...list, x]);
  const patch = useCallback((id: string, p: Partial<Ask>) => setAsks((l) => l.map((a) => (a.id === id ? { ...a, ...p } : a))), []);
  return useMemo<AsksStore>(
    () => ({
      asks,
      spots,
      template,
      loading: false,
      saveAsk: async (ask) => setAsks((l) => upsert(l, plain(ask))),
      async sendAsk(ask) {
        setAsks((l) => upsert(l, plain(ask)));
        await new Promise((r) => setTimeout(r, 500));
        patch(ask.id, { status: "sent", sentAt: Date.now() });
      },
      skipAsk: async (a, draft) => setAsks((l) => upsert(l, plain(skippedDoc(a, draft)))),
      async answerAsk(ask, decision, room) {
        const p = decide(ask, decision, Date.now());
        if (p === "reset") {
          setAsks((l) => l.map((a) => (a.id === ask.id ? { ...a, status: "sent", evidence: undefined, lastReply: undefined } : a)));
          setSpots((l) => l.filter((s) => s.id !== `ask_${ask.id}`));
          return;
        }
        if (decision === "got_it") setSpots((l) => upsert(l, spotFromAsk(ask, room, ask.lastReply?.time, Date.now())));
        patch(ask.id, p);
      },
      saveSpot: async (spot) => setSpots((l) => upsert(l, plain({ ...spot, notes: cleanNotes(spot.notes) }))),
      deleteSpot: async (id) => setSpots((l) => l.filter((s) => s.id !== id)),
      saveTemplate: async (t) => setTemplate(t.trim() || DEFAULT_ASK_TEMPLATE),
    }),
    [asks, spots, template, patch],
  );
}

// ---------------------------------------------------------------------------------------------------------------------------

/** A clock that ticks, so "closes in 6 h" stays right while the page is open. */
export function useNowMs(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** The asks to make over the next two weeks, from the comic's rooms, asks and spots. */
export function useAskPlan(now: number) {
  const roster = useRoster();
  const { asks, spots } = useAsks();
  const today = localDate(new Date(now), TZ);
  // `now` moves every 30 s; the plan only changes on the minute, which is plenty.
  const minute = Math.floor(now / 60_000);
  const plan = useMemo(
    () => planAsks(roster.rooms, roster.curators, { from: today, to: isoAddDays(today, 7) }, new Date(minute * 60_000), TZ, { asks, mySpots: spots }),
    [roster.rooms, roster.curators, asks, spots, today, minute],
  );
  return { plan, today };
}

/** A draft ask document for a planned one: what is saved (and sent). */
export function draftFor(a: PlannedAsk, message: string): Ask {
  return {
    ...(a.doc ?? {}),
    id: a.id,
    roomId: a.roomId,
    showId: a.showId,
    showDate: a.showDate,
    ...(a.time ? { time: a.time } : {}),
    ...(a.curatorId ? { curatorId: a.curatorId } : {}),
    askOn: a.askOn,
    status: "planned",
    message,
    createdAt: a.doc?.createdAt ?? Date.now(),
    roomName: a.roomName,
    showName: a.showName,
    ...(a.curatorName ? { curatorName: a.curatorName } : {}),
    mode: a.mode,
    voice: a.doc?.voice ?? true,
    closesAt: a.closesAt,
  };
}
