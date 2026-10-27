import { useRef, useState } from "react";
import { type Roster } from "@spot/shared";
import { Button, Field, IconImport, Segmented, Sheet, TextArea, TextInput } from "@spot/ui";
import { Card, Notice } from "./ui";
import { parseRosterRemote, requestFromFile, type ImportRequest } from "../lib/parseRoster";

export interface ParsedImport {
  roster: Roster;
  source: string;
  warning?: string;
}

type Mode = "text" | "file" | "link";
const ACCEPT = ".csv,.tsv,.json,.txt,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,.heic,image/*,application/pdf";

/**
 * "Import from text, file or link": paste a list, pick a file, or give a link. The server reads it (list parser first, then the
 * account's model) and the rooms go to the review sheet. Nothing is saved from here.
 */
export function PasteImportSheet({ open, onClose, city, onParsed }: { open: boolean; onClose: () => void; city?: string; onParsed: (p: ParsedImport) => void }) {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const ready = mode === "text" ? text.trim().length > 0 : mode === "file" ? file !== null : /^https?:\/\/\S+$/i.test(url.trim());
  const close = () => {
    if (busy) return;
    setError("");
    onClose();
  };

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const req: ImportRequest = mode === "text" ? { text, city } : mode === "link" ? { url: url.trim(), city } : await requestFromFile(file!, city);
      const r = await parseRosterRemote(req);
      if (!r.rooms.length) throw new Error("I couldn't find any rooms in that.");
      const source = mode === "text" ? "Pasted text" : mode === "link" ? new URL(url.trim()).hostname : file!.name;
      const how = r.source === "ai" || r.source === "list+ai" ? " Read with an AI model, so give it a once-over." : "";
      const warning = [...r.warnings, ...(how && !r.warnings.some((w) => /check the names/.test(w)) ? [how.trim()] : [])].join("\n") || undefined;
      setText("");
      setFile(null);
      setUrl("");
      onClose();
      onParsed({ roster: { rooms: r.rooms, curators: r.curators }, source, warning });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Import rooms"
      footer={
        <>
          <Button variant="text" onClick={close} disabled={busy}>Cancel</Button>
          <Button icon={IconImport} onClick={() => void run()} loading={busy} disabled={!ready}>{busy ? "Reading…" : "Read it"}</Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        <p className="type-body-l text-on-surface-variant">
          Paste a curator list from WhatsApp or a sheet, upload a CSV, Excel, PDF or screenshot, or give a link. You review every room before anything is saved.
        </p>
        <Segmented
          value={mode}
          onChange={(m) => { if (!busy) { setMode(m); setError(""); } }}
          full
          options={[{ value: "text", label: "Paste" }, { value: "file", label: "File" }, { value: "link", label: "Link" }]}
        />

        {mode === "text" && (
          <Field label="The list" htmlFor="paste-text" hint="Bold venue names with days and curators under them work best.">
            <TextArea id="paste-text" value={text} onChange={(e) => setText(e.target.value)} rows={10} disabled={busy} className="min-h-56 font-mono text-[0.8125rem]" placeholder={"*Klayworkz, JP Nagar*\nTue to Thu: Pronoy: 98765 43210 (ping on Mondays)\n\n*TAG, Koramangala*\nFri to Sun: Tarun himself will reach out"} spellCheck={false} />
          </Field>
        )}

        {mode === "file" && (
          <Field label="A file" hint="CSV, Excel, PDF or a screenshot. PDFs and pictures need a Gemini key (Settings, AI models).">
            <input ref={picker} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(""); }} />
            <Card tone="high" className="flex min-w-0 flex-wrap items-center gap-3">
              <Button variant="tonal" onClick={() => picker.current?.click()} disabled={busy}>{file ? "Choose another" : "Choose a file"}</Button>
              <span className="min-w-0 flex-1 truncate type-body-m text-on-surface-variant">{file ? `${file.name} (${(file.size / 1000).toFixed(file.size > 99_999 ? 0 : 1)} KB)` : "Nothing chosen yet"}</span>
            </Card>
          </Field>
        )}

        {mode === "link" && (
          <Field label="A link" htmlFor="paste-url" hint="A web page, or a Google Sheet shared as “anyone with the link”.">
            <TextInput id="paste-url" value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" placeholder="https://" disabled={busy} autoComplete="off" />
          </Field>
        )}

        {busy && <p role="status" className="type-body-m text-on-surface-variant">Reading it. A list in the usual format takes a second; anything else goes to your AI model and can take a minute or two.</p>}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Sheet>
  );
}
