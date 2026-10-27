// A new access request (access/{uid}, status "pending") tells every admin, three ways: an Updates notice in their Curate app (with an
// Approve link to /admin), a push to their devices in both apps, and, through that same notice, a message on their agent number if
// they have one linked (the worker forwards notices of kind "access"). Deduped: the trigger can fire twice for one request, and the
// notice id is fixed per request, so a repeat changes nothing. Only sees ports, so it is tested with fakes.

export interface AccessRequest {
  uid: string;
  email?: string | null;
  name?: string | null;
  status?: string;
  requestedAt?: number;
}

export interface AdminAccount {
  uid: string;
  email: string;
}

export interface AccessNotice {
  level: "info";
  kind: "access";
  /** What the Updates card says. */
  text: string;
  /** What the agent number says (it carries the reply commands). */
  agentText: string;
  /** Where the Approve button goes, in the app. */
  link: string;
  linkLabel: string;
  createdAt: number;
  read: false;
}

export interface AccessPush {
  title: string;
  body: string;
  /** Absolute links, one per app; each device gets the one for its own app. */
  links: { curate: string; comic: string };
}

export interface AccessAlertPorts {
  /** Atomically claim this request's alert. False when it was already claimed (a repeat delivery). */
  claim(key: string): Promise<boolean>;
  /** Admins that have an account, with the emails from config/access. */
  admins(): Promise<AdminAccount[]>;
  /** Write the notice under users/{uid}/notices/{id}; writing the same id twice leaves one. */
  putNotice(uid: string, id: string, notice: AccessNotice): Promise<void>;
  /** Mark the notice read and dismissed (no error when it is gone). */
  closeNotice(uid: string, id: string, at: number): Promise<void>;
  /** Push to this admin's devices (both apps). Never throws for a dead token. */
  push(uid: string, push: AccessPush): Promise<void>;
  now(): number;
  log?(message: string): void;
}

export const CURATE_URL = "https://nothingbotcurate.web.app";
export const COMEDY_URL = "https://nothingbotcomedy.web.app";

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, 80) : "");

/** "Priya (priya@x.com)", or just the email when there is no name. */
export function whoAsked(r: Pick<AccessRequest, "name" | "email">): string {
  const email = clean(r.email);
  const name = clean(r.name) || (email ? email.split("@")[0]! : "");
  if (!name && !email) return "Someone";
  return email && name !== email ? `${name} (${email})` : name || email;
}

export const noticeIdFor = (uid: string) => `access_${uid}`;

export function accessNotice(r: AccessRequest, now: number): AccessNotice {
  const who = whoAsked(r);
  const first = (clean(r.name) || clean(r.email).split("@")[0] || "").split(" ")[0] || "them";
  return {
    level: "info",
    kind: "access",
    text: `${who} asked to join Nothing BOT. Approve or decline them on the admin page.`,
    agentText: `${who} asked to join Nothing BOT. Reply *approve ${first}* or *decline ${first}*, or open the admin page.`,
    link: "/admin",
    linkLabel: "Approve",
    createdAt: now,
    read: false,
  };
}

/**
 * Tell the admins about one new request. Returns how many admins were told. Nothing happens for a request that isn't pending, or
 * that came from an admin themselves (the worker approves those on its own).
 */
export async function announceAccessRequest(ports: AccessAlertPorts, r: AccessRequest): Promise<number> {
  if (!r.uid || r.status !== "pending") return 0;
  const admins = await ports.admins();
  const mine = clean(r.email).toLowerCase();
  if (mine && admins.some((a) => a.email.toLowerCase() === mine)) return 0;
  if (!(await ports.claim(`${r.uid}_${r.requestedAt ?? 0}`))) return 0;
  const now = ports.now();
  const notice = accessNotice(r, now);
  const who = whoAsked(r);
  let told = 0;
  for (const a of admins) {
    if (a.uid === r.uid) continue;
    try {
      await ports.putNotice(a.uid, noticeIdFor(r.uid), notice);
      told++;
    } catch (e) {
      ports.log?.(`notice for admin ${a.uid} failed: ${(e as Error).message}`);
    }
    try {
      await ports.push(a.uid, { title: "New access request", body: `${who} asked to join Nothing BOT.`, links: { curate: `${CURATE_URL}/admin`, comic: `${COMEDY_URL}/admin` } });
    } catch (e) {
      ports.log?.(`push for admin ${a.uid} failed: ${(e as Error).message}`);
    }
  }
  return told;
}

/** The request was decided (here, on the admin page or from an agent number): take the "Approve" card away from every admin's Updates. */
export async function closeAccessRequest(ports: AccessAlertPorts, uid: string): Promise<number> {
  const now = ports.now();
  let closed = 0;
  for (const a of await ports.admins()) {
    try {
      await ports.closeNotice(a.uid, noticeIdFor(uid), now);
      closed++;
    } catch (e) {
      ports.log?.(`closing the notice for admin ${a.uid} failed: ${(e as Error).message}`);
    }
  }
  return closed;
}
