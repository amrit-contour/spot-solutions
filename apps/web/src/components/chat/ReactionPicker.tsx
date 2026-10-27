// The emoji row that opens on a message: long-press on a phone, the smiley button (or right-click) on desktop.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { cx } from "@spot/ui";

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const MORE_REACTIONS = ["🔥", "👏", "🎉", "😍", "🤣", "😊", "👌", "💯", "🙌", "😎", "🤔", "😅", "🥳", "🤝", "💪", "✅", "😭", "😡", "🫶", "✨", "🎤", "👀", "🙈", "😬"];

export function ReactionPicker({ anchor, mine, hover, onPick, onCopy, onClose }: { anchor: DOMRect; mine?: string; /** The emoji a finger that is still down (press-and-slide) is over. */ hover?: string | null; onPick: (emoji: string) => void; onCopy?: () => void; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  useLayoutEffect(() => {
    const p = panel.current;
    if (!p) return;
    const vv = window.visualViewport;
    const vw = vv?.width ?? window.innerWidth;
    const vh = vv?.height ?? window.innerHeight;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - w / 2), vw - 8 - w);
    const above = anchor.top - h - 8;
    const below = above < 64; // not enough room above (the header sits there)
    const top = below ? Math.min(anchor.bottom + 8, vh - 8 - h) : above;
    setPos({ top, left, below });
  }, [anchor, more]);

  return createPortal(
    <div className="fixed inset-0 z-[60]" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div className="absolute inset-0 bg-scrim/20" />
      <motion.div
        ref={panel}
        role="dialog"
        aria-label="React to message"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ top: pos?.top ?? -999, left: pos?.left ?? 0, transformOrigin: pos?.below ? "top center" : "bottom center" }}
        initial={{ opacity: 0, transform: "scale(0.9)" }}
        animate={{ opacity: pos ? 1 : 0, transform: "scale(1)", transition: { duration: 0.16, ease: [0.23, 1, 0.32, 1] } }}
        className="absolute flex max-w-[calc(100vw-16px)] flex-col gap-1 rounded-[1.6rem] bg-surface-high p-1.5 shadow-xl ring-1 ring-outline-variant/40"
      >
        {more ? (
          <div className="grid grid-cols-6 gap-0.5">
            {MORE_REACTIONS.map((e) => (
              <Emoji key={e} e={e} active={mine === e} hot={hover === e} onPick={onPick} />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-0.5">
            {QUICK_REACTIONS.map((e) => (
              <Emoji key={e} e={e} active={mine === e} hot={hover === e} onPick={onPick} />
            ))}
            <button type="button" aria-label="More emoji" onClick={() => setMore(true)} className="state-layer pressable grid size-11 flex-none place-items-center rounded-full bg-surface-highest text-xl leading-none text-on-surface-variant">
              +
            </button>
          </div>
        )}
        {onCopy && !more && (
          <button type="button" onClick={onCopy} className="state-layer mx-1 mb-0.5 rounded-full px-3 py-1.5 text-center type-label-l text-on-surface-variant">
            Copy text
          </button>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}

function Emoji({ e, active, hot, onPick }: { e: string; active: boolean; hot: boolean; onPick: (e: string) => void }) {
  return (
    <button type="button" data-emoji={e} onClick={() => onPick(e)} aria-label={active ? `Remove ${e}` : `React ${e}`} aria-pressed={active} className={cx("pressable grid size-11 flex-none place-items-center rounded-full text-[1.65rem] leading-none transition-transform duration-150 active:scale-90", hot && "scale-125", active ? "bg-primary-container ring-2 ring-primary" : "state-layer", hot && !active && "bg-surface-highest")}>
      {e}
    </button>
  );
}

/** Who reacted with what: the sheet a reaction pill opens. Your own row takes your reaction back. */
export function ReactionDetails({ chips, other, onRemove, onClose }: { chips: { emoji: string; count: number; byMe: boolean }[]; /** The other person's name in a one-to-one chat (the chat does not say who in a group). */ other?: string; onRemove: (emoji: string) => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const rows = chips.flatMap((c) => {
    const others = c.count - (c.byMe ? 1 : 0);
    return [
      ...(c.byMe ? [{ key: `${c.emoji}-me`, emoji: c.emoji, name: "You", mine: true }] : []),
      ...(others > 0 ? [{ key: `${c.emoji}-o`, emoji: c.emoji, name: other ?? (others === 1 ? "1 person" : `${others} people`), mine: false }] : []),
    ];
  });
  return createPortal(
    <div className="fixed inset-0 z-[60]" onPointerDown={onClose}>
      <motion.div className="absolute inset-0 bg-scrim/30" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.18 } }} />
      <motion.div
        role="dialog"
        aria-label="Reactions"
        onPointerDown={(e) => e.stopPropagation()}
        initial={{ transform: "translateY(100%)" }}
        animate={{ transform: "translateY(0%)", transition: { duration: 0.3, ease: [0.32, 0.72, 0, 1] } }}
        className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[70dvh] max-w-md flex-col rounded-t-[1.75rem] bg-surface-high pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-xl ring-1 ring-outline-variant/40"
      >
        <div className="mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-outline-variant" aria-hidden />
        <h3 className="px-5 pt-3 pb-1 type-title-m">Reactions</h3>
        <ul className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-1">
          {rows.map((r) => (
            <li key={r.key}>
              {r.mine ? (
                <button type="button" onClick={() => onRemove(r.emoji)} className="state-layer pressable flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left">
                  <span className="text-2xl leading-none" aria-hidden>{r.emoji}</span>
                  <span className="min-w-0 flex-1 truncate type-body-l font-medium">You</span>
                  <span className="type-label-m text-on-surface-variant">Tap to remove</span>
                </button>
              ) : (
                <div className="flex min-h-12 items-center gap-3 px-3">
                  <span className="text-2xl leading-none" aria-hidden>{r.emoji}</span>
                  <span className="min-w-0 flex-1 truncate type-body-l">{r.name}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </motion.div>
    </div>,
    document.body,
  );
}
