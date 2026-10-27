import { useState } from "react";
import { toast } from "sonner";
import { ASK_VARIABLES, DEFAULT_ASK_TEMPLATE, askHints, renderAsk, type PlannedAsk, type Room } from "@spot/shared";
import { Bubble, Button, Chip, Field, Segmented, Sheet, Switch, TextArea } from "@spot/ui";
import { useAsks } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { dateTime } from "../lib/time";

/** Change the message for one ask before it goes. Saving keeps it as the draft; Send saves and sends. */
export function AskEditSheet({ ask, message, onClose, onSend }: { ask: PlannedAsk | null; message: string; onClose: () => void; onSend: (text: string, voice: boolean) => void }) {
  const store = useAsks();
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(true);
  const [last, setLast] = useState<PlannedAsk | null>(null);
  if (ask !== last) {
    setLast(ask);
    if (ask) {
      setText(message);
      setVoice(ask.doc?.voice ?? true);
    }
  }
  if (!ask) return <Sheet open={false} onClose={onClose} title="" children={null} />;
  const save = async () => {
    try {
      await store.saveAsk({ ...(ask.doc ?? {}), id: ask.id, roomId: ask.roomId, showId: ask.showId, showDate: ask.showDate, status: "planned", message: text.trim(), voice, createdAt: ask.doc?.createdAt ?? Date.now(), roomName: ask.roomName, showName: ask.showName, mode: ask.mode, ...(ask.time ? { time: ask.time } : {}), ...(ask.curatorId ? { curatorId: ask.curatorId } : {}), ...(ask.curatorName ? { curatorName: ask.curatorName } : {}), closesAt: ask.closesAt, askOn: ask.askOn });
      toast.success("Draft saved.");
      onClose();
    } catch {
      toast.error("Couldn't save that. Try again.");
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Ask ${ask.curatorName?.split(/\s+/)[0] ?? ""}`.trim()}
      footer={
        <>
          <Button variant="tonal" onClick={() => void save()} disabled={!text.trim()}>
            Save draft
          </Button>
          <Button disabled={!text.trim() || !ask.canSend} onClick={() => onSend(text.trim(), voice)}>
            Send
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        <p className="type-body-l text-on-surface-variant">
          {ask.label} · {dateTime(ask.showDate, ask.time)}
        </p>
        <Field label="Message">
          <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={5} />
        </Field>
        <Switch label="Write it the way I write" checked={voice} onChange={setVoice} />
        <p className="-mt-3 type-body-s text-on-surface-variant">Uses your voice profile when you've set one up in Nothing BOT Curating. The day, date and room stay exactly as written.</p>
      </div>
    </Sheet>
  );
}

const SAMPLE = { curatorName: "Aditya Natrajan", roomName: "Bloom Indiranagar", show: "Bloom Indiranagar", showDate: "2026-10-29", time: "20:00" };

/** The message every ask starts from. */
export function TemplateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useAsks();
  const [text, setText] = useState(store.template);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setText(store.template);
  }
  const insert = (key: string) => setText((t) => `${t}${t && !/\s$/.test(t) ? " " : ""}{{${key}}}`);
  const save = async () => {
    try {
      await store.saveTemplate(text);
      toast.success("Message saved. New asks use it.");
      onClose();
    } catch {
      toast.error("Couldn't save that. Try again.");
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ask message"
      footer={
        <>
          <Button variant="text" onClick={() => setText(DEFAULT_ASK_TEMPLATE)}>
            Back to the default
          </Button>
          <Button onClick={() => void save()} disabled={!text.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        <p className="type-body-l text-on-surface-variant">This is what an ask says before you change it. Tap a word to drop it in.</p>
        <Field label="Message">
          <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={5} />
        </Field>
        <div className="flex min-w-0 flex-wrap gap-2">
          {ASK_VARIABLES.map((v) => (
            <Chip key={v.key} onClick={() => insert(v.key)}>
              {v.label}
            </Chip>
          ))}
        </div>
        <div className="min-w-0">
          <p className="mb-2 type-label-l text-on-surface-variant">How it reads</p>
          <Bubble outgoing>{renderAsk(text, SAMPLE)}</Bubble>
        </div>
      </div>
    </Sheet>
  );
}

/** Each room: send its asks for me when the window opens, or leave them as drafts to review. */
export function RoomModesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roster = useRoster();
  const rooms = roster.rooms.filter((r) => askHints(r).length > 0 && r.shows.some((s) => s.myRole !== "curator"));
  const set = async (room: Room, askMode: "auto" | "review") => {
    try {
      await roster.saveRoom({ ...room, askMode });
    } catch {
      toast.error("Couldn't save that. Try again.");
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Send or review" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="flex min-w-0 flex-col gap-4">
        <p className="type-body-l text-on-surface-variant">
          Pick what happens when a room's ask window opens. <strong className="font-medium text-on-surface">Send for me</strong> sends the ask by itself from 9 AM that day, once.{" "}
          <strong className="font-medium text-on-surface">Ask me first</strong> leaves a draft here and sends you a reminder.
        </p>
        {rooms.length === 0 ? (
          <p className="type-body-m text-on-surface-variant">None of your rooms have an ask rule yet. Add one in Rooms.</p>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
            {rooms.map((r) => (
              <li key={r.id} className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-low p-3 sm:flex-row sm:items-center sm:gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate type-title-s">{r.name}</p>
                  <p className="truncate type-body-s text-on-surface-variant">{askHints(r).slice(0, 2).join(" · ")}</p>
                </div>
                <Segmented
                  size="sm"
                  compact
                  value={r.askMode === "auto" ? "auto" : "review"}
                  onChange={(m) => void set(r, m)}
                  options={[
                    { value: "review", label: "Ask me first" },
                    { value: "auto", label: "Send for me" },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
