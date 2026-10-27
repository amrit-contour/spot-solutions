import { describe, expect, it } from "vitest";
import { canClearNow, cleanupNotice, nextRetryAt, planCleanup, type CleanupMember } from "@spot/shared";
import { removalPass, toPending, type GroupPort } from "./cleanupPass.ts";

const member = (phone: string, lid?: string, isAdmin = false): CleanupMember => ({ ids: [lid, `${phone}@c.us`].filter((x): x is string => Boolean(x)), phone, isAdmin });

/** A fake group: `rules` decide what each remove call does (throw, silently ignore, or really remove). */
function group(members: CleanupMember[], rules: Record<string, "throw403" | "ignore" | "ok"> = {}) {
  let cur = [...members];
  const calls: string[] = [];
  const port: GroupPort = {
    read: async () => cur,
    remove: async (id) => {
      calls.push(id);
      const rule = rules[id] ?? "ok";
      if (rule === "throw403") throw new Error("failed: 403");
      if (rule === "ok") cur = cur.filter((m) => !m.ids.includes(id));
    },
  };
  return { port, calls, left: () => cur };
}

describe("cleanup end to end (fake group)", () => {
  const regular = member("611", "611111@lid");
  const poc = member("612");
  const admin = member("613", undefined, true);
  const next = member("614", "614111@lid");
  const strangers = [member("621", "621111@lid"), member("622"), member("623", "623111@lid")];
  const all = [regular, poc, admin, next, ...strangers];
  const plan = () => planCleanup({ members: all, stay: ["611@c.us", "612@c.us", "614@c.us"], comics: [], self: [] });

  it("protected people are never attempted, by lid or c.us", async () => {
    const g = group(all);
    const r = await removalPass(g.port, plan().remove);
    expect(r.removed).toHaveLength(3);
    for (const id of [...regular.ids, ...poc.ids, ...admin.ids, ...next.ids]) expect(g.calls).not.toContain(id);
    expect(g.left()).toEqual([regular, poc, admin, next]);
  });
  it("tries the lid first, uses the alternate id once when that fails, and reports the reason when both fail", async () => {
    const g = group(all, { "621111@lid": "throw403", "623111@lid": "throw403", "623@c.us": "throw403" });
    const r = await removalPass(g.port, plan().remove);
    expect(g.calls.filter((c) => c.startsWith("621"))).toEqual(["621111@lid", "621@c.us"]); // alternate worked
    expect(r.removed.map((m) => m.phone).sort()).toEqual(["621", "622"]);
    expect(r.left).toHaveLength(1);
    expect(r.left[0].member.phone).toBe("623");
    expect(r.left[0].reason).toMatch(/admin/);
    expect(g.calls.filter((c) => c.startsWith("623"))).toEqual(["623111@lid", "623@c.us"]); // exactly once each
  });
  it("a call that doesn't throw but changes nothing is not counted as removed", async () => {
    const g = group(all, { "622@c.us": "ignore" });
    const r = await removalPass(g.port, plan().remove);
    expect(r.left.map((l) => l.member.phone)).toEqual(["622"]);
    expect(r.left[0].reason).toMatch(/still in the group/);
  });
  it("retries until only the protected remain, and stops asking once done", async () => {
    let rule: "throw403" | "ok" = "throw403";
    const rules = { get "622@c.us"() { return rule; } } as Record<string, "throw403" | "ok">;
    const g = group(all, rules);
    let pending = plan().remove;
    let retryAt: number | null = 0;
    let attempts = 0;
    const until = 10 * 3600_000;
    const names = new Map([["622@c.us", "Ravi"]]);
    let lastNotice = "";
    while (retryAt !== null) {
      const r = await removalPass(g.port, pending);
      attempts++;
      const pend = toPending(r.left, names);
      retryAt = pend.length ? nextRetryAt(attempts, attempts * 1000, until) : null;
      lastNotice = cleanupNotice({ show: "Open Mic", removed: r.removed.length, pending: pend, skipped: 0, retryInMs: retryAt === null ? null : 120_000, retry: attempts > 1 });
      if (attempts === 1) {
        expect(lastNotice).toContain("Ravi: ");
        expect(lastNotice).toContain("Trying again");
      }
      if (attempts === 2) rule = "ok"; // WhatsApp lets it through on the third go
      // re-read the group before each retry: the plan is rebuilt from who is there now
      pending = planCleanup({ members: await g.port.read(), stay: ["611@c.us", "612@c.us", "614@c.us"], comics: [], self: [] }).remove;
    }
    expect(attempts).toBe(3);
    expect(lastNotice).toContain("the rest are out now");
    expect(g.left().map((m) => m.phone).sort()).toEqual(["611", "612", "613", "614"]);
  });
  it("reports unverifiable results instead of claiming success", async () => {
    const g = group(all);
    g.port.read = async () => { throw new Error("page closed"); };
    const r = await removalPass(g.port, plan().remove);
    expect(r.removed).toEqual([]);
    expect(r.left).toHaveLength(3);
  });
  it("won't run on a fresh or sick session", () => {
    expect(canClearNow({ healthy: true, stableMs: 10_000 })).toBe(false);
    expect(canClearNow({ healthy: false, stableMs: 600_000 })).toBe(false);
  });
});
