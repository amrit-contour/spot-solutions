import type { SpotStats as Stats } from "@spot/shared";

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-surface-low p-4">
      <p className="truncate type-label-l text-on-surface-variant">{label}</p>
      <p className="type-headline-m tabular">{value}</p>
      <p className="h-4 truncate type-body-s text-on-surface-variant">{sub}</p>
    </div>
  );
}

/** The numbers at the top of My spots: this week and month, asks sent against got it, and where the spots were. */
export function SpotStatsHeader({ stats }: { stats: Stats }) {
  const a = stats.asks;
  return (
    <section aria-label="Your numbers" className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="This week" value={stats.doneWeek} sub={stats.bookedWeek ? `${stats.bookedWeek} still to come` : "done"} />
        <Tile label="This month" value={stats.doneMonth} sub={stats.done === stats.doneMonth ? "done" : `${stats.done} in all`} />
        <Tile label="Asks sent" value={a.sent} sub={a.sent ? `${a.gotIt} got it${a.waiting ? `, ${a.waiting} waiting` : ""}` : "none yet"} />
        <Tile label="Average rating" value={stats.avgRating === null ? "None" : `${stats.avgRating} of 5`} sub={stats.toCheck ? `${stats.toCheck} to check` : undefined} />
      </div>
      {stats.byRoom.length > 0 && (
        <div className="min-w-0">
          <p className="mb-2 px-1 type-title-s">By room</p>
          <ul className="flex min-w-0 flex-wrap gap-1.5">
            {stats.byRoom.slice(0, 8).map((r) => (
              <li key={r.roomId ?? r.roomName} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-sm bg-surface-high px-2.5 type-label-m">
                <span className="min-w-0 truncate">{r.roomName}</span>
                <span className="tabular text-primary">{r.count}</span>
              </li>
            ))}
            {stats.byRoom.length > 8 && <li className="inline-flex h-7 items-center px-1 type-label-m text-on-surface-variant">+{stats.byRoom.length - 8} more</li>}
          </ul>
        </div>
      )}
    </section>
  );
}
