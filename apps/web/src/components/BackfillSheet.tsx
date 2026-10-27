// Record who actually performed on a show that has already happened. Only history is written: nothing is sent, no
// WhatsApp group changes, no offer, no confirmation, no scheduled post. Cooldowns, "performed last week" badges, comic
// stats and the week's requests stay right. The worker never acts on a lineup marked `backfilled` (see lib/backfill.ts).
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DAY_NAMES, dateInWeek, formatDate, formatTime, kindOfSlot, lineupId, type Lineup, type Show, type SpotKind } from "@spot/shared";
import { useApp } from "../lib/app";
import { useDocument } from "../lib/data";
import { backfillAdd, backfillOutcome, backfillRemove } from "../lib/backfill";
import { Avatar, Button, Segmented, Sheet, TextInput } from "@spot/ui";
import { IconClose, IconHistory } from "@spot/ui";
import { IconButton } from "@spot/ui";

export const PAST_SHOW_NOTE = "Past show · changes are only recorded, nobody is messaged";

const KIND_OPTIONS: { value: SpotKind; label: string }[] = [
  { value: "regular", label: "Regular" },
  { value: "adhoc", label: "Ad hoc" },
];

export function BackfillSheet({ open, onClose, show, week }: { open: boolean; onClose: () => void; show: Show; week: string }) {
  const { uid, comics, comicsById, shows, settings } = useApp();
  const lineup = useDocument<Lineup>(open ? ["users", uid, "lineups", lineupId(week, show.id)] : null).data;
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const date = dateInWeek(week, show.weekday);
  const slots = lineup?.slots ?? [];
  const on = new Set(slots.map((s) => s.comicId));
  const off = lineup?.status === "canned" || lineup?.status === "cancelled";
  const outcome: "happened" | "canned" | null = lineup?.outcome ?? (off ? "canned" : lineup?.backfilled || lineup?.status === "confirmed" ? "happened" : null);
  const nameOf = (id: string) => comicsById.get(id)?.name ?? `+${id.split("@")[0]}`;

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return comics
      .filter((c) => !on.has(c.id) && (!needle || c.name.toLowerCase().includes(needle)))
      .sort((a, b) => (b.history?.[0]?.date ?? "").localeCompare(a.history?.[0]?.date ?? "") || a.name.localeCompare(b.name))
      .slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comics, q, slots.length]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const add = (id: string, kind: SpotKind) => run(`add:${id}`, () => backfillAdd(uid, week, show, shows, id, kind), `${nameOf(id).split(" ")[0]} recorded on ${show.name}`);

  return (
    <Sheet open={open} onClose={onClose} title="Past show" footer={<Button onClick={onClose}>Done</Button>}>
      <p role="note" className="flex items-start gap-2 rounded-lg bg-tertiary-container px-3 py-2 type-body-s text-on-tertiary-container">
        <IconHistory className="icon mt-0.5 size-4 flex-none" />
        <span>{PAST_SHOW_NOTE}</span>
      </p>
      <div className="mt-4">
        <h2 className="type-title-l">{show.name}</h2>
        <p className="type-body-m text-on-surface-variant">
          {DAY_NAMES[show.weekday]} {formatDate(date)} · {formatTime(show.startTime)}
        </p>
      </div>

      <section className="mt-5 flex flex-col gap-3 rounded-lg bg-surface-container p-3">
        <span className="min-w-0">
          <span className="block type-body-m">Did it happen?</span>
          <span className="block type-body-s text-on-surface-variant">{outcome ? "" : "Not marked yet. "}Didn't happen means it counts for nobody.</span>
        </span>
        <Segmented
          full
          size="sm"
          value={outcome ?? ""}
          onChange={(v) => void run("outcome", () => backfillOutcome(uid, week, show, shows, v === "happened" ? "happened" : "canned"))}
          options={[
            { value: "happened", label: "Happened" },
            { value: "canned", label: "Didn't happen" },
          ]}
        />
      </section>

      <section className="mt-5" aria-label="Who performed">
        <h3 className="type-title-s">Performed ({slots.length})</h3>
        <p className="type-body-s text-on-surface-variant">Regular spots count toward the cooldown. Ad hoc spots never do. Both stay in their history.</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {slots.map((s) => (
            <li key={s.comicId} className="flex flex-col gap-2 rounded-md bg-surface-container py-2 pr-1 pl-3">
              <div className="flex items-center gap-3">
                <Avatar name={nameOf(s.comicId)} size={32} />
                <span className="min-w-0 flex-1 truncate type-title-s">{nameOf(s.comicId)}</span>
                <IconButton icon={IconClose} label={`Remove ${nameOf(s.comicId)}`} onClick={() => void run(`rm:${s.comicId}`, () => backfillRemove(uid, week, show, shows, s.comicId))} className="size-9" />
              </div>
              <div className="pr-2">
                <Segmented full size="sm" value={kindOfSlot(s)} onChange={(k) => void run(`kind:${s.comicId}`, () => backfillAdd(uid, week, show, shows, s.comicId, k))} options={KIND_OPTIONS} />
              </div>
            </li>
          ))}
          {!slots.length && <li className="rounded-md border border-dashed border-outline-variant px-4 py-6 text-center type-body-s text-on-surface-variant">Nobody recorded yet. Add who performed below.</li>}
        </ul>
      </section>

      <section className="mt-6" aria-label="Add a comic">
        <h3 className="type-title-s">Add who performed</h3>
        <TextInput className="mt-2" placeholder="Search comics" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="mt-2 flex flex-col overflow-hidden rounded-md bg-surface-container">
          {list.map((c) => (
            <li key={c.id} className="flex min-h-12 items-center gap-3 px-3 py-1.5">
              <Avatar name={c.name} size={28} />
              <span className="min-w-0 flex-1 truncate type-body-l">{c.name}</span>
              {c.history?.[0] && <span className="hidden type-label-s text-on-surface-variant sm:inline">{formatDate(c.history[0].date)}</span>}
              <span className="flex flex-none gap-1" role="group" aria-label={`Add ${c.name} as`}>
                {KIND_OPTIONS.map((k) => (
                  <Button key={k.value} size="sm" variant={k.value === "regular" ? "tonal" : "text"} loading={busy === `add:${c.id}`} disabled={Boolean(busy)} onClick={() => void add(c.id, k.value)} aria-label={`Add ${c.name} as ${k.label}`}>
                    {k.label}
                  </Button>
                ))}
              </span>
            </li>
          ))}
          {!list.length && <li className="px-3 py-4 type-body-s text-on-surface-variant">No one matches.</li>}
        </ul>
        <p className="mt-2 type-body-s text-on-surface-variant">
          {settings.rules.skipLastWeek ? "A regular spot holds them back for the cooldown." : "The cooldown is off in Settings, so this is just for your records."}
        </p>
      </section>
    </Sheet>
  );
}
