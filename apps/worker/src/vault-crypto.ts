// Object = "SPVT" | version(1) | iv(12) | tag(16) | ciphertext. AES-256-GCM; the uid is bound in as AAD so an
// object copied between accounts fails to decrypt.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("SPVT");
const VERSION = 1;
const HEAD = 4 + 1 + 12 + 16;

const aad = (uid: string) => Buffer.from(`spot-vault:${uid}`);

export const newKey = () => randomBytes(32);
export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export async function encrypt(source: AsyncIterable<Buffer>, key: Buffer, uid: string): Promise<Buffer> {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(uid));
  const parts: Buffer[] = [Buffer.alloc(HEAD)];
  for await (const chunk of source) parts.push(c.update(chunk));
  parts.push(c.final());
  const head = parts[0];
  MAGIC.copy(head, 0);
  head[4] = VERSION;
  iv.copy(head, 5);
  c.getAuthTag().copy(head, 17);
  return Buffer.concat(parts);
}

/** Throws if the object is malformed, was tampered with, or the key/uid is wrong. */
export function decrypt(obj: Buffer, key: Buffer, uid: string): Buffer {
  if (obj.length < HEAD || !obj.subarray(0, 4).equals(MAGIC)) throw new Error("not a vault object");
  if (obj[4] !== VERSION) throw new Error(`unsupported vault version ${obj[4]}`);
  const d = createDecipheriv("aes-256-gcm", key, obj.subarray(5, 17));
  d.setAAD(aad(uid));
  d.setAuthTag(obj.subarray(17, 33));
  return Buffer.concat([d.update(obj.subarray(HEAD)), d.final()]);
}
