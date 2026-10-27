// The agent number's admin commands: who is waiting to join, approve, decline. The same checks as the admin page: only an admin
// (config/access.admins, matched to a verified Auth email, never to what the account's own profile says), and approving respects
// config/access.maxCurators. The decision is the same write the admin page makes (access/{uid}: status, decidedAt, decidedBy).
import { getAuth } from "firebase-admin/auth";
import type { ActionPlan, AgentIntent, Planned } from "@spot/shared";
import { NOT_ADMIN, formatMembersWaiting, planMember, type AccessRow } from "@spot/shared";
import { db } from "./firebase.ts";

const DEFAULT_MAX = Number(process.env.NBS_MAX_CURATORS || 6);

/** The curator's verified email when it is on config/access.admins, else null. */
export async function adminEmail(uid: string): Promise<string | null> {
  try {
    const u = await getAuth().getUser(uid);
    const email = u.emailVerified ? u.email?.trim().toLowerCase() : undefined;
    if (!email) return null;
    const admins = (await db.doc("config/access").get()).data()?.admins;
    return Array.isArray(admins) && admins.map((a) => String(a).trim().toLowerCase()).includes(email) ? email : null;
  } catch (e) {
    console.warn(`[agent] ${uid} admin check failed:`, (e as Error).message);
    return null;
  }
}

async function readAccess(): Promise<{ rows: AccessRow[]; max: number }> {
  const [snap, cfg] = await Promise.all([db.collection("access").get(), db.doc("config/access").get()]);
  const rows = snap.docs.map((d) => ({ ...(d.data() as Omit<AccessRow, "uid">), uid: d.id }));
  const max = Number(cfg.data()?.maxCurators);
  return { rows, max: Number.isFinite(max) && max >= 1 ? max : DEFAULT_MAX };
}

/** "Who's waiting to join?" Admin only. */
export async function membersWaitingText(uid: string): Promise<string> {
  if (!(await adminEmail(uid))) return NOT_ADMIN;
  return formatMembersWaiting((await readAccess()).rows);
}

/** "approve Priya" / "decline Priya": what the agent repeats back and waits for a yes on. Nothing is written. */
export async function planMemberChange(uid: string, intent: AgentIntent, now: number): Promise<Planned> {
  const admin = await adminEmail(uid);
  const { rows, max } = await readAccess();
  return planMember(intent, rows, { admin: Boolean(admin), approved: rows.filter((r) => r.status === "approved").length, max, now });
}

/** After the yes: checks everything again (who is asking, what the record says now, the limit), then writes the decision. */
export async function runMemberChange(uid: string, p: Extract<ActionPlan, { type: "member" }>): Promise<string> {
  const admin = await adminEmail(uid);
  if (!admin) return "Only admins can approve or decline people, so I did nothing.";
  const ref = db.collection("access").doc(p.uid);
  const cur = (await ref.get()).data() as { status?: string; email?: string } | undefined;
  if (!cur) return `${p.name}'s request isn't there any more, so I did nothing.`;
  if (cur.status === p.decision) return `${p.name} was already ${p.decision === "approved" ? "approved" : "declined"}.`;
  if (p.decision === "approved") {
    const { rows, max } = await readAccess();
    if (rows.filter((r) => r.status === "approved").length >= max) return `You're at the limit of ${max} curators, so I didn't approve ${p.name}. Raise the limit or remove someone on the admin page first.`;
  } else if (cur.status === "approved") {
    return `${p.name} is a member now, so I didn't decline them. To remove a member, use the admin page.`;
  }
  await ref.update({ status: p.decision, decidedAt: Date.now(), decidedBy: `${admin} (agent)` });
  return p.decision === "approved" ? `Done: ${p.name} is in. They get their own WhatsApp session on the server.` : `Done: ${p.name}'s request is declined. You can restore them on the admin page.`;
}
