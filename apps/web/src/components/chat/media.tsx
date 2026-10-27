// Pictures in a chat. Nothing is downloaded by looking at a chat: a photo or sticker is a placeholder (icon, "Photo", the caption,
// the size when WhatsApp says) with a View button. Tapping View asks the server for that one message (fetch_media), which puts it in a
// short-lived cache file. The picture then shows in the bubble and in a full-screen viewer (pinch, double-tap, drag). The cache
// files of a chat are deleted when it is closed. Videos, voice notes and documents get a label: they open on your phone.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { formatBytes, type ThreadMediaKind } from "@spot/shared";
import { Button, IconButton, IconClose, cx } from "@spot/ui";
import { useApp } from "../../lib/app";
import { forgetPicture, type FetchedPicture } from "../../lib/pictures";
import { IconImageGlyph } from "../ImageAttach";

export type PictureState = { state: "idle" } | { state: "loading" } | { state: "ready"; pic: FetchedPicture } | { state: "error"; error: string };

/**
 * The pictures the curator has asked to see in one chat. `view` fetches one (and only one) when called; the rest of the chat is never
 * touched. Leaving the chat deletes every cache file this chat made.
 */
export function usePictures(fetch: (messageId: string) => Promise<FetchedPicture>, chatKey: string) {
  const { uid } = useApp();
  const [all, setAll] = useState<Record<string, PictureState>>({});
  const held = useRef(new Map<string, FetchedPicture>());
  const fetching = useRef(new Set<string>());
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  const view = useCallback(async (id: string): Promise<FetchedPicture | null> => {
    const have = held.current.get(id);
    if (have) return have;
    if (fetching.current.has(id)) return null;
    fetching.current.add(id);
    setAll((s) => ({ ...s, [id]: { state: "loading" } }));
    try {
      const pic = await fetchRef.current(id);
      held.current.set(id, pic);
      setAll((s) => ({ ...s, [id]: { state: "ready", pic } }));
      return pic;
    } catch (e) {
      setAll((s) => ({ ...s, [id]: { state: "error", error: (e as Error).message } }));
      return null;
    } finally {
      fetching.current.delete(id);
    }
  }, []);

  // Closing the chat (or opening another) deletes the cache files it made and lets go of the pictures.
  useEffect(() => {
    setAll({});
    const mine = held.current;
    return () => {
      for (const p of mine.values()) void forgetPicture(uid, p);
      mine.clear();
    };
  }, [uid, chatKey]);

  return { get: (id: string): PictureState => all[id] ?? { state: "idle" }, view };
}

const KIND_LABEL: Record<"image" | "sticker", string> = { image: "Photo", sticker: "Sticker" };

/**
 * A photo or sticker before it is fetched: what it is and how big, the caption, and a View button. Once fetched it is the picture
 * itself (tap it to open it full screen). `onView` fetches it; `onOpen` opens the viewer with the fetched picture.
 */
