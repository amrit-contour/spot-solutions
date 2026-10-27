// One message in a chat: text, a poll, a pin, a picture or a label, with its reactions on the inner edge, and the ways to react
// (long-press on a phone, a smiley button on hover for a mouse, right-click). Your own unsent messages are PendingBubble.
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { groupReactions, reactionEdge, reactionReservePx, type ReactionChip, type ThreadMessage, type ThreadMediaResult } from "@spot/shared";
import { PinCard, PollCard, WaText, Button, IconCheck, IconWarn, Spinner, cx } from "@spot/ui";
import { MediaLabel, Photo, Sticker } from "./media";
import { ReactionPicker } from "./ReactionPicker";

const clock = (at: number, tz: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(at));

const LONG_PRESS_MS = 420;
const MOVE_SLOP = 8;

const Smile = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.2c.9 1.1 2 1.6 3.5 1.6s2.6-.5 3.5-1.6M9 9.8h.01M15 9.8h.01" />
  </svg>
);

export function Bubble({
  m,
  label,
  tz,
  media,
  reactions,
  onReact,
  onOpenPhoto,
  onOpenMention,
}: {
  m: ThreadMessage;
  label?: string;
  tz: string;
  media: (id: string) => Promise<ThreadMediaResult>;
  /** What to show on the bubble (the app's own reaction applied at once). */
  reactions?: ReactionChip[];
  /** Omit to switch reacting off. Picking the emoji you already have takes it back (the caller works that out). */
  onReact?: (emoji: string) => void;
  onOpenPhoto: (src: string) => void;
  /** Tapping a tag in the text. */
  onOpenMention?: (m: { id?: string; token: string; name: string }) => void;
}) {
  const out = m.fromMe;
  const sticker = m.kind === "sticker";
  const photo = m.kind === "media" && m.media === "image";
  const labelled = (m.kind === "media" && !photo) || m.kind === "other";
  const deleted = m.kind === "deleted";
  const caption = photo ? m.text.replace(/^\[photo\]\s*/, "") : "";
  const chips = groupReactions(reactions ?? m.reactions);
  const edge = reactionEdge(out);
  const reserve = chips.length ? reactionReservePx() : 0;

  const box = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const press = useRef<{ x: number; y: number; t: ReturnType<typeof setTimeout> } | null>(null);
  const [pressed, setPressed] = useState(false);
  const openPicker = () => {
    const r = box.current?.getBoundingClientRect();
    if (r && onReact) setAnchor(r);
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
    setPressed(false);
  };
  const mine = chips.find((c) => c.byMe)?.emoji;
  const copyable = m.kind === "text";

  return (
    <div className={cx("group/b flex flex-col", out ? "items-end" : "items-start")}>
      {label && <span className="mt-1.5 mb-0.5 px-1 type-label-s text-on-surface-variant">{label}</span>}
      <div className={cx("flex max-w-[88%] items-center gap-1 sm:max-w-[80%]", out && "flex-row-reverse")} style={{ marginBottom: reserve }}>
        <div
          ref={box}
          onContextMenu={(e) => {
            if (!onReact) return;
            e.preventDefault();
            openPicker();
          }}
          onPointerDown={(e) => {
            if (!onReact || e.pointerType === "mouse") return;
            setPressed(true);
            press.current = {
              x: e.clientX,
              y: e.clientY,
              t: setTimeout(() => {
                press.current = null;
                setPressed(false);
                navigator.vibrate?.(8);
                openPicker();
              }, LONG_PRESS_MS),
            };
          }}
          onPointerMove={(e) => press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > MOVE_SLOP && cancel()}
          onPointerUp={cancel}
          onPointerCancel={cancel}
          className={cx(
            "relative min-w-0 rounded-lg type-body-m transition-transform duration-150 ease-out [-webkit-touch-callout:none] pointer-coarse:select-none",
            sticker ? "px-0.5 py-0.5" : photo ? "p-1" : "px-3.5 py-2",
            out ? "rounded-br-xs" : "rounded-bl-xs",
            !sticker && (out ? "bg-primary-container text-on-primary-container" : "bg-surface-highest text-on-surface"),
            pressed && "scale-[0.985]",
            anchor && "ring-2 ring-primary/60",
          )}
        >
          {sticker ? (
            <Sticker id={m.id} media={media} />
          ) : photo ? (
            <>
              <Photo id={m.id} media={media} onOpen={onOpenPhoto} />
              {caption && (
                <div className="px-2.5 pt-1.5">
                  <WaText text={caption} />
                </div>
              )}
            </>
          ) : m.kind === "poll" && m.poll ? (
            <PollCard poll={m.poll} />
          ) : m.kind === "location" && m.pin ? (
            <PinCard name={m.pin.name} detail={m.pin.detail ?? "Map pin"} />
          ) : labelled ? (
            <MediaLabel kind={m.media ?? "other"} className="-mx-1 -my-0.5 min-w-0 bg-transparent px-0 py-0" />
          ) : deleted ? (
            <span className="italic opacity-80">{m.text}</span>
          ) : (
            <WaText text={m.text} mentions={m.mentions ?? []} onMention={onOpenMention} />
          )}
          <div className={cx("mt-0.5 text-right type-label-s tabular", photo && "px-2.5 pb-0.5", sticker ? "text-on-surface-variant" : "opacity-60")}>{clock(m.at, tz)}</div>
          {chips.length > 0 && (
            <div className={cx("absolute flex gap-1", edge === "right" ? "right-2" : "left-2")} style={{ bottom: -reserve }}>
              {chips.map((r) => (
                <span
                  key={r.emoji}
                  className={cx("inline-flex h-6 items-center gap-0.5 rounded-full px-1.5 text-sm leading-none shadow-sm ring-1", r.byMe ? "bg-primary-container text-on-primary-container ring-primary" : "bg-surface text-on-surface ring-outline-variant")}
                  title={r.byMe ? "You reacted" : undefined}
                >
                  <span aria-hidden>{r.emoji}</span>
                  {r.count > 1 && <span className="type-label-s tabular">{r.count}</span>}
                  <span className="sr-only">{r.byMe ? "reaction from you" : "reaction"}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        {onReact && (
          <button
            type="button"
            onClick={openPicker}
            aria-label="React to this message"
            className="state-layer hidden size-8 flex-none place-items-center rounded-full text-on-surface-variant opacity-0 transition-opacity duration-150 group-hover/b:opacity-100 focus-visible:opacity-100 pointer-fine:grid"
          >
            <Smile className="size-5" />
          </button>
        )}
      </div>
      {anchor && onReact && (
        <ReactionPicker
          anchor={anchor}
          mine={mine}
          onClose={() => setAnchor(null)}
          onPick={(e) => {
            setAnchor(null);
            onReact(e);
          }}
          onCopy={
            copyable
              ? () => {
                  setAnchor(null);
                  void navigator.clipboard?.writeText(m.text).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"));
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

export interface PendingView {
  id: string;
  state: "sending" | "sent" | "failed";
  error?: string;
  body: ReactNode;
}

/** A message you've just sent: shown at once, with Sending…, Sent or Not sent (retry), until the real one arrives. */
export function PendingBubble({ p, onRetry, onDiscard }: { p: PendingView; onRetry: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-col items-end">
      <div className={cx("max-w-[88%] rounded-lg rounded-br-xs px-3.5 py-2 type-body-m transition-colors duration-200 sm:max-w-[80%]", p.state === "failed" ? "bg-error-container text-on-error-container" : p.state === "sent" ? "bg-primary-container text-on-primary-container" : "bg-primary-container/70 text-on-primary-container")}>
        {p.body}
        <div className="mt-0.5 flex items-center justify-end gap-1.5 type-label-s opacity-80" role="status">
          {p.state === "sending" ? (
            <>
              <Spinner className="size-3" /> Sending…
            </>
          ) : p.state === "sent" ? (
            <>
              <IconCheck className="icon size-3.5" /> Sent
            </>
          ) : (
            <>
              <IconWarn className="icon size-3.5" /> Not sent
            </>
          )}
        </div>
      </div>
      {p.state === "failed" && (
        <div className="mt-1 flex flex-wrap items-center justify-end gap-2 px-1">
          <span className="min-w-0 type-body-s text-error">{p.error}</span>
          <Button size="sm" variant="tonal" onClick={onRetry}>Retry</Button>
          <Button size="sm" variant="text" onClick={onDiscard}>Discard</Button>
        </div>
      )}
    </div>
  );
}
