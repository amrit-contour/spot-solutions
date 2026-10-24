// Seeds a demo curator with realistic data and prints a dev sign-in link.
//   pnpm --filter @spot/worker exec tsx --env-file=.env scripts/seed-demo.ts
import { getAuth } from "firebase-admin/auth";
import { DEFAULT_SETTINGS, lineupId, shiftWeek, weekOf, type Comic, type Show, type SpotRequest, type Venue } from "@spot/shared";
import { col, db, sessionRef, userRef } from "../src/firebase.ts";

const uid = process.argv[2] ?? "demo-curator";
const week = weekOf();
const last = shiftWeek(week, -1);
const now = Date.now();
const H = 3600_000;

const venues: Venue[] = [{ id: "v1", name: "The Courtyard Club", area: "Indiranagar", mapsLink: "https://maps.app.goo.gl/demo" }];
const shows: Show[] = [
  { id: "mon", name: "Monday Mic", venueId: "v1", weekday: 1, startTime: "20:00", slotCount: 8, includeSlotTime: true, defaultMinutes: 5, active: true, groupId: null, regulars: ["919800000009@c.us"], protected: [] },
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
batch.set(sessionRef(uid), { status: "ready", phone: "919845012345", pushName: "Amrit", lastSeen: now + 6 * H, qr: null, error: null });
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
batch.set(col(uid, "lineups").doc(lineupId(week, "mon")), { id: lineupId(week, "mon"), weekOf: week, showId: "mon", date: week, slots: [{ comicId: "919800000004@c.us", minutes: 7 }], status: "draft", sentAt: null, groupSync: null });
batch.set(col(uid, "lineups").doc(lineupId(last, "tue")), { id: lineupId(last, "tue"), weekOf: last, showId: "tue", date: last, slots: [{ comicId: "919800000002@c.us" }, { comicId: "919800000005@c.us" }, { comicId: "919800000009@c.us" }], status: "confirmed", sentAt: now - 7 * 24 * H, groupSync: null });
await batch.commit();

const token = await getAuth().createCustomToken(uid);
console.log(`Seeded ${uid} for week ${week}.\nDev sign-in: http://localhost:5173/?devToken=${token}`);
process.exit(0);
