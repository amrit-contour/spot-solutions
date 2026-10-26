// Who is who in a chat, for the Messages page. Current WhatsApp names group writers and tags by @lid (digits that aren't a phone
// number), so each one is mapped to a phone (getContactLidAndPhone), then named from your Comics, the show's member cache, or
// the contact (saved name, else WhatsApp profile name), else "+number". Names are kept in memory for a while (a name isn't chat
// text); nothing is written anywhere.
import type WAWebJS from "whatsapp-web.js";
import { authorNames, comicIdForPhone, type Comic, type GroupMember } from "@spot/shared";

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 4000;
const LOOKUPS_AT_ONCE = 6;
const cache = new Map<string, { name: string; at: number }>();

const remember = (uid: string, id: string, name: string) => {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(`${uid}|${id}`, { name, at: Date.now() });
};
const recall = (uid: string, id: string) => {
  const hit = cache.get(`${uid}|${id}`);
  return hit && Date.now() - hit.at < TTL_MS ? hit.name : undefined;
};

/** @lid → phone-based id (919800000001@c.us), where WhatsApp will tell us. */
export async function lidToPhoneIds(client: WAWebJS.Client, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const lids = [...new Set(ids.filter((id) => id.endsWith("@lid")))];
  for (let i = 0; i < lids.length; i += 100) {
    try {
      for (const r of await client.getContactLidAndPhone(lids.slice(i, i + 100))) {
        const phone = r.pn?.split("@")[0];
        if (r.lid && phone) out.set(r.lid, comicIdForPhone(phone));
      }
    } catch {
      /* no mapping: that person keeps their @lid */
    }
  }
  return out;
}

async function inParallel<T>(items: T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LOOKUPS_AT_ONCE, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/**
 * A display name for each id (writers and tagged people), keyed by the id as WhatsApp gave it and by its phone id when known.
 * Ids with no name are left out, so callers fall back to the number. `contacts: false` skips the per-person contact lookup.
 */
export async function resolveNames(
  uid: string,
  client: WAWebJS.Client,
  ids: Iterable<string>,
  comics: Pick<Comic, "id" | "chatId" | "phone" | "name">[],
  members: GroupMember[] = [],
  opts: { contacts?: boolean; lids?: Map<string, string> } = {},
): Promise<Map<string, string>> {
  const roster = authorNames(comics);
  const known = new Map(members.map((m) => [m.id, m.name]));
  const out = new Map<string, string>();
  const todo: string[] = [];
  for (const id of new Set([...ids].filter(Boolean))) {
    const name = roster.get(id) ?? recall(uid, id);
    if (name) out.set(id, name);
    else todo.push(id);
  }
  if (!todo.length) return out;

  const lids = opts.lids ?? (await lidToPhoneIds(client, todo));
  const self = client.info?.wid?.user;
  await inParallel(todo, async (raw) => {
    const phoneId = raw.endsWith("@c.us") ? raw : lids.get(raw);
    const phone = phoneId?.split("@")[0];
    let name = (phoneId && (roster.get(phoneId) ?? known.get(phoneId))) || known.get(raw);
    if (!name && opts.contacts !== false) {
      for (const key of [raw, phoneId].filter((k): k is string => Boolean(k))) {
        const c = await client.getContactById(key).catch(() => null);
        name = (c?.isMyContact ? c.name?.trim() : "") || c?.pushname?.trim() || c?.name?.trim() || c?.shortName?.trim() || undefined;
        if (name) break;
      }
    }
    if (!name && phone && phone !== self) name = `+${phone}`;
    if (!name) return;
    out.set(raw, name);
    if (phoneId) out.set(phoneId, name);
    remember(uid, raw, name);
  });
  return out;
}
