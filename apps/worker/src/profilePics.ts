// profile_pics: the app says which comics it is showing (or that one saved URL stopped loading); a background queue asks WhatsApp
// for their pictures, one every couple of seconds, and keeps the answer on the comic.
import { PHOTO_BATCH_MAX, PHOTO_INTERVAL_MS, type Comic } from "@spot/shared";
import { col } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { isNeverRead } from "./neverRead.ts";
import { PicQueue } from "./profilePicsQueue.ts";

const queues = new Map<string, { q: PicQueue; timer: NodeJS.Timeout }>();

function queueFor(uid: string) {
  let e = queues.get(uid);
  if (e) return e.q;
  const q = new PicQueue({
    now: () => Date.now(),
    ready: () => Boolean(sessions.get(uid)),
    load: async (id) => {
      const s = await col(uid, "comics").doc(id).get();
      return s.exists ? ({ ...(s.data() as Comic), id: s.id }) : undefined;
    },
    blocked: (c) => isNeverRead(uid, sessions.get(uid), c.id, c.chatId, c.phone ? `${c.phone}@c.us` : null),
    fetchUrl: async (c) => {
      const client = sessions.require(uid);
      return (await client.getProfilePicUrl(c.chatId ?? c.id)) || null;
    },
    save: async (id, patch) => {
      await col(uid, "comics").doc(id).set(patch, { merge: true });
    },
  });
  const timer = setInterval(() => void q.step().catch((e) => console.error("[pics]", e.message)), PHOTO_INTERVAL_MS / 2);
  timer.unref();
  e = { q, timer };
  queues.set(uid, e);
  return q;
}

/** profile_pics: { comicIds: string[], force?: boolean }. Only queues; the pictures arrive on the comics a little later. */
export async function profilePics(uid: string, payload: Record<string, unknown>) {
  const ids = Array.isArray(payload.comicIds) ? payload.comicIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 200).slice(0, PHOTO_BATCH_MAX) : [];
  return { queued: queueFor(uid).enqueue(ids, payload.force === true) };
}
