// Encrypts the Google refresh token at rest: AES-256-GCM, a fresh random IV each time, the account's uid bound in as
// authenticated data so a blob copied into another account's document will not decrypt. Pure: no Firebase imports.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const aad = (uid: string) => Buffer.from(`spot-google-contacts:${uid}`);

/** The key secret is 32 random bytes, base64 (`openssl rand -base64 32`). Anything else is refused. */
export function parseKey(b64: string): Buffer {
  const k = Buffer.from(b64.trim(), "base64");
  if (k.length !== 32) throw new Error("GOOGLE_TOKEN_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  return k;
}

/** "v1.<iv>.<tag>.<ciphertext>", each part base64url. */
export function encryptToken(key: Buffer, uid: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(uid));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [VERSION, iv, c.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Throws if the blob was changed, belongs to another uid, or the key is wrong. */
export function decryptToken(key: Buffer, uid: string, blob: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== VERSION || !iv || !tag || !ct) throw new Error("Unknown token format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(aad(uid));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
