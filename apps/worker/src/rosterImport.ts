// parse_roster: "paste anything" roster import. Text, a file (CSV / JSON / XLSX / PDF / image) or a link goes in; rooms come out for
// the comic app's merge-with-review sheet. Nothing is saved here. Order of preference, cheapest and most exact first:
//   roster JSON / CSV -> the existing readers; XLSX -> read the cells; a WhatsApp curator list -> the deterministic parser;
//   whatever is left (or any other text) -> the account's model; PDF / image -> Gemini only (the local model is text-only).
// The model is wired in through `deps`, so the whole flow is tested with a fake.
import {
  RosterFormatError, ROSTER_AI_SCHEMA, buildRosterPrompt, fromCsv, fromRosterJson, jsonFromReply, mergeParsed, normaliseAiRoster, parseWhatsAppList,
  type ParseRosterResult, type Roster,
} from "@spot/shared";
import { XlsxError, readXlsx, rowsToCsv, rowsToTsv } from "./xlsx.ts";
import { type Fetched } from "./safeFetch.ts";

export interface ParseRosterInput {
  text?: string;
  fileName?: string;
  mime?: string;
  dataBase64?: string;
  url?: string;
  /** City to give rooms that don't say one. */
  city?: string;
}

export interface ImportAi {
  /** Text in, the model's JSON text out. Rejects when no model can answer. */
  text(prompt: string, schema: object): Promise<{ text: string; model: string }>;
  /** A PDF or image in. Rejects with a plain-words message when cloud AI isn't allowed. */
  file(prompt: string, schema: object, file: { mime: string; data: string }): Promise<{ text: string; model: string }>;
}
export interface ImportDeps {
  ai: ImportAi;
  fetchUrl(url: string): Promise<Fetched>;
}

/** An error whose message is fit to show the comic as is. */
export class ImportError extends Error {}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;
const CHUNK_CHARS = 6_000;
const MAX_CHUNKS = 12;

// ---------------------------------------------------------------------------------------------------------------------------
// Reading the input
// ---------------------------------------------------------------------------------------------------------------------------

type Kind = "json" | "csv" | "xlsx" | "pdf" | "image" | "html" | "text";
const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];

function kindOf(buf: Buffer, name: string, mime: string): { kind: Kind; mime: string } {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const head = buf.subarray(0, 12);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return { kind: "pdf", mime: "application/pdf" };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8) return { kind: "image", mime: "image/jpeg" };
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "image", mime: "image/webp" };
  if (head.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|heif)/.test(buf.subarray(8, 12).toString("latin1"))) return { kind: "image", mime: "image/heic" };
  if (head[0] === 0x50 && head[1] === 0x4b) return { kind: "xlsx", mime };
  if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) throw new ImportError("That's an old .xls file. Save it as .xlsx or CSV and upload that.");
  if (ext === "json" || mime === "application/json") return { kind: "json", mime };
  if (ext === "csv" || ext === "tsv" || mime === "text/csv" || mime === "text/tab-separated-values") return { kind: "csv", mime };
  if (ext === "html" || ext === "htm" || mime === "text/html") return { kind: "html", mime };
  if (IMAGE_MIME.includes(mime)) return { kind: "image", mime };
  if (mime.startsWith("text/") || ["txt", "md", "text", ""].includes(ext) || mime === "") return { kind: "text", mime };
  throw new ImportError("I can't read that kind of file. Use a CSV, Excel, PDF or image, or paste the text.");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

/** A web page as plain lines: scripts and styles dropped, block ends and table rows kept as line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|nav|header|footer|aside|main|dd|dt|pre|blockquote)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").replace(/ ?\t ?/g, "\t").trim())
    .filter(Boolean)
    .join("\n");
}

/** A Google Sheets link becomes its CSV export (it works when the sheet is shared as "anyone with the link"). */
export function sheetsExportUrl(raw: string): string | null {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/i.exec(raw.trim());
  if (!m) return null;
  const gid = /[#&?]gid=(\d+)/.exec(raw)?.[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Text to rooms
// ---------------------------------------------------------------------------------------------------------------------------

const tsvToCsv = (text: string) => rowsToCsv(text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("\t")));

/** Does this text start with a header row that has a "room" column (a roster CSV, or a sheet copied from one)? */
function hasRoomHeader(text: string): "csv" | "tsv" | null {
  const first = (text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim()) ?? "").toLowerCase();
  const cols = (sep: string) => first.split(sep).map((c) => c.trim().replace(/^"|"$/g, "").replace(/\s+/g, "_"));
  if (first.includes("\t") && cols("\t").includes("room")) return "tsv";
  if (first.includes(",") && cols(",").includes("room")) return "csv";
  return null;
}

