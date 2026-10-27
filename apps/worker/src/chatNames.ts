// Who is who in a chat, for the Messages page. Current WhatsApp names group writers and tags by @lid (digits that aren't a phone
// number), so each one is mapped to a phone (getContactLidAndPhone), then named from your Comics, the show's member cache, or
// the contact (saved name, profile name, business name), else "+number". Names are kept in memory for a while and the real ones
// (never a bare number) in users/{uid}/private/chatNames, which only the worker reads, so a freshly linked server (WhatsApp Web
// hasn't synced the address book yet) still shows names. A name isn't chat text.
import type WAWebJS from "whatsapp-web.js";
import { authorNames, bestContactName, comicIdForPhone, looksLikeNumber, numberLabel, type Comic, type GroupMember } from "@spot/shared";
import { col } from "./firebase.ts";

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 4000;
const LOOKUPS_AT_ONCE = 6;
const cache = new Map<string, { name: string; at: number }>();

const SAVED_MAX = 3000;
const SAVE_DELAY_MS = 5_000;
/** Names kept on the account (see top): loaded once per process, topped up as new real names turn up. */
const saved = new Map<string, { names: Map<string, string>; loaded: Promise<void>; timer?: ReturnType<typeof setTimeout>; dirty: boolean }>();
const savedFor = (uid: string) => {
  let s = saved.get(uid);
  if (!s) {
    const names = new Map<string, string>();
    const loaded = (async () => {
      try {
        const doc = await col(uid, "private").doc("chatNames").get();
        for (const r of (doc.data()?.list ?? []) as { id?: string; name?: string }[]) if (r.id && r.name && !looksLikeNumber(r.name) && !names.has(r.id)) names.set(r.id, r.name);
      } catch {
        /* unreadable: names are worked out live as before */
      }
    })();
    saved.set(uid, (s = { names, loaded, dirty: false }));
  }
  return s;
};
function saveSoon(uid: string) {
  const s = savedFor(uid);
  s.dirty = true;
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = undefined;
    if (!s.dirty) return;
    s.dirty = false;
    const list = [...s.names].slice(-SAVED_MAX).map(([id, name]) => ({ id, name }));
    void col(uid, "private").doc("chatNames").set({ list, at: Date.now() }).catch(() => (s.dirty = true));
  }, SAVE_DELAY_MS);
  s.timer.unref?.();
}

const remember = (uid: string, id: string, name: string) => {
  if (looksLikeNumber(name)) return; // a number is the fallback, not a name worth keeping
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(`${uid}|${id}`, { name, at: Date.now() });
  const s = savedFor(uid);
  if (s.names.get(id) !== name) {
    s.names.delete(id);
    s.names.set(id, name);
    saveSoon(uid);
  }
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
  const keep = savedFor(uid);
  await keep.loaded;

  const lids = opts.lids ?? (await lidToPhoneIds(client, todo));
  const self = client.info?.wid?.user;
  await inParallel(todo, async (raw) => {
    const phoneId = raw.endsWith("@c.us") ? raw : lids.get(raw);
    const phone = phoneId?.split("@")[0];
    let name = (phoneId && (roster.get(phoneId) ?? known.get(phoneId))) || known.get(raw);
    if (!name && opts.contacts !== false) {
      for (const key of [raw, phoneId].filter((k): k is string => Boolean(k))) {
        const c = await client.getContactById(key).catch(() => null);
        name = bestContactName(c) || undefined;
        if (name) break;
      }
    }
    // Names this account had before (another server, an earlier session) beat a bare number.
    if (!name) name = [raw, phoneId].map((k) => (k ? keep.names.get(k) : undefined)).find(Boolean);
    if (!name && phone && phone !== self) name = numberLabel(phone);
    if (!name) return;
    out.set(raw, name);
    if (phoneId) out.set(phoneId, name);
    remember(uid, raw, name);
  });
  return out;
}

/**
 * A name for each chat in a chat list (the Never read picker, the voice picker). Groups keep their subject. A person gets, in
 * order: your Comics name (matched by phone, @c.us or @lid), then what WhatsApp calls the chat if that is a real name, then the
 * contact (saved, short, profile, business name), then what this account knew before, then "+number". An @lid with no phone and
 * no name stays its digits.
 */
export async function nameChats(
  uid: string,
  client: WAWebJS.Client,
  chats: { id: string; name: string; isGroup: boolean }[],
  comics: Pick<Comic, "id" | "chatId" | "phone" | "name">[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const people = chats.filter((c) => !c.isGroup);
  const lids = await lidToPhoneIds(client, people.map((c) => c.id));
  const roster = authorNames(comics);
  const needy: string[] = [];
  for (const c of people) {
    const phoneId = c.id.endsWith("@c.us") ? c.id : lids.get(c.id);
    const comic = roster.get(c.id) ?? (phoneId ? roster.get(phoneId) : undefined);
    if (comic) out.set(c.id, comic);
    else if (!looksLikeNumber(c.name)) out.set(c.id, c.name.trim());
    else needy.push(c.id);
  }
  if (needy.length) {
    const found = await resolveNames(uid, client, needy, comics, [], { lids }).catch(() => new Map<string, string>());
    for (const id of needy) {
      const name = found.get(id);
      if (name) out.set(id, name);
    }
  }
  return out;
}

/** Test hook: forget everything held in memory. */
export const resetChatNames = () => {
  cache.clear();
  for (const s of saved.values()) if (s.timer) clearTimeout(s.timer);
  saved.clear();
};
