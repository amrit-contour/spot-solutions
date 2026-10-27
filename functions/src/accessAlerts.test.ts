import { describe, expect, it } from "vitest";
import { announceAccessRequest, closeAccessRequest, accessNotice, whoAsked, type AccessAlertPorts, type AccessNotice, type AccessPush } from "./accessAlerts";

function fake(admins = [{ uid: "a1", email: "boss@example.com" }, { uid: "a2", email: "two@example.com" }]) {
  const claimed = new Set<string>();
  const notices: Record<string, AccessNotice> = {};
  const closed: string[] = [];
  const pushes: { uid: string; push: AccessPush }[] = [];
  const ports: AccessAlertPorts = {
    claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)),
    admins: async () => admins,
    putNotice: async (uid, id, n) => void (notices[`${uid}/${id}`] = n),
    push: async (uid, push) => void pushes.push({ uid, push }),
    closeNotice: async (uid, id) => void (closed.push(`${uid}/${id}`)),
    now: () => 1000,
  };
  return { ports, notices, pushes, closed };
}
const priya = { uid: "u9", email: "priya@x.com", name: "Priya Shah", status: "pending", requestedAt: 5 };

describe("announceAccessRequest", () => {
  it("tells every admin: a notice with the Approve link, and a push", async () => {
    const f = fake();
    expect(await announceAccessRequest(f.ports, priya)).toBe(2);
    expect(Object.keys(f.notices).sort()).toEqual(["a1/access_u9", "a2/access_u9"]);
    const n = f.notices["a1/access_u9"]!;
    expect(n).toMatchObject({ kind: "access", link: "/admin", linkLabel: "Approve", read: false });
    expect(n.text).toBe("Priya Shah (priya@x.com) asked to join Nothing BOT. Approve or decline them on the admin page.");
    expect(n.agentText).toContain("Reply *approve Priya* or *decline Priya*");
    expect(f.pushes.map((p) => p.uid)).toEqual(["a1", "a2"]);
    expect(f.pushes[0]!.push.links).toEqual({ curate: "https://nothingbotcurate.web.app/admin", comic: "https://nothingbotcomedy.web.app/admin" });
  });
  it("is deduped: a repeated delivery tells nobody again", async () => {
    const f = fake();
    await announceAccessRequest(f.ports, priya);
    expect(await announceAccessRequest(f.ports, priya)).toBe(0);
    expect(f.pushes).toHaveLength(2);
  });
  it("ignores a request that isn't pending, and an admin's own", async () => {
    const f = fake();
    expect(await announceAccessRequest(f.ports, { ...priya, status: "approved" })).toBe(0);
    expect(await announceAccessRequest(f.ports, { ...priya, uid: "a2", email: "Two@Example.com" })).toBe(0);
    expect(f.pushes).toHaveLength(0);
  });
  it("one admin failing doesn't stop the others", async () => {
    const f = fake();
    f.ports.push = async (uid) => {
      if (uid === "a1") throw new Error("boom");
    };
    f.ports.putNotice = async (uid, id, n) => {
      if (uid === "a1") throw new Error("boom");
      f.notices[`${uid}/${id}`] = n;
    };
    expect(await announceAccessRequest(f.ports, priya)).toBe(1);
    expect(f.notices["a2/access_u9"]).toBeDefined();
  });
});

describe("closeAccessRequest", () => {
  it("closes the card for every admin once the request is decided", async () => {
    const f = fake();
    expect(await closeAccessRequest(f.ports, "u9")).toBe(2);
    expect(f.closed).toEqual(["a1/access_u9", "a2/access_u9"]);
  });
});

describe("texts", () => {
  it("falls back to the email, then to Someone", () => {
    expect(whoAsked({ email: "sam@x.com" })).toBe("sam (sam@x.com)");
    expect(whoAsked({})).toBe("Someone");
    expect(accessNotice({ uid: "u", email: "sam@x.com" }, 1).agentText).toContain("approve sam");
  });
});
