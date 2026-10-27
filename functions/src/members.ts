// The member directory for community rosters: picking a co-maintainer or someone to share rooms with. This is a close-knit community,
// so an approved member may see every other approved member's name, email and photo (and nobody else's). The app can't read other
// people's access records (firestore.rules), so it asks here. Only sees the ports below, so it is tested with fakes.
import { AppError } from "./core";

export interface Member {
  uid: string;
  name: string;
  email: string;
  photoURL: string | null;
}

export interface AccessRecord {
  uid: string;
  email?: string;
  name?: string;
  photo?: string;
}

export interface AuthProfile {
  uid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  disabled?: boolean;
}

export type Identifier = { uid: string } | { email: string };

export interface MemberSource {
  /** Approved in the access list, or an admin. */
  isAllowed(uid: string, email: string): Promise<boolean>;
  /** Lower-case admin emails from config/access. */
  adminEmails(): Promise<string[]>;
  /** Access records with status "approved". */
  approvedAccess(): Promise<AccessRecord[]>;
  /** Firebase Auth accounts for these ids (batched by the implementation); unknown ids are simply missing. */
  authProfiles(ids: Identifier[]): Promise<AuthProfile[]>;
}

export interface MemberCaller {
  uid?: string;
  email?: string;
  verified?: boolean;
  anonymous?: boolean;
}

export const CACHE_MS = 5 * 60_000;

async function build(src: MemberSource): Promise<Member[]> {
  const [admins, access] = await Promise.all([src.adminEmails(), src.approvedAccess()]);
  const byUid = new Map(access.map((a) => [a.uid, a]));
  const profiles = await src.authProfiles([...access.map((a) => ({ uid: a.uid })), ...admins.map((email) => ({ email }))]);
  const out = new Map<string, Member>();
  for (const p of profiles) {
    const a = byUid.get(p.uid);
    const email = (p.email || a?.email || "").trim().toLowerCase();
    // Admins count as approved even without an access record; everyone else needs the "approved" record. Anonymous accounts have no email.
    if (!email || p.disabled || (!a && !admins.includes(email))) continue;
    out.set(p.uid, { uid: p.uid, email, name: (p.displayName || a?.name || "").trim() || (email.split("@")[0] ?? email), photoURL: p.photoURL || a?.photo || null });
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }) || x.email.localeCompare(y.email));
}

/** One lister per function instance: the list is cached for a few minutes, the caller is checked on every call. */
export function memberLister(src: MemberSource, now: () => number = Date.now, ttl = CACHE_MS) {
  let cached: { at: number; members: Promise<Member[]> } | null = null;
  return async (caller: MemberCaller): Promise<{ members: Member[] }> => {
    if (!caller.uid || !caller.email || caller.anonymous) throw new AppError("permission-denied", "Sign in to see members.");
    if (!caller.verified) throw new AppError("permission-denied", "Verify your email address first.");
    if (!(await src.isAllowed(caller.uid, caller.email.toLowerCase()))) throw new AppError("permission-denied", "Your account isn't approved yet.");
    if (!cached || now() - cached.at >= ttl) {
      const members = build(src);
      cached = { at: now(), members };
      members.catch(() => { if (cached?.members === members) cached = null; });
    }
    return { members: await cached.members };
  };
}
