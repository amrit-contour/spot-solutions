// WhatsApp message formatting: a small parser (for the preview) and the editing operations behind the
// toolbar. WhatsApp renders *bold*, _italic_, ~strike~, `code`, ```monospace```, "> quote", "- bullet" and
// "1. numbered" lines. No HTML anywhere: the parser returns a plain tree that the UI turns into React nodes.

export type Inline =
  | { t: "text"; v: string }
  | { t: "b" | "i" | "s"; c: Inline[] }
  | { t: "code"; v: string };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "quote"; lines: Inline[][] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] }
  | { t: "pre"; v: string };

const MARKS: Record<string, "b" | "i" | "s"> = { "*": "b", _: "i", "~": "s" };
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** Inline marks. An opener must start a word and a closer end one, like WhatsApp: snake_case_name stays plain. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const isMark = ch in MARKS || ch === "`";
    if (isMark && !isWord(s[i - 1]) && !isSpace(s[i + 1]) && s[i + 1] !== ch) {
      let j = i + 1;
      let found = -1;
      while (j < s.length) {
        if (s[j] === "\n") break;
        if (s[j] === ch && !isSpace(s[j - 1]) && !isWord(s[j + 1])) {
          found = j;
          break;
        }
        j++;
      }
      if (found > i + 1) {
        flush();
        const inner = s.slice(i + 1, found);
        out.push(ch === "`" ? { t: "code", v: inner } : { t: MARKS[ch], c: parseInline(inner) });
        i = found + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** The whole message as blocks: fenced monospace, quotes, lists, paragraphs (one per line, blank lines kept as empty paragraphs). */
export function parseWhatsApp(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```([\s\S]*?)```/g;
  let last = 0;
  const lines = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const prev = blocks[blocks.length - 1];
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^>\s?(.*)$/))) {
        if (prev?.t === "quote") prev.lines.push(parseInline(m[1]));
        else blocks.push({ t: "quote", lines: [parseInline(m[1])] });
      } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
        if (prev?.t === "ul") prev.items.push(parseInline(m[1]));
        else blocks.push({ t: "ul", items: [parseInline(m[1])] });
      } else if ((m = line.match(/^(\d+)\.\s+(.*)$/))) {
        if (prev?.t === "ol") prev.items.push(parseInline(m[2]));
        else blocks.push({ t: "ol", start: Number(m[1]), items: [parseInline(m[2])] });
      } else blocks.push({ t: "p", c: parseInline(line) });
    }
  };
  for (const m of text.matchAll(fence)) {
    const before = text.slice(last, m.index).replace(/\n$/, "");
    if (before || m.index! > last) lines(before);
    blocks.push({ t: "pre", v: m[1].replace(/^\n|\n$/g, "") });
    last = m.index! + m[0].length;
    if (text[last] === "\n") last++;
  }
  if (last < text.length || !blocks.length) lines(text.slice(last));
  return blocks;
}

// ---------- toolbar operations ----------

export type FormatOp = "bold" | "italic" | "strike" | "mono" | "code" | "quote" | "bullet" | "number";
export interface Edit {
  value: string;
  start: number;
  end: number;
}

const WRAP: Record<"bold" | "italic" | "strike" | "mono" | "code", string> = { bold: "*", italic: "_", strike: "~", mono: "```", code: "`" };
const LINE_PREFIX: Record<"quote" | "bullet", string> = { quote: "> ", bullet: "- " };

/** Wrap the selection in a mark (or take it off again); with no selection, drop an empty pair and put the caret inside. */
function wrap(v: string, a: number, b: number, mark: string): Edit {
  const L = mark.length;
  // Already wrapped, with the marks just outside the selection.
  if (a >= L && v.slice(a - L, a) === mark && v.slice(b, b + L) === mark) {
    return { value: v.slice(0, a - L) + v.slice(a, b) + v.slice(b + L), start: a - L, end: b - L };
  }
  // Already wrapped, with the marks inside the selection.
  const sel = v.slice(a, b);
  if (sel.length >= 2 * L && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(L, sel.length - L);
    return { value: v.slice(0, a) + inner + v.slice(b), start: a, end: a + inner.length };
  }
  // Keep leading/trailing spaces outside the marks, which WhatsApp needs to see a bold word.
  const lead = sel.match(/^\s*/)![0].length;
  const trail = sel.trim() ? sel.match(/\s*$/)![0].length : 0;
  const core = sel.slice(lead, sel.length - trail);
  const text = v.slice(0, a + lead) + mark + core + mark + v.slice(b - trail);
  return core ? { value: text, start: a + lead + L, end: a + lead + L + core.length } : { value: text, start: a + L, end: a + L };
}

function prefixLines(v: string, a: number, b: number, op: "quote" | "bullet" | "number"): Edit {
  const from = v.lastIndexOf("\n", a - 1) + 1;
  let to = v.indexOf("\n", b > a ? b - 1 : b);
  if (to === -1) to = v.length;
  const lines = v.slice(from, to).split("\n");
  const pattern = op === "number" ? /^\d+\.\s/ : op === "bullet" ? /^[-*]\s/ : /^>\s?/;
  const all = lines.every((l) => pattern.test(l));
  const next = lines.map((l, i) => {
    if (all) return l.replace(pattern, "");
    const bare = l.replace(/^(\d+\.|[-*]|>)\s?/, "");
    return (op === "number" ? `${i + 1}. ` : LINE_PREFIX[op]) + bare;
  });
  const joined = next.join("\n");
  const value = v.slice(0, from) + joined + v.slice(to);
  const caret = a === b ? Math.min(from + joined.length, value.length) : from;
  return a === b && lines.length === 1 ? { value, start: caret, end: caret } : { value, start: from, end: from + joined.length };
}

export function applyFormat(value: string, start: number, end: number, op: FormatOp): Edit {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  return op === "quote" || op === "bullet" || op === "number" ? prefixLines(value, a, b, op) : wrap(value, a, b, WRAP[op]);
}

/** Insert text at the caret, replacing any selection. */
export function insertText(value: string, start: number, end: number, text: string): Edit {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  return { value: value.slice(0, a) + text + value.slice(b), start: a + text.length, end: a + text.length };
}

/** Keyboard shortcut → operation (Cmd/Ctrl + key; Shift for the less common ones). */
export function shortcutOp(key: string, shift: boolean): FormatOp | null {
  const k = key.toLowerCase();
  if (!shift) return k === "b" ? "bold" : k === "i" ? "italic" : null;
  return k === "x" ? "strike" : k === "m" ? "mono" : k === "e" ? "code" : k === "9" ? "quote" : k === "8" ? "bullet" : k === "7" ? "number" : null;
}

/** Remove WhatsApp marks, for places that can only show plain text (notices, list titles). */
export function stripFormatting(text: string): string {
  const plain = (n: Inline[]): string => n.map((x) => (x.t === "text" || x.t === "code" ? x.v : plain(x.c))).join("");
  return parseWhatsApp(text)
    .map((b) => (b.t === "pre" ? b.v : b.t === "p" ? plain(b.c) : b.t === "quote" ? b.lines.map(plain).join("\n") : b.items.map(plain).join("\n")))
    .join("\n");
}
