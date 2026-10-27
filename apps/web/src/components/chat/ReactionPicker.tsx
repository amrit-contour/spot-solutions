// The emoji row that opens on a message: long-press on a phone, the smiley button (or right-click) on desktop.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { cx } from "@spot/ui";

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const MORE_REACTIONS = ["🔥", "👏", "🎉", "😍", "🤣", "😊", "👌", "💯", "🙌", "😎", "🤔", "😅", "🥳", "🤝", "💪", "✅", "😭", "😡", "🫶", "✨", "🎤", "👀", "🙈", "😬"];

export function ReactionPicker({ anchor, mine, onPick, onCopy, onClose }: { anchor: DOMRect; mine?: string; onPick: (emoji: string) => void; onCopy?: () => void; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null);

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
              <Emoji key={e} e={e} active={mine === e} onPick={onPick} />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-0.5">
            {QUICK_REACTIONS.map((e) => (
              <Emoji key={e} e={e} active={mine === e} onPick={onPick} />
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

function Emoji({ e, active, onPick }: { e: string; active: boolean; onPick: (e: string) => void }) {
  return (
    <button type="button" onClick={() => onPick(e)} aria-label={active ? `Remove ${e}` : `React ${e}`} aria-pressed={active} className={cx("pressable grid size-11 flex-none place-items-center rounded-full text-[1.65rem] leading-none transition-transform duration-150 active:scale-90", active ? "bg-primary-container ring-2 ring-primary" : "state-layer")}>
      {e}
    </button>
  );
}
