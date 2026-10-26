// One-time: stamp `expireAt` (a Timestamp) on documents written before the TTL policies existed, so Firestore's
// TTL can delete them. Run deploy/setup-cost-controls.sh first (the policies), then this.
//   pnpm --filter @spot/worker exec tsx --env-file=.env scripts/backfill-expire-at.ts            (dry run: counts only)
//   pnpm --filter @spot/worker exec tsx --env-file=.env scripts/backfill-expire-at.ts --apply    (writes)
// Documents that already have expireAt are skipped. Old ones get an expireAt in the past (createdAt + their TTL),
// so TTL removes them within about a day. The demo template (users/demo-curator) is never touched.
import { Timestamp } from "firebase-admin/firestore";
import { DEMO_SOURCE_UID, DAY_MS, TTL_DAYS } from "@spot/shared";
import { db } from "../src/firebase.ts";

const apply = process.argv.includes("--apply");
const BATCH = 400;

/** collection group -> days after createdAt (null: no createdAt on these docs, so a fresh window from now). */
const GROUPS: { name: string; days: number; fromCreated: boolean }[] = [
  { name: "commands", days: TTL_DAYS.commands, fromCreated: true }, // users/{uid}/commands and servers/{id}/commands
  { name: "notices", days: TTL_DAYS.notices, fromCreated: true },
  { name: "contactsImport", days: TTL_DAYS.contactsImport, fromCreated: false },
];

async function main() {
  console.log(apply ? "APPLY: writing expireAt" : "DRY RUN: nothing is written (add --apply)");
  const now = Date.now();
  for (const g of GROUPS) {
    let seen = 0;
    let missing = 0;
    let past = 0;
    let batch = db.batch();
    let queued = 0;
    const flush = async () => {
      if (queued && apply) await batch.commit();
      batch = db.batch();
      queued = 0;
    };
    // select(): never download payloads, they can hold messages and contacts.
    for await (const snap of db.collectionGroup(g.name).select("createdAt", "expireAt").stream() as AsyncIterable<FirebaseFirestore.QueryDocumentSnapshot>) {
      seen++;
      if (snap.get("expireAt") != null) continue;
      if (snap.ref.path.startsWith(`users/${DEMO_SOURCE_UID}/`)) continue; // the template keeps its notices
      const created = g.fromCreated && typeof snap.get("createdAt") === "number" ? (snap.get("createdAt") as number) : now;
      const at = created + g.days * DAY_MS;
      missing++;
      if (at < now) past++;
      batch.update(snap.ref, { expireAt: Timestamp.fromMillis(at) });
      if (++queued >= BATCH) await flush();
    }
    await flush();
    console.log(`${g.name}: ${seen} docs, ${missing} without expireAt${apply ? " (stamped)" : ""}, ${past} already past their expiry (TTL deletes them soon)`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
