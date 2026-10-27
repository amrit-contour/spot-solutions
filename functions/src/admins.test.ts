import { describe, expect, it } from "vitest";
import { memberActivity, setAdmin, type AdminPorts } from "./admins";

function ports(initial: string[], approved: string[] = ["sam@example.com", "boss@example.com", "two@example.com"]) {
  let admins = [...initial];
  const p: AdminPorts & { admins: () => string[] } = {
    admins: () => admins,
    adminEmails: async () => admins,
    updateAdmins: async (next) => (admins = next(admins)),
    isApprovedEmail: async (e) => approved.includes(e),
    accessUids: async () => ["a", "b"],
    activity: async (uids) => Object.fromEntries(uids.map((u) => [u, { curating: u === "a", comedy: u === "b", lastSeen: null }])),
  };
  return p;
}
const boss = { uid: "u1", email: "Boss@Example.com", verified: true };
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

describe("setAdmin", () => {
  it("adds an approved member, lower-cased, once", async () => {
    const p = ports(["boss@example.com"]);
    expect((await setAdmin(p, boss, { email: " Sam@Example.com ", admin: true })).admins).toEqual(["boss@example.com", "sam@example.com"]);
    await setAdmin(p, boss, { email: "sam@example.com", admin: true });
    expect(p.admins()).toEqual(["boss@example.com", "sam@example.com"]);
  });
  it("refuses someone who isn't approved", async () => {
    expect(await code(setAdmin(ports(["boss@example.com"]), boss, { email: "rando@example.com", admin: true }))).toBe("failed-precondition");
  });
  it("removes another admin", async () => {
    const p = ports(["boss@example.com", "two@example.com"]);
    await setAdmin(p, boss, { email: "two@example.com", admin: false });
    expect(p.admins()).toEqual(["boss@example.com"]);
  });
  it("never removes the last admin, not even yourself", async () => {
    const p = ports(["boss@example.com"]);
    expect(await code(setAdmin(p, boss, { email: "boss@example.com", admin: false }))).toBe("failed-precondition");
    expect(p.admins()).toEqual(["boss@example.com"]);
  });
  it("lets you step down when another admin remains", async () => {
    const p = ports(["boss@example.com", "two@example.com"]);
    await setAdmin(p, boss, { email: "boss@example.com", admin: false });
    expect(p.admins()).toEqual(["two@example.com"]);
  });
  it("is for verified, signed-in admins only", async () => {
    const p = ports(["boss@example.com"]);
    const add = { email: "sam@example.com", admin: true };
    expect(await code(setAdmin(p, { uid: "x", email: "sam@example.com", verified: true }, add))).toBe("permission-denied");
    expect(await code(setAdmin(p, { ...boss, verified: false }, add))).toBe("permission-denied");
    expect(await code(setAdmin(p, { ...boss, anonymous: true }, add))).toBe("permission-denied");
    expect(await code(setAdmin(p, {}, add))).toBe("permission-denied");
    expect(p.admins()).toEqual(["boss@example.com"]);
  });
  it("rejects malformed input", async () => {
    const p = ports(["boss@example.com"]);
    expect(await code(setAdmin(p, boss, { email: "nope", admin: true }))).toBe("invalid-argument");
    expect(await code(setAdmin(p, boss, { email: "sam@example.com" }))).toBe("invalid-argument");
  });
  it("rechecks inside the update: an admin removed meanwhile can't change the list", async () => {
    const p = ports(["boss@example.com", "two@example.com"]);
    p.adminEmails = async () => ["boss@example.com"]; // the first check still sees them
    p.updateAdmins = async (next) => next(["two@example.com"]);
    expect(await code(setAdmin(p, boss, { email: "sam@example.com", admin: true }))).toBe("permission-denied");
  });
});

describe("memberActivity", () => {
  it("is admin only", async () => {
    expect(await code(memberActivity(ports(["boss@example.com"]), { uid: "x", email: "sam@example.com", verified: true }))).toBe("permission-denied");
  });
  it("returns activity per uid", async () => {
    const r = await memberActivity(ports(["boss@example.com"]), boss);
    expect(r.activity.a).toMatchObject({ curating: true, comedy: false });
  });
});
