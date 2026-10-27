// One message in a chat: text, a poll, a pin, a picture or a label, with its reactions on the inner edge, and the ways to react
// (long-press on a phone, a smiley button on hover for a mouse, right-click). Your own unsent messages are PendingBubble.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { groupReactions, type ReactionChip, type ThreadMessage, type ThreadMediaResult } from "@spot/shared";
import { PinCard, PollCard, WaText, Button, IconCheck, IconWarn, Spinner, cx } from "@spot/ui";
import { MediaLabel, Photo, Sticker } from "./media";
import { ReactionDetails, ReactionPicker } from "./ReactionPicker";

const clock = (at: number, tz: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(at));

const LONG_PRESS_MS = 400;
/** After the picker has opened under a finger that is still down, it only counts as a slide once the finger has moved this far. */
const SLIDE_SLOP = 12;
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
  reactor,
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
  /** Who the other reactions are from, in a one-to-one chat (a group doesn't say). */
  reactor?: string;
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
  const total = chips.reduce((n, c) => n + c.count, 0);

  const box = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [who, setWho] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  // One touch, start to finish. Before the picker opens a move past the slop (a scroll) cancels it; once it has opened,
  // letting go selects nothing. Only a finger that has slid onto an emoji and lets go there picks it.
  const press = useRef<{ x: number; y: number; t: ReturnType<typeof setTimeout>; open: boolean; slid: boolean } | null>(null);
  const [pressed, setPressed] = useState(false);
  const openPicker = () => {
    const r = box.current?.getBoundingClientRect();
    if (r && onReact) setAnchor((a) => a ?? r);
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
    setPressed(false);
    setHolding(false);
    setHover(null);
  };
  const emojiAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-emoji]")?.dataset.emoji ?? null;
  // While the finger is down on the open picker the page must not scroll under it (a non-passive listener; React's are passive).
  useEffect(() => {
    const el = box.current;
    if (!holding || !el) return;
    const stop = (e: TouchEvent) => e.cancelable && e.preventDefault();
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, [holding]);
  const mine = chips.find((c) => c.byMe)?.emoji;
  const copyable = m.kind === "text";

  return (
    <div className={cx("group/b flex flex-col", out ? "items-end" : "items-start")}>
      {label && <span className="mt-1.5 mb-0.5 px-1 type-label-s text-on-surface-variant">{label}</span>}
      <div className={cx("flex max-w-[88%] items-end gap-1.5 sm:max-w-[80%]", out && "flex-row-reverse")}>
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
            const x = e.clientX;
            const y = e.clientY;
            press.current = {
              x,
              y,
              open: false,
              slid: false,
              t: setTimeout(() => {
                if (!press.current) return;
                press.current.open = true;
                setPressed(false);
                setHolding(true);
                navigator.vibrate?.(8);
                openPicker();
              }, LONG_PRESS_MS),
            };
          }}
          onPointerMove={(e) => {
            const p = press.current;
            if (!p) return;
            const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
            if (!p.open) return moved > MOVE_SLOP ? cancel() : undefined;
            if (moved > SLIDE_SLOP) p.slid = true;
            setHover(p.slid ? emojiAt(e.clientX, e.clientY) : null);
          }}
          onPointerUp={(e) => {
            const p = press.current;
            if (p?.open) {
              const pick = p.slid ? emojiAt(e.clientX, e.clientY) : null;
              cancel();
              // Letting go in place leaves the picker open for a tap; letting go on an emoji after sliding onto it picks it.
              if (pick) {
                setAnchor(null);
                onReact?.(pick);
              }
            } else cancel();
          }}
          onPointerCancel={() => (press.current?.open ? (setHolding(false), setHover(null), (press.current = null)) : cancel())}
          className={cx(
            "relative min-w-0 rounded-lg type-body-m [-webkit-touch-callout:none] pointer-coarse:select-none",
            "transition-[transform,box-shadow] ease-[cubic-bezier(0.23,1,0.32,1)]",
            // Pressing sinks slowly (the hold is the feedback); letting go or opening is quick.
            pressed ? "scale-[0.96] duration-[400ms]" : anchor ? "scale-[1.03] shadow-lg duration-200" : "duration-150",
            sticker ? "px-0.5 py-0.5" : photo ? "p-1" : "px-3.5 py-2",
            out ? "rounded-br-xs" : "rounded-bl-xs",
            !sticker && (out ? "bg-primary-container text-on-primary-container" : "bg-surface-highest text-on-surface"),
            anchor && "ring-2 ring-primary/50",
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
        </div>
        {chips.length > 0 && (
          // Beside the bubble on its inner side (right of an incoming one, left of your own), flush with its bottom edge.
          <button
            type="button"
            onClick={() => setWho(true)}
            aria-label={`${total} ${total === 1 ? "reaction" : "reactions"}: ${chips.map((c) => c.emoji).join(" ")}${mine ? ", including yours" : ""}. Show who`}
            className={cx(
              "pressable relative inline-flex h-6 flex-none items-center gap-0.5 rounded-full px-1.5 text-sm leading-none ring-1 before:absolute before:-inset-2 before:content-['']",
              mine ? "bg-primary-container text-on-primary-container ring-primary" : "bg-surface-high text-on-surface ring-outline-variant",
            )}
          >
            <span className="flex" aria-hidden>
              {chips.slice(0, 3).map((c) => (
                <span key={c.emoji}>{c.emoji}</span>
              ))}
            </span>
            {total > 1 && <span className="type-label-s tabular">{total}</span>}
          </button>
        )}
        {onReact && (
          <button
            type="button"
            onClick={openPicker}
            aria-label="React to this message"
            className="state-layer order-3 hidden size-8 flex-none place-items-center self-center rounded-full text-on-surface-variant opacity-0 transition-opacity duration-150 group-hover/b:opacity-100 focus-visible:opacity-100 pointer-fine:grid"
          >
            <Smile className="size-5" />
          </button>
        )}
      </div>
      {who && (
        <ReactionDetails
          chips={chips}
          other={reactor}
          onClose={() => setWho(false)}
          onRemove={(e) => {
            setWho(false);
            onReact?.(e);
          }}
        />
      )}
      {anchor && onReact && (
        <ReactionPicker
          anchor={anchor}
          mine={mine}
          hover={hover}
          onClose={() => !holding && setAnchor(null)}
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
