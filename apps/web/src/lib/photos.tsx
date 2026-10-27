// Profile pictures in the app: comic avatars with the saved photo, WhatsApp group avatars, and a quiet request to the worker for the ones on screen.
// WhatsApp's picture URLs expire, so an image that fails to load falls back to initials and asks the worker to refresh that one.
// Comics keep the picture on their own doc; groups keep it in users/{uid}/waPhotos/{group id} (the worker writes both).
import { useEffect, useMemo, useRef } from "react";
import { WA_PHOTOS, isWaJid, photoDue, photoSrc, type WaPhoto } from "@spot/shared";
import { Avatar, createPhotoRequester, whenVisible } from "@spot/ui";
import { useApp } from "./app";
import { runCommand, useCollection } from "./data";

type Tone = "primary" | "tertiary" | "secondary";

const send = (key: "comicIds" | "chatIds") => (uid: string, ids: string[], force: boolean) =>
  void runCommand(uid, "profile_pics", { [key]: ids, ...(force && { force: true }) }, 30_000).catch(() => undefined);
const requestComic = createPhotoRequester(send("comicIds"));
const requestChat = createPhotoRequester(send("chatIds"));

/** A comic's avatar with their WhatsApp photo, when there is one. Asks the worker for a missing photo only once the avatar is on screen. */
export function ComicAvatar({ id, name, size, tone }: { id: string | null | undefined; name: string; size?: number; tone?: Tone }) {
  const { uid, comicsById, workerOnline } = useApp();
  const comic = id ? comicsById.get(id) : undefined;
  const el = useRef<HTMLSpanElement>(null);
  // Nobody to ask while the server is offline: the request would just queue behind a worker that isn't there.
  const due = workerOnline && Boolean(comic && photoDue(comic, Date.now()));
  const comicId = comic?.id;
  useEffect(() => {
    if (!due || !comicId || !el.current) return;
    return whenVisible(el.current, () => requestComic(uid, comicId, false));
  }, [uid, comicId, due]);
  return <Avatar rootRef={el} name={name} size={size} tone={tone} src={comic ? photoSrc(comic) : null} onBroken={comic ? () => requestComic(uid, comic.id, true) : undefined} />;
}

/** Saved WhatsApp pictures (groups), by id. One shared listener however many avatars are on the page. */
export function useWaPhotos() {
  const { uid } = useApp();
  const photos = useCollection<WaPhoto>(uid, WA_PHOTOS);
  return useMemo(() => new Map(photos.data.map((p) => [p.id, p])), [photos.data]);
}

/** A WhatsApp group's avatar (its picture, or initials on a group colour). Same lazy ask as comics. `groupId` is the group's @g.us id. */
export function GroupAvatar({ groupId, name, size, tone = "tertiary" }: { groupId: string | null | undefined; name: string; size?: number; tone?: Tone }) {
  const { uid, workerOnline } = useApp();
  const photos = useWaPhotos();
  const id = isWaJid(groupId) ? groupId : undefined;
  const photo = id ? photos.get(id) : undefined;
  const el = useRef<HTMLSpanElement>(null);
  const due = workerOnline && Boolean(id) && photoDue(photo ?? {}, Date.now());
  useEffect(() => {
    if (!due || !id || !el.current) return;
    return whenVisible(el.current, () => requestChat(uid, id, false));
  }, [uid, id, due]);
  return <Avatar rootRef={el} name={name} size={size} tone={tone} src={photo ? photoSrc(photo) : null} onBroken={id ? () => requestChat(uid, id, true) : undefined} />;
}
