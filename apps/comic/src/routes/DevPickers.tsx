// Dev only (/dev/pickers): date/time inputs and the searchable pickers on fake data, for checking them on a phone-sized screen.
import { useState } from "react";
import { Avatar, Button, Field, PageHeader, SearchSelect, Sheet, TextInput } from "@spot/ui";

const NAMES = ["Laugh Factory", "The Comedy Club", "Bengaluru Standup", "Humor Me", "Open Mic Mondays", "Kannada Comics", "Indiranagar Mic", "Koramangala Crew", "Whitefield Wits", "Jayanagar Jokes"];
const GROUPS = Array.from({ length: 160 }, (_, i) => ({ value: `g${i}`, label: `${NAMES[i % NAMES.length]} ${Math.floor(i / NAMES.length) + 1}`, hint: `${20 + ((i * 7) % 180)} members` }));
const BIG = Array.from({ length: 450 }, (_, i) => ({ value: `b${i}`, label: `Venue ${String(i + 1).padStart(3, "0")}`, hint: `Area ${i % 9}` }));

function Fields() {
  const [g, setG] = useState("g3");
  const [c, setC] = useState("");
  const [b, setB] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <Field label="Start date" htmlFor="d1"><TextInput id="d1" type="date" defaultValue="2026-11-03" /></Field>
      <Field label="End date (empty)" htmlFor="d2"><TextInput id="d2" type="date" /></Field>
      <Field label="Ask from" htmlFor="d3"><TextInput id="d3" type="time" step={900} defaultValue="09:30" /></Field>
      <Field label="Starts at" htmlFor="d4"><TextInput id="d4" type="datetime-local" defaultValue="2026-11-03T20:00" /></Field>
      <Field label="Show group"><SearchSelect label="Show group" value={g} onChange={setG} noneLabel="No group" searchPlaceholder="Search your groups" options={GROUPS} renderOption={(o) => (o.value ? <Avatar name={o.label} size={32} tone="tertiary" /> : null)} /></Field>
      <Field label="Curator"><SearchSelect label="Curator" value={c} onChange={setC} placeholder="Pick a curator" options={GROUPS.slice(0, 40).map((x) => ({ ...x, label: `Curator ${x.label}` }))} /></Field>
      <Field label="Venue (450)"><SearchSelect label="Venue" value={b} onChange={setB} placeholder="Pick a venue" options={BIG} /></Field>
    </div>
  );
}

export function DevPickers() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader width="narrow" title="Pickers" />
      <div className="mx-auto w-full max-w-xl px-4 pb-10">
        <Fields />
        <div className="mt-6"><Button onClick={() => setOpen(true)}>Open in a sheet</Button></div>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title="Add show"><Fields /></Sheet>
    </>
  );
}
