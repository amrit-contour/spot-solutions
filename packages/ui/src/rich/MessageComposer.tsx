// Edit one outgoing message: text with formatting, a poll, or a venue pin. Used by Settings → Messages,
// saved replies, the reply boxes and the offer sheet.
import { useRef, useState } from "react";
import {
  POLL_MAX_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  OFFER_POLL_OPTIONS,
  insertText,
  pollProblem,
  renderRich,
  SAMPLE_VARS,
  type MessageKind,
  type PollSpec,
  type RichMessage,
  type TemplateVars,
} from "@spot/shared";
import { Bubble, Button, Segmented, Switch, TextInput, cx } from "../ui";
import { IconAdd, IconClose, IconMap } from "../icons";
import { RichField } from "./RichField";
import { PinCard, PollCard, WaText } from "./WaText";

const KIND_LABEL: Record<MessageKind, string> = { text: "Text", poll: "Poll", location: "Location" };

export const emptyPoll = (): PollSpec => ({ question: "", options: ["", ""], multi: false });

/** How a message reads in a list: the text, or what kind of thing it is. */
export function messageSummary(m: RichMessage) {
  return m.kind === "poll" ? `Poll: ${m.poll?.question ?? ""}` : m.kind === "location" ? "Venue location pin" : m.body;
}

/** Switch kinds without losing what was typed: the text stays put, and a new poll's question starts from it. */
export function withKind(m: RichMessage, kind: MessageKind): RichMessage {
  if (kind === m.kind) return m;
  if (kind === "poll") return { ...m, kind, poll: m.poll ?? { ...emptyPoll(), question: m.body.split("\n")[0].slice(0, POLL_QUESTION_MAX) } };
  return { ...m, kind };
}

export interface Variable {
  key: string;
  label: string;
}

