// Offer an open slot to one comic. A "yes" reply books them and sends the confirmation.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DAY_NAMES, dateInWeek, formatDate, formatTime, greetName, lineupId, renderMessage, type Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { SnippetMenu } from "./SnippetMenu";
import { runCommand } from "../lib/data";
import { Avatar, Button, Sheet, TextArea, TextInput, cx } from "./ui";
import { IconSend } from "./icons";

export function OfferSheet({ open, onClose, show, exclude }: { open: boolean; onClose: () => void; show: Show; exclude: string[] }) {
  const { uid, week, comics, settings, venues } = useApp();
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const comic = comics.find((c) => c.id === pick);
  const vars = { show: show.name, venue: venues.find((v) => v.id === show.venueId)?.name, day: DAY_NAMES[show.weekday], date: formatDate(dateInWeek(week, show.weekday)), time: formatTime(show.startTime) };
  const [body, setBody] = useState("");
  const defaultBody = (name: string) => renderMessage(settings, "offer", { ...vars, name: greetName(name) });

  const list = useMemo(() => {
    const out = new Set(exclude);
    return comics
      .filter((c) => !out.has(c.id) && c.list !== "banned" && c.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (b.history?.[0]?.date ?? "").localeCompare(a.history?.[0]?.date ?? "") || a.name.localeCompare(b.name))
      .slice(0, 30);
  }, [comics, exclude, q]);

  const send = async () => {
    if (!comic) return;
    setBusy(true);
    try {
      await runCommand(uid, "send_offer", { comicId: comic.id, lineupId: lineupId(week, show.id), body: body || defaultBody(comic.name) }, 120_000);
      toast.success(`Offer sent to ${comic.name.split(" ")[0]}`);
      setPick(null);
      setBody("");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Offer a spot"
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={IconSend} disabled={!comic} loading={busy} onClick={send}>
            Send offer
          </Button>
        </>
      }
    >
      <p className="type-body-m text-on-surface-variant">
        {`${vars.show}, ${vars.day} ${vars.date} at ${vars.time}`}. If they reply yes within {settings.offers.expiryHours} h, they're added to the lineup and get your confirmation message. If it fills up first, they're told it's gone.
      </p>
      <div className="mt-5 flex flex-col gap-4">
        <TextInput placeholder="Search comics" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="max-h-64 overflow-y-auto rounded-md bg-surface-container">
          {list.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => {
                  setPick(c.id);
                  setBody(defaultBody(c.name));
                }}
                className={cx("state-layer flex w-full items-center gap-3 px-3 py-2 text-left", pick === c.id && "bg-secondary-container text-on-secondary-container")}
              >
                <Avatar name={c.name} size={32} />
                <span className="min-w-0 flex-1 truncate type-body-l">{c.name}</span>
                {c.history?.[0] && <span className="type-label-s text-on-surface-variant">{formatDate(c.history[0].date)}</span>}
              </button>
            </li>
          ))}
          {!list.length && <li className="px-3 py-4 type-body-s text-on-surface-variant">No one matches.</li>}
        </ul>
        {comic && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="type-label-l text-on-surface-variant">Message to {greetName(comic.name)}</span>
              <SnippetMenu name={comic.name} vars={vars} onPick={setBody} />
            </div>
            <TextArea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder={defaultBody(comic.name)} aria-label={`Message to ${comic.name}`} />
          </div>
        )}
      </div>
    </Sheet>
  );
}
