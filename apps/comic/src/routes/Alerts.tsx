import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { clashNote, localDate, type GroupUpdate, type SpotAlert } from "@spot/shared";
import { Button, Chip, IconBell, IconCheck, IconGroup, IconInbox, IconWarn, PageHeader, Spinner } from "@spot/ui";
import { Card, CardActions, EmptyState, IconTile, ListGroup, ListRow, Page, Section } from "../components/ui";
import { TZ, applyUpdate, dismissAlert, dismissUpdate, gotTheSpot, pickAlertRoom, splitAlerts, useClock, useGroupUpdates, useMySpotList, useSpotAlerts, useWatchedGroups } from "../lib/alerts";
import { RosterProvider, useFirestoreRoster, useRoster } from "../lib/roster";
import { ago } from "../lib/time";
import { AlertAskSheet } from "../components/AlertAskSheet";
import { AlertCard } from "../components/AlertCard";
import { PushPrompt } from "../components/PushPrompt";

/** Alerts: spots offered in the groups you watch (act on them now), and closures or curator changes waiting for you to apply. */
export function Alerts({ uid }: { uid: string }) {
  const store = useFirestoreRoster(uid);
  return (
    <RosterProvider store={store}>
      <AlertsPage uid={uid} />
    </RosterProvider>
  );
}

