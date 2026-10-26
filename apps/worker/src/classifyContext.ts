// What the model is told besides the messages: the curator's venues and facts about the sender.
import { localNow, senderFacts, type Comic, type SpotRequest } from "@spot/shared";
import { col } from "./firebase.ts";
import { watchUser } from "./userData.ts";
import type { ClassifyContext } from "./gemma.ts";

/** Requests this comic made in weeks other than `week`. */
export async function countPriorRequests(uid: string, comicId: string, week: string) {
  const snap = await col(uid, "requests").where("comicId", "==", comicId).get();
  return snap.docs.filter((d) => (d.data() as SpotRequest).weekOf !== week).length;
}

export function classifyContext(uid: string, comic: Comic | undefined, week: string, priorRequests: number): ClassifyContext {
  const { settings, venues } = watchUser(uid);
  const today = localNow(new Date(), settings.timezone).date;
  return { venues, sender: senderFacts({ comic, week, today, priorRequests }) };
}
