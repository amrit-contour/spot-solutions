// profile_pics: the app says which comics, groups or curators it is showing (or that one saved URL stopped loading); a background
// queue asks WhatsApp for their pictures, one every couple of seconds (a little randomly), and keeps the answer:
// on the comic doc for comics, in users/{uid}/waPhotos/{jid} for groups and Comedy's curators. The scheduler also puts the stale
// ones back in the queue now and then (maybePhotoSweep), so photos stay current without anyone asking.
import { PHOTO_BATCH_MAX, PHOTO_INTERVAL_MS, PHOTO_REFRESH_MS, PHOTO_SWEEP_EVERY_MS, PHOTO_SWEEP_MAX, WA_PHOTOS, isWaJid, type Comic } from "@spot/shared";
import { col } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { isNeverRead } from "./neverRead.ts";
import { PicQueue, type PicKind } from "./profilePicsQueue.ts";

const queues = new Map<string, { q: PicQueue; timer: NodeJS.Timeout }>();

const collOf = (kind: PicKind) => (kind === "wa" ? WA_PHOTOS : "comics");

function queueFor(uid: string) {
  let e = queues.get(uid);
  if (e) return e.q;
  const q = new PicQueue(
    {
      now: () => Date.now(),
      ready: () => Boolean(sessions.get(uid)),
      load: async (id, kind) => {
        const s = await col(uid, collOf(kind)).doc(id).get();
        if (kind === "wa") return { id, chatId: id, ...(s.exists ? (s.data() as object) : {}) }; // never asked yet: no doc, still worth a look
        return s.exists ? ({ ...(s.data() as Comic), id: s.id }) : undefined;
      },
      blocked: (c, kind) => isNeverRead(uid, sessions.get(uid), c.id, c.chatId, kind === "comic" && c.phone ? `${c.phone}@c.us` : null),
      fetchUrl: async (c) => {
        const client = sessions.require(uid);
        return (await client.getProfilePicUrl(c.chatId ?? c.id)) || null;
      },
      save: async (id, patch, kind) => {
        await col(uid, collOf(kind)).doc(id).set(patch, { merge: true });
      },
    },
    PHOTO_INTERVAL_MS,
    Math.random,
  );
  const timer = setInterval(() => void q.step().catch((e) => console.error("[pics]", e.message)), PHOTO_INTERVAL_MS / 2);
  timer.unref();
  e = { q, timer };
  queues.set(uid, e);
  return q;
}

const cleanIds = (v: unknown, ok: (x: unknown) => x is string) => (Array.isArray(v) ? v.filter(ok).slice(0, PHOTO_BATCH_MAX) : []);
const isComicId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length < 200;

/** profile_pics: { comicIds?: string[], chatIds?: string[] (groups, curators: WhatsApp ids), force?: boolean }. Only queues; the pictures arrive a little later. */
export async function profilePics(uid: string, payload: Record<string, unknown>) {
  const q = queueFor(uid);
  const force = payload.force === true;
  q.enqueue(cleanIds(payload.comicIds, isComicId), force, "comic");
  return { queued: q.enqueue(cleanIds(payload.chatIds, isWaJid), force, "wa") };
}

// ---- Keeping photos current -------------------------------------------------------------------------------------------------
// Only pictures that were asked for before come back (photoAt set): nobody is looked up just because they exist. The oldest go first,
// a few at a time, through the same one-at-a-time queue.
const nextSweep = new Map<string, number>();

async function sweep(uid: string) {
  const q = queueFor(uid);
  const before = Date.now() - PHOTO_REFRESH_MS;
  for (const kind of ["comic", "wa"] as const) {
    const snap = await col(uid, collOf(kind)).where("photoAt", "<", before).orderBy("photoAt").limit(PHOTO_SWEEP_MAX).get();
    q.enqueue(snap.docs.map((d) => d.id), false, kind);
  }
}

/** Called from the scheduler for each connected account. Runs a sweep about every six hours, at a different moment for each account. */
export async function maybePhotoSweep(uid: string) {
  const now = Date.now();
  const at = nextSweep.get(uid);
  if (at === undefined) {
    nextSweep.set(uid, now + Math.round(Math.random() * 30 * 60_000)); // first one soon after start, spread out
    return;
  }
  if (now < at) return;
  nextSweep.set(uid, now + PHOTO_SWEEP_EVERY_MS * (0.75 + Math.random() * 0.5));
  await sweep(uid);
}
