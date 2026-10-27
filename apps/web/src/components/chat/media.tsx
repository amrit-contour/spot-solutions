// Pictures in a chat: stickers and photos are fetched when they scroll into view (get_media, one result each, never stored on
// a server) and kept in memory for this visit only. Videos, voice notes and documents get a label: they open on your phone.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { ThreadMediaKind, ThreadMediaResult } from "@spot/shared";
import { IconButton, IconClose, Spinner, cx } from "@spot/ui";

export type MediaFetch = (messageId: string) => Promise<ThreadMediaResult>;

const cache = new Map<string, string | "none">();
const CACHE_MAX = 40;
let active = 0;
const queue: (() => void)[] = [];
const MAX_AT_ONCE = 3;
const withSlot = async <T,>(job: () => Promise<T>): Promise<T> => {
  if (active >= MAX_AT_ONCE) await new Promise<void>((go) => queue.push(go));
  active++;
  try {
    return await job();
  } finally {
    active--;
    queue.shift()?.();
  }
};

/** Loads one picture when it is near the screen. `src` is a data URL, "none" when it can't be shown, null while waiting. */
function useLazyMedia(id: string, media: MediaFetch) {
  const [src, setSrc] = useState<string | "none" | null>(() => cache.get(id) ?? null);
  const holder = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (src) return;
    const el = holder.current;
    if (!el) return;
    let live = true;
    const go = () =>
      void withSlot(() => media(id))
        .then((r) => {
          const v = r.dataUrl ?? "none";
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(id, v);
          if (live) setSrc(v);
        })
        .catch(() => live && setSrc("none"));
    if (typeof IntersectionObserver === "undefined") return go();
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && (io.disconnect(), go()), { rootMargin: "300px" });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [id, media, src]);
  return { src, holder };
}

export function Sticker({ id, media }: { id: string; media: MediaFetch }) {
  const { src, holder } = useLazyMedia(id, media);
  if (src && src !== "none") return <img src={src} alt="Sticker" width={144} height={144} className="size-36 object-contain" draggable={false} />;
  return (
    <span ref={holder} className="grid size-36 place-items-center rounded-md bg-on-surface/5 type-label-m text-on-surface-variant">
      {src === "none" ? "Sticker" : <Spinner className="size-5" />}
    </span>
  );
}

/** A photo thumbnail. Tap it to see it full screen. The caption (if any) is shown by the bubble, under the picture. */
export function Photo({ id, media, onOpen }: { id: string; media: MediaFetch; onOpen: (src: string) => void }) {
  const { src, holder } = useLazyMedia(id, media);
  if (src && src !== "none") {
    return (
      <button type="button" onClick={() => onOpen(src)} aria-label="Open photo" className="pressable block overflow-hidden rounded-md">
        <img src={src} alt="Photo" className="block max-h-72 w-full max-w-[16rem] bg-on-surface/5 object-cover" draggable={false} />
      </button>
    );
  }
  if (src === "none") return <MediaLabel kind="image" />;
  return (
    <span ref={holder} className="grid h-40 w-52 max-w-full place-items-center rounded-md bg-on-surface/5 text-on-surface-variant">
      <Spinner className="size-5" />
    </span>
  );
}

const LABEL: Record<ThreadMediaKind, string> = { image: "Photo", video: "Video", audio: "Voice note", document: "Document", other: "Attachment" };

/** A kind of message the page doesn't play: say what it is and where to open it. */
export function MediaLabel({ kind, className }: { kind: ThreadMediaKind; className?: string }) {
  return (
    <span className={cx("flex min-w-40 flex-col rounded-md bg-on-surface/5 px-3 py-2", className)}>
      <span className="type-label-l">{LABEL[kind]}</span>
      <span className="type-body-s opacity-70">Open on your phone</span>
    </span>
  );
}

/** Full-screen look at a photo. Tap anywhere, the close button or Escape to leave. */
export function PhotoViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <motion.div role="dialog" aria-modal aria-label="Photo" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.15 } }} className="fixed inset-0 z-[65] flex items-center justify-center bg-black/90 p-2" onClick={onClose}>
      <div className="absolute top-[max(0.5rem,env(safe-area-inset-top))] right-2 z-10">
        <IconButton icon={IconClose} label="Close photo" onClick={onClose} className="text-white" />
      </div>
      <motion.img initial={{ transform: "scale(0.96)" }} animate={{ transform: "scale(1)", transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }} src={src} alt="Photo" className="max-h-full max-w-full object-contain" draggable={false} />
    </motion.div>,
    document.body,
  );
}
