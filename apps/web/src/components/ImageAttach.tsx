// Attaching a picture to a message: pick (the phone offers the camera or the library), squeeze, upload to the curator's own Storage
// folder, show a thumbnail with a Remove button. `useImageAttachment` is the logic; the chat composer draws its own chip around it,
// and `ImageField` is the same thing as a block for the message editors (templates, scheduled group posts, offers, replies).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { formatBytes, parseImagePath, type ImageScope, type MessageImage } from "@spot/shared";
import { Button, IconClose, Spinner, cx } from "@spot/ui";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { deleteImage, prepareImage, uploadImage } from "../lib/pictures";

export function IconImageGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
    </svg>
  );
}

export interface Attachment {
  path: string;
  name: string;
  bytes: number;
  /** Object URL of the squeezed picture, for the thumbnail. */
  previewUrl: string;
}

export type AttachStatus = "idle" | "preparing" | "uploading" | "ready";

/**
 * One attached picture. `pick` squeezes and uploads it; `remove` deletes the upload; `release` lets go of it without deleting
 * (it was sent, and the server deletes a sent one-time upload). A picture still attached when the component goes away is deleted,
 * unless `keepOnUnmount`.
 */
export function useImageAttachment(scope: ImageScope, opts: { keepOnUnmount?: boolean } = {}) {
  const { uid } = useApp();
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [status, setStatus] = useState<AttachStatus>("idle");
  const latest = useRef<Attachment | null>(null);
  // A one-time upload (outbox) is deleted the moment it is taken off the message. A kept one (attachments) is only ever deleted by the
  // server, once no template or scheduled post uses it: a saved message may still point at it, or another post may have copied it.
  const discard = useCallback(
    (a: Attachment) => {
      URL.revokeObjectURL(a.previewUrl);
      if (scope === "outbox" && !isDemoUser()) void deleteImage(uid, a.path);
    },
    [uid, scope],
  );
  latest.current = attachment;
  const token = useRef(0);

  const pick = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return;
      const mine = ++token.current;
      setStatus("preparing");
      try {
        const img = await prepareImage(file);
        if (mine !== token.current) return void URL.revokeObjectURL(img.previewUrl);
        setStatus("uploading");
        // The demo has no storage of its own: the picture stays on the device, and sending is off in the demo anyway.
        const path = isDemoUser() ? `users/${uid}/${scope}/demo${Date.now().toString(36)}.jpg` : await uploadImage(uid, scope, img.blob);
        if (mine !== token.current) return void discard({ path, name: img.name, bytes: img.bytes, previewUrl: img.previewUrl });
        const old = latest.current;
        setAttachment({ path, name: img.name, bytes: img.bytes, previewUrl: img.previewUrl });
        setStatus("ready");
        if (old) discard(old);
      } catch (e) {
        if (mine === token.current) setStatus(latest.current ? "ready" : "idle");
        toast.error(friendly(e));
      }
    },
    [uid, scope, discard],
  );

  /** Take it off the message and delete the upload. */
  const remove = useCallback(() => {
    token.current++;
    const a = latest.current;
    setAttachment(null);
    setStatus("idle");
    if (a) discard(a);
  }, [discard]);

  /** It was sent: forget it here, leave the file (the server deletes it after sending). */
  const release = useCallback(() => {
    token.current++;
    setAttachment(null);
    setStatus("idle");
  }, []);

  useEffect(
    () => () => {
      const a = latest.current;
      if (a && !opts.keepOnUnmount) discard(a);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [discard],
  );

  return { attachment, status, busy: status === "preparing" || status === "uploading", pick, remove, release };
}

const friendly = (e: unknown) => {
  const m = (e as Error)?.message ?? "";
  if (/unauthorized|permission|storage\/unauthorized/i.test(m)) return "Couldn't upload the photo. Check you're signed in, then try again.";
  if (/network|offline|retry-limit/i.test(m)) return "Couldn't upload the photo. Check your connection and try again.";
  return m || "Couldn't add that photo.";
};

