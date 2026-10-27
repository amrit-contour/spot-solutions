import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { askDayLabel, openNow, upcomingGroups, type Ask, type PlannedAsk } from "@spot/shared";
import { Button, Empty, IconAdd, IconBuilding, IconChat, IconClock, IconMenuDots, IconButton, Menu, MenuItem, PageHeader, Segmented, Spinner } from "@spot/ui";
import { draftFor, useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { shortDate } from "../lib/time";
import { AskOpenCard, AskSentCard, AskUpcomingRow } from "../components/AskCards";
import { AskEditSheet, RoomModesSheet, TemplateSheet } from "../components/AskSheets";
import { messageFor } from "../components/askMessage";

type Tab = "open" | "coming" | "sent";

/** Replies the comic has to look at: a reply nobody could read, or a thumbs-up counted as a yes. */
export const needsYou = (a: Ask) => !a.skipped && ((a.status === "sent" && a.lastReply?.decision === "unclear") || (a.status === "got_it" && Boolean(a.lastReply?.unsure)));

/** Asks: what to ask for now, what is coming, and what has gone out. */
export function Asks() {
  const store = useAsks();
  const roster = useRoster();
  const now = useNowMs();
  const { plan, today } = useAskPlan(now);
  const [tab, setTab] = useState<Tab>("open");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<PlannedAsk | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [modesOpen, setModesOpen] = useState(false);

  const open = useMemo(() => openNow(plan), [plan]);
  const groups = useMemo(() => upcomingGroups(plan, today, 7), [plan, today]);
  const comingCount = groups.reduce((n, g) => n + g.asks.length, 0);
  const sent = useMemo(
    () =>
      store.asks
        .filter((a) => !a.skipped && ["sent", "got_it", "declined", "no_reply"].includes(a.status) && a.sentAt)
        .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || (b.sentAt ?? 0) - (a.sentAt ?? 0)),
    [store.asks],
  );
  const attention = sent.filter(needsYou).length;
  const waiting = sent.filter((a) => a.status === "sent").length;

  const mark = (id: string, on: boolean) => setBusy((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const send = async (a: PlannedAsk, text?: string, voice?: boolean) => {
    mark(a.id, true);
    try {
      const draft = draftFor(a, text ?? messageFor(a, store.template));
      await store.sendAsk(voice === undefined ? draft : { ...draft, voice });
      toast.success(`Sent to ${a.curatorName?.split(/\s+/)[0] ?? "the curator"}.`);
      setEditing(null);
    } catch (e) {
      toast.error((e as Error).message || "Couldn't send that.");
    } finally {
      mark(a.id, false);
    }
  };
  const skip = async (a: PlannedAsk) => {
    try {
      await store.skipAsk(a, draftFor(a, messageFor(a, store.template)));
      toast(`Skipped ${a.label}, ${shortDate(a.showDate)}.`);
    } catch {
      toast.error("Couldn't skip that. Try again.");
    }
  };
  const answer = (ask: Ask, d: "got_it" | "declined" | "waiting") => {
    const room = roster.rooms.find((r) => r.id === ask.roomId);
    store.answerAsk(ask, d, room).then(
      () => toast.success(d === "got_it" ? "Added to My spots." : d === "declined" ? "Marked as a no." : "Back to waiting."),
      () => toast.error("Couldn't save that. Try again."),
    );
  };

  const noRooms = !roster.loading && roster.rooms.length === 0;
  return (
    <div className="w-full">
      <PageHeader
        title="Asks"
        subtitle="Ask the rooms for spots, and see how they replied."
        actions={
          <Menu align="right" trigger={(openMenu) => <IconButton icon={IconMenuDots} label="Ask settings" onClick={openMenu} />}>
            {(close) => (
              <>
                <MenuItem onClick={() => { close(); setTemplateOpen(true); }}>Ask message</MenuItem>
                <MenuItem onClick={() => { close(); setModesOpen(true); }}>Send or review, per room</MenuItem>
              </>
            )}
          </Menu>
        }
        bar={
          <Segmented
            full
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "open", label: `Open now${open.length ? ` ${open.length}` : ""}` },
              { value: "coming", label: `Coming up${comingCount ? ` ${comingCount}` : ""}` },
              { value: "sent", label: `Sent${waiting ? ` ${waiting}` : ""}${attention ? " •" : ""}` },
            ]}
          />
        }
      />

      <div className="min-w-0 px-4 pt-3 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        {store.loading || roster.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : noRooms ? (
          <Empty icon={IconBuilding} title="Add your rooms first" action={<Link to="/rooms"><Button icon={IconAdd}>Go to Rooms</Button></Link>}>
            Asks come from your rooms: which shows, who curates them and when to ask. Add them, or load the Bangalore starter.
          </Empty>
        ) : tab === "open" ? (
          <div className="flex min-w-0 flex-col gap-3">
            {attention > 0 && (
              <button onClick={() => setTab("sent")} className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-secondary-container p-4 text-left text-on-secondary-container">
                <IconChat aria-hidden className="icon size-6 flex-none" />
                <span className="min-w-0 flex-1 type-title-s">{attention === 1 ? "A reply needs a look" : `${attention} replies need a look`}</span>
                <span className="type-label-l">See</span>
              </button>
            )}
            {open.length === 0 ? (
              <Empty icon={IconClock} title="Nothing to ask right now">
                {groups[0] ? `The next ask opens ${askDayLabel(groups[0].date, today).toLowerCase()}: ${groups[0].asks[0]!.label}.` : "When a room's ask window opens, it shows up here."}
              </Empty>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
                {open.slice(0, showAll ? undefined : 12).map((a) => (
                  <li key={a.id} className="min-w-0">
                    <AskOpenCard a={a} template={store.template} now={now} busy={busy.has(a.id)} onSend={() => void send(a)} onSkip={() => void skip(a)} onEdit={() => setEditing(a)} />
                  </li>
                ))}
              </ul>
            )}
            {open.length > 12 && !showAll && (
              <Button variant="tonal" onClick={() => setShowAll(true)} className="self-center">
                Show {open.length - 12} more
              </Button>
            )}
          </div>
        ) : tab === "coming" ? (
          groups.length === 0 ? (
            <Empty icon={IconClock} title="Nothing coming up this week">Asks that open in the next 7 days will be listed here, by the day they open.</Empty>
          ) : (
            <div className="flex min-w-0 flex-col gap-6">
              {groups.map((g) => (
                <section key={g.date} aria-label={askDayLabel(g.date, today)} className="min-w-0">
                  <h2 className="mb-2 flex items-baseline gap-2 type-title-m text-on-surface-variant">
                    <span className="min-w-0 truncate">Opens {askDayLabel(g.date, today).toLowerCase()}</span>
                    <span className="type-label-m tabular">{g.asks.length}</span>
                  </h2>
                  <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-2">
                    {g.asks.map((a) => (
                      <li key={a.id} className="min-w-0">
                        <AskUpcomingRow a={a} today={today} onSkip={() => void skip(a)} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )
        ) : sent.length === 0 ? (
          <Empty icon={IconChat} title="No asks sent yet">When you send an ask, it waits here for the curator's reply. Replies are read for you.</Empty>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
            {sent.map((a) => (
              <li key={a.id} className="min-w-0">
                <AskSentCard ask={a} now={now} onAnswer={(d) => answer(a, d)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <AskEditSheet ask={editing} message={editing ? messageFor(editing, store.template) : ""} onClose={() => setEditing(null)} onSend={(text, voice) => editing && void send(editing, text, voice)} />
      <TemplateSheet open={templateOpen} onClose={() => setTemplateOpen(false)} />
      <RoomModesSheet open={modesOpen} onClose={() => setModesOpen(false)} />
    </div>
  );
}

