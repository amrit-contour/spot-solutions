// The Day view's middle column: quick actions for the shows on the chosen day, and who is asking for that weekday
// with a Place button each. Everything here reuses the lib functions the Lineup page uses.
import { useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { DAY_NAMES, DAY_SHORT, sentSnapshot, type Show, type SpotRequest } from "@spot/shared";
import { useApp } from "../../lib/app";
import { runCommand } from "../../lib/data";
import { db } from "@spot/ui/firebase";
import { weekdayOf } from "../../lib/calendarDates";
import { addDefaults, placeComic, withSelf } from "../../lib/lineup";
import { answerMicCheck } from "../../lib/updates";
import { BackfillSheet } from "../BackfillSheet";
import { OfferSheet } from "../OfferSheet";
import { Popover } from "@spot/ui";
import { SendUpdatesSheet } from "../SendUpdatesSheet";
import { Avatar, Button, Spinner, cx } from "@spot/ui";
import { IconCheck, IconHistory, IconMic, IconRefresh, IconSend, IconUserPlus } from "@spot/ui";
import { listNames } from "./EventCard";
import { pendingCount, type CalEvent, useCal } from "./shared";

function ActionRow({ icon: I, label, hint, onClick, to, disabled, busy, accent }: { icon: typeof IconMic; label: string; hint?: string; onClick?: () => void; to?: string; disabled?: boolean; busy?: boolean; accent?: boolean }) {
  const cls = cx(
    "state-layer pressable flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-1.5 text-left aria-disabled:pointer-events-none aria-disabled:opacity-40",
    accent ? "bg-primary text-on-primary" : "text-on-surface",
  );
  const body = (
    <>
      {busy ? <Spinner className="size-5 flex-none" /> : <I className={cx("icon size-5 flex-none", !accent && "text-primary")} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate type-label-l">{label}</span>
        {hint && <span className={cx("block truncate type-body-s", accent ? "text-on-primary/80" : "text-on-surface-variant")}>{hint}</span>}
      </span>
    </>
  );
  return to ? (
    <Link to={to} className={cls}>{body}</Link>
  ) : (
    <button type="button" onClick={onClick} disabled={disabled || busy} className={cls}>{body}</button>
  );
}

function ShowActions({ ev, many }: { ev: CalEvent; many: boolean }) {
  const { uid, comicsById, session } = useApp();
  const cal = useCal();
  const { show, lineup, week } = ev;
  const [offer, setOffer] = useState(false);
  const [updates, setUpdates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backfill, setBackfill] = useState(false);
  const off = lineup?.status === "cancelled" || lineup?.status === "canned";
  const past = ev.date < cal.today;
  const full = (lineup?.slots.length ?? 0) >= show.slotCount;
  const pending = pendingCount(ev);
  const mic = past && lineup?.status === "confirmed" && !lineup.outcome ? lineup : null;
  const baseline = lineup?.status === "confirmed" ? (lineup.sent ?? sentSnapshot(lineup.slots, show, lineup.sentAt ?? 0)) : null;

  // Same as Lineup > "Add POCs, regulars and co-hosts": read the group again, then add whoever is missing.
  const addRegulars = async () => {
    setBusy(true);
    try {
      let members = show.groupId && show.groupMembers?.groupId === show.groupId ? show.groupMembers.members : [];
      if (show.groupId) {
        await runCommand(uid, "list_group_members", { showId: show.id }, 3 * 60_000).catch(() => undefined);
        const fresh = (await getDoc(doc(db, "users", uid, "shows", show.id))).data() as Show | undefined;
        if (fresh?.groupMembers?.groupId === show.groupId) members = fresh.groupMembers.members;
      }
      if (show.groupId) members = withSelf(members, session);
      const nameOf = (id: string) => comicsById.get(id)?.name ?? members.find((m) => m.id === id)?.name ?? `+${id.split("@")[0]}`;
      const people = [...new Set([...(show.pocs ?? []), ...(show.regulars ?? []), ...(show.protected ?? []), ...members.filter((m) => m.isAdmin).map((m) => m.id)])];
      const n = await addDefaults(uid, week, show, people.map((id) => ({ id, name: nameOf(id) })));
      toast.success(n ? `Added ${n} to ${show.name}` : "Everyone's already on (or you chose not to go over)");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {many && <p className="px-3 pb-1 type-label-l text-on-surface-variant">{show.name}</p>}
      <ul className="flex flex-col gap-0.5">
        {past && <li><ActionRow icon={IconHistory} label="Record who performed" hint="Past show: only recorded, nobody is messaged" onClick={() => setBackfill(true)} /></li>}
        {mic && <li><ActionRow icon={IconCheck} label="Mark happened" hint="It already took place" onClick={() => answerMicCheck(uid, mic, "happened")} /></li>}
        {!off && !past && pending > 0 && baseline && <li><ActionRow icon={IconSend} label="Send updates" hint={`${pending} change${pending > 1 ? "s" : ""} not told yet`} onClick={() => setUpdates(true)} accent /></li>}
        <li><ActionRow icon={IconMic} label="Open lineup" hint={`${lineup?.slots.length ?? 0}/${show.slotCount} slots filled`} to="/lineup" /></li>
        {!off && !past && <li><ActionRow icon={IconUserPlus} label="Offer a spot" hint={full ? "Lineup is full: asks before going over" : "Ask someone to take a slot"} onClick={() => setOffer(true)} /></li>}
        {!off && !past && <li><ActionRow icon={IconRefresh} label="Add POCs, regulars and co-hosts" hint="Reads the group again, adds anyone missing" onClick={() => void addRegulars()} busy={busy} /></li>}
      </ul>
      <BackfillSheet open={backfill} onClose={() => setBackfill(false)} show={show} week={week} />
      <OfferSheet open={offer} onClose={() => setOffer(false)} show={show} exclude={lineup?.slots.map((s) => s.comicId) ?? []} />
      {lineup && baseline && <SendUpdatesSheet open={updates} onClose={() => setUpdates(false)} show={show} lineup={lineup} baseline={baseline} onSent={() => undefined} />}
    </div>
  );
}

/** Place a request on this day's show (a choice when the day has several). */
function PlaceButton({ r, evs }: { r: SpotRequest; evs: CalEvent[] }) {
  const { uid, shows } = useApp();
  const cal = useCal();
  const [busy, setBusy] = useState(false);
  const open = evs.filter((e) => e.lineup?.status !== "cancelled" && e.lineup?.status !== "canned" && e.date >= cal.today);
  const place = async (ev: CalEvent) => {
    setBusy(true);
    try {
      if (!(await placeComic(uid, ev.week, ev.show, r.comicId, cal.lineups.filter((l) => l.weekOf === ev.week), shows, { name: r.comicName }))) return;
      toast.success(`${r.comicName} placed in ${ev.show.name}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open.length) return null;
  if (open.length === 1)
    return <Button size="sm" variant="tonal" loading={busy} onClick={() => void place(open[0])} aria-label={`Place ${r.comicName} in ${open[0].show.name}`}>Place</Button>;
  return (
    <Popover
      title={`Place ${r.comicName}`}
      width={300}
      trigger={(toggle, isOpen) => <Button size="sm" variant="tonal" loading={busy} aria-haspopup="dialog" aria-expanded={isOpen} onClick={toggle}>Place</Button>}
    >
      {(close) => (
        <ul className="flex flex-col gap-1">
          {open.map((ev) => (
            <li key={ev.key}>
              <button type="button" onClick={() => (close(), void place(ev))} className="state-layer flex min-h-12 w-full items-center gap-2 rounded-md px-3 text-left type-label-l">
                <span className="min-w-0 flex-1 truncate">{ev.show.name}</span>
                <span className="flex-none type-body-s text-on-surface-variant tabular">{ev.lineup?.slots.length ?? 0}/{ev.show.slotCount}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

export function DayActions({ date, wants, anyDay, evs }: { date: string; wants: SpotRequest[]; anyDay: SpotRequest[]; evs: CalEvent[] }) {
  const cal = useCal();
  const wd = weekdayOf(date);
  const placed = new Set(evs.flatMap((e) => e.lineup?.slots.map((s) => s.comicId) ?? []));
  const waiting = wants.filter((r) => !placed.has(r.comicId));
  const canPlace = evs.some((e) => e.date >= cal.today);
  return (
    <>
      {evs.length > 0 && (
        <section aria-labelledby="day-actions" className="rounded-lg bg-surface-low p-2">
          <h2 id="day-actions" className="px-3 pt-2 pb-1 type-title-m">Quick actions</h2>
          <div className="flex flex-col gap-2">
            {evs.map((ev) => <ShowActions key={ev.key} ev={ev} many={evs.length > 1} />)}
          </div>
        </section>
      )}

      <section aria-labelledby="day-asking">
        <h2 id="day-asking" className="mb-2 type-title-m">Asking for {DAY_NAMES[wd]}</h2>
        {waiting.length === 0 && anyDay.length === 0 ? (
          <p className="type-body-m text-on-surface-variant">{evs.length ? "Nobody is waiting for this day." : `Nobody has asked for ${DAY_NAMES[wd]}.`}</p>
        ) : (
          <>
            {waiting.length > 0 && (
              <ul className="flex flex-col">
                {waiting.map((r) => (
                  <li key={r.id} className="flex min-h-12 items-center gap-3 border-b border-outline-variant/40 py-1 last:border-b-0">
                    <Avatar name={r.comicName} size={32} tone="secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate type-body-m">{r.comicName}</span>
                      <span className="block type-label-s text-on-surface-variant">{r.intent.preferredDays.map((x) => DAY_SHORT[x]).join(" · ")}</span>
                    </span>
                    {canPlace && <PlaceButton r={r} evs={evs} />}
                  </li>
                ))}
              </ul>
            )}
            {anyDay.length > 0 && (
              <p className={cx("type-body-m text-on-surface-variant", waiting.length > 0 && "mt-2")}>
                {anyDay.length} open to any day: {listNames(anyDay.map((r) => r.comicName), 4)}.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
