// Admin management for both apps (Curating and Comedy share config/access.admins). The browser can never write the admin list
// (firestore.rules only lets an admin change maxCurators), so adding and removing admins goes through here, where the rules that
// matter are checked: only an admin may change it, only an approved member can become one, and the last admin can never go.
// Also the per-member activity (which app they use, when they were last seen) for the admin Members list. Only sees ports, so it is tested with fakes.
import { AppError } from "./core";

export interface AdminCaller {
  uid?: string;
  email?: string;
  verified?: boolean;
  anonymous?: boolean;
}

export interface Activity {
  curating: boolean;
  comedy: boolean;
  /** Epoch ms of the last token refresh or sign-in; null when the account has never been seen. */
  lastSeen: number | null;
}

export interface AdminPorts {
  /** Lower-case admin emails from config/access. */
  adminEmails(): Promise<string[]>;
  /** Atomically change the admin list: `next` gets the current list and returns the new one (or throws). Returns the stored list. */
  updateAdmins(next: (current: string[]) => string[]): Promise<string[]>;
  /** Is there an access record for this email with status "approved"? */
  isApprovedEmail(email: string): Promise<boolean>;
  /** Every uid that has an access record. */
  accessUids(): Promise<string[]>;
  activity(uids: string[]): Promise<Record<string, Activity>>;
}

const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

async function requireAdmin(ports: AdminPorts, caller: AdminCaller): Promise<string> {
  if (!caller.uid || !caller.email || caller.anonymous) throw new AppError("permission-denied", "Sign in as an admin.");
  if (!caller.verified) throw new AppError("permission-denied", "Verify your email address first.");
  const email = caller.email.trim().toLowerCase();
  if (!(await ports.adminEmails()).includes(email)) throw new AppError("permission-denied", "Only admins can do this.");
  return email;
}

/** Make `email` an admin (`admin: true`) or take it away (`false`). Returns the new list. */
export async function setAdmin(ports: AdminPorts, caller: AdminCaller, input: { email?: unknown; admin?: unknown }): Promise<{ admins: string[] }> {
  const me = await requireAdmin(ports, caller);
  const target = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(target) || typeof input.admin !== "boolean") throw new AppError("invalid-argument", "Say who, and whether to add or remove them.");

  if (input.admin && !(await ports.isApprovedEmail(target))) {
    throw new AppError("failed-precondition", "Only approved members can be made admins. Approve them first.");
  }
  const admins = await ports.updateAdmins((current) => {
    const list = current.map((e) => e.trim().toLowerCase());
    // Checked again inside the transaction, in case an admin was removed since the check above.
    if (!list.includes(me)) throw new AppError("permission-denied", "Only admins can do this.");
    if (input.admin) return list.includes(target) ? list : [...list, target];
    if (!list.includes(target)) return list;
    const rest = list.filter((e) => e !== target);
    if (rest.length === 0) throw new AppError("failed-precondition", "That's the last admin. Make someone else an admin first.");
    return rest;
  });
  return { admins };
}

/** Admin: which app each member uses and when they were last seen. */
export async function memberActivity(ports: AdminPorts, caller: AdminCaller): Promise<{ activity: Record<string, Activity> }> {
  await requireAdmin(ports, caller);
  return { activity: await ports.activity(await ports.accessUids()) };
}
