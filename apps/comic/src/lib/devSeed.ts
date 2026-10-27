// Dev only: asks and spots for the demo routes and screenshots, built around today so every lane has something in it.
import { isoAddDays, localDate, showDates, spotFromAsk, type Ask, type Curator, type MySpot, type Roster } from "@spot/shared";
import { TZ } from "./asks";

/** The Bangalore seed with a (made-up) number on every curator but one, so asks can be sent, and one that can't. */
export function demoRoster(base: Roster): Roster {
  const r = structuredClone(base);
  let n = 0;
  r.curators = r.curators.map((c: Curator, i: number) => (i === 3 ? { ...c, phone: undefined } : { ...c, phone: c.phone ?? `+91 90000 ${String(10000 + ++n).slice(-5)}` }));
  // The Bloom Indiranagar rooms are the demo comic's own: one room on auto-send so both modes show.
  const auto = r.rooms.find((x) => x.name === "Glen's Bakehouse" && x.area === "Koramangala") ?? r.rooms[3];
  if (auto) auto.askMode = "auto";
  return r;
}

export function demoAsksAndSpots(roster: Roster, now = Date.now()): { asks: Ask[]; spots: MySpot[] } {
  const today = localDate(new Date(now), TZ);
  const day = (n: number) => isoAddDays(today, n);
  const candidates = roster.rooms.filter((r) => r.shows.some((s) => s.myRole !== "curator") && r.shows[0]!.days.length > 0);
  const hour = 3_600_000;
  let k = 0;
  const pick = () => {
    const room = candidates[k++ % candidates.length]!;
    const show = room.shows.find((s) => s.myRole !== "curator")!;
    const date = showDates(show, today, isoAddDays(today, 14))[0] ?? isoAddDays(today, 3);
    return { room, show, date };
  };
  const mk = (p: Partial<Ask>, i: number): Ask => {
    const { room, show, date } = pick();
    const plan = show.days[0]!;
    const cur = roster.curators.find((c) => c.id === plan.curatorIds[0]);
    const id = `${date}_${room.id}_${show.id}`;
    return { id, roomId: room.id, showId: show.id, showDate: date, time: show.times[0], curatorId: cur?.id, askOn: today, status: "sent", message: "Hey! Could I get a spot this week? Thanks 🙏", sentAt: now - (i + 1) * 2 * hour, createdAt: now - (i + 3) * 2 * hour, roomName: room.name, showName: show.name, curatorName: cur?.name ?? "Aditya", ...p };
  };
  const asks: Ask[] = [
    mk({ status: "sent" }, 0),
    mk({ status: "sent", lastReply: { text: "will let you know tomorrow", at: now - 40 * 60_000, decision: "unclear" } }, 1),
    mk({ status: "got_it", lastReply: { text: "Yes you're on, 8:30 pm", at: now - 5 * hour, decision: "got_it" }, evidence: { text: "Yes you're on", at: now - 5 * hour } }, 2),
    mk({ status: "got_it", lastReply: { text: "👍", at: now - 9 * hour, decision: "got_it", unsure: true } }, 3),
    mk({ status: "declined", lastReply: { text: "sorry, full this week", at: now - 26 * hour, decision: "declined" } }, 4),
    mk({ status: "no_reply", sentAt: now - 4 * 86_400_000 }, 5),
  ];
  const spots: MySpot[] = [
    ...asks.filter((a) => a.status === "got_it").map((a) => spotFromAsk(a, roster.rooms.find((r) => r.id === a.roomId), a.lastReply?.time, now)),
    { id: "tonight-1", date: today, time: "20:00", roomName: "Bloom Indiranagar", source: "regular", happened: null, status: "booked", createdAt: now },
    { id: "tonight-2", date: today, time: "21:00", roomName: "Banter Comedy Club", source: "group_offer", happened: null, status: "booked", createdAt: now },
    { id: "up-1", date: day(2), time: "19:30", roomName: "Cafe Muziris", source: "adhoc", happened: null, status: "booked", createdAt: now },
    { id: "past-1", date: day(-1), time: "20:00", roomName: "The Local", source: "ask", happened: null, status: "booked", createdAt: now },
    { id: "past-2", date: day(-3), time: "21:00", roomId: candidates[0]!.id, roomName: candidates[0]!.name, source: "ask", happened: true, status: "booked", createdAt: now, notes: { rating: 4, crowd: "Packed, warm, mostly regulars", whatWorked: "The airport callback", whatDidnt: "Opener ran long", room: "Great sound", setList: "Airport\nFlatmate\nCallback" } },
    { id: "past-3", date: day(-7), time: "20:00", roomName: "Bloom Indiranagar", source: "regular", happened: true, status: "booked", createdAt: now, notes: { rating: 5 } },
    { id: "past-4", date: day(-9), time: "22:00", roomName: "Banter Comedy Club", source: "group_offer", happened: false, status: "booked", createdAt: now },
    { id: "past-5", date: day(-22), time: "20:30", roomName: "Glen's Bakehouse", source: "ask", happened: true, status: "booked", createdAt: now, notes: { rating: 3 } },
  ];
  return { asks, spots };
}
