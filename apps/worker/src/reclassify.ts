// "Re-read this week's requests": run the current prompt again over a week's open requests.
// Only the model's reading (note, tags, venue) is rewritten. Status, lane, acks, holds and messages are never touched,
// and nothing is sent. Requests the curator already placed or closed are skipped.
import type { Comic, SpotRequest } from "@spot/shared";
import { col, db } from "./firebase.ts";
import { classify } from "./gemma.ts";
import { classifyContext, countPriorRequests } from "./classifyContext.ts";
import { watchUser } from "./userData.ts";

const OPEN = ["new", "acked"];

export async function reclassifyRequests(uid: string, payload: Record<string, unknown>) {
  const week = String(payload.weekOf ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error("Missing week");
  const { settings, shows } = watchUser(uid);
  const activeShows = shows.filter((s) => s.active);
  const docs = (await col(uid, "requests").where("weekOf", "==", week).get()).docs;

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const doc of docs) {
    const r = doc.data() as SpotRequest;
    if (!OPEN.includes(r.status) || !r.messages.length) {
      skipped++;
      continue;
    }
    try {
      const known = (await col(uid, "comics").doc(r.comicId).get()).data() as Comic | undefined;
      const prior = r.priorRequests ?? (known ? await countPriorRequests(uid, r.comicId, week) : 0);
      const intent = await classify(uid, r.messages.map((m) => m.body), activeShows, settings.ai, classifyContext(uid, known, week, prior));
      // The new reading must still agree it's a spot request, or we keep what the curator already sees.
      if (!intent.isSpotRequest && r.intent.isSpotRequest) {
        skipped++;
        continue;
      }
      await db.runTransaction(async (tx) => {
        const fresh = (await tx.get(doc.ref)).data() as SpotRequest | undefined;
        if (!fresh || !OPEN.includes(fresh.status)) return; // placed or closed while we were reading
        tx.update(doc.ref, { "intent.note": intent.note ?? null, "intent.tags": intent.tags ?? [], "intent.venueId": intent.venueId ?? null });
      });
      updated++;
    } catch (e) {
      failed++;
      console.error(`[reclassify] ${uid} ${r.id} failed`, e);
    }
  }
  return { checked: docs.length, updated, skipped, failed };
}
