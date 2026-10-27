import { describe, expect, it, vi } from "vitest";
import { memberLister, type AccessRecord, type AuthProfile, type MemberSource } from "./members";

const auth: AuthProfile[] = [
  { uid: "me", email: "Me@Example.com", displayName: "Me Myself", photoURL: "https://x/me.png" },
  { uid: "sam1", email: "sam1@example.com", displayName: "Sam Rao", photoURL: "https://x/s1.png" },
  { uid: "sam2", email: "sam2@example.com", displayName: "Sam Rao", photoURL: "https://x/s2.png" },
  { uid: "nameless", email: "zed@example.com" },
  { uid: "fallback", email: "fb@example.com" },
  { uid: "pending", email: "pending@example.com", displayName: "Pending Pat" },
  { uid: "gone", email: "gone@example.com", displayName: "Gone Gil" },
  { uid: "anon" },
  { uid: "off", email: "off@example.com", displayName: "Disabled Dee", disabled: true },
  { uid: "boss", email: "boss@example.com", displayName: "Admin Ash" },
];
const access: AccessRecord[] = [
  { uid: "me", email: "me@example.com" },
  { uid: "fallback", name: "Fallback Fay", photo: "https://x/fb.png" },
  { uid: "sam1" },
  { uid: "sam2" },
  { uid: "nameless" },
  { uid: "anon" },
  { uid: "off" },
];
const admins = ["boss@example.com", "nobody@example.com"];

function source(): MemberSource & { calls: number } {
  const s = {
    calls: 0,
    isAllowed: async (uid: string, email: string) => admins.includes(email) || access.some((a) => a.uid === uid),
    adminEmails: async () => admins,
    approvedAccess: async () => { s.calls++; return access; },
    authProfiles: async (ids: ({ uid: string } | { email: string })[]) =>
      auth.filter((u) => ids.some((i) => ("uid" in i ? i.uid === u.uid : i.email === u.email))),
  };
  return s;
}
const me = { uid: "me", email: "ME@example.com", verified: true };
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

describe("memberLister", () => {
  it("returns approved, non-anonymous members and admins, sorted, in the picker's shape", async () => {
    const { members } = await memberLister(source())(me);
    expect(members.map((m) => m.uid)).toEqual(["boss", "fallback", "me", "sam1", "sam2", "nameless"]);
    expect(members.find((m) => m.uid === "me")).toEqual({ uid: "me", name: "Me Myself", email: "me@example.com", photoURL: "https://x/me.png" });
  });
  it("leaves out pending, removed, anonymous and disabled accounts", async () => {
    const ids = (await memberLister(source())(me)).members.map((m) => m.uid);
    for (const u of ["pending", "gone", "anon", "off"]) expect(ids).not.toContain(u);
  });
  it("keeps two people with the same name apart by email, and falls back to the access record and the email", async () => {
    const { members } = await memberLister(source())(me);
    const sams = members.filter((m) => m.name === "Sam Rao");
    expect(sams.map((m) => m.email)).toEqual(["sam1@example.com", "sam2@example.com"]);
    expect(members.find((m) => m.uid === "fallback")).toMatchObject({ name: "Fallback Fay", photoURL: "https://x/fb.png" });
    expect(members.find((m) => m.uid === "nameless")).toMatchObject({ name: "zed", photoURL: null });
  });
  it("rejects anonymous, unverified, unapproved and signed-out callers", async () => {
    const list = memberLister(source());
    expect(await code(list({ ...me, anonymous: true }))).toBe("permission-denied");
    expect(await code(list({ ...me, verified: false }))).toBe("permission-denied");
    expect(await code(list({ uid: "pending", email: "pending@example.com", verified: true }))).toBe("permission-denied");
    expect(await code(list({}))).toBe("permission-denied");
  });
  it("lets an admin without an access record in", async () => {
    expect(await code(memberLister(source())({ uid: "boss", email: "boss@example.com", verified: true }))).toBe("ok");
  });
  it("caches the list for a few minutes but still checks the caller", async () => {
    const s = source();
    let t = 0;
    const list = memberLister(s, () => t, 1000);
    await list(me);
    await list(me);
    expect(s.calls).toBe(1);
    expect(await code(list({ uid: "pending", email: "pending@example.com", verified: true }))).toBe("permission-denied");
    t = 1000;
    await list(me);
    expect(s.calls).toBe(2);
  });
  it("doesn't cache a failure", async () => {
    const s = source();
    const boom = vi.spyOn(s, "approvedAccess").mockRejectedValueOnce(new Error("x"));
    const list = memberLister(s);
    await expect(list(me)).rejects.toThrow();
    expect((await list(me)).members.length).toBeGreaterThan(0);
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it("still lists members from the access records when the Auth lookup fails, and never sends a malformed admin email to it", async () => {
    const seen: unknown[] = [];
    const src = { ...source(), approvedAccess: async () => [{ uid: "me", email: "me@example.com", name: "Me Myself" }, { uid: "sam1", email: "sam1@example.com", name: "Sam Rao" }], adminEmails: async () => ["not an email", "boss@example.com", "boss@example.com"],
      authProfiles: async (ids: unknown[]) => { seen.push(ids); throw new Error("PERMISSION_DENIED"); } };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await memberLister(src)(me);
    expect(r.members.map((m) => m.name)).toEqual(["Me Myself", "Sam Rao"]);
    expect(seen[0]).toEqual([{ uid: "me" }, { uid: "sam1" }, { email: "boss@example.com" }]);
  });
});
