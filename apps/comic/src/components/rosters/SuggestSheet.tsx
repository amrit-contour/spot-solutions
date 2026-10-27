import { useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { toSharedRoster, type PublishedRosterDoc, type RoomShared, type SuggestionDraft } from "@spot/shared";
import { Button, Field, IconMic, IconPen, IconSearch, IconTrash, IconUserCheck, IconPlus, IconClock, Sheet, TextArea, type Icon } from "@spot/ui";
import { sendSuggestion } from "../../lib/rosters";
import { IconTile, ListGroup, ListRow, Notice } from "../ui";
import { AddRoomForm, AddShowForm, CuratorFieldForm, DayForm, RemoveRoomForm, RemoveShowForm, RoomFieldForm, ShowFieldForm, type OnDraft } from "./SuggestForms";

type Kind = "room" | "show" | "day" | "curator" | "addShow" | "removeShow" | "removeRoom" | "addRoom";

const OPTIONS: { kind: Kind; icon: Icon; title: string; text: string; needsShow?: boolean }[] = [
  { kind: "day", icon: IconUserCheck, title: "Who curates a day", text: "A curator moved, or a day is missing.", needsShow: true },
  { kind: "show", icon: IconClock, title: "Times or when to ask", text: "Start times, ask window, name, how often.", needsShow: true },
  { kind: "room", icon: IconPen, title: "A detail of the room", text: "Name, area, tags, other ways to ask, limits." },
  { kind: "curator", icon: IconSearch, title: "A curator's number", text: "A wrong or new number or Instagram handle." },
  { kind: "addShow", icon: IconPlus, title: "Add a show", text: "A mic or show this room is missing." },
  { kind: "removeShow", icon: IconMic, title: "Remove a show", text: "A show that has stopped.", needsShow: true },
  { kind: "removeRoom", icon: IconTrash, title: "Remove this room", text: "It has closed or doesn't run mics." },
];

/**
 * "Suggest a change": one field at a time, in plain language. The maintainers approve or reject it, so nothing here edits the roster.
 * Without a room it is "suggest a new room".
 */
export function SuggestSheet({ roster, room, open, onClose, user }: { roster: PublishedRosterDoc; room: RoomShared | null; open: boolean; onClose: () => void; user: User }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [draft, setDraft] = useState<SuggestionDraft | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const shared = toSharedRoster(roster);

  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setKind(room ? null : "addRoom");
      setDraft(null);
      setNote("");
    }
  }
  const back = () => {
    setKind(null);
    setDraft(null);
  };
  const close = () => (kind && room ? back() : onClose());

  const send = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await sendSuggestion(roster, { ...draft, ...(note.trim() ? { note: note.trim() } : {}) }, user);
      toast.success("Sent. The maintainers will take a look.");
      onClose();
    } catch {
      toast.error("Couldn't send that. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const onDraft: OnDraft = (d) => setDraft(d);
  let form: ReactNode = null;
  if (kind === "addRoom") form = <AddRoomForm key="addRoom" defaultCity={roster.city} onDraft={onDraft} />;
  else if (room && kind) {
    const f = { roster: shared, room, onDraft };
    form =
      kind === "room" ? <RoomFieldForm key={kind} {...f} />
      : kind === "show" ? <ShowFieldForm key={kind} {...f} />
      : kind === "day" ? <DayForm key={kind} {...f} />
      : kind === "curator" ? <CuratorFieldForm key={kind} {...f} />
      : kind === "addShow" ? <AddShowForm key={kind} room={room} onDraft={onDraft} />
      : kind === "removeShow" ? <RemoveShowForm key={kind} {...f} />
      : <RemoveRoomForm key={kind} {...f} />;
  }

  const options = OPTIONS.filter((o) => !o.needsShow || (room?.shows.length ?? 0) > 0);
  return (
    <Sheet
      open={open}
      onClose={close}
      title={room ? "Suggest a change" : "Suggest a new room"}
      footer={
        kind ? (
          <>
            <Button variant="text" onClick={close}>{room ? "Back" : "Cancel"}</Button>
            <Button onClick={() => void send()} loading={busy} disabled={!draft}>Send suggestion</Button>
          </>
        ) : (
          <Button variant="text" onClick={onClose}>Cancel</Button>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        {!kind ? (
          <>
            <p className="type-body-l text-on-surface-variant">What is wrong or missing at {room?.name}? Pick one. {roster.ownerName ?? "The owner"} and the maintainers see it and decide.</p>
            <ListGroup>
              {options.map((o) => (
                <ListRow key={o.kind} onClick={() => setKind(o.kind)} leading={<IconTile icon={o.icon} />} title={o.title} subtitle={o.text} className="[&_.truncate]:whitespace-normal" />
              ))}
            </ListGroup>
          </>
        ) : (
          <>
            {kind === "addRoom" && <Notice>Suggest a room that {roster.title} is missing. Add one mic or show now; the maintainers can add more.</Notice>}
            {form}
            <Field label="Why? (optional)" hint="Helps the maintainers decide, for example how you know.">
              <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="min-h-20" placeholder="Their Instagram says the mic moved to Thursdays" />
            </Field>
          </>
        )}
      </div>
    </Sheet>
  );
}
