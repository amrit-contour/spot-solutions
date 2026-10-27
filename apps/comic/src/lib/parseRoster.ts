// Import from text, a file or a link: the browser half. The worker (parse_roster) does the reading; this builds the request, keeps it
// inside Firestore's 1 MiB document limit, and deletes the result as soon as it has it (it holds curators' phone numbers).
import { addDoc, deleteDoc, onSnapshot, Timestamp } from "firebase/firestore";
import { TTL_DAYS, parseWhatsAppList, ttlMs, type Command, type ParseRosterResult } from "@spot/shared";
import { auth } from "@spot/ui/firebase";
import { userCol } from "./data";

/** A command document may hold 1 MiB; the base64 of a file has to leave room for the rest. (The worker accepts up to 5 MB.) */
export const MAX_B64 = 880_000;
const MAX_TEXT = 200_000;

export interface ImportRequest {
  text?: string;
  fileName?: string;
  mime?: string;
  dataBase64?: string;
  url?: string;
  city?: string;
}

const isTextFile = (f: File) => /\.(csv|tsv|json|txt|md|html?)$/i.test(f.name) || /^text\//.test(f.type) || f.type === "application/json";

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A screenshot shrunk to fit: JPEG, longest side 1800 px, quality down until it fits. */
async function shrinkImage(file: File): Promise<{ mime: string; dataBase64: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("I couldn't open that picture. Try a PNG or JPEG screenshot.");
  }
  for (const [side, q] of [[1800, 0.85], [1600, 0.75], [1400, 0.65], [1100, 0.55], [800, 0.5]] as const) {
    const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bitmap.width * k));
    c.height = Math.max(1, Math.round(bitmap.height * k));
    const g = c.getContext("2d");
    if (!g) break;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bitmap, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", q));
    if (!blob) break;
    const b64 = toBase64(await blob.arrayBuffer());
    if (b64.length <= MAX_B64) return { mime: "image/jpeg", dataBase64: b64 };
  }
  throw new Error("That picture is too detailed to send. Crop it to the list and try again.");
}

/** What to send for a chosen file. Text-like files go as text; sheets, PDFs and pictures as base64 (pictures shrunk first). */
export async function requestFromFile(file: File, city?: string): Promise<ImportRequest> {
  if (isTextFile(file)) {
    if (file.size > MAX_TEXT * 4) throw new Error("That file is too long. Paste just the part with the rooms.");
    const text = await file.text();
    if (text.length > MAX_TEXT) throw new Error("That file is too long. Paste just the part with the rooms.");
    return { text, fileName: file.name, city };
  }
  if (file.type.startsWith("image/") || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name)) {
    const img = await shrinkImage(file);
    return { fileName: file.name, ...img, city };
  }
  const buf = await file.arrayBuffer();
  const b64 = toBase64(buf);
  if (b64.length > MAX_B64) {
    throw new Error(`That file is ${(file.size / 1_000_000).toFixed(1)} MB, and ${(MAX_B64 * 0.75 / 1_000_000).toFixed(1)} MB is the most I can send. Export just the rooms as CSV, or paste the text.`);
  }
  return { fileName: file.name, mime: file.type || undefined, dataBase64: b64, city };
}

/** Ask the comic's server to read it. Resolves with rooms for the review sheet; nothing is saved. */
export async function parseRosterRemote(req: ImportRequest, timeoutMs = 6 * 60_000): Promise<ParseRosterResult> {
  const uid = auth.currentUser?.uid;
  if (!uid || (import.meta.env.DEV && location.pathname.startsWith("/dev/"))) {
    // The dev-only demo route has no sign-in and no server: read the common list format right here so the page can be tried.
    if (import.meta.env.DEV && req.text) {
      const l = parseWhatsAppList(req.text, { city: req.city });
      if (!l.rooms.length) throw new Error("(Dev preview: no server. Only the WhatsApp list format is read here.)");
      return { rooms: l.rooms, curators: l.curators, notes: l.preamble, warnings: [...l.warnings, "Dev preview: read in the browser with no server or model."], source: "list" };
    }
    throw new Error("Sign in first.");
  }
  const ref = await addDoc(userCol(uid, "commands"), {
    type: "parse_roster", payload: { ...req }, status: "pending", createdAt: Date.now(), expireAt: Timestamp.fromMillis(ttlMs(TTL_DAYS.messages)),
  } satisfies Command);
  return new Promise<ParseRosterResult>((resolve, reject) => {
    const forget = () => void deleteDoc(ref).catch(() => undefined);
    const timer = setTimeout(() => {
      unsub();
      forget();
      reject(new Error("Your server didn't answer. Is it running? A slow local model can also take a few minutes: try again."));
    }, timeoutMs);
    const unsub = onSnapshot(ref, (s) => {
      const d = s.data() as (Command & { result?: ParseRosterResult }) | undefined;
      if (d?.status === "done" && d.result) {
        clearTimeout(timer);
        unsub();
        forget();
        resolve(d.result);
      } else if (d?.status === "error") {
        clearTimeout(timer);
        unsub();
        forget();
        reject(new Error(/^Unknown command /.test(d.error ?? "") ? "The server running your account is on an older version that can't read lists yet. Update it, then try again." : (d.error ?? "That didn't work.")));
      }
    });
  });
}
