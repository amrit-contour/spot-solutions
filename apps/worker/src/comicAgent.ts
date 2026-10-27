// Nothing BOT Comedy on the agent number, the real wiring: the comic's own documents in Firestore, their AI routes and the same
// send_ask / Ask for it code the app uses. The conversation itself is comicAgentCore.ts. Only for accounts that use the Comedy
// app (they have rooms, or comicSettings). It reads only what the comic says to the agent: never their chats.
import {
  TTL_DAYS,
  isoAddDays,
  localDate,
  mergeRegulars,
  regularWindow,
  type Ask,
  type ComicPending,
  type Curator,
  type MySpot,
  type RegularSpot,
  type Room,
  type SpotAlert,
} from "@spot/shared";
import { col, expireAt, userRef } from "./firebase.ts";
import { agentOn, readMemory, readSettings, sendToCurator, writeMemory } from "./agentOutbox.ts";
import { generateJson } from "./llm.ts";
import { sendAsk } from "./asks.ts";
import { askForSpot } from "./groupWatch.ts";
import { comicAgent, type ComicDeps } from "./comicAgentCore.ts";

const withId = <T,>(d: FirebaseFirestore.QueryDocumentSnapshot) => ({ ...(d.data() as T), id: d.id }) as T & { id: string };
/** Firestore refuses undefined; drop it (and keep the rest as it is). */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const known = new Map<string, number>();
const KNOWN_MS = 10 * 60_000;
const notComic = new Map<string, number>();

/** Does this account use the Comedy app? (rooms, or comic settings). Re-checked every ten minutes. */
export async function isComicAccount(uid: string): Promise<boolean> {
  const now = Date.now();
  if ((known.get(uid) ?? 0) > now) return true;
  if ((notComic.get(uid) ?? 0) > now) return false;
  const user = (await userRef(uid).get()).data();
  const yes = Boolean(user?.comicSettings) || !(await col(uid, "rooms").limit(1).get()).empty;
  (yes ? known : notComic).set(uid, now + (yes ? KNOWN_MS : 60_000));
  return yes;
}

export async function hasShows(uid: string): Promise<boolean> {
  return !(await col(uid, "shows").where("active", "==", true).limit(1).get()).empty;
}

function depsFor(uid: string): ComicDeps {
  return {
    async settings() {
      const s = await readSettings(uid);
      const comic = (await userRef(uid).get()).data()?.comicSettings as { agentAuto?: boolean } | undefined;
      return { answer: Boolean(s.agent?.answer), actions: Boolean(s.agent?.actions), auto: Boolean(comic?.agentAuto), tz: s.timezone };
    },
    async load() {
      const s = await readSettings(uid);
      const today = localDate(new Date(), s.timezone);
      const win = regularWindow(today);
      const [rooms, curators, asks, spots, regulars, alerts, user] = await Promise.all([
        col(uid, "rooms").get(),
        col(uid, "curators").get(),
        col(uid, "asks").where("showDate", ">=", isoAddDays(today, -30)).get(),
        col(uid, "mySpots").where("date", ">=", isoAddDays(today, -60)).get(),
        col(uid, "regularSpots").get(),
        col(uid, "spotAlerts").where("expiresAt", ">", Date.now() - 6 * 3_600_000).get(),
        userRef(uid).get(),
      ]);
      const reg = regulars.docs.map((x) => withId<RegularSpot>(x));
      return {
        rooms: rooms.docs.map((x) => withId<Room>(x)),
        curators: curators.docs.map((x) => withId<Curator>(x)),
        asks: asks.docs.map((x) => withId<Ask>(x)),
        spots: mergeRegulars(spots.docs.map((x) => withId<MySpot>(x)), reg, win.from, win.to),
        regulars: reg,
        alerts: alerts.docs.map((x) => withId<SpotAlert>(x)),
        template: (user.data()?.comic?.askTemplate as string | undefined) ?? undefined,
      };
    },
    async readPending() {
      const p = (await readMemory(uid)) as { comicPending?: ComicPending | null };
      return p.comicPending ?? null;
    },
    // One question at a time: a new comic question replaces any curator one that was waiting.
    writePending: async (p) => void (await writeMemory(uid, { comicPending: p, ...(p ? { pending: null } : {}) })),
    async apply(w) {
      const batch = col(uid, "rooms").firestore.batch();
      for (const r of w.rooms) batch.set(col(uid, "rooms").doc(r.id), plain(r));
      for (const c of w.curators) batch.set(col(uid, "curators").doc(c.id), plain(c));
      for (const x of w.spots) batch.set(col(uid, "mySpots").doc(x.id), plain(x), { merge: true });
      for (const x of w.regulars) batch.set(col(uid, "regularSpots").doc(x.id), plain(x));
      // merge: a draft keeps its reminder stamps and anything the comic edited.
      for (const a of w.asks) batch.set(col(uid, "asks").doc(a.id), plain(a), { merge: true });
      await batch.commit();
    },
    async sendAsk(askId) {
      const r = (await sendAsk(uid, askId)) as { body?: string };
      return { body: r.body };
    },
    async askForSpot(alertId, body) {
      const r = (await askForSpot(uid, { alertId, body })) as { sentTo?: string };
      return { sentTo: r.sentTo };
    },
    async model(prompt, schema) {
      const s = await readSettings(uid);
      return (await generateJson(uid, s.ai, prompt, schema)).text;
    },
    // users/{uid}/agentLog: what the agent did, one line each (the app's Settings shows it). Only the outcome, never the message.
    async log(e) {
      await col(uid, "agentLog").add({ ...e, expireAt: expireAt(TTL_DAYS.notices) }).catch(() => undefined);
    },
    say: (text) => sendToCurator(uid, text),
    now: () => Date.now(),
  };
}

/** The comic's conversation, or null when this account doesn't use the Comedy app or the agent is off. */
export async function comicFor(uid: string) {
  if (!(await agentOn(uid))) return null;
  if (!(await isComicAccount(uid))) return null;
  return comicAgent(depsFor(uid));
}