/** Split long text on line boundaries (blank lines first) so a small local model gets a few rooms at a time. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length + 2 > size) flush();
    if (para.length > size) {
      flush();
      for (const line of para.split("\n")) {
        if (cur && cur.length + line.length + 1 > size) flush();
        cur += `${cur ? "\n" : ""}${line.slice(0, size)}`;
      }
      flush();
    } else cur += `${cur ? "\n\n" : ""}${para}`;
  }
  flush();
  return out;
}

const fill = (r: Roster, city?: string): Roster => (city ? { ...r, rooms: r.rooms.map((x) => (x.city ? x : { ...x, city })) } : r);
const result = (r: Roster, rest: Omit<ParseRosterResult, "rooms" | "curators" | "notes" | "warnings"> & { notes?: string[]; warnings?: string[] }): ParseRosterResult => ({
  rooms: r.rooms,
  curators: r.curators,
  notes: rest.notes ?? [],
  warnings: rest.warnings ?? [],
  source: rest.source,
  ...(rest.model && { model: rest.model }),
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ask the model to read these texts; all replies are checked together. */
async function readWithModel(texts: string[], deps: ImportDeps, city: string | undefined, sourceText: string) {
  const chunks = texts.flatMap((t) => chunkText(t));
  const warnings: string[] = [];
  if (chunks.length > MAX_CHUNKS) warnings.push(`That's a lot of text. Only the first ${MAX_CHUNKS} parts (about ${Math.round((MAX_CHUNKS * CHUNK_CHARS) / 1000)} thousand characters) were read.`);
  const replies: Record<string, unknown>[] = [];
  let model = "";
  let failed = 0;
  let lastErr: unknown;
  for (const chunk of chunks.slice(0, MAX_CHUNKS)) {
    try {
      const r = await deps.ai.text(buildRosterPrompt({ text: chunk, city }), ROSTER_AI_SCHEMA);
      model = r.model;
      const j = jsonFromReply(r.text);
      if (j && typeof j === "object") replies.push(j as Record<string, unknown>);
      else failed++;
    } catch (e) {
      failed++;
      lastErr = e;
    }
  }
  if (failed && replies.length) warnings.push(`The model couldn't read ${failed} of ${Math.min(chunks.length, MAX_CHUNKS)} parts of the text, so some rooms may be missing.`);
  const merged = normaliseAiRoster({ rooms: replies.flatMap((r) => (Array.isArray(r.rooms) ? r.rooms : [])), notes: replies.flatMap((r) => (Array.isArray(r.notes) ? r.notes : [])) }, { city, sourceText });
  return { ...merged, warnings: [...warnings, ...merged.warnings], model, answered: replies.length > 0, lastErr };
}

async function fromText(text: string, deps: ImportDeps, city: string | undefined, via: "csv" | "text"): Promise<ParseRosterResult> {
  const body = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const warnings: string[] = body !== text ? [`That's very long, so only the first ${MAX_TEXT_CHARS / 1000} thousand characters were read.`] : [];
  if (!body.trim()) throw new ImportError("There's nothing there to read. Paste a list or pick a file.");

  // 1. Already in roster form.
  if (body.trimStart().startsWith("{")) {
    try {
      const { roster } = fromRosterJson(body);
      if (roster.rooms.length) return result(fill(roster, city), { source: "json", warnings });
    } catch (e) {
      if (!(e instanceof RosterFormatError) || /newer app/.test(e.message)) throw new ImportError(errText(e));
    }
  }
  const header = hasRoomHeader(body);
  if (header) {
    try {
      const roster = fromCsv(header === "tsv" ? tsvToCsv(body) : body);
      if (roster.rooms.length) return result(fill(roster, city), { source: "csv", warnings });
    } catch (e) {
      if (!(e instanceof RosterFormatError)) throw e;
    }
  }

  // 2. A WhatsApp curator list: no model needed.
  const list = parseWhatsAppList(body, { city });
  let base: Roster = { rooms: list.rooms, curators: list.curators };
  const notes = list.preamble.slice(0, 3);
  warnings.push(...list.warnings);
  const sourceText = body;

  if (list.rooms.length && !list.unparsed.length) return result(fill(base, city), { source: "list", notes, warnings });

  // 3. A model for what the list parser couldn't read (or for everything, when it read nothing).
  const toRead = list.rooms.length ? list.unparsed.map((u) => u.raw) : [body];
  let ai: Awaited<ReturnType<typeof readWithModel>> | undefined;
  let aiError: string | undefined;
  try {
    ai = await readWithModel(toRead, deps, city, sourceText);
    if (!ai.answered) aiError = errText(ai.lastErr ?? "no answer");
  } catch (e) {
    aiError = errText(e);
  }
  if (ai?.answered && ai.rooms.length) {
    base = list.rooms.length ? mergeParsed(base, { rooms: ai.rooms, curators: ai.curators }) : { rooms: ai.rooms, curators: ai.curators };
    return result(fill(base, city), { source: list.rooms.length ? "list+ai" : "ai", model: ai.model, notes: [...notes, ...ai.notes], warnings: [...warnings, ...ai.warnings] });
  }
  if (list.rooms.length) {
    // Keep what the list parser got; the lines it couldn't read are on their rooms as notes.
    const why = aiError ? ` (${aiError.replace(/\.$/, "")})` : "";
    warnings.push(`Some lines couldn't be read and are kept as notes on their rooms: ${list.unparsed.map((u) => u.room).join(", ")}${why}.`);
    return result(fill(base, city), { source: "list", notes, warnings });
  }
  if (aiError) throw new ImportError(`That doesn't look like a list I can read without a model, and the model didn't answer: ${aiError.replace(/\.$/, "")}.`);
  throw new ImportError(via === "csv" ? "I couldn't find any rooms in that file. A CSV needs a \"room\" column." : "I couldn't find any rooms in that text. Try a list with a venue name on each heading and days with curators under it.");
}

