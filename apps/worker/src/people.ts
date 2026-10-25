// Reads only: pull a show group's members, or list the curator's saved contacts. Nothing is sent.
import type WAWebJS from "whatsapp-web.js";
import { comicIdForPhone, shouldUpdateName, type Comic, type GroupMembersResult, type WaContact } from "@spot/shared";
import { col, db } from "./firebase.ts";
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

/** Upsert group members as comics. Manual names are never touched; new names follow the intake precedence rules. */
export async function pullGroupMembers(uid: string, { groupId }: Record<string, unknown>): Promise<GroupMembersResult> {
  const client = sessions.require(uid);
  const chat = await client.getChatById(String(groupId));
  if (!chat.isGroup) throw new Error("That isn't a WhatsApp group");
  const group = chat as WAWebJS.GroupChat;
  const me = client.info.wid.user;
  const people = group.participants.filter((p) => p.id.user !== me);
  const lids = await lidToPhone(client, people.map((p) => p.id._serialized));

  const members = await mapLimit(people, CONCURRENCY, async (p) => {
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
  // The same person can show up twice (@lid and @c.us); keep one entry per comic id.
  const unique = [...new Map(members.map((m) => [m.id, m])).values()];

  const existing = new Map<string, Comic>();
  await inChunks(unique, 300, async (chunk) => {
    const snaps = await db.getAll(...chunk.map((m) => col(uid, "comics").doc(m.id)));
    for (const s of snaps) if (s.exists) existing.set(s.id, s.data() as Comic);
  });

  let added = 0;
  let updated = 0;
  await inChunks(unique, BATCH, async (chunk) => {
    const batch = db.batch();
    for (const m of chunk) {
      const ref = col(uid, "comics").doc(m.id);
      const cur = existing.get(m.id);
      if (!cur) {
        const c: Comic = { id: m.id, chatId: m.chatId, name: m.name, nameSource: m.nameSource, phone: m.phone, tier: "open", lastPerformedWeek: null, regularOf: [] };
        batch.set(ref, c);
        added++;
        continue;
      }
      const patch: Partial<Comic> = {};
      if (!cur.chatId) patch.chatId = m.chatId;
      if (shouldUpdateName(cur, m)) Object.assign(patch, { name: m.name, nameSource: m.nameSource });
      if (Object.keys(patch).length) {
        batch.update(ref, patch);
        updated++;
      }
    }
    await batch.commit();
  });

  return { total: unique.length, added, updated, memberIds: unique.map((m) => m.id), adminIds: unique.filter((m) => m.isAdmin).map((m) => m.id) };
}

/** The curator's saved WhatsApp contacts that are real people with a phone number. */
export async function listContacts(uid: string): Promise<{ contacts: WaContact[] }> {
  const client = sessions.require(uid);
  const all = await client.getContacts();
  const mine = all.filter((c) => c.isMyContact && !c.isGroup && c.isUser && !c.isMe && c.id.user !== client.info.wid.user);
  // isMyContact keeps businesses out unless the curator saved them.
  const lids = await lidToPhone(client, mine.map((c) => c.id._serialized));
  const seen = new Set<string>();
  const contacts: WaContact[] = [];
  for (const c of mine) {
    const phone = c.id.server === "lid" ? (lids.get(c.id._serialized) ?? "") : (c.number || c.id.user);
    if (!/^\d{8,15}$/.test(phone) || seen.has(phone)) continue;
    seen.add(phone);
    const name = c.name?.trim() || c.pushname?.trim() || `+${phone}`;
    contacts.push({ id: comicIdForPhone(phone), name, phone });
  }
  contacts.sort((a, b) => a.name.localeCompare(b.name));
  return { contacts };
}
