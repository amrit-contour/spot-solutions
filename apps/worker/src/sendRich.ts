// One way to send a template: text (rendered, optionally rewritten in the curator's voice), a poll, or a
// venue pin, plus an optional pin after the text. Everything goes through the same queue and jitter as plain text.
import WAWebJS from "whatsapp-web.js";
import { cleanPoll, hasPin, pollProblem, renderRich, type RichMessage, type TemplateVars, type Venue } from "@spot/shared";
import { sendContent } from "./sendQueue.ts";

export interface SendRichOpts {
  /** Rewrites the rendered text (the "your voice" step). Text only; polls and pins are never rewritten. */
  rewrite?: (text: string) => Promise<string>;
  /** The text and poll are already filled in (a draft the curator edited): don't run the template renderer over them. */
  prerendered?: boolean;
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
  if (r.body.trim()) {
    const text = opts.rewrite ? await opts.rewrite(r.body) : r.body;
    main = await sendContent(client, to, text, text.length);
  }
  if (r.attachLocation && hasPin(venue)) {
    const pin = await sendContent(client, to, venuePin({ ...venue, name: venue.name, area: venue.area }));
    main ??= pin;
  }
  return main;
}
