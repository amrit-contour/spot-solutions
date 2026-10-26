// {{name}} in every message: the first name you saved them under in your phone, else their
// WhatsApp profile name, else "there". A name you typed in the app always wins.
import type WAWebJS from "whatsapp-web.js";
import { firstName, type Comic } from "@spot/shared";

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { name: string; at: number }>();

type Who = Pick<Comic, "id" | "name"> & Partial<Pick<Comic, "chatId" | "nameSource">>;

/** Looked up live at send time, so saving someone in your phone takes effect on the next message. */
export async function greetFor(client: WAWebJS.Client | null | undefined, who: Who): Promise<string> {
  const stored = firstName(who.name);
  if (who.nameSource === "manual" && stored) return stored;
  const chatId = who.chatId ?? who.id;
  const hit = cache.get(chatId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  let saved = "";
  let profile = "";
  if (client) {
    const contact = await Promise.race([client.getContactById(chatId), new Promise<null>((r) => setTimeout(() => r(null), 5_000))]).catch(() => null);
    saved = contact?.isMyContact ? firstName(contact.name) : "";
    profile = firstName(contact?.pushname);
  }
  // A stored "contact" name came from your phone earlier; keep it over a profile name.
  const name = saved || (who.nameSource === "contact" ? stored : "") || profile || stored || "there";
  cache.set(chatId, { name, at: Date.now() });
  return name;
}
