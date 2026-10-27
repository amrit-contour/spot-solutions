// "Add a past spot" from a comic's profile: pick a show and one of its past dates, say regular or ad hoc. Recorded only.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DAY_NAMES, dateInWeek, formatDate, localNow, weekOfDate, type Comic, type SpotKind } from "@spot/shared";
import { useApp } from "../lib/app";
import { backfillAdd } from "../lib/backfill";
import { PAST_SHOW_NOTE } from "./BackfillSheet";
import { Button, Segmented, Select, Sheet } from "@spot/ui";
import { IconHistory } from "@spot/ui";

export function PastSpotSheet({ open, onClose, comic }: { open: boolean; onClose: () => void; comic: Comic }) {
  const { uid, shows, settings } = useApp();
  const list = shows.filter((s) => s.active);
  const [showId, setShowId] = useState("");
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<SpotKind>("regular");
  const [busy, setBusy] = useState(false);
  const show = list.find((s) => s.id === showId) ?? list[0];
  const today = localNow(new Date(), settings.timezone).date;
  // The last 12 times this show ran, newest first.
  const dates = useMemo(() => {
    if (!show) return [];
    const out: string[] = [];
    const monday = weekOfDate(today);
    for (let i = 0; i < 14 && out.length < 12; i++) {
      const d = new Date(`${monday}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 7 * i);
      const date = dateInWeek(d.toISOString().slice(0, 10), show.weekday);
      if (date < today) out.push(date);
    }
    return out;
  }, [show, today]);
  const chosen = dates.includes(date) ? date : dates[0];
  const save = async () => {
    if (!show || !chosen) return;
    setBusy(true);
    try {
      await backfillAdd(uid, weekOfDate(chosen), show, shows, comic.id, kind);
      toast.success(`${comic.name.split(" ")[0]} recorded on ${show.name}, ${formatDate(chosen)}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add a past spot" footer={<><Button variant="text" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!show || !chosen} onClick={save}>Record spot</Button></>}>
      <p role="note" className="flex items-start gap-2 rounded-lg bg-tertiary-container px-3 py-2 type-body-s text-on-tertiary-container">
        <IconHistory className="icon mt-0.5 size-4 flex-none" />
        <span>{PAST_SHOW_NOTE}</span>
      </p>
      {!show ? (
        <p className="mt-4 type-body-m text-on-surface-variant">Add a show first.</p>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="type-label-l text-on-surface-variant">Show</span>
            <Select label="Show" value={show.id} onChange={setShowId} options={list.map((s) => ({ value: s.id, label: `${s.name} · ${DAY_NAMES[s.weekday]}` }))} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="type-label-l text-on-surface-variant">Date</span>
            <Select label="Date" value={chosen ?? ""} onChange={setDate} options={dates.map((d) => ({ value: d, label: `${DAY_NAMES[show.weekday]} ${formatDate(d)}` }))} />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="type-label-l text-on-surface-variant">Was it a regular spot or ad hoc?</span>
            <Segmented value={kind} onChange={setKind} options={[{ value: "regular", label: "Regular" }, { value: "adhoc", label: "Ad hoc" }]} />
            <span className="type-body-s text-on-surface-variant">Regular spots count toward the cooldown. Ad hoc spots never do. Both stay in their history.</span>
          </div>
        </div>
      )}
    </Sheet>
  );
}
