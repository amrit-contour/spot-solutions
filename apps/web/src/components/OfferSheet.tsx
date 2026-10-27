// Offer open slots to one comic or several at once (one ad hoc request). One comic: a "yes" books them and sends the
// confirmation. Several: the first yeses fill the slots (auto-add), or the yeses wait in Updates for you to pick.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { where } from "firebase/firestore";
import { DAY_NAMES, dateInWeek, directPlan, formatDate, formatTime, greetName, lineupId, messageRich, renderRich, searchPeople, OFFER_POLL_OPTIONS, type SpotRequest, type RichMessage, type Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { SnippetMenu } from "./SnippetMenu";
import { askOverfill, whoLabel } from "../lib/overfill";
import { runCommand, useCollection } from "../lib/data";
import { ComicAvatar } from "../lib/photos";
import { RecentRow, SearchField, SearchHint } from "./PeopleSearch";
import { Button, Sheet, Stepper, Switch, cx } from "@spot/ui";
import { MessageComposer, MessagePreview } from "@spot/ui";
import { IconSend, IconUserPlus } from "@spot/ui";

// Remembered per curator, in this browser: whether the sheet opens on "Already agreed".
const directKey = (uid: string) => `nbot.adhoc.direct.${uid}`;
const readDirect = (uid: string) => {
  try {
    return localStorage.getItem(directKey(uid)) === "1";
  } catch {
    return false;
  }
};

// The two switches under "Already agreed": remembered per curator, in this browser. Both default on.
const switchKey = (uid: string, name: "confirm" | "group") => `nbot.adhoc.${name}.${uid}`;
const readSwitch = (uid: string, name: "confirm" | "group") => {
  try {
    return localStorage.getItem(switchKey(uid, name)) !== "0";
  } catch {
    return true;
  }
};

export function OfferSheet({ open, onClose, show, exclude, onDirectAdded }: { open: boolean; onClose: () => void; show: Show; exclude: string[]; onDirectAdded?: () => void }) {
  const { uid, week, comics, settings, venues } = useApp();
  const [q, setQ] = useState("");
  const requests = useCollection<SpotRequest>(open ? uid : undefined, "requests", [where("weekOf", "==", week)], week);
  const [picks, setPicks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const open_ = Math.max(1, show.slotCount - exclude.length);
  const [slots, setSlots] = useState(1);
  const [autoAdd, setAutoAdd] = useState(settings.offers.autoAdd !== false);
  const [direct, setDirect] = useState(() => readDirect(uid));
  const [confirmMsg, setConfirmMsg] = useState(() => readSwitch(uid, "confirm"));
  const [toGroup, setToGroup] = useState(() => readSwitch(uid, "group"));
  const choose = (name: "confirm" | "group", v: boolean) => {
    (name === "confirm" ? setConfirmMsg : setToGroup)(v);
    try {
      localStorage.setItem(switchKey(uid, name), v ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };
  const many = picks.length > 1;
  const plan = directPlan(exclude, picks, show.slotCount);
  const chooseDirect = (v: boolean) => {
    setDirect(v);
    try {
      localStorage.setItem(directKey(uid), v ? "1" : "0");
    } catch {
      /* not remembered */
    }
  };
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

  // Type-first: nobody is listed until something is typed. Before that, this week's requesters are one tap away.
  const available = useMemo(() => {
    const out = new Set(exclude);
    return comics.filter((c) => !out.has(c.id) && c.list !== "banned");
  }, [comics, exclude]);
  const list = useMemo(() => searchPeople(available, q), [available, q]);
  const recent = useMemo(() => {
    const ok = new Set(available.map((c) => c.id));
    const seen = new Set<string>();
    return requests.data
      .filter((r) => ok.has(r.comicId) && r.status !== "rejected" && r.status !== "dismissed")
      .map((r) => ({ id: r.comicId, name: comics.find((c) => c.id === r.comicId)?.name ?? r.comicName }))
      .filter((p) => !seen.has(p.id) && seen.add(p.id))
      .slice(0, 5);
  }, [requests.data, available, comics]);

  const toggle = (id: string) => {
    const next = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id];
    setPicks(next);
    // The message follows the switch between one comic (their name filled in) and several (a template).
    const one = next.length === 1 ? comics.find((c) => c.id === next[0]) : undefined;
    if (next.length) setMsg(defaultMsg(one ? one.name : null));
  };
  const send = async () => {
    if (!picks.length) return;
    // The slot count is a soft limit: a full show asks first ("Add anyway"), and the command carries the yes.
    const names = picks.map((id) => (comics.find((c) => c.id === id)?.name ?? "them").split(/\s+/)[0]);
    const adding = direct ? plan.add.length : 1;
    const over = exclude.length + adding > show.slotCount;
    if (over && !(await askOverfill(show, exclude.length, whoLabel(direct ? names : names.slice(0, 1)), adding))) return;
    setBusy(true);
    try {
      if (direct) {
        await runCommand(uid, "send_offer", { comicIds: picks, lineupId: lineupId(week, show.id), direct: true, ...(over && { overfill: true }), confirm: confirmMsg, addToGroup: toGroup }, 180_000);
        toast.success(comic ? `Added ${comic.name.split(" ")[0]} to ${show.name}` : `Added ${picks.length} comics to ${show.name}`);
        setPicks([]);
        setMsg({ kind: "text", body: "" });
        onDirectAdded?.();
        onClose();
        return;
      }
      await runCommand(uid, "send_offer", { comicIds: picks, lineupId: lineupId(week, show.id), body: msg.body, rich: { kind: msg.kind, body: msg.body, ...(msg.kind === "poll" && { poll: { question: msg.poll?.question ?? "", options: [...OFFER_POLL_OPTIONS], multi: false } }) }, slots: fill, autoAdd, ...(over && { overfill: true }) }, 180_000);
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
      title={direct ? "Add a comic directly" : "Offer a spot"}
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={direct ? IconUserPlus : IconSend} disabled={!picks.length || (!direct && !ready)} loading={busy} onClick={send}>
            {direct ? (many ? `Add ${picks.length} comics` : comic ? `Add ${greetName(comic.name)}` : "Add to lineup") : many ? `Send to ${picks.length}` : "Send offer"}
          </Button>
        </>
      }
    >
      <p className="type-body-m text-on-surface-variant">
        {`${vars.show}, ${vars.day} ${vars.date} at ${vars.time}`}.{" "}
        {direct
          ? `Pick who's already agreed. They go straight onto the lineup${toGroup ? " and into the show's WhatsApp group" : ""}${confirmMsg ? ", and get your confirmation message" : ""}. No offer is sent.`
          : `Pick one comic or several. If they say yes within ${settings.offers.expiryHours} h, by poll or by typing, they're added to the lineup and get your confirmation message. If it fills up first, they're told it's gone.`}
      </p>
      <label className="mt-4 flex items-center gap-3 rounded-lg bg-surface-container p-3">
        <span className="min-w-0 flex-1">
          <span className="block type-body-m">Already agreed: add directly</span>
          <span className="block type-body-s text-on-surface-variant">{direct ? "No offer, no waiting for a yes." : "Off: they get an offer and are added when they say yes."}</span>
        </span>
        <Switch checked={direct} onChange={chooseDirect} label="Already agreed: add directly" />
      </label>
      {direct && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex items-center gap-3 rounded-lg bg-surface-container p-3">
            <span className="min-w-0 flex-1">
              <span className="block type-body-m">Send them a confirmation</span>
              <span className="block type-body-s text-on-surface-variant">{confirmMsg ? "Your confirmation message goes out now." : "No message. They show as Not told until Send updates or Confirm names them."}</span>
            </span>
            <Switch checked={confirmMsg} onChange={(v) => choose("confirm", v)} label="Send them a confirmation" />
          </label>
          <label className="flex items-center gap-3 rounded-lg bg-surface-container p-3">
            <span className="min-w-0 flex-1">
              <span className="block type-body-m">Add them to the show's group</span>
              <span className="block type-body-s text-on-surface-variant">{toGroup ? "Joins the group like everyone else (on show day)." : "Not added. Automatic syncs leave them out; a sync you press adds them."}</span>
            </span>
            <Switch checked={toGroup} onChange={(v) => choose("group", v)} label="Add them to the show's group" />
          </label>
        </div>
      )}
      <div className="mt-5 flex flex-col gap-4">
        <SearchField value={q} onChange={setQ} />
        {!q.trim() && <RecentRow people={recent} onPick={toggle} selected={picks} label="Asked this week" />}
        {picks.length > 0 && !q.trim() && (
          <p className="type-body-s text-on-surface-variant">
            Picked: {picks.map((id) => comics.find((c) => c.id === id)?.name ?? id).join(", ")}
          </p>
        )}
        {q.trim() ? (
          <ul className="max-h-64 overflow-y-auto rounded-md bg-surface-container">
            {list.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => toggle(c.id)}
                  aria-pressed={picks.includes(c.id)}
                  className={cx("state-layer flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left", picks.includes(c.id) && "bg-secondary-container text-on-secondary-container")}
                >
                  <ComicAvatar id={c.id} name={c.name} size={32} />
                  <span className="min-w-0 flex-1 truncate type-body-l">{c.name}</span>
                  {c.history?.[0] && <span className="type-label-s text-on-surface-variant">{formatDate(c.history[0].date)}</span>}
                </button>
              </li>
            ))}
            {!list.length && <li className="px-3 py-4 type-body-s text-on-surface-variant">No one matches.</li>}
          </ul>
        ) : (
          <SearchHint />
        )}
        {direct && plan.over > 0 && (
          <p role="status" className="rounded-lg bg-tertiary-container px-3 py-2 type-body-s text-on-tertiary-container">
            {show.name} has {show.slotCount} {show.slotCount === 1 ? "spot" : "spots"} and {exclude.length} {exclude.length === 1 ? "is" : "are"} filled. Adding {plan.add.length} puts it {plan.over} over; you'll be asked to confirm.
          </p>
        )}
        {!direct && many && (
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
        {!direct && picks.length > 0 && (
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
