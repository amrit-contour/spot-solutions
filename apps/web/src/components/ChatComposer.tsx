// The Messages composer, built like a messenger's: one row (+, the box, send). "+" opens a small sheet (poll, venue pin, templates,
// mention, your voice), "Aa" shows the formatting bar only while you want it, the box grows from one line to about six, and what
// you attach (a venue pin, a poll, your voice) sits as a removable chip above the box. A pin on its own goes out as a pin; with
// text, it follows the text. In a group, typing "@" offers the members and the tags become real WhatsApp tags on send.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hasPin, pollProblem, shortcutOp, type PollSpec, type RichMessage, type ThreadMember, type Venue } from "@spot/shared";
import { Button, FormatBar, IconCheck, IconClose, IconMap, IconSend, IconSparkle, IconTemplate, MessageComposer, Popover, Switch, cx, emptyPoll, useTextEditing, type Icon } from "@spot/ui";
import { useApp } from "../lib/app";
import type { MentionTag } from "../lib/messages";

/** One message to send: what, which venue's pin (if it carries one), whether to reword it, and who it tags. */
export interface Outgoing {
  msg: RichMessage;
  venueId: string | null;
  voice: boolean;
  tags: MentionTag[];
}

type View = "menu" | "poll" | "pin";
const TITLE: Record<View, string> = { menu: "Add to message", poll: "Poll", pin: "Venue pin" };
const MAX_SUGGESTIONS = 6;

const Plus = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

