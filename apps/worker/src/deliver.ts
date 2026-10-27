// Drafts that can be more than text: what a template becomes when it's drafted for review, and how a reviewed draft goes out.
import type WAWebJS from "whatsapp-web.js";
import { messageRich, renderRich, type ComicAction, type MessageKey, type TemplateVars, type Venue, type VoiceKind } from "@spot/shared";
import { sendRich } from "./sendRich.ts";
import { dropSentImage } from "./media.ts";
import { inVoice } from "./voice.ts";
import { watchUser } from "./userData.ts";

/** Fill a message template for a draft: text (in the curator's voice) or the poll / pin it should send, kept in `rich`. */
export async function composeDraft(uid: string, key: Exclude<MessageKey, "groupWelcome">, facts: TemplateVars, venue?: Pick<Venue, "id"> | null): Promise<{ draft: string; rich?: NonNullable<ComicAction["rich"]> }> {
  const { settings } = watchUser(uid);
  const m = messageRich(settings, key);
  const r = renderRich(m, facts);
  const venueId = venue?.id ?? null;
  if (m.kind === "poll" && r.poll) return { draft: "", rich: { kind: "poll", poll: r.poll, venueId } };
  if (m.kind === "location") return { draft: "", rich: { kind: "location", venueId } };
  const draft = await inVoice(uid, key as VoiceKind, r.body, facts as Record<string, string>);
  return { draft, ...((m.attachLocation || m.image) && { rich: { kind: "text" as const, ...(m.attachLocation && { attachLocation: true }), ...(m.image && { image: m.image }), venueId } }) };
}

/** Send a draft as the curator left it: its text, plus the poll or pin it carries. */
export async function deliverDraft(uid: string, client: WAWebJS.Client, to: string, body: string, rich?: ComicAction["rich"] | null, mentions?: string[]) {
  const venue = rich?.venueId ? watchUser(uid).venues.find((v) => v.id === rich.venueId) : null;
  const sent = await sendRich(client, to, { kind: rich?.kind ?? "text", body, poll: rich?.poll, attachLocation: rich?.attachLocation, ...(rich?.image && { image: rich.image }) }, {}, venue, { prerendered: true, mentions, uid, imageRequired: Boolean(rich?.image) });
  if (rich?.image) await dropSentImage(uid, rich.image.path); // a one-time upload; a template's kept picture is left alone
  return sent;
}