function AlertsPage({ uid }: { uid: string }) {
  const roster = useRoster();
  const alerts = useSpotAlerts(uid);
  const updates = useGroupUpdates(uid);
  const spots = useMySpotList(uid);
  const groups = useWatchedGroups(uid);
  const now = useClock();
  const today = localDate(new Date(now), TZ);
  const [params, setParams] = useSearchParams();
  const focusId = params.get("alert");
  const [asking, setAsking] = useState<string | null>(null);
  const { open, earlier } = useMemo(() => splitAlerts(alerts.data, now), [alerts.data, now]);

  // A tap on the notification's "Ask for it" lands here with ?alert=ID&ask=1: open the ask for that alert, ready to send.
  const wantAsk = params.get("ask") === "1";
  useEffect(() => {
    if (!wantAsk || !focusId || alerts.loading) return;
    if (alerts.data.some((a) => a.id === focusId)) setAsking(focusId);
    else toast("That offer is gone.");
    const next = new URLSearchParams(params);
    next.delete("ask");
    setParams(next, { replace: true });
  }, [wantAsk, focusId, alerts.loading, alerts.data, params, setParams]);
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || alerts.loading || scrolled.current === focusId) return;
    const el = document.getElementById(`alert-${focusId}`);
    if (el) {
      scrolled.current = focusId;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusId, alerts.loading, alerts.data]);

  const asked = alerts.data.find((a) => a.id === asking) ?? null;
  const pending = updates.data.filter((u) => u.status === "pending").sort((a, b) => b.receivedAt - a.receivedAt);
  const heads = updates.data.filter((u) => u.status === "info").sort((a, b) => b.receivedAt - a.receivedAt);
  const done = updates.data.filter((u) => u.status === "applied").sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5);
  const loading = alerts.loading || updates.loading;
  const nothing = !loading && !open.length && !earlier.length && !pending.length && !heads.length && !done.length;

  const card = (a: SpotAlert) => (
    <li key={a.id} className="min-w-0">
      <AlertCard
        alert={a}
        now={now}
        today={today}
        clash={clashNote(a, spots.data)}
        highlight={focusId === a.id}
        onAsk={() => setAsking(a.id)}
        onDismiss={() => void dismissAlert(uid, a.id)}
        onPickRoom={(roomId) => {
          const room = roster.rooms.find((r) => r.id === roomId);
          if (room) void pickAlertRoom(uid, a, room).then(() => toast.success(`Remembered for ${a.poster.name ?? "them"} in ${a.groupName ?? "this group"}`), (e: Error) => void toast.error(e.message));
        }}
        onGotIt={() => {
          void gotTheSpot(uid, a, a.times[0]);
          toast.success("Added to My spots");
        }}
      />
    </li>
  );

  return (
    <div className="w-full">
      <PageHeader width="narrow" title="Alerts" subtitle="Spots offered in your groups, as they happen." />
      <Page>
        <PushPrompt uid={uid} />

        {!groups.loading && groups.data.length === 0 && (
          <Card className="flex items-start gap-3">
            <IconTile icon={IconGroup} />
            <div className="min-w-0 flex-1">
              <p className="type-title-m">No groups watched yet</p>
              <p className="mt-0.5 type-body-m text-on-surface-variant">Pick the WhatsApp groups where spots get posted. Only those are read.</p>
              <Link to="/groups" className="mt-1 -mb-2 -ml-3 flex min-h-11 w-fit items-center rounded-full px-3 type-label-l text-primary state-layer">
                Choose groups
              </Link>
            </div>
          </Card>
        )}

        {loading && (
          <div className="grid place-items-center py-12 text-primary">
            <Spinner className="size-8" />
          </div>
        )}

        {!loading && open.length > 0 && (
          <Section title="Open now" count={open.length}>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">{open.map(card)}</ul>
          </Section>
        )}

        {!loading && pending.length > 0 && (
          <Section title="To review" count={pending.length}>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
              {pending.map((u) => (
                <li key={u.id} className="min-w-0">
                  <UpdateCard u={u} now={now} onApply={() => applyUpdate(uid, u, roster).then(() => toast.success("Applied to your rooms"), (e: Error) => void toast.error(e.message))} onDismiss={() => void dismissUpdate(uid, u.id)} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {!loading && heads.length > 0 && (
          <Section title="Heads up" count={heads.length}>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
              {heads.map((u) => (
                <li key={u.id} className="min-w-0">
                  <UpdateCard u={u} now={now} onDismiss={() => void dismissUpdate(uid, u.id)} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {nothing && (
          <EmptyState icon={IconBell} title="Nothing on offer right now">
            When someone posts spots in a group you watch, it shows up here and on your phone straight away.
          </EmptyState>
        )}
        {!loading && !nothing && !open.length && !pending.length && (
          <p className="px-1 type-body-m text-on-surface-variant">No spots on offer right now. You'll be notified when one comes up.</p>
        )}

        {!loading && done.length > 0 && (
          <Section title="Applied by itself">
            <ListGroup>
              {done.map((u) => (
                <ListRow
                  key={u.id}
                  leading={<IconCheck aria-hidden className="icon size-5 flex-none text-primary" />}
                  title={<span className="type-body-m font-normal">{u.summary}</span>}
                  subtitle={`${u.groupName ? `${u.groupName} · ` : ""}${ago(u.receivedAt, now)}`}
                  trailing={<Button variant="text" size="sm" onClick={() => void dismissUpdate(uid, u.id)}>Clear</Button>}
                />
              ))}
            </ListGroup>
          </Section>
        )}

        {!loading && earlier.length > 0 && (
          <Section title="Earlier" count={earlier.length}>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">{earlier.map(card)}</ul>
          </Section>
        )}
      </Page>

      <AlertAskSheet uid={uid} alert={asked} spots={spots.data} today={today} now={now} onClose={() => setAsking(null)} onSent={() => undefined} />
    </div>
  );
}

const KIND_LABEL: Record<GroupUpdate["kind"], string> = { closure: "Full", schedule: "Curators", opening: "Opening" };

/** A closure, a curator schedule or an opening notice from a group. */
function UpdateCard({ u, now, onApply, onDismiss }: { u: GroupUpdate; now: number; onApply?: () => Promise<unknown> | void; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <IconTile tone="neutral" icon={u.kind === "closure" ? IconWarn : IconInbox} />
        <div className="min-w-0 flex-1">
          <p className="type-title-m">{u.summary}</p>
          <p className="truncate type-body-s text-on-surface-variant">
            {u.groupName ? `${u.groupName} · ` : ""}
            {ago(u.receivedAt, now)}
          </p>
        </div>
        <Chip tone={u.kind === "closure" ? "error" : "neutral"} className="flex-none">
          {KIND_LABEL[u.kind]}
        </Chip>
      </div>
      {u.text && <p className="line-clamp-2 type-body-s text-on-surface-variant">“{u.text}”</p>}
      <CardActions spread={Boolean(onApply)}>
        <Button variant="text" size="sm" onClick={onDismiss} className={onApply ? "-ml-2" : undefined}>
          {onApply ? "Not now" : "Clear"}
        </Button>
        {onApply && (
          <Button
            size="sm"
            icon={IconCheck}
            loading={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onApply()).finally(() => setBusy(false));
            }}
          >
            {u.kind === "closure" ? "Mark full" : u.kind === "opening" ? "Set opening time" : "Update curators"}
          </Button>
        )}
      </CardActions>
    </Card>
  );
}
