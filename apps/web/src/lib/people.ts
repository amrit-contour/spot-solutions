import { writeBatch } from "firebase/firestore";
import { comicIdsOf, numbersOf, shouldUpdateName, type Comic, type ImportPerson } from "@spot/shared";
import { userDoc } from "./data";
import { db } from "@spot/ui/firebase";

export interface PersonToImport extends ImportPerson {
  id: string;
  nameSource: NonNullable<Comic["nameSource"]>;
}

/** Find a roster entry by comic id or phone (a comic known only by @lid has no phone-based id). */
export function rosterLookup(comics: Comic[]) {
  const byId = new Map(comics.flatMap((c) => comicIdsOf(c).map((id) => [id, c] as const)));
  for (const c of comics) byId.set(c.id, c);
  const byPhone = new Map(comics.flatMap((c) => numbersOf(c).map((n) => [n.phone, c] as const)));
  return (p: { id: string; phone: string }) => byId.get(p.id) ?? byPhone.get(p.phone);
}

/** Add new people and refresh names the precedence rules allow. Firestore batches cap at 500 writes. */
export async function importPeople(uid: string, people: PersonToImport[], find: ReturnType<typeof rosterLookup>) {
  let added = 0;
  let updated = 0;
  /** Everyone whose roster name was just written, with the name now on the roster. */
  const changed: { id: string; name: string; phone: string }[] = [];
  for (let i = 0; i < people.length; i += 450) {
    const batch = writeBatch(db);
    for (const p of people.slice(i, i + 450)) {
      const cur = find(p);
      if (!cur) {
        const c: Comic = { id: p.id, name: p.name, nameSource: p.nameSource, phone: p.phone, lastPerformedWeek: null, regularOf: [] };
        // Merge: if the roster was stale and this comic exists after all, its other fields (history, notes, list) survive.
        batch.set(userDoc(uid, "comics", p.id), c, { merge: true });
        added++;
        changed.push({ id: p.id, name: p.name, phone: p.phone });
      } else if (shouldUpdateName(cur, p)) {
        batch.update(userDoc(uid, "comics", cur.id), { name: p.name, nameSource: p.nameSource });
        updated++;
        changed.push({ id: cur.id, name: p.name, phone: cur.phone || p.phone });
      }
    }
    await batch.commit();
  }
  return { added, updated, changed };
}
