// People import: phone normalisation, CSV / vCard parsing, and the name-precedence rule shared by the worker and web.
import type { Comic } from "./types.ts";

type NameSource = NonNullable<Comic["nameSource"]>;

/** A person found in a file, a group or the curator's contacts. */
export interface ImportPerson {
  name: string;
  /** Digits only, country code first (919876543210). */
  phone: string;
}

/** One contact from the curator's WhatsApp (worker `list_contacts` result). */
export interface WaContact extends ImportPerson {
  id: string; // comic id (919876543210@c.us)
}

export interface GroupMembersResult {
  total: number;
  added: number;
  updated: number;
  /** Comic ids of everyone in the group (the curator excluded). */
  memberIds: string[];
  /** Comic ids of group admins (the curator excluded). */
  adminIds: string[];
}

export const comicIdForPhone = (phone: string) => `${phone}@c.us`;

/** Digits with country code, or "" when it can't be a phone number. 10 digits are taken as Indian. */
export function normalizePhone(raw: string, defaultCountry = "91"): string {
  const s = raw.trim();
  if (!s) return "";
  const hasPlus = s.startsWith("+");
  let d = s.replace(/\D/g, "");
  let intl = hasPlus;
  if (!intl && d.startsWith("00")) {
    d = d.slice(2);
    intl = true;
  }
  if (!intl) {
    if (d.length === 11 && d[0] === "0") d = d.slice(1);
    if (d.length === 10) d = defaultCountry + d;
  }
  return d.length >= 11 && d.length <= 15 ? d : "";
}

const RANK: Record<NameSource, number> = { number: 0, whatsapp: 1, contact: 2, manual: 3 };

/** Same precedence as incoming messages: never touch a manual name; a better source may replace a worse one. */
export function shouldUpdateName(cur: { name: string; nameSource?: Comic["nameSource"] }, incoming: { name: string; nameSource: NameSource }) {
  if (cur.nameSource === "manual" || cur.name === incoming.name) return false;
  return RANK[incoming.nameSource] >= Math.min(RANK[cur.nameSource ?? "whatsapp"], 2);
}

/** RFC 4180-ish CSV with quoted fields, escaped quotes and embedded newlines. */
export function parseCsvRows(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const push = () => {
    row.push(cell);
    cell = "";
  };
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') (cell += '"', i++);
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) push();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      push();
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) (push(), rows.push(row));
  return rows.filter((r) => r.some((c) => c.trim()));
}

function detectDelimiter(text: string) {
  const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const count = (d: string) => first.split(d).length - 1;
  return [";", "\t"].reduce((best, d) => (count(d) > count(best) ? d : best), ",");
}

const firstPhone = (cell: string) => {
  // Google Contacts joins several numbers with " ::: ".
  for (const part of cell.split(/\s*:::\s*|\n/)) {
    const p = normalizePhone(part);
    if (p) return p;
  }
  return "";
};

const isPhoneHeader = (h: string) => /phone|mobile|\btel\b|telephone|cell|whatsapp|contact number|^number$/.test(h) && !/type|label/.test(h);
const isNameHeader = (h: string) => /^(full |display |contact )?name$|^fn$/.test(h);

export function parseCsv(text: string): ImportPerson[] {
  const rows = parseCsvRows(text, detectDelimiter(text));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = !rows[0].some((c) => firstPhone(c)) && head.some((h) => isNameHeader(h) || isPhoneHeader(h) || /first name|last name/.test(h));

  let phoneCols: number[];
  let nameOf: (r: string[]) => string;
  let data = rows;
  if (hasHeader) {
    data = rows.slice(1);
    phoneCols = head.flatMap((h, i) => (isPhoneHeader(h) ? [i] : []));
    const nameCol = head.findIndex(isNameHeader);
    const part = (re: RegExp) => head.findIndex((h) => re.test(h) && !/phonetic/.test(h));
    const parts = [part(/^(first|given) name$/), part(/^middle name$/), part(/^(last|family) name$/)].filter((i) => i >= 0);
    nameOf = (r) => {
      const full = nameCol >= 0 ? r[nameCol]?.trim() : "";
      return full || parts.map((i) => r[i]?.trim()).filter(Boolean).join(" ");
    };
  } else {
    // No header: two columns, name and phone in either order.
    const phoneFirst = rows.slice(0, 5).filter((r) => firstPhone(r[0] ?? "")).length > rows.slice(0, 5).filter((r) => firstPhone(r[1] ?? "")).length;
    phoneCols = [phoneFirst ? 0 : 1];
    nameOf = (r) => r[phoneFirst ? 1 : 0]?.trim() ?? "";
  }
  if (!phoneCols.length) return [];
  const out: ImportPerson[] = [];
  for (const r of data) {
    let phone = "";
    for (const i of phoneCols) if ((phone = firstPhone(r[i] ?? ""))) break;
    if (phone) out.push({ name: nameOf(r) || `+${phone}`, phone });
  }
  return out;
}

const vcardValue = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

export function parseVcf(text: string): ImportPerson[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: ImportPerson[] = [];
  let fn = "";
  let n = "";
  let phone = "";
  let inCard = false;
  const end = () => {
    if (phone) {
      const name = fn || n || `+${phone}`;
      out.push({ name, phone });
    }
    fn = n = phone = "";
  };
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).toUpperCase();
    const value = line.slice(colon + 1);
    const prop = key.split(";")[0].replace(/^[\w-]+\./, ""); // drop "item1." groups
    if (prop === "BEGIN" && value.trim().toUpperCase() === "VCARD") (inCard = true, end());
    else if (prop === "END") (inCard && end(), (inCard = false));
    else if (!inCard) continue;
    else if (prop === "FN") fn = vcardValue(value);
    else if (prop === "N") {
      const [family = "", given = "", additional = ""] = value.split(";");
      n = [given, additional, family].map(vcardValue).filter(Boolean).join(" ");
    } else if (prop === "TEL" && !phone) phone = normalizePhone(value.replace(/^tel:/i, ""));
  }
  return out;
}

export interface ParsedPeople {
  people: ImportPerson[];
  /** Rows dropped for repeating a number already seen in the file. */
  duplicates: number;
}

/** Parse a CSV or vCard export; the format is sniffed from the content, not the extension. */
export function parsePeopleFile(text: string): ParsedPeople {
  const raw = /^\s*BEGIN:VCARD/im.test(text) ? parseVcf(text) : parseCsv(text);
  const seen = new Set<string>();
  const people = raw.filter((p) => !seen.has(p.phone) && seen.add(p.phone));
  return { people, duplicates: raw.length - people.length };
}
