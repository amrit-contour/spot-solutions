// Dev only, against the Firebase emulators (pnpm emulators): fills the signed-in emulator user with a few watched groups, group
// spot alerts, review items and the Bangalore rooms, so Alerts, Groups and the Open spots widget have something to show.
//   node --experimental-strip-types scripts/seed-alerts.mjs            (uses the only user in the Auth emulator)
//   node --experimental-strip-types scripts/seed-alerts.mjs <uid>
// Nothing here can touch the real project: it only talks to 127.0.0.1.
import { BLR_ROSTER } from "@spot/shared/fixtures/blrRooms";
import { alertExpiry, alertIdFor, localParts, zonedToMs } from "@spot/shared";

const PROJECT = "demo-nbot";
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const TZ = "Asia/Kolkata";

async function uidFromAuth() {
  const r = await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}" });
  const users = (await r.json()).userInfo ?? [];
  if (users.length !== 1) throw new Error(`Expected one emulator user, found ${users.length}. Sign in once in the app ("Sign in as the emulator test user"), or pass the uid.`);
  return users[0].localId;
}

const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
};
const put = async (path, data) => {
  const r = await fetch(`${FS}/${path}`, { method: "PATCH", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: JSON.stringify({ fields: enc(data).mapValue.fields }) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
};

const uid = process.argv[2] ?? (await uidFromAuth());
const now = Date.now();
const { date: today } = localParts(now, TZ);
const at = (time) => zonedToMs(today, time, TZ);
const base = `users/${uid}`;
const room = (name, area) => BLR_ROSTER.rooms.find((r) => r.name === name && (!area || r.area === area));

// The comic's rooms (Bangalore starter; made-up numbers dropped like the app does) and the groups.
for (const r of BLR_ROSTER.rooms) await put(`${base}/rooms/${r.id}`, JSON.parse(JSON.stringify({ ...r, id: undefined })));
for (const c of BLR_ROSTER.curators) await put(`${base}/curators/${c.id}`, JSON.parse(JSON.stringify({ ...c, phone: undefined, id: undefined })));
const groups = [["120363001@g.us", "Bangalore Comics", 412], ["120363002@g.us", "Open mic gang", 86], ["120363003@g.us", "Family", 9], ["120363004@g.us", "Comedy Square curation", 31]];
for (const [id, name, participants] of groups) await put(`${base}/groups/${id}`, { id, name, participants, isAdmin: false });
await put(`${base}/watchedGroups/120363001@g.us`, { id: "120363001@g.us", name: "Bangalore Comics", addedAt: now - 86_400_000 });

const alert = (n, o) => {
  const a = { groupId: "120363001@g.us", groupName: "Bangalore Comics", messageId: `seed-${n}`, poster: { id: "919800000001@c.us", name: "Dhruv Rathi" }, contact: { id: "919800000001@c.us", name: "Dhruv Rathi", kind: "sender" }, status: "new", receivedAt: now - n * 60_000, date: today, times: [], ...o };
  a.id = alertIdFor(a.groupId, a.messageId);
  a.expiresAt = o.expiresAt ?? alertExpiry(a, TZ, a.receivedAt);
  return a;
};
const alerts = [
  alert(1, { roomId: room("TAG").id, roomName: "TAG", showId: "mic", times: ["21:30", "23:00"], text: "Spots available for both 9:30 and 11 pm today at TAG. DM", expiresAt: now + 95 * 60_000 }),
  alert(3, { roomName: "Comedy Theatre", times: ["18:00"], reachBy: "17:40", busking: true, text: "Busking spot available at 6pm today at comedy theatre. DM if you can reach by 5.40pm.", expiresAt: now + 24 * 60_000, poster: { id: "919800000002@c.us", name: "Akhil" }, contact: { id: "919800000002@c.us", name: "Akhil", kind: "sender" } }),
  alert(6, { roomId: room("Banter Comedy Club").id, roomName: "Banter Comedy Club", times: ["19:00", "21:00"], text: "Spots available at 7 and 9pm today at Banter comedy club. DM.", expiresAt: now + 3 * 3_600_000, clash: { with: "Zostel 9:00 PM", times: ["19:00", "21:00"] } }),
  alert(9, { roomId: room("Underground Comedy Club").id, roomName: "Underground Comedy Club", times: ["22:30"], text: "One spot available at 10.30 at UGC today, DM", status: "closed", closedAt: now - 120_000, expiresAt: now + 3_600_000 }),
  alert(40, { roomName: "the entertainment store", times: ["15:00", "17:00", "19:00"], text: "Spots at the entertainment store: 3-5pm 5-7pm 7-9pm Dm me", status: "expired", expiresAt: now - 3_600_000 }),
];
for (const a of alerts) await put(`${base}/spotAlerts/${a.id}`, a);

const sq = room("Comedy Square");
const upd = (n, o) => ({ groupId: "120363001@g.us", groupName: "Bangalore Comics", poster: { id: "919800000003@c.us", name: "Vishal KG" }, status: "pending", receivedAt: now - n * 60_000, messageId: `seed-u${n}`, ...o });
const updates = [
  upd(12, { id: "closure-sq", kind: "closure", roomId: sq.id, roomName: sq.name, summary: "Comedy Square is full: Wed 28 to Sat 31", text: "Wednesday, Thursday, Friday, and Saturday spots are over for this week at Comedy Square.", closure: { ranges: [{ from: addDays(today, 1), until: addDays(today, 4) }] } }),
  upd(20, { id: "sched-sq", kind: "schedule", roomId: sq.id, roomName: sq.name, summary: "Comedy Square curators: Mon Vishal KG, Tue Varun Sachdev, Wed to Sat Akhil, Sun Varun Sachdev", text: "Comedy Square – Curation Schedule: Monday: @Vishal KG Comic BLR, Tuesday: …", schedule: { entries: [{ days: [1], people: ["Vishal KG"] }, { days: [2], people: ["Varun Sachdev"] }, { days: [3, 4, 5, 6], people: ["Akhil"] }, { days: [0], people: ["Varun Sachdev"] }] } }),
  upd(30, { id: "open-moc", kind: "opening", status: "info", roomId: room("Ministry of Comedy").id, roomName: "Ministry of Comedy", summary: "Ministry of Comedy: spots open by 3:15 PM", text: "ministry spots will open by 3:15pm", opening: { openAt: "15:15", website: false } }),
  upd(300, { id: "closure-done", kind: "closure", status: "applied", auto: true, appliedAt: now - 290 * 60_000, roomId: room("UGC")?.id ?? room("Underground Comedy Club").id, roomName: "Underground Comedy Club", summary: "Underground Comedy Club is full: Sun 1", closure: { ranges: [{ from: addDays(today, 5), until: addDays(today, 5) }] } }),
];
for (const u of updates) await put(`${base}/groupUpdates/${u.id}`, u);
console.log(`Seeded ${alerts.length} alerts, ${updates.length} group updates, ${groups.length} groups and ${BLR_ROSTER.rooms.length} rooms for ${uid}.`);

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
