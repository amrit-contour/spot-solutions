// Nothing BOT Comedy on the agent number, the real wiring: the comic's own documents in Firestore, their AI routes and the same
// send_ask / Ask for it code the app uses. The conversation itself is comicAgentCore.ts. Only for accounts that use the Comedy
// app (they have rooms, or comicSettings). It reads only what the comic says to the agent: never their chats.
import {
  TTL_DAYS,
  agentScope,
  isoAddDays,
  localDate,
  mergeRegulars,
  regularWindow,
  tagText,
  type AgentScope,
  type Ask,
  type ComicPending,
  comicAskText,
  pollForPending,
  type Curator,
  type MySpot,
  type RegularSpot,
  type Room,
  type SpotAlert,
} from "@spot/shared";
import { col, expireAt, userRef } from "./firebase.ts";
import { readMemory, readSettings, sendQuestion, sendToCurator, writeMemory } from "./agentOutbox.ts";
import { generateJson } from "./llm.ts";
import { sendAsk } from "./asks.ts";
import { askForSpot } from "./groupWatch.ts";
import { comicAgent, type ComicDeps } from "./comicAgentCore.ts";

const withId = <T,>(d: FirebaseFirestore.QueryDocumentSnapshot) => ({ ...(d.data() as T), id: d.id }) as T & { id: string };
/** Firestore refuses undefined; drop it (and keep the rest as it is). */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const scopes = new Map<string, { at: number; scope: AgentScope }>();
const SCOPE_MS = 60_000;

/** Which apps this account uses (agentScope, shared): decides what the agent number does for it. Re-read every minute. */
export async function scopeFor(uid: string): Promise<AgentScope> {
  const hit = scopes.get(uid);
  if (hit && Date.now() - hit.at < SCOPE_MS) return hit.scope;
  const has = async (c: string) => !(await col(uid, c).limit(1).get()).empty;
  const [shows, venues, lineups, rooms, devices, user] = await Promise.all([has("shows"), has("venues"), has("lineups"), has("rooms"), col(uid, "devices").get(), userRef(uid).get()]);
  const apps = devices.docs.map((d) => d.data().app as string | undefined);
  const scope = agentScope({
    shows,
    venues,
    lineups,
    rooms,
    comicSettings: user.data()?.comicSettings != null,
    curateDevice: apps.some((a) => a !== "comic"),
    comicDevice: apps.some((a) => a === "comic"),
  });
  scopes.set(uid, { at: Date.now(), scope });
  return scope;
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
    writePending: async (p) => void (await writeMemory(uid, { comicPending: p, ...(p ? { pending: null, sideAsk: null } : {}) })),
    async askPending(p) {
      const id = await sendQuestion(uid, comicAskText(p), { poll: pollForPending(p), kind: "comic" });
      if (id) await writeMemory(uid, { comicPending: { ...p, pollId: id } });
    },
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
    // Curators the reply names are mentioned (WhatsApp tags) when they have a number, else first names (shared tagText).
    say: async (text) => {
      const curators = (await col(uid, "curators").get()).docs.map((x) => x.data() as Curator);
      const people = curators.map((c) => ({ name: c.name, id: c.phone && c.phone.replace(/\D/g, "").length >= 8 ? `${c.phone.replace(/\D/g, "")}@c.us` : null }));
      const r = tagText(text, people);
      return sendToCurator(uid, r.text, { mentions: { ids: r.mentions, plain: r.plain } });
    },
    now: () => Date.now(),
  };
}

/** The comic's conversation (the caller has checked the account uses Comedy). */
export const comicFor = (uid: string) => comicAgent(depsFor(uid));
