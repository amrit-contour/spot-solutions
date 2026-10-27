import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { clashingIds, spotClashes, spotStats, spotsByDay, type MySpot } from "@spot/shared";
import { CompactButton, Empty, IconAdd, IconMic, IconRepeat, PageHeader, Segmented, Spinner } from "@spot/ui";
import { useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { monthLabel, shortDate } from "../lib/time";
import { SpotCard } from "../components/SpotCards";
import { SpotEditor } from "../components/SpotEditor";
import { blankSpot } from "../lib/newSpot";
import { SpotStatsHeader } from "../components/SpotStats";
import { useAllSpots, useSpotActions } from "../lib/regulars";

type Tab = "coming" | "past";

const DAY_NUM = (d: string) => String(Number(d.slice(8, 10)));
const WEEKDAY = (d: string) => shortDate(d).slice(0, 3);

/** My spots: a calendar-style list of everything booked and done, with numbers on top and notes on each. */
export function MySpots() {
  const store = useAsks();
  const now = useNowMs(60_000);
  const { today } = useAskPlan(now);
  const [tab, setTab] = useState<Tab>("coming");
  const [editing, setEditing] = useState<MySpot | null>(null);
  const all = useAllSpots(today); // stored spots plus the regulars' occurrences
  const act = useSpotActions();

  const stats = useMemo(() => spotStats(all, store.asks, today), [all, store.asks, today]);
  const clashes = useMemo(() => clashingIds(all), [all]);
  const live = all.filter((s) => s.status !== "cancelled");
  const coming = useMemo(() => spotsByDay(live.filter((s) => s.date >= today && s.happened !== false)), [live, today]);
  const toCheck = useMemo(() => live.filter((s) => s.date < today && s.happened == null), [live, today]);
  const past = useMemo(() => spotsByDay(live.filter((s) => s.date < today && s.happened != null), true), [live, today]);
  const toCheckDays = useMemo(() => spotsByDay(toCheck, true), [toCheck]);

  const mark = (s: MySpot, happened: boolean) =>
    act.mark(s, happened).then(
      () => toast.success(happened ? "Marked as done. Add notes while it's fresh." : "Marked as didn't happen."),
      () => toast.error("Couldn't save that. Try again."),
    );

  const days = tab === "coming" ? coming : [...toCheckDays, ...past];
  return (
    <div className="w-full">
      <PageHeader
        title="My spots"
        subtitle="Everything you're booked for, and how it went."
        actions={
          <>
            <Link to="/spots/regulars" aria-label="Regular spots" className="state-layer pressable grid size-11 place-items-center rounded-full text-primary"><IconRepeat className="icon size-5" /></Link>
            <CompactButton icon={IconAdd} label="Add a spot" variant="filled" onClick={() => setEditing(blankSpot(today))} />
          </>
        }
        bar={
          <Segmented
            full
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "coming", label: "Coming up" },
              { value: "past", label: `Past${toCheck.length ? ` · ${toCheck.length} to check` : ""}` },
            ]}
          />
        }
      />
      <div className="flex min-w-0 flex-col gap-6 px-4 pt-3 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        {store.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : (
          <>
            <SpotStatsHeader stats={stats} />
            {tab === "coming" && toCheck.length > 0 && (
              <button onClick={() => setTab("past")} className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-secondary-container p-4 text-left text-on-secondary-container">
                <span className="min-w-0 flex-1 type-title-s">{toCheck.length === 1 ? "1 spot to check: did it happen?" : `${toCheck.length} spots to check: did they happen?`}</span>
                <span className="type-label-l">See</span>
              </button>
            )}
            {days.length === 0 ? (
              <Empty icon={IconMic} title={tab === "coming" ? "No spots booked" : "No past spots yet"} action={tab === "coming" ? <CompactButton icon={IconAdd} label="Add a spot" variant="filled" size="md" onClick={() => setEditing(blankSpot(today))} /> : undefined}>
                {tab === "coming" ? "When a curator says yes to an ask, the spot lands here. You can add one by hand too, like a spot you got in person." : "Spots you've done will list here, with your notes and ratings."}
              </Empty>
            ) : (
              <div className="flex min-w-0 flex-col gap-5">
                {days.map((d, i) => {
                  const month = d.date.slice(0, 7);
                  const newMonth = i === 0 || days[i - 1]!.date.slice(0, 7) !== month;
                  return (
                    <section key={d.date} aria-label={shortDate(d.date)} className="min-w-0">
                      {newMonth && <h2 className="mb-3 type-title-m text-on-surface-variant">{monthLabel(d.date)}</h2>}
                      <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-3">
                        <div className="pt-3 text-center" aria-hidden>
                          <p className={`type-label-m ${d.date === today ? "text-primary" : "text-on-surface-variant"}`}>{WEEKDAY(d.date)}</p>
                          <p className={`type-headline-s tabular ${d.date === today ? "text-primary" : ""}`}>{DAY_NUM(d.date)}</p>
                        </div>
                        <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5">
                          {d.spots.map((s) => (
                            <li key={s.id} className="min-w-0">
                              <SpotCard spot={s} today={today} clash={clashes.has(s.id) ? spotClashes(all, s) : undefined} onOpen={() => setEditing(s)} onMark={(h) => void mark(s, h)} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
      <SpotEditor value={editing} onClose={() => setEditing(null)} today={today} />
    </div>
  );
}

