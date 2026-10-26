// Reads only: pull a show group's members, or list the curator's saved contacts. Nothing is sent.
import type WAWebJS from "whatsapp-web.js";
import { TTL_DAYS, comicIdForPhone, normalizePhone, shouldUpdateName, type Comic, type GroupMember, type GroupMembersResult, type Show, type WaContact } from "@spot/shared";
import { col, db, expireAt } from "./firebase.ts";
import { sessions } from "./sessions.ts";

const BATCH = 450;
const CONCURRENCY = 8;

async function inChunks<T>(items: T[], size: number, fn: (chunk: T[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** @lid → phone number, where WhatsApp will tell us. */
async function lidToPhone(client: WAWebJS.Client, ids: string[]) {
  const map = new Map<string, string>();
  const lids = ids.filter((id) => id.endsWith("@lid"));
  for (let i = 0; i < lids.length; i += 100) {
    try {
      for (const r of await client.getContactLidAndPhone(lids.slice(i, i + 100))) if (r.lid && r.pn) map.set(r.lid, r.pn.split("@")[0]);
    } catch {
      /* no mapping: those people keep their @lid id */
    }
  }
  return map;
}

function contactName(c: WAWebJS.Contact | null, phone: string) {
  const saved = c?.isMyContact ? c.name?.trim() : undefined;
  const profile = c?.pushname?.trim();
  const name = saved || profile || (phone ? `+${phone}` : "Unknown");
  const nameSource = (saved ? "contact" : profile ? "whatsapp" : "number") as NonNullable<Comic["nameSource"]>;
  return { name, nameSource };
}

/**
 * Read a show's group and cache who is in it on the show doc (names from the roster first, then WhatsApp contacts).
 * Changes nothing in WhatsApp and doesn't touch the roster, so it's cheap to run from the lineup page.
 */
export async function listGroupMembers(uid: string, { showId }: Record<string, unknown>): Promise<{ count: number; at: number }> {
  const client = sessions.require(uid);
  const showRef = col(uid, "shows").doc(String(showId));
  const show = (await showRef.get()).data() as Show | undefined;
  if (!show?.groupId) throw new Error("No WhatsApp group linked to this show");
  const chat = await client.getChatById(show.groupId);
  if (!chat.isGroup) throw new Error("That isn't a WhatsApp group");
  const group = chat as WAWebJS.GroupChat;
  const self = client.info.wid;
  const people = group.participants.filter((p) => p.id.user !== self.user && p.id._serialized !== self._serialized);
  const lids = await lidToPhone(client, people.map((p) => p.id._serialized));

  const found = people.map((p) => {
    const raw = p.id._serialized;
    const phone = p.id.server === "lid" ? (lids.get(raw) ?? "") : p.id.user;
    return { raw, phone, id: phone ? comicIdForPhone(phone) : raw, isAdmin: Boolean(p.isAdmin || p.isSuperAdmin) };
  });
  // The curator's own @lid only shows its phone once resolved.
  const others = found.filter((m) => m.phone !== self.user);
  const roster = new Map<string, Comic>();
  await inChunks([...new Set(others.map((m) => m.id))], 300, async (chunk) => {
    for (const s of await db.getAll(...chunk.map((id) => col(uid, "comics").doc(id)))) if (s.exists) roster.set(s.id, s.data() as Comic);
  });
  const members = await mapLimit(others, CONCURRENCY, async (m): Promise<GroupMember> => {
    const known = roster.get(m.id)?.name;
    if (known) return { id: m.id, name: known, isAdmin: m.isAdmin };
    const contact = await client.getContactById(m.raw).catch(() => null);
    return { id: m.id, name: contactName(contact, m.phone).name, isAdmin: m.isAdmin };
  });
  // The same person can show up twice (@lid and @c.us); keep one entry.
  const unique = [...new Map(members.map((m) => [m.id, m])).values()];
  const at = Date.now();
  await showRef.set({ groupMembers: { groupId: show.groupId, at, members: unique } }, { merge: true });
  return { count: unique.length, at };
}

/** Upsert group members as comics. Manual names are never touched; new names follow the intake precedence rules. */
export async function pullGroupMembers(uid: string, { groupId }: Record<string, unknown>): Promise<GroupMembersResult> {
  const client = sessions.require(uid);
  const chat = await client.getChatById(String(groupId));
  if (!chat.isGroup) throw new Error("That isn't a WhatsApp group");
  const group = chat as WAWebJS.GroupChat;
  const self = client.info.wid;
  const people = group.participants.filter((p) => p.id.user !== self.user);
  const lids = await lidToPhone(client, people.map((p) => p.id._serialized));

  const resolved = await mapLimit(people, CONCURRENCY, async (p) => {
    const raw = p.id._serialized;
    const phone = p.id.server === "lid" ? (lids.get(raw) ?? "") : p.id.user;
    const contact = await client.getContactById(raw).catch(() => null);
    return {
      id: phone ? comicIdForPhone(phone) : raw,
      chatId: raw,
      phone,
      isAdmin: Boolean(p.isAdmin || p.isSuperAdmin),
      ...contactName(contact, phone),
    };
  });
  // The curator's own @lid only shows its phone once resolved, so this can't happen before the lookup.
  const members = resolved.filter((m) => m.phone !== self.user && m.chatId !== self._serialized);

  // Find who is on the roster already: by phone-based id, by the raw @lid id, or by the chat id they were first seen on.
  const docs = new Map<string, Comic>();
  const byChat = new Map<string, Comic>();
  const docIds = [...new Set(members.flatMap((m) => [m.id, m.chatId]))];
  await inChunks(docIds, 300, async (chunk) => {
    const snaps = await db.getAll(...chunk.map((id) => col(uid, "comics").doc(id)));
    for (const s of snaps) if (s.exists) docs.set(s.id, { ...(s.data() as Comic), id: s.id });
  });
  await inChunks(members.map((m) => m.chatId), 30, async (chunk) => {
    for (const s of (await col(uid, "comics").where("chatId", "in", chunk).get()).docs) byChat.set(s.get("chatId"), { ...(s.data() as Comic), id: s.id });
  });
  const matched = members.map((m) => ({ m, cur: docs.get(m.id) ?? byChat.get(m.chatId) ?? docs.get(m.chatId) }));
  // The same person can show up twice (@lid and @c.us); keep one entry per comic.
  const unique = [...new Map(matched.map((x) => [x.cur?.id ?? x.m.id, x])).values()];

  let added = 0;
  let updated = 0;
  await inChunks(unique, BATCH, async (chunk) => {
    const batch = db.batch();
    for (const { m, cur } of chunk) {
      if (!cur) {
        const c: Comic = { id: m.id, chatId: m.chatId, name: m.name, nameSource: m.nameSource, phone: m.phone, tier: "open", lastPerformedWeek: null, regularOf: [] };
        batch.set(col(uid, "comics").doc(m.id), c);
        added++;
        continue;
      }
      // An existing comic keeps its id (and anything the curator set); we only fill in what it was missing.
      const patch: Partial<Comic> = {};
      if (!cur.chatId) patch.chatId = m.chatId;
      if (!cur.phone && m.phone) patch.phone = m.phone;
      if (shouldUpdateName(cur, m)) Object.assign(patch, { name: m.name, nameSource: m.nameSource });
      if (Object.keys(patch).length) {
        batch.update(col(uid, "comics").doc(cur.id), patch);
        updated++;
      }
    }
    await batch.commit();
  });

  const idOf = (x: (typeof unique)[number]) => x.cur?.id ?? x.m.id;
  return { total: unique.length, added, updated, memberIds: unique.map(idOf), adminIds: unique.filter((x) => x.m.isAdmin).map(idOf) };
}

/** Contacts per users/{uid}/contactsImport/chunkN doc. Keeps each doc well under Firestore's 1 MiB limit. */
const CONTACT_CHUNK = 1000;

/**
 * The curator's saved WhatsApp contacts that are real people with a phone number. A command result is one Firestore
 * doc (1 MiB), too small for a big phonebook, so the contacts go to contactsImport chunks and the result says how many.
 */
export async function listContacts(uid: string): Promise<{ count: number; chunks: number }> {
  const client = sessions.require(uid);
  const all = await client.getContacts();
  const mine = all.filter((c) => c.isMyContact && !c.isGroup && c.isUser && !c.isMe && c.id.user !== client.info.wid.user);
  // isMyContact keeps businesses out unless the curator saved them.
  const lids = await lidToPhone(client, mine.map((c) => c.id._serialized));
  const seen = new Set<string>();
  const contacts: WaContact[] = [];
  for (const c of mine) {
    // WhatsApp numbers always carry the country code, so treat them as international (same rules as file import).
    const phone = normalizePhone(`+${c.id.server === "lid" ? (lids.get(c.id._serialized) ?? "") : (c.number || c.id.user)}`);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const name = c.name?.trim() || c.pushname?.trim() || `+${phone}`;
    contacts.push({ id: comicIdForPhone(phone), name, phone });
  }
  contacts.sort((a, b) => a.name.localeCompare(b.name));

  const dest = col(uid, "contactsImport");
  const old = await dest.listDocuments();
  for (let i = 0; i < old.length; i += BATCH) {
    const batch = db.batch();
    old.slice(i, i + BATCH).forEach((r) => batch.delete(r));
    await batch.commit();
  }
  const chunks = Math.ceil(contacts.length / CONTACT_CHUNK);
  await Promise.all(Array.from({ length: chunks }, (_, n) => dest.doc(`chunk${n}`).set({ n, contacts: contacts.slice(n * CONTACT_CHUNK, (n + 1) * CONTACT_CHUNK), expireAt: expireAt(TTL_DAYS.contactsImport) })));
  return { count: contacts.length, chunks };
}
