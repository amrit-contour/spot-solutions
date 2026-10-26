import { formatDate, shiftWeek, dateInWeek } from "@spot/shared";
import { useApp } from "../lib/app";
import { IconArrowLeft, IconArrowRight } from "./icons";
import { IconButton, cx } from "./ui";

export function WeekSwitcher() {
  const { week, setWeek, currentWeek } = useApp();
  const label = week === currentWeek ? "This week" : week === shiftWeek(currentWeek, -1) ? "Last week" : week === shiftWeek(currentWeek, 1) ? "Next week" : "Week of";
  return (
    <div className="inline-flex flex-none items-center gap-0.5 rounded-full bg-surface-container p-1 sm:gap-1">
      <IconButton icon={IconArrowLeft} label="Previous week" onClick={() => setWeek(shiftWeek(week, -1))} className="size-8" />
      <button
        onClick={() => setWeek(currentWeek)}
        className={cx("state-layer rounded-full px-2 py-1 text-center sm:px-3 sm:text-left", week !== currentWeek && "text-primary")}
        title="Jump to this week"
      >
        {/* Phones: just the week's start, so it fits next to the page title. */}
        <span className="block type-label-s text-on-surface-variant max-sm:hidden">{label}</span>
        <span className="block type-label-l whitespace-nowrap tabular">
          {formatDate(week)}
          <span className="max-sm:hidden"> – {formatDate(dateInWeek(week, 0))}</span>
        </span>
      </button>
      <IconButton icon={IconArrowRight} label="Next week" onClick={() => setWeek(shiftWeek(week, 1))} className="size-8" />
    </div>
  );
}
