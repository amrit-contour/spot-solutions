// The Never read list (Settings → Rules & replies). Checked FIRST in every inbound path, before any text is read, stored,
// logged or sent to a model. Kept warm by the settings listener in userData.ts, so a change applies to the very next message.
import type WAWebJS from "whatsapp-web.js";
import { compileNeverRead, linkedGroups, matchesNeverRead, neverReadLookups, normalizeNeverReadId, type NeverReadEntry, type NeverReadMatcher } from "@spot/shared";
import { col } from "./firebase.ts";
import { watchUser } from "./userData.ts";

const compiled = new WeakMap<NeverReadEntry[], NeverReadMatcher>();
const EMPTY = compileNeverRead([]);

/** Comedy's watched groups per account (users/{uid}/watchedGroups): only needed while "Never read any group" is on, so listen lazily. */
const watched = new Map<string, { ids: Set<string>; ready: Promise<void> }>();
function watchedGroupIds(uid: string) {
  let w = watched.get(uid);
  if (w) return w;
  const ids = new Set<string>();
  let done!: () => void;
  const ready = new Promise<void>((r) => (done = r));
  col(uid, "watchedGroups").onSnapshot(
    (q) => {
      ids.clear();
      for (const d of q.docs) ids.add(d.id);
      done();
    },
    () => done(), // unreadable: the show groups still apply, and every other group stays silenced
  );
  w = { ids, ready };
  watched.set(uid, w);
  return w;
}

/** The compiled list for this account (waits for the first settings snapshot so a message arriving at startup isn't let through). */
export async function neverReadFor(uid: string): Promise<NeverReadMatcher> {
  const cache = watchUser(uid);
  await cache.ready;
  const list = cache.settings.neverRead;
  const allGroups = !!cache.settings.neverReadAllGroups;
  // Linked groups (show groups for sync, cleanup and posts; Comedy's watched groups; the host poll group) always win over the list.
  if (allGroups || list?.some((e) => e.kind === "group")) {
    const w = watchedGroupIds(uid);
    await w.ready;
    const linked = linkedGroups({ shows: cache.shows, watched: [...w.ids].map((id) => ({ id })), hostPollGroupId: cache.settings.hostPoll?.groupId });
    return compileNeverRead(list, { allGroups, exceptGroups: linked.keys() });
  }
  if (!list?.length) return EMPTY;
  let m = compiled.get(list);
  if (!m) compiled.set(list, (m = compileNeverRead(list)));
  return m;
}

/** lid ↔ phone answers WhatsApp gave us, per account. Empty string = asked, no answer (don't ask again every message). */
const lidToPhone = new Map<string, string>();
const phoneToLid = new Map<string, string>();
const asked = new Set<string>();

async function lookUp(uid: string, client: Pick<WAWebJS.Client, "getContactLidAndPhone">, ids: string[]) {
  const todo = ids.filter((id) => !asked.has(`${uid}|${id}`));
  if (!todo.length) return;
  for (const id of todo) asked.add(`${uid}|${id}`);
  try {
    for (const r of await client.getContactLidAndPhone(todo)) {
      const lid = r.lid && normalizeNeverReadId(r.lid)?.id;
      const pn = r.pn && normalizeNeverReadId(r.pn)?.id;
      if (lid && pn) {
        lidToPhone.set(`${uid}|${lid}`, pn);
        phoneToLid.set(`${uid}|${pn}`, lid);
      }
    }
  } catch {
    for (const id of todo) asked.delete(`${uid}|${id}`); // WhatsApp wasn't ready: ask again next time
  }
}

/**
 * Is any of these ids (chat, sender, group author) on this account's Never read list? Cheap when the list is empty. A @lid is
 * mapped to its phone (and a phone to its lid) only when some entry could use the answer.
 */
export async function isNeverRead(uid: string, client: Pick<WAWebJS.Client, "getContactLidAndPhone"> | undefined, ...ids: (string | null | undefined)[]): Promise<boolean> {
  const m = await neverReadFor(uid);
  if (!m.size) return false;
  if (matchesNeverRead(m, ids)) return true;
  if (!client) return false;
  const need = neverReadLookups(m, ids);
  if (!need.lids.length && !need.phones.length) return false;
  await lookUp(uid, client, [...need.lids, ...need.phones]);
  const pick = (map: Map<string, string>, prefix: string) => new Map([...map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
  return matchesNeverRead(m, ids, { lidToPhone: pick(lidToPhone, `${uid}|`), phoneToLid: pick(phoneToLid, `${uid}|`) });
}

/** Keep only the chats that are not on the list. */
export async function dropNeverRead<C extends { id: { _serialized: string } }>(uid: string, client: Pick<WAWebJS.Client, "getContactLidAndPhone"> | undefined, chats: C[]): Promise<C[]> {
  const m = await neverReadFor(uid);
  if (!m.size) return chats;
  const out: C[] = [];
  for (const c of chats) if (!(await isNeverRead(uid, client, c.id._serialized))) out.push(c);
  return out;
}