export function MessageComposer({
  value,
  onChange,
  kinds = ["text", "poll", "location"],
  variables,
  extraVars,
  attach = kinds.includes("location"),
  attachLabel = "Also send the venue location",
  canPin = true,
  offer,
  compact,
  preview = true,
  idPrefix = "msg",
}: {
  value: RichMessage;
  onChange: (m: RichMessage) => void;
  kinds?: MessageKind[];
  /** Variable chips that insert {{key}} into the field being edited. */
  variables?: readonly Variable[];
  extraVars?: TemplateVars;
  /** Offer the "Also send the venue location" switch on text. Defaults to on when Location is one of the kinds. */
  attach?: boolean;
  attachLabel?: string;
  /** False when the venue for this message is known to have no pin (the switch is hidden). */
  canPin?: boolean;
  /** Offer polls: the options are fixed (first books the spot, second passes). */
  offer?: boolean;
  /** Reply boxes: no kind switcher or variable chips; the kind comes from the template that was picked. */
  compact?: boolean;
  /** Show the chat preview beside the editor (stacked on phones). Off in reply boxes. */
  preview?: boolean;
  idPrefix?: string;
}) {
  const fields = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});
  const last = useRef("body");
  const poll = value.poll ?? emptyPoll();
  const problem = value.kind === "poll" ? pollProblem(poll) : null;
  const [touched, setTouched] = useState(false);

  const setPoll = (p: Partial<PollSpec>) => onChange({ ...value, poll: { ...poll, ...p } });
  const setOption = (i: number, v: string) => setPoll({ options: poll.options.map((o, j) => (j === i ? v : o)) });

  const setField = (id: string, v: string) => (id === "body" ? onChange({ ...value, body: v }) : id === "q" ? setPoll({ question: v }) : setOption(Number(id.slice(1)), v));
  const insertToken = (key: string) => {
    const token = key === "minutes" ? "{{#minutes}}⏱ {{minutes}} min{{/minutes}}" : `{{${key}}}`;
    const id = fields.current[last.current] ? last.current : "body";
    const el = fields.current[id];
    const cur = id === "body" ? value.body : id === "q" ? poll.question : (poll.options[Number(id.slice(1))] ?? "");
    const next = insertText(cur, el?.selectionStart ?? cur.length, el?.selectionEnd ?? cur.length, token);
    setField(id, next.value);
    requestAnimationFrame(() => {
      // Already focused (the chip never took focus): re-focusing makes iOS re-open the keyboard and zoom/scroll.
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
      el?.setSelectionRange(next.start, next.end);
    });
  };

  const showKinds = kinds.length > 1 && !compact;
  const vars = { ...SAMPLE_VARS, ...extraVars };

  const editor = (
    <div className="flex min-w-0 flex-col gap-3">
      {showKinds && <Segmented value={value.kind} onChange={(k) => onChange(withKind(value, k))} options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))} size="sm" />}

      {value.kind === "text" && (
        <>
          <RichField
            value={value.body}
            onChange={(body) => onChange({ ...value, body })}
            rows={compact ? 3 : 5}
            mono={!compact}
            id={`${idPrefix}-body`}
            ariaLabel="Message text"
            preview={Boolean(compact)}
            onFocus={() => (last.current = "body")}
            fieldRef={(el) => (fields.current.body = el)}
          />
          {attach && (!compact || canPin) && (
            <div className="flex items-center justify-between gap-3">
              <span className="type-body-m">{attachLabel}</span>
              <Switch checked={Boolean(value.attachLocation)} onChange={(v) => onChange({ ...value, attachLocation: v })} label={attachLabel} />
            </div>
          )}
          {value.attachLocation && !compact && <p className="-mt-1 type-body-s text-on-surface-variant">Goes out as a map pin right after the text. Venues without a pin send nothing extra.</p>}
        </>
      )}

      {value.kind === "poll" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${idPrefix}-q`} className="type-label-l text-on-surface-variant">Question</label>
            <TextInput
              id={`${idPrefix}-q`}
              value={poll.question}
              onFocus={() => (last.current = "q")}
              ref={(el) => void (fields.current.q = el)}
              onChange={(e) => setPoll({ question: e.target.value })}
              onBlur={() => setTouched(true)}
              placeholder="Want the Monday 8:30 PM spot?"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="type-label-l text-on-surface-variant">{offer ? "Answers" : `Options (${poll.options.filter((o) => o.trim()).length} of ${POLL_MAX_OPTIONS} max)`}</span>
            {offer ? (
              <>
                <ul className="flex flex-col gap-1.5">
                  {OFFER_POLL_OPTIONS.map((o, i) => (
                    <li key={o} className="flex h-10 items-center gap-2 rounded-sm bg-surface-container px-3 type-body-m">
                      <span className="flex-1">{o}</span>
                      <span className="type-label-s text-on-surface-variant">{i === 0 ? "Books the spot" : "Passes"}</span>
                    </li>
                  ))}
                </ul>
                <p className="type-body-s text-on-surface-variant">A typed “yes” or “no” still works too.</p>
              </>
            ) : (
              <>
                {poll.options.map((o, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <TextInput
                      value={o}
                      aria-label={`Option ${i + 1}`}
                      placeholder={`Option ${i + 1}`}
                      className="h-10"
                      onFocus={() => (last.current = `o${i}`)}
                      ref={(el) => void (fields.current[`o${i}`] = el)}
                      onChange={(e) => setOption(i, e.target.value)}
                      onBlur={() => setTouched(true)}
                    />
                    <button
                      type="button"
                      disabled={poll.options.length <= 2}
                      onClick={() => setPoll({ options: poll.options.filter((_, j) => j !== i) })}
                      aria-label={`Remove option ${i + 1}`}
                      className="state-layer pressable grid size-10 flex-none place-items-center rounded-full text-on-surface-variant disabled:opacity-30"
                    >
                      <IconClose className="icon size-5" />
                    </button>
                  </div>
                ))}
                <div>
                  <Button size="sm" variant="text" icon={IconAdd} className="-ml-3" disabled={poll.options.length >= POLL_MAX_OPTIONS} onClick={() => setPoll({ options: [...poll.options, ""] })}>
                    Add option
                  </Button>
                </div>
              </>
            )}
          </div>
          {!offer && (
            <div className="flex items-center justify-between gap-3">
              <span className="type-body-m">Let people pick more than one</span>
              <Switch checked={poll.multi} onChange={(v) => setPoll({ multi: v })} label="Allow more than one answer" />
            </div>
          )}
          <p className="type-body-s text-on-surface-variant">
            Polls are plain text: up to {POLL_QUESTION_MAX} characters for the question and {POLL_OPTION_MAX} for each option.
          </p>
          {problem && touched && (
            <p role="alert" className="type-body-s text-error">
              {problem}
            </p>
          )}
        </div>
      )}

      {value.kind === "location" && (
        <p className="flex items-start gap-2 rounded-md bg-surface-container p-3 type-body-m text-on-surface-variant">
          <IconMap className="icon mt-0.5 size-5 flex-none" />
          <span>Sends the show's venue as a map pin. A venue without a pin sends nothing, so add one under Shows → Venues.</span>
        </p>
      )}

      {!compact && variables && value.kind !== "location" && (
        <div className="flex flex-wrap gap-1.5">
          {variables.map((v) => (
            <button key={v.key} type="button" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => insertToken(v.key)} className="state-layer pressable touch-manipulation h-7 rounded-sm bg-surface-high px-2.5 font-mono text-xs text-on-surface-variant" title={`Insert ${v.label}`}>
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (!preview) return editor;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      {editor}
      <MessagePreview value={value} vars={vars} />
    </div>
  );
}

/** What the comic will see: the text with WhatsApp formatting, the poll, and the pin, as separate bubbles. */
export function MessagePreview({ value, vars, className }: { value: RichMessage; vars: TemplateVars; className?: string }) {
  const r = renderRich(value, vars);
  const venue = String(vars.venue ?? "The venue");
  return (
    <div className={cx("flex flex-col rounded-lg bg-surface-container p-4", className)}>
      <span className="mb-3 type-label-m text-on-surface-variant">Preview</span>
      <div className="flex flex-col gap-1.5">
        {r.kind === "text" && (
          <Bubble outgoing meta="9:41 PM">
            {r.body.trim() ? <WaText text={r.body} /> : <span className="opacity-50">Empty message</span>}
          </Bubble>
        )}
        {r.kind === "poll" && r.poll && (
          <Bubble outgoing meta="9:41 PM">
            <PollCard poll={r.poll} />
          </Bubble>
        )}
        {(r.kind === "location" || (r.kind === "text" && r.attachLocation)) && (
          <Bubble outgoing meta="9:41 PM">
            <PinCard name={venue} detail="Map pin" />
          </Bubble>
        )}
      </div>
    </div>
  );
}
