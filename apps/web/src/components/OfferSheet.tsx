// Offer open slots to one comic or several at once (one ad hoc request). One comic: a "yes" books them and sends the
// confirmation. Several: the first yeses fill the slots (auto-add), or the yeses wait in Updates for you to pick.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DAY_NAMES, dateInWeek, formatDate, formatTime, greetName, lineupId, messageRich, renderRich, OFFER_POLL_OPTIONS, type RichMessage, type Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { SnippetMenu } from "./SnippetMenu";
import { runCommand } from "../lib/data";
import { Avatar, Button, Sheet, Stepper, Switch, TextInput, cx } from "@spot/ui";
import { MessageComposer, MessagePreview } from "@spot/ui";
import { IconSend } from "@spot/ui";

export function OfferSheet({ open, onClose, show, exclude }: { open: boolean; onClose: () => void; show: Show; exclude: string[] }) {
  const { uid, week, comics, settings, venues } = useApp();
  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const open_ = Math.max(1, show.slotCount - exclude.length);
  const [slots, setSlots] = useState(1);
  const [autoAdd, setAutoAdd] = useState(settings.offers.autoAdd !== false);
  const many = picks.length > 1;
  const comic = picks.length === 1 ? comics.find((c) => c.id === picks[0]) : undefined;
  const fill = Math.max(1, Math.min(slots, open_, picks.length || 1));
  const vars = { show: show.name, venue: venues.find((v) => v.id === show.venueId)?.name, day: DAY_NAMES[show.weekday], date: formatDate(dateInWeek(week, show.weekday)), time: formatTime(show.startTime) };
  const [msg, setMsg] = useState<RichMessage>({ kind: "text", body: "" });
  // The curator's offer message, filled in for this comic. A poll unless they switched it to text.
  // With several comics the {{name}} stays in, and each gets their own name when it's sent.
  const defaultMsg = (name: string | null): RichMessage => {
    const m = renderRich(messageRich(settings, "offer"), { ...vars, name: name === null ? "{{name}}" : greetName(name) });
    return m.kind === "poll" || m.kind === "text" ? m : { kind: "text", body: m.body };
  };
  // An offer poll always has the same two answers: the first books the spot, the second passes.
  const fixed = (m: RichMessage): RichMessage => (m.kind === "poll" ? { ...m, poll: { question: m.poll?.question ?? "", options: [...OFFER_POLL_OPTIONS], multi: false } } : m);
  const ready = msg.kind === "poll" ? Boolean(msg.poll?.question.trim()) : Boolean(msg.body.trim());

  const list = useMemo(() => {
    const out = new Set(exclude);
    return comics
      .filter((c) => !out.has(c.id) && c.list !== "banned" && c.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => (b.history?.[0]?.date ?? "").localeCompare(a.history?.[0]?.date ?? "") || a.name.localeCompare(b.name))
      .slice(0, 30);
  }, [comics, exclude, q]);

  const toggle = (id: string) => {
    const next = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id];
    setPicks(next);
    // The message follows the switch between one comic (their name filled in) and several (a template).
    const one = next.length === 1 ? comics.find((c) => c.id === next[0]) : undefined;
    if (next.length) setMsg(defaultMsg(one ? one.name : null));
  };
  const send = async () => {
    if (!picks.length) return;
    setBusy(true);
    try {
      await runCommand(uid, "send_offer", { comicIds: picks, lineupId: lineupId(week, show.id), body: msg.body, rich: { kind: msg.kind, body: msg.body, ...(msg.kind === "poll" && { poll: { question: msg.poll?.question ?? "", options: [...OFFER_POLL_OPTIONS], multi: false } }) }, slots: fill, autoAdd }, 180_000);
      toast.success(comic ? `Offer sent to ${comic.name.split(" ")[0]}` : `Offer sent to ${picks.length} comics`);
      setPicks([]);
      setMsg({ kind: "text", body: "" });
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
          <Button icon={IconSend} disabled={!picks.length || !ready} loading={busy} onClick={send}>
            {many ? `Send to ${picks.length}` : "Send offer"}
          </Button>
        </>
      }
    >
      <p className="type-body-m text-on-surface-variant">
        {`${vars.show}, ${vars.day} ${vars.date} at ${vars.time}`}. Pick one comic or several. If they say yes within {settings.offers.expiryHours} h, by poll or by typing, they're added to the lineup and get your confirmation message. If it fills up first, they're told it's gone.
      </p>
      <div className="mt-5 flex flex-col gap-4">
        <TextInput placeholder="Search comics" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="max-h-64 overflow-y-auto rounded-md bg-surface-container">
          {list.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => toggle(c.id)}
                aria-pressed={picks.includes(c.id)}
                className={cx("state-layer flex w-full items-center gap-3 px-3 py-2 text-left", picks.includes(c.id) && "bg-secondary-container text-on-secondary-container")}
              >
                <Avatar name={c.name} size={32} />
                <span className="min-w-0 flex-1 truncate type-body-l">{c.name}</span>
                {c.history?.[0] && <span className="type-label-s text-on-surface-variant">{formatDate(c.history[0].date)}</span>}
              </button>
            </li>
          ))}
          {!list.length && <li className="px-3 py-4 type-body-s text-on-surface-variant">No one matches.</li>}
        </ul>
        {many && (
          <div className="flex flex-col gap-3 rounded-lg bg-surface-container p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="type-body-m">Spots to fill</span>
              <Stepper value={fill} onChange={setSlots} min={1} max={Math.min(open_, picks.length)} />
            </div>
            <label className="flex items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="block type-body-m">Add the first {fill === 1 ? "yes" : `${fill} yeses`} automatically</span>
                <span className="block type-body-s text-on-surface-variant">{autoAdd ? "Anyone who says yes after it fills is told it's gone." : "Everyone who says yes comes to Updates; you pick, the rest are told it's filled."}</span>
              </span>
              <Switch checked={autoAdd} onChange={setAutoAdd} label="Add the first yeses automatically" />
            </label>
          </div>
        )}
        {picks.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="type-label-l text-on-surface-variant">{comic ? `Message to ${greetName(comic.name)}` : `Message to ${picks.length} comics ({{name}} is filled for each)`}</span>
              <SnippetMenu name={comic?.name ?? "{{name}}"} vars={vars} onPick={(m) => setMsg(fixed(m))} kinds={["text", "poll"]} />
            </div>
            <MessageComposer value={msg} onChange={(m) => setMsg(fixed(m))} kinds={["text", "poll"]} offer compact={false} preview={false} idPrefix="offer" />
            <MessagePreview value={msg} vars={{ ...vars, name: greetName(comic?.name ?? comics.find((c) => c.id === picks[0])?.name ?? "") }} className="mt-2" />
          </div>
        )}
      </div>
    </Sheet>
  );
}
