// One way to send a template: text (rendered, optionally rewritten in the curator's voice), a poll, or a
// venue pin, plus an optional pin after the text. Everything goes through the same queue and jitter as plain text.
import WAWebJS from "whatsapp-web.js";
import { cleanPoll, hasPin, pollProblem, renderRich, type RichMessage, type TemplateVars, type Venue } from "@spot/shared";
import { sendContent } from "./sendQueue.ts";
import { loadOutImage } from "./media.ts";

export interface SendRichOpts {
  /** Rewrites the rendered text (the "your voice" step). Text only; polls and pins are never rewritten. */
  rewrite?: (text: string) => Promise<string>;
  /** The text and poll are already filled in (a draft the curator edited): don't run the template renderer over them. */
  prerendered?: boolean;
  /** Group messages: people tagged in the text ("@<number>" in the text, their ids here). */
  mentions?: string[];
  /**
   * Whose message this is. A message with a picture needs it: the picture's path is only trusted when it is inside this account's
   * own folders (a path in a settings document could name anyone's file).
   */
  uid?: string;
  /** The picture is part of the message: if it can't be loaded the send fails (a scheduled post says so) instead of going out as text alone. */
  imageRequired?: boolean;
}

type VenuePin = Pick<Venue, "name" | "area" | "lat" | "lng">;

export const venuePin = (venue: VenuePin & { lat: number; lng: number }) =>
  new WAWebJS.Location(venue.lat, venue.lng, { name: venue.name, ...(venue.area && { address: venue.area }) });

/**
 * Send `msg` to `to`. Returns the main message (the text, the poll, or the pin), or undefined when there was
 * nothing to send: a pin with no venue coordinates is skipped silently.
 */
export async function sendRich(client: WAWebJS.Client, to: string, msg: RichMessage, vars: TemplateVars, venue?: VenuePin | null, opts: SendRichOpts = {}) {
  const r = opts.prerendered ? { ...msg, body: msg.body.trim(), ...(msg.poll && { poll: cleanPoll(msg.poll) }) } : renderRich(msg, vars);
  if (r.kind === "poll") {
    const problem = pollProblem(r.poll);
    if (problem || !r.poll) throw new Error(problem ?? "The poll is empty.");
    const p = cleanPoll(r.poll);
    return sendContent(client, to, new WAWebJS.Poll(p.question, p.options, { allowMultipleAnswers: p.multi, messageSecret: undefined }), p.question.length);
  }
  if (r.kind === "location") return hasPin(venue) ? sendContent(client, to, venuePin({ ...venue, name: venue.name, area: venue.area })) : undefined;
  let main: WAWebJS.Message | undefined;
  const text = r.body.trim() ? (opts.rewrite ? await opts.rewrite(r.body) : r.body) : "";
  const pic = r.image ? await loadPicture(r.image, opts) : null;
  if (pic) {
    // The text is the picture's caption: one message, not two. Deleting a one-time upload is the caller's job (dropSentImage), once
    // the last copy is out: an offer to five comics sends the same file five times.
    const options = { ...(text && { caption: text }), ...(opts.mentions?.length && { mentions: opts.mentions }) };
    main = await sendContent(client, to, new WAWebJS.MessageMedia(pic.mime, pic.data, pic.name), text.length, options);
  } else if (text) {
    main = await sendContent(client, to, text, text.length, opts.mentions?.length ? { mentions: opts.mentions } : undefined);
  }
  if (r.attachLocation && hasPin(venue)) {
    const pin = await sendContent(client, to, venuePin({ ...venue, name: venue.name, area: venue.area }));
    main ??= pin;
  }
  return main;
}

async function loadPicture(image: NonNullable<RichMessage["image"]>, opts: SendRichOpts) {
  try {
    if (!opts.uid) throw new Error("This message has a picture but no account to check it against.");
    return await loadOutImage(opts.uid, image);
  } catch (e) {
    if (opts.imageRequired) throw e;
    console.warn(`[send] picture skipped, sending the text alone: ${(e as Error).message}`);
    return null;
  }
}
