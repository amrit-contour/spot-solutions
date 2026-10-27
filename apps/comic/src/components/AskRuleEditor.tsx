import { DAY_NAMES, WEEK_ORDER, type AskRule, type AskRuleKind } from "@spot/shared";
import { Field, Select, TextInput } from "@spot/ui";
import { ToggleRow } from "./ui";

const KINDS: { value: AskRuleKind | ""; label: string }[] = [
  { value: "same_day", label: "On the day" },
  { value: "day_before", label: "The day before" },
  { value: "weekday", label: "On a set weekday" },
  { value: "start_of_week", label: "At the start of the week" },
  { value: "start_of_month", label: "At the start of the month" },
  { value: "they_reach_out", label: "They reach out" },
  { value: "fcfs", label: "First come, first served (a note)" },
  { value: "walk_in", label: "Walk in (a note)" },
  { value: "website", label: "Register on a website (a note)" },
  { value: "instagram", label: "Ask on Instagram (a note)" },
];

const DAY_OPTIONS = WEEK_ORDER.map((d) => ({ value: String(d), label: d === 0 ? `${DAY_NAMES[d]} (the one before the week)` : DAY_NAMES[d] }));

const fresh = (kind: AskRuleKind, keep?: AskRule): AskRule => {
  const note = keep?.note;
  switch (kind) {
    case "weekday": return { kind, day: 1, ...(note ? { note } : {}) };
    case "start_of_week": return { kind, day: 1, ...(note ? { note } : {}) };
    default: return { kind, ...(note ? { note } : {}) } as AskRule;
  }
};

/**
 * When to ask. `emptyLabel` is what "no rule" means here: "No rule" for a show, "Same as the show" for one day.
 * The last four options are notes, not pings: the app never messages anyone for them.
 */
export function AskRuleEditor({ value, onChange, emptyLabel = "No rule" }: { value: AskRule | undefined; onChange: (r: AskRule | undefined) => void; emptyLabel?: string }) {
  const hasMorning = value && (value.kind === "same_day" || value.kind === "day_before" || value.kind === "weekday");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Select
        label="When to ask"
        value={value?.kind ?? ""}
        onChange={(k) => onChange(k === "" ? undefined : fresh(k as AskRuleKind, value))}
        options={[{ value: "", label: emptyLabel }, ...KINDS.map((k) => ({ value: k.value as string, label: k.label }))]}
      />
      {value && (value.kind === "weekday" || value.kind === "start_of_week") && (
        <Field label={value.kind === "weekday" ? "Which weekday" : "Which day of that week"}>
          <Select label="Weekday" value={String(value.day ?? 1)} onChange={(d) => onChange({ ...value, day: Number(d) as 0 })} options={DAY_OPTIONS} />
        </Field>
      )}
      {hasMorning && <ToggleRow label="Best in the morning" checked={Boolean(value.morning)} onChange={(m) => onChange({ ...value, morning: m || undefined } as AskRule)} />}
      {value && (
        <Field label="Note (optional)">
          <TextInput value={value.note ?? ""} onChange={(e) => onChange({ ...value, note: e.target.value || undefined })} placeholder="DM before 11 AM" maxLength={140} />
        </Field>
      )}
    </div>
  );
}
