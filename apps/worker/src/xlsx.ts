// A small, dependency-free .xlsx reader: a zip of XML files. Reads the cell text of every sheet (shared strings, inline strings,
// numbers as written). Dates and times stored as serial numbers come out as the number: the roster import hands the text to a
// model or to the CSV reader, neither of which needs them.
import { inflateRawSync } from "node:zlib";

const MAX_ENTRY = 24 * 1024 * 1024; // inflated size of one file in the zip: a zip bomb stops here
const MAX_ROWS = 3000;
const MAX_COLS = 60;

export class XlsxError extends Error {}

function entries(buf: Buffer): Map<string, Buffer> {
  // End of central directory: the last 22+ bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("That isn't a spreadsheet file (it isn't a zip).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count && n < 2000; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError("The spreadsheet file is damaged.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxError("The spreadsheet file is damaged.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    try {
      out.set(name, method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ENTRY }) : (() => { throw new XlsxError("Unsupported compression."); })());
    } catch (e) {
      if (e instanceof XlsxError) throw e;
      throw new XlsxError("The spreadsheet is too big or damaged to read.");
    }
  }
  return out;
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The text of every <t> in a fragment (a rich-text string is several runs). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join("");

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0] ?? "") n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
};

export interface Sheet {
  name: string;
  rows: string[][];
}

export function readXlsx(buf: Buffer): Sheet[] {
  const files = entries(buf);
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) throw new XlsxError("That zip isn't an Excel spreadsheet (no workbook in it).");
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const rels = new Map<string, string>();
  for (const m of (files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(?:xl\/)?/, "xl/"));
  }
  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet");
    const rid = /\br:id="([^"]*)"/.exec(m[0])?.[1];
    const xml = files.get((rid && rels.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`)?.toString("utf8");
    if (!xml) continue;
    const rows: string[][] = [];
    for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (rows.length >= MAX_ROWS) break;
      const row: string[] = [];
      let next = 0;
      for (const cm of (rm[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]!;
        const at = /\br="([A-Za-z]+\d*)"/.exec(attrs)?.[1];
        const col = at ? colIndex(at) : next;
        next = col + 1;
        if (col >= MAX_COLS) continue;
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
        const body = cm[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = textOf(body);
        else if (v !== undefined) value = decode(v);
        while (row.length < col) row.push("");
        row[col] = value.trim();
      }
      if (row.some((c) => c !== "")) rows.push(row);
    }
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw new XlsxError("The spreadsheet has no sheets.");
  return sheets;
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const rowsToCsv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
export const rowsToTsv = (rows: string[][]) => rows.map((r) => r.map((c) => c.replace(/[\t\n\r]+/g, " ")).join("\t")).join("\n");
