// Pills on a request card: what the app knows (solid) and what Gemma read from the message (dashed).
import { motion } from "motion/react";
import { INTENT_TAG_LABEL, type FactTagId, type IntentTag, type Comic, type SpotRequest, type Show, factTags } from "@spot/shared";
import { Chip } from "./ui";
import { IconCrown, IconFlag, IconGroup, IconHistory, IconLightbulb, IconMap, IconMic, IconRepeat, IconStopwatch, IconSuitcase, IconUserPlus, IconCalendar, IconClock } from "./icons";

type Icon = typeof IconMic;

const FACT_ICON: Record<FactTagId, Icon> = {
  new_to_you: IconUserPlus,
  performed_last_week: IconHistory,
  regular: IconRepeat,
  co_host: IconCrown,
  spots: IconMic,
};

const READING_ICON: Record<IntentTag, Icon> = {
  new_material: IconLightbulb,
  flexible_days: IconCalendar,
  specific_time: IconClock,
  longer_set: IconStopwatch,
  travelling: IconSuitcase,
  bringing_audience: IconGroup,
  first_time_here: IconFlag,
};

export interface Pill {
  key: string;
  label: string;
  icon: Icon;
  kind: "fact" | "reading";
}

/** App facts first, then the venue (only when it isn't implied), then Gemma's tags. */
export function requestPills(args: { r: SpotRequest; comic?: Comic; shows: Show[]; today: string; venueName?: string }): Pill[] {
  const { r, comic, shows, today, venueName } = args;
  const facts = factTags({ comic, shows, week: r.weekOf, today, firstContact: r.firstContact, priorRequests: r.priorRequests });
  return [
    ...facts.map((f): Pill => ({ key: f.id, label: f.label, icon: FACT_ICON[f.id], kind: "fact" })),
    ...(venueName ? [{ key: "venue", label: venueName, icon: IconMap, kind: "reading" } satisfies Pill] : []),
    ...(r.intent.tags ?? []).map((t): Pill => ({ key: t, label: INTENT_TAG_LABEL[t] ?? t, icon: READING_ICON[t] ?? IconLightbulb, kind: "reading" })),
  ];
}

export function RequestPills({ pills }: { pills: Pill[] }) {
  if (!pills.length) return null;
  return (
    <>
      {pills.map((p, i) => (
        <motion.span
          key={p.key}
          layout
          className="inline-flex max-w-full"
          initial={{ opacity: 0, transform: "scale(0.92)" }}
          animate={{ opacity: 1, transform: "scale(1)" }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1], delay: Math.min(i, 6) * 0.03 }}
        >
          <Chip tone={p.kind === "fact" ? "fact" : "reading"} icon={p.icon} className="max-w-full">
            <span className="truncate">{p.label}</span>
          </Chip>
        </motion.span>
      ))}
    </>
  );
}
