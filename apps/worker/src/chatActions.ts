// Messages page actions that are more than reading: react to a message, send a photo. Small and dependency-injected so they are
// tested with fakes (no WhatsApp). The photo arrives inside a short-lived command document that the app deletes once it is done.
import { PHOTO_SEND_MAX_BYTES } from "@spot/shared";

export interface PhotoPayload {
  mime: "image/jpeg" | "image/png" | "image/webp";
  /** Base64, no "data:" prefix. */
  data: string;
  caption: string;
  filename: string;
}

/** Checks what the app sent. Only a still image of a sane size goes out, with a caption of at most 1000 characters. */
export function parsePhotoPayload(p: Record<string, unknown>): PhotoPayload {
  const mime = String(p.mime ?? "");
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") throw new Error("Only photos can be sent from here.");
  const data = String(p.data ?? "").replace(/^data:[^,]*,/, "");
  if (!data) throw new Error("There's no photo to send.");
  // Base64 is 4 characters per 3 bytes. The app squeezes to PHOTO_SEND_MAX_BYTES; allow a little slack.
  if ((data.length * 3) / 4 > PHOTO_SEND_MAX_BYTES * 1.25) throw new Error("That photo is too big to send from here. Pick a smaller one.");
  const filename = String(p.filename ?? "photo").replace(/[^\w.\- ]/g, "").slice(0, 60) || "photo";
  return { mime, data, caption: String(p.caption ?? "").trim().slice(0, 1000), filename };
}

/** The emoji to react with: one short emoji string, or "" to take your reaction back. */
export function parseEmoji(v: unknown): string {
  const e = String(v ?? "").trim();
  if (e.length > 16) throw new Error("That isn't an emoji.");
  if (e && !/\p{Extended_Pictographic}/u.test(e)) throw new Error("That isn't an emoji.");
  return e;
}

export interface Reactable {
  react: (emoji: string) => Promise<unknown>;
}
export async function reactTo(msg: Reactable | undefined, emoji: string) {
  if (!msg) throw new Error("That message isn't available any more.");
  await msg.react(emoji);
  return { emoji };
}

/** Send a parsed photo to a chat that was already checked (roster comic or linked group, not on Never read). */
export async function sendPhoto<M>(send: (chatId: string, media: M, opts: { caption?: string }) => Promise<unknown>, makeMedia: (mime: string, data: string, filename: string) => M, chatId: string, photo: PhotoPayload) {
  await send(chatId, makeMedia(photo.mime, photo.data, photo.filename), photo.caption ? { caption: photo.caption } : {});
  return { sent: true };
}
