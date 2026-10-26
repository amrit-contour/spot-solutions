// Seeds a demo curator with realistic data and prints a dev sign-in link.
//   pnpm --filter @spot/worker exec tsx --env-file=.env scripts/seed-demo.ts
import { getAuth } from "firebase-admin/auth";
import { DEFAULT_SETTINGS, dateInWeek, lineupId, sentSnapshot, shiftWeek, weekOf, type Comic, type GroupMember, type Show, type SpotRequest, type Venue } from "@spot/shared";
import { col, db, sessionRef, userRef } from "../src/firebase.ts";

const uid = process.argv[2] ?? "demo-curator";
const week = weekOf();
const last = shiftWeek(week, -1);
const now = Date.now();
const H = 3600_000;

const venues: Venue[] = [{ id: "v1", name: "The Courtyard Club", area: "Indiranagar", mapsLink: "https://maps.app.goo.gl/demo" }];
// A cached member list for Monday's group, so the group panel is visible in the demo without a linked WhatsApp.
const groupMembers: GroupMember[] = [
  { id: "919800000010@c.us", name: "Neha Kapoor", isAdmin: true },
  { id: "919800000009@c.us", name: "Devansh Gupta", isAdmin: false },
  { id: "919800000004@c.us", name: "Ananya Kulkarni", isAdmin: false },
  { id: "919800000001@c.us", name: "Rohan Mehta", isAdmin: false },
  { id: "919800000002@c.us", name: "Ishita Rao", isAdmin: false },
  { id: "919800000005@c.us", name: "Vikram Nair", isAdmin: false },
  { id: "919800000011@c.us", name: "Pooja Menon", isAdmin: false },
  { id: "919800000012@c.us", name: "Arjun Pillai", isAdmin: false },
  { id: "919800000013@c.us", name: "Tanvi Shah", isAdmin: false },
  { id: "919800000014@c.us", name: "Kabir Anand", isAdmin: false },
  { id: "919800000015@c.us", name: "Riya Das", isAdmin: false },
  { id: "919800000016@c.us", name: "Nikhil Verma", isAdmin: false },
];
const shows: Show[] = [
  { id: "mon", name: "Monday Mic", venueId: "v1", weekday: 1, startTime: "20:00", slotCount: 8, includeSlotTime: true, defaultMinutes: 5, active: true, groupId: "demo-monday-group@g.us", groupMode: "manual", regulars: ["919800000009@c.us"], protected: ["919800000010@c.us"], groupMembers: { groupId: "demo-monday-group@g.us", at: now - 5 * 60_000, members: groupMembers } },
  { id: "tue", name: "Tuesday Trial", venueId: "v1", weekday: 2, startTime: "20:30", slotCount: 6, includeSlotTime: false, defaultMinutes: 5, active: true, groupId: null, regulars: [], protected: [] },
];
const people: [string, string, Comic["tier"], string | null][] = [
  ["Rohan Mehta", "919800000001", "open", null],
  ["Ishita Rao", "919800000002", "regular", last],
  ["Karthik S", "919800000003", "open", null],
  ["Ananya Kulkarni", "919800000004", "featured", null],
  ["Vikram Nair", "919800000005", "open", last],
  ["Sana Sheikh", "919800000006", "open", null],
  ["Aditya Bose", "919800000007", "regular", null],
  ["Meera Iyer", "919800000008", "open", null],
  ["Devansh Gupta", "919800000009", "regular", last],
  ["Neha Kapoor", "919800000010", "regular", null],
];
const msgs: Record<string, [string[], number[], number, string]> = {
  "919800000001": [["hey bro", "monday ka spot milega? got a new 5"], [1], 0.95, "Wants Monday, trying a new 5"],
  "919800000002": [["hii can I come up tuesday?"], [2], 0.95, "Asking for Tuesday"],
  "919800000003": [["got new bits, any day works this week"], [1, 2], 0.9, "Flexible, new material"],
  "919800000004": [["Need a spot to run my closer before Saturday's show", "mon or tue"], [1, 2], 0.95, "Wants to test closer, Mon or Tue"],
  "919800000005": [["yo put me down for monday pls"], [1], 0.95, "Wants Monday"],
  "919800000006": [["is there space on the lineup next week?"], [], 0.85, "Asking about space next week"],
  "919800000007": [["guru tuesday spot sigutta?"], [2], 0.9, "Asking for Tuesday (Kannada)"],
  "919800000008": [["are you guys doing the mic on monday?"], [1], 0.5, "Asking if Monday mic is on"],
};

