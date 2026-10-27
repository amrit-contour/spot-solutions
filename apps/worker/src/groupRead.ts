// Reading a message from a group the comic chose to watch: what to ask the model, and how to take its answer. The model only
// says what KIND of message it is and which room / person it names; dates, times and flags come from the rules in
// @spot/shared (groupAlerts.ts), which don't make things up. Pure, so it is tested without a model (groupRead.test.ts).
import { heuristicRead, type AiRead, type GroupMsg, type GroupReadKind, type Room } from "@spot/shared";

const KINDS: GroupReadKind[] = ["spot_offer", "closure", "opening_notice", "schedule_update", "other"];

export const GROUP_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: KINDS },
    room: { type: "string" },
    show: { type: "string" },
    contact: { type: "string", enum: ["sender", "mentioned", "named"] },
    contact_name: { type: "string" },
  },
  required: ["kind", "room", "show", "contact", "contact_name"],
};

/** The comic's rooms as the model sees them: name, area, and the other names it goes by. Capped so a long list stays quick. */
export function roomLines(rooms: Pick<Room, "name" | "area" | "aliases" | "brand">[], max = 80): string {
  if (!rooms.length) return "- (none yet)";
  return rooms
    .slice(0, max)
    .map((r) => `- ${r.name}${r.area ? ` (${r.area})` : ""}${r.aliases.length ? `, also called: ${r.aliases.join(", ")}` : ""}`)
    .join("\n");
}

const EXAMPLES: [string, AiRead][] = [
  ["Spots available for both 9:30 and 11 pm today at TAG. DM", { kind: "spot_offer", room: "TAG", show: "", contactKind: "sender", contactName: "" }],
  ["Busking spot available at 6pm today at comedy theatre. DM if you can reach by 5.40pm.", { kind: "spot_offer", room: "comedy theatre", show: "", contactKind: "sender", contactName: "" }],
  ["Spot at Banter tonight at 9, PM @Akhil", { kind: "spot_offer", room: "Banter", show: "", contactKind: "mentioned", contactName: "Akhil" }],
  ["Closed Thank you", { kind: "closure", room: "", show: "", contactKind: "sender", contactName: "" }],
  ["Wednesday, Thursday, Friday, and Saturday spots are over for this week at Comedy Square.", { kind: "closure", room: "Comedy Square", show: "", contactKind: "sender", contactName: "" }],
  ["ministry spots will open by 3:15pm", { kind: "opening_notice", room: "ministry", show: "", contactKind: "sender", contactName: "" }],
  ["Comedy Square – Curation Schedule: Monday: @Vishal, Tuesday: @Varun, Wednesday to Saturday: Akhil", { kind: "schedule_update", room: "Comedy Square", show: "", contactKind: "sender", contactName: "" }],
  ["Great set last night everyone!", { kind: "other", room: "", show: "", contactKind: "sender", contactName: "" }],
];

const example = ([text, a]: [string, AiRead]) =>
  `Message: ${text}\nAnswer: ${JSON.stringify({ kind: a.kind, room: a.room ?? "", show: a.show ?? "", contact: a.contactKind ?? "sender", contact_name: a.contactName ?? "" })}`;

/** The prompt for one group message. Small local models read this too, so it is short, has examples, and asks for little. */
export function buildGroupPrompt(msg: Pick<GroupMsg, "text" | "sender">, rooms: Pick<Room, "name" | "area" | "aliases" | "brand">[], now: { date: string; time: string; weekday: number }): string {
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const text = msg.text.length > 600 ? `${msg.text.slice(0, 600)}…` : msg.text;
  return `You read one message from a WhatsApp group of stand-up comedy comics and open-mic curators in an Indian city. Decide what it is.

kind is exactly one of:
- spot_offer: someone offers spots to perform ("Spots available at 7 and 9 today at Banter, DM", "busking spot at 6", "DM for spots at UGC", "PM @x for a spot").
- closure: spots are taken or over ("Closed", "Over, thanks!", "Spots full Square Sunday", "Wed to Sat spots are over this week at Comedy Square").
- opening_notice: when or how spots will open ("ministry spots will open by 3:15pm", "website is open for spots now").
- schedule_update: who curates which day ("Comedy Square Curation Schedule: Monday: @A, Tuesday: @B").
- other: everything else: chat, jokes, thanks, shows to attend, questions. When unsure, other.

room: the venue the message is about, as written ("TAG", "comedy theatre", "church street"), or "". If it names no venue, "".
show: "mic", "show" or similar only if the message says so, else "".
contact: who to message about the spot. "sender" when it says DM (me), or says nothing; "mentioned" when it tags a person ("PM @Akhil"); "named" when it names someone without tagging ("DM Dhruv"). contact_name: that person's name, else "".

The comic's own venues (use their names when the message points at one):
${roomLines(rooms)}

Today is ${DAYS[now.weekday]} ${now.date}, ${now.time} now. The message was written by ${msg.sender.name || "someone"}.

${EXAMPLES.map(example).join("\n\n")}

Message: ${text}
Reply ONLY with JSON: {"kind": "...", "room": "...", "show": "...", "contact": "sender|mentioned|named", "contact_name": "..."}`;
}

/** The model's answer as an AiRead. A reply that isn't JSON, or has an unknown kind, is an error (so the rules take over) or "other". */
export function parseAiRead(raw: string): AiRead {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model didn't answer in JSON");
  const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const kind = KINDS.includes(o.kind as GroupReadKind) ? (o.kind as GroupReadKind) : "other";
  const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");
  const ck = o.contact === "mentioned" || o.contact === "named" ? o.contact : "sender";
  return { kind, room: str(o.room), show: str(o.show), contactKind: ck, contactName: str(o.contact_name) };
}

/** Ask the model; if it is too slow (`budgetMs`), errors or answers badly, the rules read the message instead: an offer can't wait minutes. */
export async function readWithFallback(
  ask: () => Promise<string>,
  msg: Pick<GroupMsg, "text" | "mentioned">,
  budgetMs: number,
): Promise<{ read: AiRead; by: "model" | "rules"; why?: string }> {
  try {
    const raw = await Promise.race([ask(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${Math.round(budgetMs / 1000)}s`)), budgetMs).unref())]);
    return { read: parseAiRead(raw), by: "model" };
  } catch (e) {
    return { read: heuristicRead(msg.text, msg.mentioned), by: "rules", why: (e as Error).message };
  }
}
