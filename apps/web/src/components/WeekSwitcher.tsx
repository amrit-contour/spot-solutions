import { formatDate, shiftWeek, dateInWeek } from "@spot/shared";
import { useApp } from "../lib/app";
import { IconArrowLeft, IconArrowRight } from "./icons";
import { IconButton, cx } from "./ui";

export function WeekSwitcher() {
  const { week, setWeek, currentWeek } = useApp();
  const label = week === currentWeek ? "This week" : week === shiftWeek(currentWeek, -1) ? "Last week" : week === shiftWeek(currentWeek, 1) ? "Next week" : "Week of";
  return (
    <div className="flex w-full items-center justify-between gap-1 rounded-full bg-surface-container p-1 sm:inline-flex sm:w-auto">
      <IconButton icon={IconArrowLeft} label="Previous week" onClick={() => setWeek(shiftWeek(week, -1))} className="size-8" />
      <button
        onClick={() => setWeek(currentWeek)}
        className={cx("state-layer rounded-full px-3 py-1 text-center sm:text-left", week !== currentWeek && "text-primary")}
        title="Jump to this week"
      >
        <span className="block type-label-s text-on-surface-variant">{label}</span>
        <span className="block type-label-l tabular">
          {formatDate(week)} – {formatDate(dateInWeek(week, 0))}
        </span>
      </button>
      <IconButton icon={IconArrowRight} label="Next week" onClick={() => setWeek(shiftWeek(week, 1))} className="size-8" />
    </div>
  );
}