function Row({ icon: I, label, hint, onClick, disabled, trailing }: { icon?: Icon; label: string; hint?: string; onClick?: () => void; disabled?: boolean; trailing?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="state-layer flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-2 text-left type-body-l disabled:opacity-40">
      {I && <I className="icon size-6 flex-none text-on-surface-variant" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate type-body-s text-on-surface-variant">{hint}</span>}
      </span>
      {trailing}
    </button>
  );
}

function AttachChip({ icon: I, label, onOpen, onRemove, removeLabel }: { icon?: Icon; label: string; onOpen: () => void; onRemove: () => void; removeLabel: string }) {
  return (
    <span className="inline-flex h-8 max-w-full items-center rounded-full bg-secondary-container text-on-secondary-container">
      <button type="button" onClick={onOpen} className="state-layer inline-flex h-8 min-w-0 items-center gap-1.5 rounded-l-full pr-1 pl-3 type-label-l">
        {I && <I className="icon size-4 flex-none" />}
        <span className="truncate">{label}</span>
      </button>
      <button type="button" onClick={onRemove} aria-label={removeLabel} className="state-layer grid size-8 flex-none place-items-center rounded-r-full">
        <IconClose className="icon size-4" />
      </button>
    </span>
  );
}

export function ChatComposer({
  idPrefix,
  onSend,
  templates,
  voiceReady,
  defaultVenueId,
  members,
  baseTags = [],
  draft,
  onDraftUsed,
}: {
  idPrefix: string;
  onSend: (items: Outgoing[]) => void;
  /** The Templates menu: call `pick` with the chosen message and render `trigger` as its button. */
  templates: (pick: (m: RichMessage) => void, trigger: (toggle: () => void, open: boolean) => ReactNode) => ReactNode;
  voiceReady: boolean;
  defaultVenueId?: string;
  /** A group's members for the "@" picker. Leave out in a one-to-one chat. */
  members?: ThreadMember[];
  /** Tags the text may already hold (the show's POCs, from a template). */
  baseTags?: MentionTag[];
  /** A suggested reply from the AI assist, put in the box for editing. */
  draft?: RichMessage | null;
  onDraftUsed?: () => void;
}) {
  const { venues } = useApp();
  const pinVenues = useMemo(() => venues.filter((v: Venue) => hasPin(v)), [venues]);
  const defaultPin = () => (defaultVenueId && pinVenues.some((v) => v.id === defaultVenueId) ? defaultVenueId : (pinVenues[0]?.id ?? null));

  const [text, setText] = useState("");
  const [poll, setPoll] = useState<PollSpec | null>(null);
  const [pinId, setPinId] = useState<string | null>(null);
  const [voice, setVoice] = useState(false);
  const [fmt, setFmt] = useState(false);
  const [sheet, setSheet] = useState<View | null>(null);
  const [pollDraft, setPollDraft] = useState<PollSpec>(emptyPoll);
  const [picked, setPicked] = useState<MentionTag[]>([]);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const { format, insert } = useTextEditing(box, text, setText);

  // The box grows with its text, one line to about six.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 152)}px`;
  }, [text]);

  const focusEnd = (at?: number) =>
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      const p = at ?? el.value.length;
      el.setSelectionRange(p, p);
    });

  const apply = (m: RichMessage) => {
    if (m.kind === "poll") setPoll(m.poll ?? emptyPoll());
    else if (m.kind === "location") setPinId(defaultPin());
    else {
      setText(m.body);
      if (m.attachLocation) setPinId(defaultPin());
      focusEnd(m.body.length);
    }
  };
  useEffect(() => {
    if (!draft) return;
    apply(draft);
    onDraftUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const pinVenue = venues.find((v: Venue) => v.id === pinId);
  const pollOk = poll ? !pollProblem(poll) : true;
  const body = text.trim();
  const canSend = (Boolean(body) || Boolean(pinId) || Boolean(poll)) && pollOk;

  const send = () => {
    if (!canSend) return;
    const tags = [...baseTags, ...picked].filter((t) => body.includes(t.label));
    const items: Outgoing[] = [];
    if (body) items.push({ msg: { kind: "text", body: text.trimEnd(), ...(pinId && { attachLocation: true }) }, venueId: pinId, voice, tags });
    else if (pinId) items.push({ msg: { kind: "location", body: "" }, venueId: pinId, voice: false, tags: [] });
    if (poll) items.push({ msg: { kind: "poll", body: "", poll }, venueId: null, voice: false, tags: [] });
    onSend(items);
    setText("");
    setPoll(null);
    setPinId(null);
    setPicked([]);
  };

  // "@" in a group: the word being typed, and who matches it.
  const query = members?.length && focused ? text.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,30})$/) : null;
  const suggestions = useMemo(() => {
    if (!query || !members) return [];
    const q = query[1].toLowerCase();
    const starts = members.filter((m) => m.name.toLowerCase().startsWith(q) || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
    return starts.slice(0, MAX_SUGGESTIONS);
  }, [query, members]);
  useEffect(() => setActive(0), [query?.[1]]);
  const pickMember = (m: ThreadMember) => {
    if (!query) return;
    const start = caret - query[1].length - 1;
    const label = `@${m.name}`;
    const next = `${text.slice(0, start)}${label} ${text.slice(caret)}`;
    setText(next);
    setPicked((p) => (p.some((t) => t.label === label && t.comicId === m.id) ? p : [...p, { label, comicId: m.id }]));
    focusEnd(start + label.length + 1);
  };

  const openSheet = (v: View) => {
    if (v === "poll") setPollDraft(poll ?? emptyPoll());
    setSheet(v);
  };
  const closeSheet = () => setSheet(null);
  const choosePin = () => {
    if (pinVenues.length === 1) {
      setPinId(pinVenues[0].id);
      closeSheet();
    } else openSheet("pin");
  };
  const mention = () => {
    const at = box.current?.selectionStart ?? text.length;
    const lead = at > 0 && !/\s/.test(text[at - 1]) ? " " : "";
    setText(`${text.slice(0, at)}${lead}@${text.slice(at)}`);
    closeSheet();
    focusEnd(at + lead.length + 1);
    setFocused(true);
    setCaret(at + lead.length + 1);
  };

  return (
    <div className="flex flex-col gap-1.5" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && (e.preventDefault(), send())}>
      {suggestions.length > 0 && (
        <ul role="listbox" aria-label="Mention someone" className="flex max-h-48 flex-col overflow-y-auto rounded-md bg-surface-container py-1 shadow-md ring-1 ring-outline-variant/40">
          {suggestions.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMember(m)}
                className={cx("state-layer flex min-h-11 w-full items-center gap-2 px-3 text-left type-body-m", i === active && "bg-secondary-container text-on-secondary-container")}
              >
                <span className="font-medium text-primary">@</span>
                <span className="truncate">{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(pinId || poll || (voice && voiceReady)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {pinId && <AttachChip icon={IconMap} label={pinVenue?.name ?? "Venue pin"} onOpen={() => openSheet("pin")} onRemove={() => setPinId(null)} removeLabel="Remove the venue pin" />}
          {poll && <AttachChip label={`📊 ${poll.question.trim() || "Poll"}`} onOpen={() => openSheet("poll")} onRemove={() => setPoll(null)} removeLabel="Remove the poll" />}
          {voice && voiceReady && <AttachChip icon={IconSparkle} label="In my voice" onOpen={() => openSheet("menu")} onRemove={() => setVoice(false)} removeLabel="Stop writing it in my voice" />}
        </div>
      )}

      {fmt && (
        <div className="-mx-1 overflow-x-auto px-1">
          <FormatBar className="flex-nowrap" onFormat={format} onEmoji={(e) => insert(e, false)} />
        </div>
      )}

      <div className="flex items-end gap-1.5">
        <Popover
          title={TITLE[sheet ?? "menu"]}
          width={360}
          controlledOpen={sheet !== null}
          onOpenChange={(o) => (o ? openSheet("menu") : closeSheet())}
          trigger={(toggle, open) => (
            <button type="button" onClick={toggle} aria-label="Add: poll, venue pin, templates" aria-expanded={open} className={cx("state-layer pressable grid size-10 flex-none place-items-center rounded-full text-on-surface-variant transition-transform duration-200", open && "rotate-45 bg-secondary-container text-on-secondary-container")}>
              <Plus className="size-6" />
            </button>
          )}
        >
          {(close) =>
            sheet === "poll" ? (
              <div className="flex flex-col gap-3">
                <MessageComposer value={{ kind: "poll", body: "", poll: pollDraft }} onChange={(m) => setPollDraft(m.poll ?? pollDraft)} kinds={["poll"]} preview={false} attach={false} idPrefix={`${idPrefix}-poll`} />
                <div className="flex items-center gap-2">
                  <Button variant="text" onClick={() => openSheet("menu")}>Back</Button>
                  <span className="flex-1" />
                  {poll && (
                    <Button variant="text" onClick={() => (setPoll(null), close())}>
                      Remove
                    </Button>
                  )}
                  <Button
                    disabled={Boolean(pollProblem(pollDraft))}
                    onClick={() => {
                      setPoll({ ...pollDraft, options: pollDraft.options.map((o) => o.trim()).filter(Boolean) });
                      close();
                    }}
                  >
                    Add poll
                  </Button>
                </div>
              </div>
            ) : sheet === "pin" ? (
              <div className="flex flex-col gap-1">
                {pinVenues.length ? (
                  pinVenues.map((v) => (
                    <Row
                      key={v.id}
                      icon={IconMap}
                      label={v.name}
                      hint={v.area || undefined}
                      onClick={() => (setPinId(v.id), close())}
                      trailing={v.id === pinId ? <IconCheck className="icon size-5 flex-none text-primary" /> : undefined}
                    />
                  ))
                ) : (
                  <p className="py-2 type-body-m text-error">None of your venues has a map pin yet. Add one under Shows → Venues.</p>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                <Row label="Poll" hint={poll ? `Added: ${poll.question}` : "Ask a question with answers to tap"} icon={IconPollGlyph} onClick={() => openSheet("poll")} />
                <Row icon={IconMap} label="Venue pin" hint={pinVenue ? `Added: ${pinVenue.name}` : pinVenues.length ? "On its own, or after your text" : "No venue has a map pin yet"} onClick={choosePin} disabled={!pinVenues.length} />
                {templates((m) => (apply(m), close()), (toggle) => <Row icon={IconTemplate} label="Templates" hint="Saved replies and your messages" onClick={toggle} />)}
                {members?.length ? <Row label="Mention someone" hint="Tag a group member" icon={AtGlyph} onClick={mention} /> : null}
                {voiceReady && (
                  <div className="flex min-h-12 items-center gap-3 rounded-md px-2 py-2">
                    <IconSparkle className="icon size-6 flex-none text-on-surface-variant" />
                    <span className="min-w-0 flex-1">
                      <span className="block type-body-l">Send in my voice</span>
                      <span className="block type-body-s text-on-surface-variant">Reworded when sent; your own words go if it changes a fact.</span>
                    </span>
                    <Switch checked={voice} onChange={setVoice} label="Send in my voice" />
                  </div>
                )}
              </div>
            )
          }
        </Popover>

        <div className="flex min-w-0 flex-1 items-end rounded-[1.4rem] border border-outline-variant bg-surface-container focus-within:border-primary">
          <textarea
            ref={box}
            id={`${idPrefix}-box`}
            rows={1}
            value={text}
            placeholder="Message"
            aria-label="Message"
            enterKeyHint="enter"
            autoCapitalize="sentences"
            onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart))}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (suggestions.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  return setActive((a) => (a + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  return pickMember(suggestions[active]);
                }
                if (e.key === "Escape") return setCaret(0);
              }
              if ((e.metaKey || e.ctrlKey) && !e.altKey) {
                const op = shortcutOp(e.key, e.shiftKey);
                if (op) return e.preventDefault(), format(op);
              }
              // A keyboard with a real Enter key sends; on a phone Enter makes a new line and the arrow sends.
              if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer: fine)").matches) {
                e.preventDefault();
                send();
              }
            }}
            className="max-h-[9.5rem] min-h-10 min-w-0 flex-1 resize-none bg-transparent py-2 pr-1 pl-4 text-base leading-6 outline-none placeholder:text-on-surface-variant/70 sm:type-body-m sm:leading-6"
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFmt((v) => !v)}
            aria-pressed={fmt}
            aria-label="Formatting"
            title="Formatting"
            className={cx("state-layer pressable mr-0.5 mb-0.5 grid size-9 flex-none place-items-center rounded-full type-label-l", fmt ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant")}
          >
            Aa
          </button>
        </div>

        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send"
          data-primary
          className="pressable grid size-10 flex-none place-items-center rounded-full bg-primary text-on-primary transition-opacity disabled:bg-surface-high disabled:text-on-surface-variant disabled:opacity-60"
        >
          <IconSend className="icon size-5" />
        </button>
      </div>
    </div>
  );
}

function IconPollGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  );
}
function AtGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M15.5 8.5v4.2a2.3 2.3 0 0 0 4.5 0V12a8 8 0 1 0-3.2 6.4" />
    </svg>
  );
}
