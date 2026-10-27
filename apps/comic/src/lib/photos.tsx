// Profile pictures in Nothing BOT Comedy: curators (from the number the comic saved) and WhatsApp groups. The comic's own server asks WhatsApp
// for them, one at a time and a little randomly, and keeps each in users/{uid}/waPhotos/{WhatsApp id}. Only the curators and groups on
// screen are ever asked about, so a comic's photos are exactly the people they have. WhatsApp's picture links expire: one that stops
// loading falls back to initials and asks the server for a fresh one.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { onSnapshot } from "firebase/firestore";
import { WA_PHOTOS, isWaJid, jidForPhone, photoDue, photoSrc, type Curator, type WaPhoto } from "@spot/shared";
import { Avatar, createPhotoRequester, whenVisible } from "@spot/ui";
import { runCommand } from "./commands";
import { userCol } from "./data";

type Tone = "primary" | "tertiary" | "secondary";

const request = createPhotoRequester((uid, ids, force) => void runCommand(uid, "profile_pics", { chatIds: ids, ...(force && { force: true }) }, 30_000).catch(() => undefined));

// One Firestore listener for every avatar on the page, closed shortly after the last one goes.
type Store = { photos: Map<string, WaPhoto>; subs: Set<() => void>; stop?: () => void; timer?: ReturnType<typeof setTimeout> };
const stores = new Map<string, Store>();
const EMPTY = new Map<string, WaPhoto>();

function storeFor(uid: string) {
  let s = stores.get(uid);
  if (!s) stores.set(uid, (s = { photos: EMPTY, subs: new Set() }));
  return s;
}

function subscribe(uid: string, cb: () => void) {
  const s = storeFor(uid);
  clearTimeout(s.timer);
  s.subs.add(cb);
  s.stop ??= onSnapshot(
    userCol(uid, WA_PHOTOS),
    (q) => {
      s.photos = new Map(q.docs.map((d) => [d.id, { ...(d.data() as WaPhoto), id: d.id }]));
      s.subs.forEach((f) => f());
    },
    () => undefined, // no photos yet, or the rules don't allow it: everyone keeps their initials
  );
  return () => {
    s.subs.delete(cb);
    if (s.subs.size) return;
    s.timer = setTimeout(() => {
      if (s.subs.size) return;
      s.stop?.();
      s.stop = undefined;
    }, 120_000);
  };
}

function usePhoto(uid: string, jid: string | null): WaPhoto | undefined {
  const photos = useSyncExternalStore(
    (cb) => subscribe(uid, cb),
    () => storeFor(uid).photos,
  );
  return jid ? photos.get(jid) : undefined;
}

/** The picture of one WhatsApp id (a curator's number or a group), as an avatar. Asks the server for a missing or old one once the avatar is on screen. */
function WaAvatar({ uid, jid, name, size, tone }: { uid: string; jid: string | null; name: string; size?: number; tone?: Tone }) {
  const id = isWaJid(jid) ? jid : null;
  const photo = usePhoto(uid, id);
  const el = useRef<HTMLSpanElement>(null);
  const due = Boolean(id) && photoDue(photo ?? {}, Date.now());
  useEffect(() => {
    if (!due || !id || !el.current) return;
    return whenVisible(el.current, () => request(uid, id, false));
  }, [uid, id, due]);
  return <Avatar rootRef={el} name={name} size={size} tone={tone} src={photo ? photoSrc(photo) : null} onBroken={id ? () => request(uid, id, true) : undefined} />;
}

/** A curator's avatar. No number saved, or signed out (the dev demo): initials only, nothing is asked. */
export function CuratorAvatar({ uid, curator, size = 40, tone = "primary" }: { uid?: string; curator: Pick<Curator, "name" | "phone">; size?: number; tone?: Tone }) {
  const jid = jidForPhone(curator.phone);
  return uid && jid ? <WaAvatar uid={uid} jid={jid} name={curator.name} size={size} tone={tone} /> : <Avatar name={curator.name} size={size} tone={tone} />;
}

/** A WhatsApp group's avatar. `groupId` is the group's @g.us id. */
export function GroupAvatar({ uid, groupId, name, size = 40, tone = "tertiary" }: { uid?: string; groupId: string; name: string; size?: number; tone?: Tone }) {
  return uid ? <WaAvatar uid={uid} jid={groupId} name={name} size={size} tone={tone} /> : <Avatar name={name} size={size} tone={tone} />;
}
