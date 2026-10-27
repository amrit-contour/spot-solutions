import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { applyPush, describeChanges, planPush, publishedRosterId, toSharedRoster, type Roster } from "@spot/shared";
import { Button, Field, IconShield, Select, Sheet, TextInput } from "@spot/ui";
import { useRoster } from "../../lib/roster";
import { StaleRosterError, pushRoster, usePublishedRosters } from "../../lib/rosters";
import { ChangeList, defaultPicks } from "./ChangeList";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const NEW = "";

/**
 * Publishers only: push my rooms to my published roster (or start one). The publisher sees what the push changes in the published
 * roster, picks what to send, and writes a line for the changelog. Rooms outside the roster's city are left out.
 */
export function PublishSheet({ open, onClose, user, initialId }: { open: boolean; onClose: () => void; user: User; /** Update this roster (from its own page). */ initialId?: string }) {
  const store = useRoster();
  const nav = useNavigate();
  const all = usePublishedRosters();
  const mine = useMemo(() => all.data.filter((r) => r.ownerUid === user.uid), [all.data, user.uid]);
  const [target, setTarget] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [city, setCity] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Pick sensible defaults once the sheet opens: update my only roster, or start one in the city I have most rooms in.
  const topCity = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of store.rooms) if (r.city) n.set(r.city, (n.get(r.city) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }, [store.rooms]);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTarget(initialId ?? null);
      setNote("");
      setTitle("");
      setCity(topCity);
    }
  }
  const chosenId = target ?? (mine.length === 1 ? mine[0]!.id : NEW);
  const current = mine.find((r) => r.id === chosenId) ?? null;
  const cityName = current ? current.city : city;

  const myRoster = useMemo<Roster>(() => ({ rooms: store.rooms.filter((r) => same(r.city, cityName)), curators: store.curators }), [store.rooms, store.curators, cityName]);
  const published = current ? toSharedRoster(current) : null;
  const changes = useMemo(() => planPush(published, myRoster), [published, myRoster]);
  // New list of changes: start with the default ticks.
  const [seenKey, setSeenKey] = useState("");
  const key = `${chosenId}|${cityName}|${changes.map((c) => c.id).join(",")}`;
  if (key !== seenKey) {
    setSeenKey(key);
    setPicked(defaultPicks(changes));
  }

  const roomsHere = myRoster.rooms.length;
  const titleText = current ? current.title : title.trim();
  const problem = !cityName.trim() ? "Say which city this roster is for." : !titleText ? "Give the roster a title." : roomsHere === 0 ? `You have no rooms in ${cityName} to publish.` : "";

  const publish = async () => {
    if (problem) return toast.error(problem);
    setBusy(true);
    try {
      const id = current?.id ?? publishedRosterId(titleText, all.data.map((r) => r.id));
      const next = applyPush(published, myRoster, picked);
      const v = await pushRoster({ id, basedOn: current?.version ?? null, next, changes, picked: [...picked], title: titleText, city: cityName, user, note });
      toast.success(`Published version ${v}`);
      onClose();
      nav(`/rosters/${id}`);
    } catch (e) {
      toast.error(e instanceof StaleRosterError ? "This roster changed while you were reviewing. Close this and try again." : "Couldn't publish. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const nothing = current && changes.length === 0;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      wide
      title="Publish your rooms"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void publish()} loading={busy} disabled={Boolean(problem) || Boolean(nothing) || (changes.length > 0 && picked.size === 0)}>
            {current ? "Publish update" : "Publish"}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        <p className="type-body-l text-on-surface-variant">
          Send your rooms to a community roster other comics can follow. Only what is public in a roster goes: venues, shows, days, ask windows and curators. Your notes, your role and your spots stay private.
        </p>
        <div className="flex items-start gap-3 rounded-md bg-tertiary-container p-4 text-on-tertiary-container">
          <IconShield aria-hidden className="icon mt-0.5 size-5 flex-none" />
          <p className="min-w-0 type-body-m">Curator phone numbers are part of a roster. They are only visible to signed-in, approved members of the app, never on the open web.</p>
        </div>

        {mine.length > 0 && (
          <Field label="Which roster">
            <Select
              label="Which roster"
              value={chosenId}
              onChange={(v) => setTarget(v)}
              options={[...mine.map((r) => ({ value: r.id, label: `Update ${r.title}` })), { value: NEW, label: "Start a new roster" }]}
            />
          </Field>
        )}
        {!current && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <Field label="Title" hint="What people will search for.">
              <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bangalore Scene" maxLength={60} />
            </Field>
            <Field label="City" hint="Only your rooms in this city go in.">
              <TextInput value={city} onChange={(e) => setCity(e.target.value)} placeholder="Bengaluru" maxLength={40} />
            </Field>
          </div>
        )}

        <p className="type-title-s" aria-live="polite">
          {roomsHere} of your {store.rooms.length} room{store.rooms.length === 1 ? "" : "s"} {roomsHere === 1 ? "is" : "are"} in {cityName || "that city"}.
        </p>
        {problem && roomsHere === 0 && cityName ? <p role="alert" className="rounded-md bg-error-container p-4 type-body-m text-on-error-container">{problem}</p> : null}

        {nothing ? (
          <p className="rounded-md bg-surface-container p-4 type-body-m">Nothing to publish. {current!.title} already matches your rooms.</p>
        ) : changes.length > 0 ? (
          <>
            <p className="type-body-l text-on-surface-variant">
              {current ? "Here is what this changes in the published roster." : "These rooms will be published."} Untick anything you want to leave out.
            </p>
            <ChangeList changes={changes} picked={picked} onPick={setPicked} verb={current ? "Added" : "New"} />
            <Field label="What changed (shown to followers)" hint={`Left empty it says: ${describeChanges(changes.filter((c) => picked.has(c.id)))}`}>
              <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Added the new Saturday mics" maxLength={140} />
            </Field>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