export function MediaPlaceholder({ kind, status, bytes, caption, onView, onOpen }: { kind: "image" | "sticker"; status: PictureState; bytes?: number; caption?: ReactNode; onView: () => void; onOpen: (url: string) => void }) {
  if (status.state === "ready") {
    return kind === "sticker" ? (
      <img src={status.pic.url} alt="Sticker" width={144} height={144} className="size-36 object-contain" draggable={false} />
    ) : (
      <>
        <button type="button" onClick={() => onOpen(status.pic.url)} aria-label="Open photo full screen" className="pressable block overflow-hidden rounded-md">
          <img src={status.pic.url} alt="Photo" className="block max-h-72 w-full max-w-[16rem] bg-on-surface/5 object-cover" draggable={false} />
        </button>
        {caption && <div className="px-2.5 pt-1.5">{caption}</div>}
      </>
    );
  }
  const size = formatBytes(bytes);
  const loading = status.state === "loading";
  return (
    <div className={cx("flex flex-col gap-2 rounded-md bg-on-surface/5 p-3", kind === "sticker" ? "w-36" : "w-56 max-w-full")} data-media-placeholder={kind}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-10 flex-none place-items-center rounded-full bg-on-surface/8 text-on-surface-variant">
          <IconImageGlyph className="icon size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block type-label-l">{KIND_LABEL[kind]}</span>
          {size && <span className="block type-body-s opacity-70">{size}</span>}
        </span>
      </div>
      {caption && <div>{caption}</div>}
      {status.state === "error" && (
        <p role="alert" className="type-body-s text-error">
          {status.error}
        </p>
      )}
      <Button type="button" size="sm" variant="tonal" loading={loading} onClick={onView} aria-label={`View ${KIND_LABEL[kind].toLowerCase()}`} className="self-start">
        {loading ? "Fetching…" : status.state === "error" ? "Try again" : "View"}
      </Button>
    </div>
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

// ---------- Full-screen viewer ----------

const MAX_SCALE = 6;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
type View = { s: number; x: number; y: number };
type Pt = { x: number; y: number };

/** Keep the picture's edges from leaving the screen while zoomed in: at most half the extra size either way. */
export function clampView(v: View, box: { w: number; h: number }): View {
  const mx = (box.w * (v.s - 1)) / 2;
  const my = (box.h * (v.s - 1)) / 2;
  return v.s <= 1 ? { s: 1, x: 0, y: 0 } : { s: v.s, x: clamp(v.x, -mx, mx), y: clamp(v.y, -my, my) };
}

/** Zoom to `s`, keeping the point under (cx, cy) (relative to the picture's centre) where it is. */
export function zoomAbout(v: View, s: number, cx: number, cy: number): View {
  const k = clamp(s, 1, MAX_SCALE) / v.s;
  return { s: v.s * k, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
}

/** The picture, with pinch to zoom, double-tap (or double-click) to toggle zoom, drag to pan and the wheel to zoom. */
function ZoomImage({ src }: { src: string }) {
  const [v, setV] = useState<View>({ s: 1, x: 0, y: 0 });
  const el = useRef<HTMLImageElement>(null);
  const pts = useRef(new Map<number, Pt>());
  const gesture = useRef<{ dist: number; v: View; mid: Pt } | null>(null);
  const lastTap = useRef(0);
  const dragged = useRef(false);
  const box = () => ({ w: el.current?.offsetWidth ?? 0, h: el.current?.offsetHeight ?? 0 });
  const centre = (p: Pt) => {
    const r = el.current?.parentElement?.getBoundingClientRect();
    return r ? { x: p.x - (r.left + r.width / 2), y: p.y - (r.top + r.height / 2) } : { x: 0, y: 0 };
  };
  const dist = () => {
    const [a, b] = [...pts.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const mid = (): Pt => {
    const [a, b] = [...pts.current.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const toggle = (at: Pt) => setV((c) => (c.s > 1.05 ? { s: 1, x: 0, y: 0 } : clampView(zoomAbout(c, 2.5, centre(at).x, centre(at).y), box())));

  return (
    <div
      className="flex size-full touch-none items-center justify-center overflow-hidden"
      // A tap on the empty black around the picture (not zoomed in, not the end of a drag) closes the viewer; anything else stays.
      onClick={(e) => {
        // Pointer capture retargets the click to this box, so "outside the picture" is decided by where the tap landed.
        const r = el.current?.getBoundingClientRect();
        const outside = !r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (!(outside && v.s <= 1.05 && !dragged.current)) e.stopPropagation();
      }}
      onWheel={(e) => {
        const c = centre({ x: e.clientX, y: e.clientY });
        setV((cur) => clampView(zoomAbout(cur, cur.s * Math.exp(-e.deltaY * 0.0025), c.x, c.y), box()));
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        dragged.current = false;
        if (pts.current.size === 2) gesture.current = { dist: dist(), v, mid: mid() };
      }}
      onPointerMove={(e) => {
        const prev = pts.current.get(e.pointerId);
        if (!prev) return;
        const now = { x: e.clientX, y: e.clientY };
        pts.current.set(e.pointerId, now);
        if (pts.current.size >= 2 && gesture.current) {
          dragged.current = true;
          const g = gesture.current;
          const m = mid();
          const zoomed = zoomAbout(g.v, g.v.s * (dist() / (g.dist || 1)), centre(g.mid).x, centre(g.mid).y);
          setV(clampView({ s: zoomed.s, x: zoomed.x + (m.x - g.mid.x), y: zoomed.y + (m.y - g.mid.y) }, box()));
        } else if (pts.current.size === 1 && v.s > 1) {
          if (Math.hypot(now.x - prev.x, now.y - prev.y) > 0) dragged.current = true;
          setV((cur) => clampView({ ...cur, x: cur.x + now.x - prev.x, y: cur.y + now.y - prev.y }, box()));
        }
      }}
      onPointerUp={(e) => {
        const wasOne = pts.current.size === 1;
        pts.current.delete(e.pointerId);
        gesture.current = null;
        if (wasOne && !dragged.current) {
          const now = Date.now();
          if (now - lastTap.current < 300) {
            lastTap.current = 0;
            toggle({ x: e.clientX, y: e.clientY });
          } else lastTap.current = now;
        }
      }}
      onPointerCancel={(e) => {
        pts.current.delete(e.pointerId);
        gesture.current = null;
      }}
    >
      <img
        ref={el}
        src={src}
        alt="Photo"
        draggable={false}
        style={{ transform: `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`, transition: pts.current.size ? "none" : "transform 160ms cubic-bezier(0.23, 1, 0.32, 1)" }}
        className="max-h-full max-w-full object-contain will-change-transform select-none"
      />
    </div>
  );
}

/** Full-screen look at a photo. Pinch or double-tap to zoom. Tap outside the picture, the close button or Escape to leave. */
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
      <ZoomImage src={src} />
    </motion.div>,
    document.body,
  );
}
