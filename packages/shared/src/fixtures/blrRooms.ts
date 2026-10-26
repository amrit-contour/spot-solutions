// A seed roster for tests: the owner's Bangalore mic list ("Bangalore Open Mics.xlsx", "Mic Venues @ BLR.xlsx") in the rooms model.
// Names, areas, times, curators and ask rules come from the sheets. Real phone numbers are NOT copied here (a few made-up ones
// stand in so the number paths are covered). Where the two sheets disagree (the Local: Krishna vs Shreekant; Just BLR times) the
// "Bangalore Open Mics" sheet wins. Covers the awkward cases: a curator per day (Comedy Square), "they'll reach out" (TAG), website
// + password (Ministry), Instagram (Humble Pie), walk-in (Jagriti), day before (Just BLR), two locations of one brand (Comedy Theatre,
// Glen's Bakehouse, Bloom, GoStops), English only (Cafe Muziris), co-curators (Bloom HSR) and limits (1 a month, 2 a week, 2 a day).
import { newRoomId, slug, type AskRule, type Curator, type DayPlan, type Limit, type Room, type RoomNote, type Roster, type RoomShow } from "../rooms.ts";
import type { Weekday } from "../types.ts";

const [SUN, MON, TUE, WED, THU, FRI, SAT] = [0, 1, 2, 3, 4, 5, 6] as Weekday[];
const WEEKDAYS = [MON, TUE, WED, THU, FRI];
const WEEKEND = [SAT, SUN];
const ALL = [MON, TUE, WED, THU, FRI, SAT, SUN];

