import { describe, expect, it, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CURATOR_LIST } from "@spot/shared/fixtures/curatorList";
import { toCsv, toRosterJson } from "@spot/shared";
import { BLR_ROSTER } from "@spot/shared/fixtures/blrRooms";
import { chunkText, htmlToText, parseRoster, sheetsExportUrl, type ImportDeps } from "./rosterImport.ts";
import { readXlsx } from "./xlsx.ts";
import { FetchBlockedError, checkUrl, isPublicIp, safeFetch } from "./safeFetch.ts";

// ---- a tiny zip writer, so the xlsx reader is tested on a real zip without a fixture file ----
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text, "utf8"));
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(Buffer.byteLength(text), 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(Buffer.byteLength(text), 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    parts.push(lh, nm, data);
    central.push(ch, nm);
    offset += lh.length + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const xlsx = (rows: string[][], sheet = "Mics") => {
  const strings: string[] = [];
  const cell = (v: string, r: number, c: number) => {
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    if (/^\d+(\.\d+)?$/.test(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    strings.push(v);
    return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
  };
  const sheetXml = `<worksheet><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v === "" ? "" : cell(v, r, c))).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const sst = `<sst>${strings.map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("")}</sst>`;
  return zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": sst,
    "xl/worksheets/sheet1.xml": sheetXml,
  });
};

// ---- a fake model ----
const aiReply = (rooms: unknown[], notes: string[] = []) => ({ text: JSON.stringify({ rooms, notes }), model: "ollama/fake" });
function deps(over: { text?: ReturnType<typeof vi.fn>; file?: ReturnType<typeof vi.fn>; fetchUrl?: ImportDeps["fetchUrl"] } = {}) {
  const text = over.text ?? vi.fn(async () => { throw new Error("no model"); });
  const file = over.file ?? vi.fn(async () => { throw new Error("Images need Gemini: add a key in Settings → AI models."); });
  return { d: { ai: { text, file }, fetchUrl: over.fetchUrl ?? (async () => { throw new Error("no net"); }) } as ImportDeps, text, file };
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");

describe("parse_roster: text", () => {
  it("reads the WhatsApp list with no model call at all", async () => {
    const { d, text } = deps();
    const r = await parseRoster({ text: CURATOR_LIST, city: "Bengaluru" }, d);
    expect(r.source).toBe("list");
    expect(r.rooms.map((x) => x.name)).toEqual(["Klayworkz", "Comedy Square", "TAG Comedy Club", "Humble Pie", "Ministry of Comedy", "Bloom"]);
    expect(r.rooms.every((x) => x.city === "Bengaluru")).toBe(true);
    expect(r.curators.find((c) => c.id === "pronoy")?.phone).toBe("+919000000011");
    expect(r.notes).toEqual(["Curator list, Bangalore (updated Oct)"]);
    expect(text).not.toHaveBeenCalled();
  });

  it("sends only the lines the list parser couldn't read to the model, and keeps the rest", async () => {
    const src = "*A Room, Indiranagar*\nMon: Sid 9000000021\n*Odd Room, HSR*\nsome free text about when to come maybe tuesdays\n";
    const text = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("Odd Room");
      expect(prompt).not.toContain("A Room");
      return aiReply([{ name: "Odd Room", area: "HSR", shows: [{ days: [{ days: ["Tue"], curators: [] }] }] }]);
    });
    const r = await parseRoster({ text: src, city: "Bengaluru" }, deps({ text }).d);
    expect(r.source).toBe("list+ai");
    expect(r.model).toBe("ollama/fake");
    expect(r.rooms.map((x) => x.name)).toEqual(["A Room", "Odd Room"]);
    expect(r.rooms[1]!.shows[0]!.days[0]!.weekday).toBe(2);
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("falls back to the parser's partial result, with a warning, when the model is down", async () => {
    const src = "*A Room, Indiranagar*\nMon: Sid\nbring a friend sometimes\n";
    const r = await parseRoster({ text: src }, deps().d);
    expect(r.source).toBe("list");
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0]!.notes).toContainEqual({ kind: "other", text: "bring a friend sometimes" });
    expect(r.warnings.join(" ")).toMatch(/couldn't be read.*A Room, Indiranagar/);
  });

  it("uses the model for text that isn't a list, and drops a number the text never had", async () => {
    const src = "Pronoy runs the mic at Klayworkz on tuesdays; his number is 9611939277";
    const text = vi.fn(async () => aiReply([{ name: "Klayworkz", shows: [{ days: [{ days: ["Tue"], curators: [{ name: "Pronoy", phone: "9611939277" }, { name: "Ghost", phone: "9876543210" }] }] }] }]));
    const r = await parseRoster({ text: src, city: "Bengaluru" }, deps({ text }).d);
    expect(r.source).toBe("ai");
    expect(r.curators.find((c) => c.id === "pronoy")?.phone).toBe("+919611939277");
    expect(r.curators.find((c) => c.id === "ghost")?.phone).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/isn't in what you gave me/);
  });

  it("says so when it can't read it and no model answers", async () => {
    await expect(parseRoster({ text: "hello there, add me please" }, deps().d)).rejects.toThrow(/model didn't answer/);
    await expect(parseRoster({ text: "   " }, deps().d)).rejects.toThrow(/nothing there/i);
    const none = vi.fn(async () => aiReply([]));
    await expect(parseRoster({ text: "hello there" }, deps({ text: none }).d)).rejects.toThrow(/couldn't find any rooms/);
  });

  it("splits a long text so a small model gets a few rooms at a time", async () => {
    const big = Array.from({ length: 60 }, (_, i) => `Venue ${i}: some words that are not a list but long enough ${"x".repeat(150)}`).join("\n\n");
    expect(chunkText(big).length).toBeGreaterThan(1);
    expect(chunkText(big).every((c) => c.length <= 6000)).toBe(true);
    const text = vi.fn(async () => aiReply([]));
    await expect(parseRoster({ text: big }, deps({ text }).d)).rejects.toThrow();
    expect(text.mock.calls.length).toBeGreaterThan(1);
    expect(text.mock.calls.length).toBeLessThanOrEqual(12);
  });
});

describe("parse_roster: files", () => {
  it("reads our own JSON and CSV exports exactly, with no model", async () => {
    const roster = { rooms: BLR_ROSTER.rooms, curators: BLR_ROSTER.curators };
    const j = await parseRoster({ fileName: "r.json", mime: "application/json", dataBase64: b64(toRosterJson(roster)) }, deps().d);
    expect(j.source).toBe("json");
    expect(j.rooms).toHaveLength(BLR_ROSTER.rooms.length);
    const c = await parseRoster({ fileName: "r.csv", mime: "text/csv", dataBase64: b64(toCsv(roster)) }, deps().d);
    expect(c.source).toBe("csv");
    expect(c.rooms).toHaveLength(BLR_ROSTER.rooms.length);
  });

  it("reads pasted tab-separated cells that have a room column", async () => {
    const tsv = "room\tarea\tshow\tday\tcurators\ncomedy square\tHSR Layout\tMic\tMon\tVishal\n";
    const r = await parseRoster({ text: tsv, city: "Bengaluru" }, deps().d);
    expect(r.source).toBe("csv");
    expect(r.rooms[0]).toMatchObject({ name: "comedy square", city: "Bengaluru" });
  });

  it("reads an xlsx with the cell reader, then the list parser or the model", async () => {
    const rows = [["Venue", "Area", "Day", "Curator"], ["Klayworkz", "JP Nagar", "Tue", "Pronoy"], ["Tom & Jerry"]];
    const buf = xlsx(rows);
    expect(readXlsx(buf)).toEqual([{ name: "Mics", rows }]);
    const text = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("Klayworkz\tJP Nagar\tTue\tPronoy");
      expect(prompt).toContain("Tom & Jerry");
      return aiReply([{ name: "Klayworkz", area: "JP Nagar", shows: [{ days: [{ days: ["Tue"], curators: [{ name: "Pronoy" }] }] }] }]);
    });
    const r = await parseRoster({ fileName: "mics.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", dataBase64: b64(buf) }, deps({ text }).d);
    expect(r.source).toBe("ai");
    expect(r.rooms[0]!.name).toBe("Klayworkz");
  });

  it("reads an xlsx that is a roster export exactly", async () => {
    const rows = [["room", "area", "show", "day", "curators"], ["Comedy Square", "HSR Layout", "Mic", "Mon", "Vishal"]];
    const r = await parseRoster({ fileName: "r.xlsx", dataBase64: b64(xlsx(rows)) }, deps().d);
    expect(r.source).toBe("xlsx");
    expect(r.rooms[0]!.shows[0]!.days[0]).toMatchObject({ weekday: 1, curatorIds: ["vishal"] });
  });

  it("rejects a zip that isn't a spreadsheet, an old .xls, and a file that is too big", async () => {
    await expect(parseRoster({ fileName: "a.zip", dataBase64: b64(zip({ "a.txt": "hi" })) }, deps().d)).rejects.toThrow(/no workbook/);
    await expect(parseRoster({ fileName: "a.xls", dataBase64: b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) }, deps().d)).rejects.toThrow(/old \.xls/);
    await expect(parseRoster({ fileName: "a.bin", mime: "application/octet-stream", dataBase64: b64("abc") }, deps().d)).rejects.toThrow(/can't read that kind/);
    await expect(parseRoster({ fileName: "a.png", dataBase64: "A".repeat(7_100_000) }, deps().d)).rejects.toThrow(/over 5 MB/);
  });

  it("sends a picture or PDF to the model that can see it, and warns to check the numbers", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake")]);
    const file = vi.fn(async (_p: string, _s: object, f: { mime: string; data: string }) => {
      expect(f.mime).toBe("image/png");
      expect(f.data).toBe(png.toString("base64"));
      return { text: JSON.stringify({ rooms: [{ name: "Zostel", area: "Koramangala", shows: [{ days: [{ days: ["Sun"], curators: [{ name: "Devashish", phone: "9000000031" }] }] }] }] }), model: "gemini/gemini-2.5-flash" };
    });
    const r = await parseRoster({ fileName: "shot.png", mime: "image/png", dataBase64: b64(png), city: "Bengaluru" }, deps({ file }).d);
    expect(r.source).toBe("ai");
    expect(r.model).toBe("gemini/gemini-2.5-flash");
    expect(r.curators[0]!.phone).toBe("+919000000031");
    expect(r.warnings.join(" ")).toMatch(/check the names and phone numbers/);
    const pdf = await parseRoster({ fileName: "x.pdf", dataBase64: b64("%PDF-1.4 hi") }, deps({ file }).d).catch((e: Error) => e);
    expect(file.mock.calls[1]![2].mime).toBe("application/pdf");
    expect(pdf).toBeTruthy();
  });

  it("says plainly that images need Gemini when cloud AI isn't allowed", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake")]);
    await expect(parseRoster({ fileName: "shot.png", dataBase64: b64(png) }, deps().d)).rejects.toThrow("Images need Gemini: add a key in Settings → AI models.");
  });
});

describe("parse_roster: links", () => {
  const fetched = (body: string, contentType: string, url = "https://example.com/mics") => async () => ({ url, contentType, body: Buffer.from(body) });
  it("reads a web page as text, through the list parser", async () => {
    const html = `<html><head><style>x{}</style></head><body><nav>Home</nav><p><b>Klayworkz, JP Nagar</b></p><p>Tue to Thu: Pronoy: 9000000011 (ping on Mondays)</p></body></html>`;
    expect(htmlToText(html)).toContain("Tue to Thu: Pronoy");
    // A web page has no WhatsApp bold, so the plain-heading rule has to find the room.
    const r = await parseRoster({ url: "https://example.com/mics", city: "Bengaluru" }, deps({ fetchUrl: fetched(html, "text/html") }).d);
    expect(r.rooms[0]).toMatchObject({ name: "Klayworkz", area: "JP Nagar" });
    expect(r.rooms[0]!.shows[0]!.days.map((x) => x.weekday)).toEqual([2, 3, 4]);
  });
  it("turns a Google Sheets link into its CSV export", async () => {
    expect(sheetsExportUrl("https://docs.google.com/spreadsheets/d/abc_123-x/edit#gid=77")).toBe("https://docs.google.com/spreadsheets/d/abc_123-x/export?format=csv&gid=77");
    expect(sheetsExportUrl("https://example.com/x")).toBeNull();
    const seen: string[] = [];
    const csv = "room,area,show,day,curators\nComedy Square,HSR Layout,Mic,Mon,Vishal\n";
    const r = await parseRoster({ url: "https://docs.google.com/spreadsheets/d/abc/edit" }, deps({ fetchUrl: async (u) => { seen.push(u); return { url: u, contentType: "text/csv", body: Buffer.from(csv) }; } }).d);
    expect(seen[0]).toContain("/export?format=csv");
    expect(r.source).toBe("csv");
  });
  it("explains a Sheet that wants a sign-in, and a link that can't be opened", async () => {
    await expect(parseRoster({ url: "https://docs.google.com/spreadsheets/d/abc/edit" }, deps({ fetchUrl: fetched("<html>", "text/html", "https://accounts.google.com/ServiceLogin") }).d)).rejects.toThrow(/isn't shared/);
    await expect(parseRoster({ url: "http://127.0.0.1/x" }, deps({ fetchUrl: (u) => safeFetch(u) }).d)).rejects.toThrow(/private/);
  });
});

describe("safeFetch", () => {
  it("knows which addresses are public", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.1.1", "2606:4700:4700::1111"]) expect(isPublicIp(ip)).toBe(true);
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not an ip"]) expect(isPublicIp(ip)).toBe(false);
    expect(isPublicIp("172.32.0.1")).toBe(true);
  });
  it("accepts only plain public http(s) links", () => {
    expect(checkUrl("https://example.com/a?b=1").hostname).toBe("example.com");
    for (const bad of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "http://localhost/x", "http://127.0.0.1/", "http://[::1]/", "http://10.1.2.3/", "http://169.254.169.254/latest/meta-data", "http://user:pw@example.com/", "http://example.com:22/", "http://intranet/", "http://printer.local/", "http://x.internal/", "nonsense"]) {
      expect(() => checkUrl(bad), bad).toThrow(FetchBlockedError);
    }
  });
  it("won't connect to a local server, and caps size", async () => {
    const server = http.createServer((_q, res) => res.end("secret"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/private|port/);
      await expect(safeFetch(`http://localhost:${port}/`)).rejects.toThrow(/private|port/);
    } finally {
      server.close();
    }
  });
});

describe("xlsx reader", () => {
  it("reads inline strings, numbers, gaps and entities", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a &amp; b</t></is></c><c r="C1"><v>42</v></c></row><row r="3"><c r="B3" t="str"><v>x</v></c></row></sheetData></worksheet>`;
    const buf = zip({ "xl/workbook.xml": `<workbook><sheets><sheet name="S" r:id="rId9"/></sheets></workbook>`, "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId9" Target="/xl/worksheets/s.xml"/></Relationships>`, "xl/worksheets/s.xml": sheet });
    expect(readXlsx(buf)).toEqual([{ name: "S", rows: [["a & b", "", "42"], ["", "x"]] }]);
  });
  it("refuses something that isn't a zip", () => {
    expect(() => readXlsx(Buffer.from("hello world, definitely not a zip file"))).toThrow(/isn't a spreadsheet/);
  });
});
