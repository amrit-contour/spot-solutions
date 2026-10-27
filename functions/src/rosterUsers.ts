// "Who is this email?" for community rosters: adding a co-maintainer or a publisher, sharing a roster with one person.
// The app can't read other people's access records (firestore.rules), so a signed-in, approved member asks here and gets back
// only a uid, an email and a name, and only for another approved member. Only sees the ports below, so it is tested with fakes.
import { AppError } from "./core";

export interface DirectoryEntry {
  uid: string;
  email: string;
  name?: string;
}

export interface UserDirectory {
  /** Who signed in with this email (lower case), if anyone. */
  byEmail(email: string): Promise<DirectoryEntry | null>;
  /** Approved in the access list, or an admin. */
  isAllowed(uid: string, email: string): Promise<boolean>;
}

export interface RosterCaller {
  uid?: string;
  email?: string;
  verified?: boolean;
  anonymous?: boolean;
}

export const NOT_FOUND = "No one with that email uses the app yet. Ask them to sign in once, then try again.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function lookupRosterUser(dir: UserDirectory, caller: RosterCaller, input: { email?: unknown }): Promise<DirectoryEntry> {
  if (!caller.uid || !caller.email || caller.anonymous) throw new AppError("permission-denied", "Sign in to look people up.");
  if (!caller.verified) throw new AppError("permission-denied", "Verify your email address first.");
  if (!(await dir.isAllowed(caller.uid, caller.email.toLowerCase()))) throw new AppError("permission-denied", "Your account isn't approved yet.");

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL.test(email)) throw new AppError("invalid-argument", "Enter a full email address.");

  const found = await dir.byEmail(email);
  if (!found) throw new AppError("not-found", NOT_FOUND);
  if (!(await dir.isAllowed(found.uid, email))) throw new AppError("failed-precondition", "They have signed in but an admin hasn't approved them yet.");
  return { uid: found.uid, email, ...(found.name ? { name: found.name } : {}) };
}
