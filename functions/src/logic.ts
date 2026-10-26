// Pure rules for join codes and server accounts. No Google or Firebase imports, so they are unit-tested directly.
import { createHash, randomInt } from "node:crypto";

export const PROJECT_ID = "spot-solutions";
export const REGION = "asia-south1";
export const DEFAULT_BUCKET = "spot-solutions.firebasestorage.app";
/** The functions' own runtime identity (deploy/setup-functions-iam.sh). Never touched by removeServer. */
export const ENROLLER_ID = "spot-enroller";

/** Exactly what deploy/new-server-key.sh grants. */
export const PROJECT_ROLES = ["roles/datastore.user", "roles/firebasecloudmessaging.admin"] as const;
export const BUCKET_ROLES = ["roles/storage.objectAdmin"] as const;

export const CODE_TTL_MS = 15 * 60_000;
/** An online server's heartbeat is fresher than this (packages/shared/src/fleet.ts SERVER_ONLINE_MS). */
export const SERVER_ONLINE_MS = 75_000;

/** Base 31: no 0, 1, I, L or O, so a code read aloud or off a screen is hard to get wrong. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const GROUP = 4;
const GROUPS = 2;

/** A new code like SPOT-7K3F-Q9TX. 8 random characters, about 39 bits. */
export function generateCode(): string {
  const chars = Array.from({ length: GROUP * GROUPS }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  const groups = Array.from({ length: GROUPS }, (_, i) => chars.slice(i * GROUP, (i + 1) * GROUP).join(""));
  return `SPOT-${groups.join("-")}`;
}

/**
 * Whatever the person typed (any case, spaces, missing dashes, the SPOT- prefix or not) to the canonical code, or
 * null if it can't be a code. Characters outside the alphabet (0, 1, I, L, O) are rejected, never guessed.
 */
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("SPOT") && s.length === 4 + GROUP * GROUPS) s = s.slice(4);
  if (s.length !== GROUP * GROUPS) return null;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return null;
  return `SPOT-${s.slice(0, GROUP)}-${s.slice(GROUP)}`;
}

export const hashCode = (canonical: string) => createHash("sha256").update(canonical).digest("hex");

export const isExpired = (expiresAt: number, now: number) => now >= expiresAt;
export const isOnline = (lastSeen: number | undefined, now: number) => typeof lastSeen === "number" && now - lastSeen < SERVER_ONLINE_MS;

/** Lower-case letters and digits, runs of anything else become one dash. "Studio Mac!" is "studio-mac". */
export function sanitiseDevice(name: unknown): string {
  if (typeof name !== "string") return "";
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Service account ids are 6 to 30 characters of lower-case letters, digits and dashes. "spot-" takes 5. */
export const SA_PREFIX = "spot-";
const SA_MAX = 30;

/** spot-<device>, cut to fit. Empty or unusable names become "spot-server". */
export function serviceAccountBase(device: unknown): string {
  const slug = sanitiseDevice(device) || "server";
  return (SA_PREFIX + slug).slice(0, SA_MAX).replace(/-+$/g, "");
}

/** The first free id: the base, then base-2, base-3, ... (the base is trimmed so the id stays within 30 characters). */
export function pickServiceAccountId(device: unknown, taken: (id: string) => boolean): string {
  const base = serviceAccountBase(device);
  const ok = (id: string) => id.length >= 6 && !taken(id) && id !== ENROLLER_ID;
  if (ok(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const id = base.slice(0, SA_MAX - suffix.length).replace(/-+$/g, "") + suffix;
    if (ok(id)) return id;
  }
  throw new Error("Couldn't find a free service account name.");
}

export const serviceAccountEmail = (id: string, project = PROJECT_ID) => `${id}@${project}.iam.gserviceaccount.com`;

/** The only accounts Nothing BOT Curating may ever delete: its own per-server accounts. Never firebase-adminsdk, never the enroller. */
export function isManagedAccount(email: string, project = PROJECT_ID) {
  const m = new RegExp(`^(spot-[a-z0-9-]+)@${project.replace(/\./g, "\\.")}\\.iam\\.gserviceaccount\\.com$`).exec(email);
  return Boolean(m && m[1] !== ENROLLER_ID);
}

export const ipHash = (ip: string) => createHash("sha256").update(`spot-ip:${ip}`).digest("hex").slice(0, 32);

/** Fixed-window rate limit: returns the next counter state and whether this attempt is allowed. */
export function rateLimit(prev: { start: number; count: number } | undefined, now: number, limit: number, windowMs: number) {
  const fresh = !prev || now - prev.start >= windowMs;
  const state = fresh ? { start: now, count: 1 } : { start: prev.start, count: prev.count + 1 };
  return { state, allowed: state.count <= limit };
}

/** Add `member` to `role` in an IAM policy, leaving conditional bindings alone. Returns whether anything changed. */
export function addBinding(policy: { bindings?: Binding[] | null }, role: string, member: string): boolean {
  const bindings = (policy.bindings ??= []);
  const b = bindings.find((x) => x.role === role && !x.condition);
  if (!b) {
    bindings.push({ role, members: [member] });
    return true;
  }
  const members = (b.members ??= []);
  if (members.includes(member)) return false;
  members.push(member);
  return true;
}

/** Remove `member` from `role`, dropping the binding if it ends up empty. Conditional bindings are never touched. */
export function removeBinding(policy: { bindings?: Binding[] | null }, role: string, member: string): boolean {
  const bindings = policy.bindings ?? [];
  let changed = false;
  for (const b of bindings) {
    if (b.role !== role || b.condition || !b.members?.includes(member)) continue;
    b.members = b.members.filter((m) => m !== member);
    changed = true;
  }
  if (changed) policy.bindings = bindings.filter((b) => b.condition || (b.members?.length ?? 0) > 0);
  return changed;
}

export interface Binding {
  role?: string | null;
  members?: string[] | null;
  condition?: unknown;
}