const batch = db.batch();
batch.set(userRef(uid), { settings: DEFAULT_SETTINGS, name: "Demo Curator", email: "demo@spot.solutions", waEnabled: false, createdAt: now });
batch.set(sessionRef(uid), { status: "ready", phone: "919845012345", pushName: "Demo", lastSeen: now + 12 * H, qr: null, error: null });
venues.forEach((v) => batch.set(col(uid, "venues").doc(v.id), v));
shows.forEach((s) => batch.set(col(uid, "shows").doc(s.id), s));
people.forEach(([name, phone, tier, lp], i) => {
  const id = `${phone}@c.us`;
  batch.set(col(uid, "comics").doc(id), { id, name, phone, tier, lastPerformedWeek: lp, regularOf: phone === "919800000009" ? ["mon"] : [] } satisfies Comic);
  const m = msgs[phone];
  if (!m) return;
  const at = now - (20 - i * 2) * H;
  const r: SpotRequest = {
    id: `${week}_${id}`, comicId: id, comicName: name, weekOf: week,
    messages: m[0].map((body, j) => ({ id: `${phone}-${j}`, body, at: at + j * 40_000 })),
    intent: { isSpotRequest: m[2] >= 0.6, confidence: m[2], preferredDays: m[1] as never, note: m[3], model: "ollama/gemma3:4b" },
    status: phone === "919800000004" ? "assigned" : m[2] >= 0.6 ? "acked" : "new",
    ackedAt: m[2] >= 0.6 ? at + 60_000 : null, createdAt: at, updatedAt: at + 60_000,
  };
  batch.set(col(uid, "requests").doc(r.id), r);
});
batch.set(col(uid, "lineups").doc(lineupId(week, "mon")), { id: lineupId(week, "mon"), weekOf: week, showId: "mon", date: week, slots: [{ comicId: "919800000004@c.us", minutes: 7 }, { comicId: "919800000001@c.us", minutes: 5 }, { comicId: "919800000009@c.us", minutes: 5 }], status: "draft", sentAt: null, groupSync: null });
batch.set(col(uid, "requests").doc(`${week}_919800000001@c.us`), { status: "assigned" }, { merge: true });
// A held request (performed last week) and a drafted reply waiting for the curator.
batch.set(col(uid, "requests").doc(`${week}_919800000005@c.us`), { hold: "last_week", holdOverridden: false }, { merge: true });
batch.set(col(uid, "actions").doc("demo-cancel"), { kind: "cancel_spot", comicId: "919800000002@c.us", comicName: "Ishita Rao", weekOf: week, message: "hey so sorry, can't make it tuesday 😭 something came up", draft: "No worries Ishita, I've freed up your Tuesday spot. See you next time! 🫡", lineupId: null, status: "pending", createdAt: now - H });
// One of each kind for the Updates panel: a cancellation that frees a slot, a status question, a venue question,
// a "who are you?" draft for someone unsaved, and a server warning.
batch.set(col(uid, "actions").doc("demo-cancel-slot"), { kind: "cancel_spot", comicId: "919800000007@c.us", comicName: "Aditya Bose", weekOf: week, message: "bro I'm stuck at work, won't make tuesday", draft: "No stress Aditya, I've freed your Tuesday slot. Catch you next week!", lineupId: lineupId(week, "tue"), status: "pending", createdAt: now - 30 * 60_000 });
batch.set(col(uid, "actions").doc("demo-status"), { kind: "status_query", comicId: "919800000006@c.us", comicName: "Sana Sheikh", weekOf: week, message: "am I up this week?", draft: "Hey Sana! Lineups go out on Sunday night. I'll message you if you're on.", lineupId: null, status: "pending", createdAt: now - 3 * H });
batch.set(col(uid, "actions").doc("demo-info"), { kind: "show_info", comicId: "919800000008@c.us", comicName: "Meera Iyer", weekOf: week, message: "what time does the monday mic start and where is it?", draft: "Monday Mic starts at 8:00 PM at The Courtyard Club. Doors open a bit earlier.", lineupId: null, status: "pending", createdAt: now - 4 * H });
batch.set(col(uid, "actions").doc("demo-onboard"), { kind: "onboard", comicId: "919800000099@c.us", comicName: "+91 98000 00099", weekOf: week, message: "hi can i get a spot on monday", draft: "Hey! Don't think I have you saved yet 🙂 Could you tell me your full name, which comedy scene you're from, and how long you've been doing comedy? Also, are you travelling?", lineupId: null, status: "pending", createdAt: now - 5 * H });
batch.set(col(uid, "notices").doc("demo-warn"), { level: "warn", text: "WhatsApp asked to be linked again. Open Settings, Show QR code and scan it.", createdAt: now - 6 * H, read: false });
batch.set(col(uid, "notices").doc("demo-notice"), { level: "info", text: "Karthik S introduced themselves: from Pune, 2 yrs in comedy, travelling.", createdAt: now - 2 * H, read: false });
batch.set(db.collection("access").doc(uid), { uid, email: "demo@spot.solutions", name: "Demo Curator", photo: null, status: "approved", requestedAt: now, decidedAt: now, decidedBy: "demo" });
batch.set(col(uid, "session").doc("state"), { aliveAt: now }, { merge: true });
// Tuesday is already confirmed (and sent), so the demo can show editing a lineup after confirming and the Send updates review.
const tue = [{ comicId: "919800000007@c.us" }, { comicId: "919800000003@c.us" }];
batch.set(col(uid, "lineups").doc(lineupId(week, "tue")), { id: lineupId(week, "tue"), weekOf: week, showId: "tue", date: dateInWeek(week, 2), slots: tue, status: "confirmed", sentAt: now - 3 * H, sent: sentSnapshot(tue, shows[1], now - 3 * H), groupSync: null });
for (const t of tue) batch.set(col(uid, "requests").doc(`${week}_${t.comicId}`), { status: "confirmed" }, { merge: true });
batch.set(col(uid, "lineups").doc(lineupId(last, "tue")), { id: lineupId(last, "tue"), weekOf: last, showId: "tue", date: last, slots: [{ comicId: "919800000002@c.us" }, { comicId: "919800000005@c.us" }, { comicId: "919800000009@c.us" }], status: "confirmed", sentAt: now - 7 * 24 * H, groupSync: null });
await batch.commit();

const token = await getAuth().createCustomToken(uid);
console.log(`Seeded ${uid} for week ${week}.\nDev sign-in: http://localhost:5173/?devToken=${token}`);
process.exit(0);
