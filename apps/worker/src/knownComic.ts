// A person messaging from an @lid must not become a second comic when the roster already has them under their phone id (or the
// other way round). Before an id is used to create anything, ask the roster who this really is.
import type { Comic } from "@spot/shared";
import { col } from "./firebase.ts";

/** The id of the comic these ids belong to, or `id` when nobody on the roster matches (a genuinely new person). */
export async function knownComicId(uid: string, who: { id: string; chatId: string; phone: string }): Promise<string> {
  try {
    if ((await col(uid, "comics").doc(who.id).get()).exists) return who.id;
    const tries: [string, FirebaseFirestore.WhereFilterOp, string][] = [
      ["chatId", "==", who.chatId],
      ["aliases", "array-contains", who.chatId],
      ...(who.id !== who.chatId ? ([["aliases", "array-contains", who.id]] as [string, FirebaseFirestore.WhereFilterOp, string][]) : []),
      ...(who.phone ? ([["phone", "==", who.phone]] as [string, FirebaseFirestore.WhereFilterOp, string][]) : []),
    ];
    for (const [field, op, value] of tries) {
      const hit = (await col(uid, "comics").where(field, op, value).limit(1).get()).docs[0];
      if (hit) return (hit.data() as Comic).id || hit.id;
    }
  } catch (e) {
    console.warn("[intake] roster lookup failed, using the id as given", (e as Error).message);
  }
  return who.id;
}
