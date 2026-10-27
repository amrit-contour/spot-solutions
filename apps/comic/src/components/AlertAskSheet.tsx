import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { alertClash, alertDayLabel, alertState, formatTime, givenName, renderAlertAsk, type MySpot, type SpotAlert } from "@spot/shared";
import { Bubble, Button, Chip, Field, IconSend, Sheet, TextArea } from "@spot/ui";
import { runCommand } from "../lib/commands";

/**
 * "Ask for it": the message is filled in ("Hi Dhruv, I can do the 9:30 PM spot at TAG today!"), editable, and goes to the person
 * the offer says to DM, from your own WhatsApp, in one tap. Picking another time rewrites the message until you've edited it.
 */
export function AlertAskSheet({ uid, alert: a, spots, today, now, onClose, onSent }: { uid: string; alert: SpotAlert | null; spots: MySpot[]; today: string; now: number; onClose: () => void; onSent: () => void }) {
  const times = useMemo(() => {
    if (!a) return [];
    const { free } = alertClash(a, spots);
    return free.length ? free : a.times;
  }, [a, spots]);
  const [time, setTime] = useState<string | undefined>(undefined);
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  const draft = (t: string | undefined) => (a ? renderAlertAsk({ name: a.contact.name, time: t, room: a.roomName, day: alertDayLabel(a.date, today) }) : "");
  const id = a?.id;
  useEffect(() => {
    if (!a) return;
    const t = times[0];
    setTime(t);
    setText(draft(t));
    setEdited(false);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const pick = (t: string) => {
    setTime(t);
    if (!edited) setText(draft(t));
  };
  const state = a ? alertState(a, now) : "open";
  const gone = state === "closed" || state === "expired";

  const send = async () => {
    if (!a || !text.trim()) return;
    setBusy(true);
    try {
      const r = await runCommand<{ sentTo?: string }>(uid, "ask_for_spot", { alertId: a.id, body: text.trim(), time, force: gone || undefined });
      toast.success(`Sent to ${r?.sentTo ? givenName(r.sentTo) || r.sentTo : "them"}`);
      onSent();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={Boolean(a)}
      onClose={onClose}
      title="Ask for it"
      footer={
        <Button icon={IconSend} loading={busy} disabled={!text.trim()} onClick={() => void send()}>
          {gone ? "Send anyway" : "Send"}
        </Button>
      }
    >
      {a && (
        <div className="flex flex-col gap-5">
          <div>
            <p className="type-title-m">{a.roomName ?? "A room"}</p>
            <p className="type-body-m text-on-surface-variant">
              {alertDayLabel(a.date, today)}
              {a.times.length ? ` · ${a.times.map(formatTime).join(", ")}` : ""}
            </p>
          </div>
          <p className="type-body-m">
            Goes to <strong>{a.contact.name ?? "the poster"}</strong> on WhatsApp{a.contact.kind === "mentioned" ? " (the person tagged in the post)" : ""}.
          </p>
          {gone && (
            <p role="status" className="rounded-md bg-error-container px-3 py-2 type-body-s text-on-error-container">
              {state === "closed" ? "They said it's closed in the group." : "This offer has ended."} You can still send it.
            </p>
          )}
          {times.length > 1 && (
            <Field label="Which time">
              <div className="flex flex-wrap gap-2">
                {times.map((t) => (
                  <Chip key={t} selected={t === time} onClick={() => pick(t)}>
                    {formatTime(t)}
                  </Chip>
                ))}
              </div>
            </Field>
          )}
          <Field label="Your message" hint="Edit it if you like.">
            <TextArea
              rows={4}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setEdited(true);
              }}
              maxLength={1000}
            />
          </Field>
          {text.trim() && (
            <div aria-hidden>
              <Bubble outgoing>{text}</Bubble>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
