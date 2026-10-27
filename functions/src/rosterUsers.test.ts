import { describe, expect, it } from "vitest";
import { NOT_FOUND, lookupRosterUser, type RosterCaller, type UserDirectory } from "./rosterUsers";

const people: Record<string, { uid: string; name?: string; allowed: boolean }> = {
  "me@example.com": { uid: "me", name: "Me", allowed: true },
  "sam@example.com": { uid: "sam", name: "Sam Rao", allowed: true },
  "new@example.com": { uid: "new", allowed: false },
};
const dir: UserDirectory = {
  async byEmail(email) { const p = people[email]; return p ? { uid: p.uid, email, ...(p.name ? { name: p.name } : {}) } : null; },
  async isAllowed(uid) { return Object.values(people).some((p) => p.uid === uid && p.allowed); },
};
const me: RosterCaller = { uid: "me", email: "Me@Example.com", verified: true };
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

describe("lookupRosterUser", () => {
  it("finds an approved member by email, ignoring case and spaces", async () => {
    expect(await lookupRosterUser(dir, me, { email: "  SAM@example.com " })).toEqual({ uid: "sam", email: "sam@example.com", name: "Sam Rao" });
  });
  it("says so when nobody has that email", async () => {
    await expect(lookupRosterUser(dir, me, { email: "ghost@example.com" })).rejects.toMatchObject({ code: "not-found", message: NOT_FOUND });
  });
  it("won't hand out someone who isn't approved", async () => {
    expect(await code(lookupRosterUser(dir, me, { email: "new@example.com" }))).toBe("failed-precondition");
  });
  it("rejects anonymous, unverified, unapproved and signed-out callers", async () => {
    expect(await code(lookupRosterUser(dir, { ...me, anonymous: true }, { email: "sam@example.com" }))).toBe("permission-denied");
    expect(await code(lookupRosterUser(dir, { ...me, verified: false }, { email: "sam@example.com" }))).toBe("permission-denied");
    expect(await code(lookupRosterUser(dir, { uid: "new", email: "new@example.com", verified: true }, { email: "sam@example.com" }))).toBe("permission-denied");
    expect(await code(lookupRosterUser(dir, {}, { email: "sam@example.com" }))).toBe("permission-denied");
  });
  it("rejects things that aren't an email", async () => {
    for (const email of [undefined, 42, "", "sam", "sam@", "a b@c.d", `${"x".repeat(260)}@example.com`]) {
      expect(await code(lookupRosterUser(dir, me, { email }))).toBe("invalid-argument");
    }
  });
});