/** The hidden file input behind an attach button. `accept="image/*"` is what makes a phone offer the camera as well as the library. */
export function PickImage({ onPick, children }: { onPick: (file: File) => void; children: (open: () => void) => ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept="image/*" hidden aria-hidden tabIndex={-1} onChange={(e) => (e.target.files?.[0] && onPick(e.target.files[0]), (e.target.value = ""))} />
      {children(() => input.current?.click())}
    </>
  );
}

/** A saved picture's thumbnail: read from the curator's own Storage folder when the editor opens. */
function useSavedThumb(path: string | undefined, skip: boolean) {
  const { uid } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path || skip || !parseImagePath(uid, path)) return setUrl(null);
    let gone = false;
    let made: string | null = null;
    void import("../lib/pictures").then(async ({ readOwnPicture }) => {
      const u = await readOwnPicture(path).catch(() => null);
      if (gone) return void (u && URL.revokeObjectURL(u));
      made = u;
      setUrl(u);
    });
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path, skip, uid]);
  return url;
}

/**
 * The picture on a message in an editor. `scope`: "outbox" for a message that is sent once (a reply, an offer; the server deletes the
 * file after sending), "attachments" for one that is saved and sent again (a template, a scheduled group post; it stays until you
 * remove it). A replaced or removed picture that was saved earlier is not deleted here (the saved message still points at it until
 * you save): `onDropped` tells the editor, which deletes it once the change is saved.
 */
export function ImageField({
  value,
  onChange,
  scope,
  disabled,
  label = "Add a photo",
  hint,
  className,
}: {
  value: MessageImage | undefined;
  onChange: (image: MessageImage | undefined) => void;
  scope: ImageScope;
  disabled?: boolean;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const att = useImageAttachment(scope, { keepOnUnmount: true });
  const mine = att.attachment && value?.path === att.attachment.path ? att.attachment : null;
  const saved = useSavedThumb(value?.path, Boolean(mine));
  const thumb = mine?.previewUrl ?? saved;

  // A picture picked here goes onto the message as soon as its upload is done.
  const picked = att.attachment?.path;
  useEffect(() => {
    if (att.attachment && att.attachment.path !== value?.path) onChange({ path: att.attachment.path, name: att.attachment.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  const clear = () => {
    // One picked in this session and not yet saved is ours to delete. A saved one stays until the editor saves the change.
    if (mine) att.remove();
    onChange(undefined);
  };

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {value || att.busy ? (
        <div className="flex items-center gap-3 rounded-lg bg-surface-container p-2">
          <span className="grid size-16 flex-none place-items-center overflow-hidden rounded-md bg-on-surface/5">
            {thumb ? <img src={thumb} alt="Attached photo" className="size-full object-cover" /> : <Spinner className="size-5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate type-label-l">{att.status === "preparing" ? "Preparing photo…" : att.status === "uploading" ? "Uploading…" : "Photo"}</span>
            <span className="block type-body-s text-on-surface-variant">{mine ? `${formatBytes(mine.bytes)} · the text above goes as its caption` : "The text above goes as its caption"}</span>
          </span>
          <PickImage onPick={(f) => void att.pick(f)}>
            {(open) => (
              <Button type="button" size="sm" variant="text" onClick={open} disabled={disabled || att.busy}>
                Change
              </Button>
            )}
          </PickImage>
          <button type="button" onClick={clear} disabled={disabled} aria-label="Remove the photo" className="state-layer grid size-10 flex-none place-items-center rounded-full text-on-surface-variant">
            <IconClose className="icon size-5" />
          </button>
        </div>
      ) : (
        <PickImage onPick={(f) => void att.pick(f)}>
          {(open) => (
            <Button type="button" size="sm" variant="outlined" icon={IconImageGlyph} onClick={open} disabled={disabled} className="self-start">
              {label}
            </Button>
          )}
        </PickImage>
      )}
      {hint && !value && <p className="type-body-s text-on-surface-variant">{hint}</p>}
    </div>
  );
}
