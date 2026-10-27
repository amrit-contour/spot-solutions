// Getting a photo ready to send: any picked image becomes a JPEG of at most 1600 px a side, squeezed under the size a command can carry.
import { PHOTO_PICK_MAX_BYTES, PHOTO_SEND_MAX_BYTES, PHOTO_SEND_MAX_EDGE, fitWithin } from "@spot/shared";

export interface PreparedPhoto {
  mime: "image/jpeg";
  /** Base64, no prefix. */
  data: string;
  dataUrl: string;
  bytes: number;
  filename: string;
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith("image/")) throw new Error("Pick a photo.");
  if (file.size > PHOTO_PICK_MAX_BYTES) throw new Error("That photo is over 5 MB. Pick a smaller one.");
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("That photo couldn't be opened.");
  const base = fitWithin(bmp.width, bmp.height, PHOTO_SEND_MAX_EDGE);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't prepare photos.");
  // Squeeze the quality first, then the picture itself, until it fits what a command can carry.
  for (const scale of [1, 0.8, 0.6, 0.45]) {
    canvas.width = Math.max(1, Math.round(base.w * scale));
    canvas.height = Math.max(1, Math.round(base.h * scale));
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const dataUrl = await toDataUrl(canvas, quality);
      const comma = dataUrl.indexOf(",");
      const bytes = Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
      if (bytes <= PHOTO_SEND_MAX_BYTES) {
        bmp.close?.();
        return { mime: "image/jpeg", data: dataUrl.slice(comma + 1), dataUrl, bytes, filename: `${(file.name || "photo").replace(/\.[^.]+$/, "")}.jpg` };
      }
    }
  }
  bmp.close?.();
  throw new Error("That photo can't be made small enough to send.");
}

const toDataUrl = (canvas: HTMLCanvasElement, q: number) =>
  new Promise<string>((resolve, reject) =>
    canvas.toBlob(
      (b) => {
        if (!b) return reject(new Error("That photo couldn't be prepared."));
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("That photo couldn't be prepared."));
        r.readAsDataURL(b);
      },
      "image/jpeg",
      q,
    ),
  );
