// Profile pictures in the app: comic avatars with the saved photo, and a quiet request to the worker for the ones on screen.
// WhatsApp's picture URLs expire, so an image that fails to load falls back to initials and asks the worker to refresh that one.
import { useEffect } from "react";
import { PHOTO_BATCH_MAX, photoDue, photoSrc } from "@spot/shared";
import { Avatar } from "@spot/ui";
import { useApp } from "./app";
import { runCommand } from "./data";

const asked = new Set<string>(); // per page load: nobody is asked for twice
const refreshed = new Set<string>();
let pending: { uid: string; ids: Set<string>; force: boolean }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  timer = undefined;
  const batches = pending;
  pending = [];
  for (const b of batches) {
    const ids = [...b.ids];
    for (let i = 0; i < ids.length; i += PHOTO_BATCH_MAX) void runCommand(b.uid, "profile_pics", { comicIds: ids.slice(i, i + PHOTO_BATCH_MAX), ...(b.force && { force: true }) }, 30_000).catch(() => undefined);
  }
}

function request(uid: string, id: string, force: boolean) {
  const key = `${uid}|${id}`;
  const seen = force ? refreshed : asked;
  if (seen.has(key)) return;
  seen.add(key);
  let b = pending.find((x) => x.uid === uid && x.force === force);
  if (!b) pending.push((b = { uid, ids: new Set(), force }));
  b.ids.add(id);
  timer ??= setTimeout(flush, 1500);
}

/** A comic's avatar with their WhatsApp photo, when there is one. */
export function ComicAvatar({ id, name, size, tone }: { id: string | null | undefined; name: string; size?: number; tone?: "primary" | "tertiary" | "secondary" }) {
  const { uid, comicsById } = useApp();
  const comic = id ? comicsById.get(id) : undefined;
  useEffect(() => {
    if (comic && photoDue(comic, Date.now())) request(uid, comic.id, false);
  }, [uid, comic]);
  return <Avatar name={name} size={size} tone={tone} src={comic ? photoSrc(comic) : null} onBroken={comic ? () => request(uid, comic.id, true) : undefined} />;
}