// ---------------------------------------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------------------------------------

async function fromFile(buf: Buffer, name: string, mimeIn: string, deps: ImportDeps, city: string | undefined): Promise<ParseRosterResult> {
  if (!buf.length) throw new ImportError("That file is empty.");
  if (buf.length > MAX_FILE_BYTES) throw new ImportError("That file is over 5 MB. Paste the text, or upload a smaller file.");
  const { kind, mime } = kindOf(buf, name, mimeIn);
  switch (kind) {
    case "json":
    case "csv":
    case "text":
      return fromText(buf.toString("utf8"), deps, city, kind === "csv" ? "csv" : "text");
    case "html":
      return fromText(htmlToText(buf.toString("utf8")), deps, city, "text");
    case "xlsx": {
      let sheets;
      try {
        sheets = readXlsx(buf);
      } catch (e) {
        throw new ImportError(e instanceof XlsxError ? e.message : "I couldn't read that spreadsheet.");
      }
      const filled = sheets.filter((s) => s.rows.length);
      if (!filled.length) throw new ImportError("That spreadsheet is empty.");
      // A roster export has a "room" header on its first sheet: read it exactly.
      const first = filled[0]!;
      if (first.rows[0]?.some((c) => c.trim().toLowerCase().replace(/\s+/g, "_") === "room")) {
        try {
          const roster = fromCsv(rowsToCsv(first.rows));
          if (roster.rooms.length) return result(fill(roster, city), { source: "xlsx" });
        } catch (e) {
          if (!(e instanceof RosterFormatError)) throw e;
        }
      }
      const text = filled.map((s) => `${filled.length > 1 ? `Sheet: ${s.name}\n` : ""}${rowsToTsv(s.rows)}`).join("\n\n");
      return fromText(text, deps, city, "text");
    }
    case "pdf":
    case "image": {
      let reply;
      try {
        reply = await deps.ai.file(buildRosterPrompt({ city, what: kind === "pdf" ? "The attached PDF" : "The attached picture" }), ROSTER_AI_SCHEMA, { mime, data: buf.toString("base64") });
      } catch (e) {
        throw new ImportError(errText(e));
      }
      const out = normaliseAiRoster(reply.text, { city });
      if (!out.rooms.length) throw new ImportError(`I couldn't find any rooms in that ${kind === "pdf" ? "PDF" : "picture"}.${out.warnings[0] ? ` ${out.warnings[0]}` : ""} A clearer picture, or the text pasted in, usually works.`);
      return result(fill({ rooms: out.rooms, curators: out.curators }, city), {
        source: "ai",
        model: reply.model,
        notes: out.notes,
        warnings: [...out.warnings, `Read from ${kind === "pdf" ? "a PDF" : "a picture"}: check the names and phone numbers before you apply.`],
      });
    }
  }
}

/** The command: whichever of text / file / link the comic gave. */
export async function parseRoster(input: ParseRosterInput, deps: ImportDeps): Promise<ParseRosterResult> {
  const city = typeof input.city === "string" && input.city.trim() ? input.city.trim().slice(0, 60) : undefined;
  const text = typeof input.text === "string" ? input.text : "";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (input.dataBase64) {
    if (typeof input.dataBase64 !== "string" || input.dataBase64.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8) throw new ImportError("That file is over 5 MB. Paste the text, or upload a smaller file.");
    const buf = Buffer.from(input.dataBase64, "base64");
    return fromFile(buf, String(input.fileName ?? "").slice(0, 200), String(input.mime ?? "").toLowerCase().slice(0, 100), deps, city);
  }
  if (url && !text.trim()) {
    const target = sheetsExportUrl(url) ?? url;
    const got = await deps.fetchUrl(target).catch((e: unknown) => {
      throw new ImportError(errText(e));
    });
    if (/(^|\.)accounts\.google\.com$/i.test(new URL(got.url).hostname)) throw new ImportError("That Google Sheet isn't shared. Share it as \"anyone with the link can view\", or download it as a file and upload that.");
    const name = new URL(got.url).pathname.split("/").pop() ?? "";
    return fromFile(got.body, name, got.contentType, deps, city);
  }
  return fromText(text, deps, city, "text");
}
