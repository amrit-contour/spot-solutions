// Device link: a server console asks to join (no sign-in on the console), an admin approves in the web app, and the
// console collects its own key by proving it holds a secret. The key never travels in a URL and is never stored.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { AppError, provision, revokeAccount, type Deps } from "./core";
import { CODE_ALPHABET, isManagedAccount } from "./logic";
import type { LinkDoc, LinkStore } from "./ports";

export type LinkDeps = Deps & { links: LinkStore };

export const LINK_TTL_MS = 15 * 60_000;
/** A reply that never arrived may be re-issued (the lost key's account is revoked first) for this long. */
export const REDELIVER_MS = 10 * 60_000;
export const MAX_DELIVERIES = 3;
/** A claim older than this was abandoned (the function died); someone else may take it. */
export const CLAIM_STALE_MS = 2 * 60_000;
export const START_LIMIT = 10;
export const START_WINDOW_MS = 15 * 60_000;
const LINK_CODE_LEN = 12;
const NOT_FOUND = "This link isn't valid any more. Start again from the server console.";

/** 12 random characters (about 59 bits), no 0/1/I/L/O. Unlike a typed join code it sits in a URL, so it is longer. */
export function generateLinkCode(): string {
  return Array.from({ length: LINK_CODE_LEN }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

export function normaliseLinkCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== LINK_CODE_LEN) return null;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return null;
  return s;
}

export const hashLinkCode = (canonical: string) => createHash("sha256").update(`link:${canonical}`).digest("hex");
export const isChallenge = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Is `secret` the one `challenge` was made from? Constant time. */
export function secretMatches(secret: unknown, challenge: string): boolean {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 128) return false;
  const a = createHash("sha256").update(secret).digest();
  const b = Buffer.from(challenge, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Four characters both the console and the approval page show, so the admin can see they are approving the
 * computer in front of them and not a link someone sent. Derived from the code and the console's challenge.
 */
export function verifyCode(code: string, challenge: string): string {
  const h = createHash("sha256").update(`verify:${code}:${challenge}`).digest();
  return Array.from({ length: 4 }, (_, i) => CODE_ALPHABET[h[i]! % CODE_ALPHABET.length]).join("");
}

const cleanName = (v: unknown, max = 60) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");
const lookup = async (deps: LinkDeps, code: unknown) => {
  const canonical = normaliseLinkCode(code);
  if (!canonical) throw new AppError("not-found", NOT_FOUND);
  const hash = hashLinkCode(canonical);
  const link = await deps.links.getLink(hash);
  if (!link || deps.now() >= link.expiresAt) throw new AppError("not-found", NOT_FOUND);
  return { canonical, hash, link };
};

// ---------- 1. the console asks (public, rate limited per IP) ----------

export async function startDeviceLink(deps: LinkDeps, input: { deviceName?: unknown; challenge?: unknown; ip: string }) {
  const now = deps.now();
  if (!(await deps.store.allowAttempt(`start:${input.ip}`, now, START_LIMIT, START_WINDOW_MS))) {
    throw new AppError("resource-exhausted", "Too many attempts. Wait a few minutes and try again.");
  }
  if (!isChallenge(input.challenge)) throw new AppError("invalid-argument", "Update this server's console and try again.");
  const code = generateLinkCode();
  const expiresAt = now + LINK_TTL_MS;
  await deps.links.putLink(hashLinkCode(code), {
    challenge: input.challenge,
    deviceName: cleanName(input.deviceName) || "server",
    createdAt: now,
    expiresAt,
    status: "pending",
  });
  await deps.links.sweepLinks(now).catch(() => undefined);
  return { code, expiresAt, verify: verifyCode(code, input.challenge) };
}

// ---------- 2. the web app shows it and an admin approves ----------

type Caller = { email?: string; verified?: boolean };
const requireSignedIn = (caller: Caller) => {
  const email = caller.email?.toLowerCase();
  if (!email || !caller.verified) throw new AppError("permission-denied", "Sign in with a verified email first.");
  return email;
};

export async function getDeviceLink(deps: LinkDeps, caller: Caller, input: { code?: unknown }) {
  const email = requireSignedIn(caller);
  const { canonical, link } = await lookup(deps, input.code);
  return {
    deviceName: link.deviceName,
    status: link.status,
    expiresAt: link.expiresAt,
    verify: verifyCode(canonical, link.challenge),
    /** Anyone signed in may look; only admins may approve. */
    canApprove: await deps.store.isAdmin(email),
  };
}

export async function approveDeviceLink(deps: LinkDeps, caller: Caller, input: { code?: unknown }) {
  const email = requireSignedIn(caller);
  if (!(await deps.store.isAdmin(email))) throw new AppError("permission-denied", "Only admins can connect a server. Ask an admin to do it.");
  const { hash, link } = await lookup(deps, input.code);
  const r = await deps.links.approveLink(hash, email, deps.now());
  if (r === "already") throw new AppError("failed-precondition", "This server was already approved.");
  if (r !== "ok") throw new AppError("not-found", NOT_FOUND);
  deps.log(`${email} approved device link for ${link.deviceName}`);
  return { deviceName: link.deviceName };
}

// ---------- 3. the console collects its key (secret-protected) ----------

export type PollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "done" }
  | { status: "approved"; key: Record<string, unknown>; serviceAccount: string; approvedBy: string; deviceName: string };

export async function pollDeviceLink(deps: LinkDeps, input: { code?: unknown; secret?: unknown }): Promise<PollResult> {
  const canonical = normaliseLinkCode(input.code);
  if (!canonical) return { status: "expired" };
  const hash = hashLinkCode(canonical);
  const now = deps.now();
  const link = await deps.links.getLink(hash);
  // Same answer for "no such link" and "wrong secret": nothing to learn by guessing.
  if (!link || !secretMatches(input.secret, link.challenge)) return { status: "expired" };
  if (link.status !== "done" && now >= link.expiresAt) return { status: "expired" };
  if (link.status === "pending") return { status: "pending" };

  const claimed = await deps.links.claimLink(hash, now);
  if (!claimed.ok) return { status: claimed.reason === "done" ? "done" : claimed.reason === "missing" ? "expired" : "pending" };
  const redo = claimed.link.status === "done" ? claimed.link.serviceAccount : undefined;
  // A re-issue: the first key never reached the console, so retire its account before making another.
  if (redo && isManagedAccount(redo)) {
    await revokeAccount(deps, redo).catch((e) => deps.log(`re-issue: cleanup of ${redo} failed: ${(e as Error).message}`));
    await deps.store.deleteServerKey(redo).catch(() => undefined);
  }
  const approvedBy = claimed.link.approvedBy ?? "";
  const r = await provision(
    deps,
    { finish: (sa) => deps.links.finishLink(hash, sa, deps.now()), release: () => deps.links.releaseLink(hash) },
    approvedBy,
    claimed.link.deviceName,
  );
  return { status: "approved", key: r.key, serviceAccount: r.serviceAccount, approvedBy, deviceName: r.deviceName };
}
