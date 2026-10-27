// One removal pass of the after-show cleanup, with the WhatsApp group behind a small port so tests can fake it (the real port is
// in groupCleanup.ts). whatsapp-web.js's removeParticipants answers { status: 200 } even when WhatsApp ignored the request and
// drops the per-participant result codes, so a call that didn't throw proves nothing: the group is read again to see who is really gone.
import { removeFailureReason, type CleanupMember, type CleanupPending } from "@spot/shared";

export interface GroupPort {
  /** The group's members now (fresh read). */
  read(): Promise<CleanupMember[]>;
  /** Remove one member by this id form. Throws on failure. */
  remove(id: string): Promise<void>;
}

const same = (a: CleanupMember, b: CleanupMember) => (a.phone && a.phone === b.phone) || a.ids.some((x) => b.ids.includes(x));

export interface PassResult {
  removed: CleanupMember[];
  left: { member: CleanupMember; reason: string }[];
}

/**
 * Remove `targets`: first by each one's first id form, then (for those still in the group) once by the alternate form (@lid vs @c.us).
 * Anyone still there at the end is returned with the reason of the last failure.
 */
export async function removalPass(port: GroupPort, targets: CleanupMember[], log: (m: string) => void = () => undefined): Promise<PassResult> {
  const reasons = new Map<CleanupMember, string>();
  let pending = targets;
  for (const form of [0, 1]) {
    const tries = pending.filter((t) => t.ids[form]);
    for (const t of tries) {
      try {
        await port.remove(t.ids[form]);
      } catch (e) {
        reasons.set(t, removeFailureReason(e));
        log(`remove ${t.ids[form]} failed: ${(e as Error)?.message ?? e}`);
      }
    }
    if (!tries.length) continue;
    try {
      const now = await port.read();
      pending = pending.filter((t) => now.some((m) => same(t, m)));
    } catch (e) {
      // Can't verify: don't claim success.
      for (const t of pending) reasons.set(t, reasons.get(t) ?? "couldn't check the group afterwards");
      log(`re-read failed: ${(e as Error).message}`);
      break;
    }
    if (!pending.length) break;
  }
  const left = pending.map((member) => ({ member, reason: reasons.get(member) ?? "still in the group after removal (WhatsApp ignored it)" }));
  return { removed: targets.filter((t) => !pending.includes(t)), left };
}

export const toPending = (left: PassResult["left"], names: Map<string, string>): CleanupPending[] =>
  left.map(({ member, reason }) => {
    const id = member.ids.find((x) => x.endsWith("@c.us")) ?? (member.phone ? `${member.phone}@c.us` : member.ids[0]);
    return { id, ...(names.get(id) ? { name: names.get(id) } : {}), reason };
  });