export function buildBlrRoster(): Roster {
  const curators = new Map<string, Curator>();
  const cur = (name: string, extra: Partial<Curator> = {}) => {
    const id = slug(name);
    if (!curators.has(id)) curators.set(id, { id, name, ...extra });
    return id;
  };
  /** Days with the same curators (none: nobody to ask). */
  const days = (wds: Weekday[], who: string[] = [], extra: Partial<DayPlan> = {}): DayPlan[] => wds.map((weekday) => ({ weekday, curatorIds: who.map((n) => cur(n)), ...extra }));
  const show = (name: string, type: RoomShow["type"], cadence: RoomShow["cadence"], times: string[], ds: DayPlan[], extra: Partial<RoomShow> = {}): RoomShow => ({ id: slug(name), name, type, cadence, times, days: ds, ...extra });
  const mic = (times: string[], ds: DayPlan[], extra: Partial<RoomShow> = {}) => show("Mic", "mic", "weekly", times, ds, extra);
  const room = (name: string, area: string, shows: RoomShow[], extra: Partial<Room> = {}): Room => ({
    id: newRoomId(name, area), name, area, city: "Bengaluru", aliases: [], tags: [], notes: [], limits: [], shows, ...extra,
  });
  const sameDay: AskRule = { kind: "same_day" };
  const sameDayAm: AskRule = { kind: "same_day", morning: true };
  const mondayAm: AskRule = { kind: "weekday", day: MON, morning: true };
  const startOfWeek: AskRule = { kind: "start_of_week", day: SUN };
  const walkIn: RoomNote = { kind: "walk_in", text: "Registration starts at 5 PM" };

  const rooms: Room[] = [
    room("Jagriti Theatre", "Whitefield", [mic(["17:30"], days([SAT], [], { note: "Walk-in, registration from 5 PM" }), { askRule: { kind: "walk_in" } })], { tags: ["walk-in"], notes: [walkIn] }),
    room("Bloom Whitefield", "Whitefield", [mic([], [...days([SAT], ["Sagar Joshi"], { times: ["20:00"] }), ...days([SUN], ["Sagar Joshi"], { times: ["19:00"] })])], { brand: "Bloom" }),
    room("The Local", "Kalyan Nagar", [mic(["20:00"], days([MON], ["Krishna"]), { askRule: { kind: "weekday", day: SUN } })], { tags: ["english-only"], aliases: ["The Local Kalyan Nagar"] }),
    room("Glen's Bakehouse", "Kalyan Nagar", [mic(["20:00"], [...days([MON], ["Rahul Robin"]), ...days([WED], ["Shreekanth"]), ...days([THU], ["Krishna"])], { askRule: startOfWeek })], { brand: "Glen's Bakehouse" }),
    room("Glen's Bakehouse", "Koramangala", [
      mic(["20:00", "22:00"], days(WEEKDAYS, ["BOT"]), { askRule: startOfWeek }),
      show("Show", "show", "monthly", [], days(WEEKEND, ["Aman"]), { askRule: { kind: "start_of_month" } }),
    ], { brand: "Glen's Bakehouse", limits: [{ scope: "show", showId: "mic", perWeek: 2 }] }),
    room("Banter Comedy Club", "Kalyan Nagar", [mic([], [...days(WEEKDAYS, ["Vishal"], { times: ["19:00", "21:00"] }), ...days(WEEKEND, ["Vishal"], { times: ["17:00", "22:30"] })])], { aliases: ["Banter"] }),
    room("Cafe Muziris", "Indiranagar", [mic(["21:00"], days(WEEKDAYS, ["Dwip"]), { askRule: startOfWeek })], { tags: ["english-only"] }),
    room("Bloom Indiranagar", "Indiranagar", [
      mic(["20:00"], [...days([MON, TUE], ["Amrit Dash"]), ...days([WED], ["Sharan"]), ...days([THU], ["Aditya Natrajan"]), ...days(WEEKEND, ["Aditya Ojha"])], { askRule: { kind: "weekday", day: MON }, myRole: "curator" }),
    ], { brand: "Bloom", myNotes: "Good sound, tough crowd on Thursdays." }),
    room("Big Pitcher", "Indiranagar", [show("Show", "show", "monthly", [], days(WEEKEND, ["Akash"]), { askRule: { kind: "weekday", day: MON }, tags: ["check-bms"] })]),
    room("Just BLR", "MG Road", [
      show("Mic", "both", "weekly", ["19:00", "21:00"], [...days([TUE], ["Jagadish"]), ...days([WED], ["Harish"]), ...days([THU], ["Vernon"], { }), ...days([FRI], ["Prathyusha"]), ...days(WEEKEND, ["Vivek"])], { askRule: { kind: "day_before" } }),
    ], { aliases: ["Just BLR Comedy Club", "Brigade Road"], limits: [{ scope: "room", unlimited: true }] }),
    room("Comedy Theatre", "Church Street", [
      show("Mic", "both", "daily", ["12:00", "14:00", "16:00", "18:00", "20:00", "21:30", "23:00"], [...days([MON, TUE, WED, THU], ["Navneeth"]), ...days([FRI, SAT, SUN], ["Ruby"])], { askRule: { kind: "day_before", morning: true } }),
    ], { brand: "Comedy Theatre", aliases: ["Comedy Theatre Church Street"], limits: [{ scope: "room", perDay: 2 }] }),
    room("Comedy Theatre", "Indiranagar", [show("Mic", "both", "daily", [], days(ALL, ["Kush"]), { askRule: startOfWeek })], { brand: "Comedy Theatre" }),
    room("Zostel", "Koramangala", [mic(["17:00"], days([SUN], ["Devashish"]), { askRule: sameDayAm })]),
    room("TAG", "Koramangala", [
      show("Mic", "mic", "daily", ["21:30", "23:00"], [
        ...days([MON], ["Dhruv"]), ...days([TUE], ["Rohit"]), ...days([WED], ["Nisarg"]), ...days([THU], ["Devashish"]),
        ...days(WEEKEND, ["Tarun"], { theyReachOut: true, askRule: { kind: "they_reach_out", note: "Tarun himself will reach out" } }),
      ], { askRule: sameDay }),
    ], { aliases: ["The Art Gully"], notes: [{ kind: "check_bms", text: "Shows: check BMS" }] }),
    room("Ministry of Comedy", "Koramangala", [
      mic(["21:30"], days(WEEKDAYS), { askRule: { kind: "website", note: "Register at ministryofcomedy.in/mics" } }),
    ], { aliases: ["MOC"], notes: [{ kind: "website", url: "https://ministryofcomedy.in/mics", text: "Needs the site password: ask a regular." }] }),
    room("Underground Comedy Club", "Koramangala", [
      mic(["21:00"], [...days([MON], ["Kavya"]), ...days([TUE], ["Mehran"]), ...days([WED], ["Gaurav Purohit"]), ...days([FRI, SAT, SUN], [], { theyReachOut: true })], { askRule: sameDay }),
    ], { aliases: ["UGC"], notes: [{ kind: "check_bms", text: "Shows: check BMS" }] }),
    room("Cafe Reset", "Koramangala", [
      show("Show", "show", "monthly", [], [...days([FRI], ["Joteen"], { times: ["21:00"] }), ...days(WEEKEND, ["Joteen"], { times: ["20:00"] })], { askRule: { kind: "start_of_month" } }),
    ], { limits: [{ scope: "room", perMonth: 1 }] }),
    room("Humble Pie", "HSR Layout", [
      mic([], [...days([TUE, WED, THU], ["Comedy Bandar"], { times: ["20:30"] }), ...days(WEEKEND, [], { times: ["17:30"], note: "Group list" })], { askRule: mondayAm }),
    ], { notes: [{ kind: "instagram", handle: "comedybandar" }] }),
    room("Comedy Square", "HSR Layout", [
      mic(["20:30", "22:30"], [
        ...days([MON], ["Vishal KG"]), ...days([TUE], ["Varun Sachdev"]), ...days([WED, THU, FRI, SAT], ["Akhil"]), ...days([SUN], ["Varun Sachdev"]),
      ]),
    ], { pin: { lat: 12.9116, lng: 77.6474, label: "Comedy Square, HSR Layout" } }),
    room("Laugh Junction", "HSR Layout", [mic([], [...days([MON, WED], ["Sid"]), ...days([TUE, THU], ["Rishabh"])], { askRule: sameDayAm })]),
    room("Bloom HSR", "HSR Layout", [
      mic([], [...days([FRI], ["Sharan", "Minahaj"], { times: ["20:00", "22:00"] }), ...days([SAT], ["Sharan", "Minahaj"], { times: ["20:30", "22:00"] }), ...days([SUN], ["Sharan", "Minahaj"], { times: ["19:00", "21:00"] })], { askRule: { kind: "weekday", day: MON } }),
    ], { brand: "Bloom" }),
    room("GoStops", "HSR Layout", [mic(["20:30"], days([FRI, SAT, SUN], ["Prashansa"]), { askRule: sameDay })], { brand: "GoStops" }),
    room("GoStops", "Jayanagar", [mic(["20:30"], days([FRI, SAT, SUN], ["Prashansa"]), { askRule: sameDay })], { brand: "GoStops" }),
    room("Klayworkz", "JP Nagar", [mic(["20:30"], days([TUE, WED, THU], ["Pronoy"]), { askRule: mondayAm })], { aliases: ["Klayworkz Barista"] }),
  ];
  // Made-up numbers, only so phone handling is exercised.
  const fake: Record<string, string> = { tarun: "+91 90000 00001", "vishal-kg": "+91 90000 00002", akhil: "+91 90000 00003", sharan: "+91 90000 00004" };
  for (const [id, phone] of Object.entries(fake)) {
    const c = curators.get(id);
    if (c) c.phone = phone;
  }
  const bandar = curators.get("comedy-bandar");
  if (bandar) bandar.instagram = "comedybandar";
  return { rooms, curators: [...curators.values()] };
}

export const BLR_ROSTER: Roster = buildBlrRoster();
export const BLR_LIMITS_EXAMPLES: Limit[] = BLR_ROSTER.rooms.flatMap((r) => r.limits);
