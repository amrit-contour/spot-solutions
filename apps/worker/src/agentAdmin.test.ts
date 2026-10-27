import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseSide } from "@spot/shared";

// The admin commands read access/* and config/access and write the decision. Fakes stand in for Firestore and Auth.
const store = new Map<string, Record<string, unknown>>();
const authUsers = new Map<string, { email?: string; emailVerified: boolean }>();
vi.mock("./firebase.ts", () => ({
  db: {
    doc: (path: string) => ({ get: async () => ({ data: () => store.get(path) }), update: async (d: Record<string, unknown>) => void store.set(path, { ...store.get(path), ...d }) }),
    collection: (name: string) => ({
      doc: (id: string) => ({ get: async () => ({ data: () => store.get(`${name}/${id}`) }), update: async (d: Record<string, unknown>) => void store.set(`${name}/${id}`, { ...store.get(`${name}/${id}`), ...d }) }),
      get: async () => ({ docs: [...store].filter(([k]) => k.startsWith(`${name}/`)).map(([k, d]) => ({ id: k.slice(name.length + 1), data: () => d })) }),
    }),
  },
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    getUser: async (uid: string) => {
      const u = authUsers.get(uid);
      if (!u) throw new Error("no user");
      return u;
    },
  }),
}));

const { adminEmail, membersWaitingText, planMemberChange, runMemberChange } = await import("./agentAdmin.ts");
const { curateReads, comedyReads } = await import("./agentRoute.ts");

beforeEach(() => {
  store.clear();
  authUsers.clear();
  store.set("config/access", { admins: ["boss@example.com"], maxCurators: 3 });
  authUsers.set("boss", { email: "Boss@Example.com", emailVerified: true });
  authUsers.set("plain", { email: "plain@example.com", emailVerified: true });
  authUsers.set("spoof", { email: "boss@example.com", emailVerified: false });
  store.set("access/u1", { email: "priya@x.com", name: "Priya Shah", status: "pending", requestedAt: 1 });
  store.set("access/u2", { email: "sam@x.com", name: "Sam Lee", status: "approved", requestedAt: 0 });
});

describe("who is an admin", () => {
  it("only a verified email on config/access.admins", async () => {
    expect(await adminEmail("boss")).toBe("boss@example.com");
    expect(await adminEmail("plain")).toBeNull();
    expect(await adminEmail("spoof")).toBeNull();
    expect(await adminEmail("nobody")).toBeNull();
  });
});

describe("agent member commands", () => {
  const approve = { name: "approve_member" as const, person: "priya" };
  it("lists who is waiting, for admins only", async () => {
    expect(await membersWaitingText("boss")).toContain("Priya Shah (priya@x.com)");
    expect(await membersWaitingText("plain")).toContain("Only admins");
  });
  it("a non-admin can't plan or run an approval", async () => {
    expect((await planMemberChange("plain", approve, 1)).reply).toContain("Only admins");
    await runMemberChange("plain", { type: "member", uid: "u1", name: "Priya Shah", email: "priya@x.com", decision: "approved" });
    expect(store.get("access/u1")!.status).toBe("pending");
  });
  it("approve: plan, yes, written like the admin page writes it", async () => {
    const r = await planMemberChange("boss", approve, 1);
    if (r.pending?.stage !== "confirm" || r.pending.plan.type !== "member") throw new Error("expected a member plan");
    const said = await runMemberChange("boss", r.pending.plan);
    expect(said).toContain("Priya Shah is in");
    expect(store.get("access/u1")).toMatchObject({ status: "approved", decidedBy: "boss@example.com (agent)" });
    expect(typeof store.get("access/u1")!.decidedAt).toBe("number");
  });
  it("decline marks the request removed", async () => {
    const r = await planMemberChange("boss", { name: "decline_member", person: "priya" }, 1);
    if (r.pending?.stage !== "confirm" || r.pending.plan.type !== "member") throw new Error("expected a member plan");
    await runMemberChange("boss", r.pending.plan);
    expect(store.get("access/u1")!.status).toBe("removed");
  });
  it("respects the curator limit, both when planning and at the yes", async () => {
    store.set("access/u3", { email: "a@x.com", name: "A", status: "approved", requestedAt: 0 });
    store.set("access/u4", { email: "b@x.com", name: "B", status: "approved", requestedAt: 0 });
    expect((await planMemberChange("boss", approve, 1)).reply).toContain("limit of 3 curators");
    expect(await runMemberChange("boss", { type: "member", uid: "u1", name: "Priya Shah", email: "priya@x.com", decision: "approved" })).toContain("limit of 3");
    expect(store.get("access/u1")!.status).toBe("pending");
  });
  it("rechecks at the yes: already decided by someone else, or gone", async () => {
    store.set("access/u1", { ...store.get("access/u1"), status: "approved" });
    expect(await runMemberChange("boss", { type: "member", uid: "u1", name: "Priya Shah", email: "", decision: "approved" })).toContain("already approved");
    expect(await runMemberChange("boss", { type: "member", uid: "zz", name: "Ghost", email: "", decision: "approved" })).toContain("isn't there");
  });
});

describe("routing for an account that uses both apps", () => {
  const side = (t: string) => chooseSide(t, { curate: curateReads(t), comedy: comedyReads(t, Date.parse("2026-10-27T07:00:00Z")) });
  it("sends the new commands to Curate without asking", () => {
    for (const t of ["approve Priya", "decline Priya", "who's waiting to join?", "offer Rahul a spot on Monday", "give Rahul Monday ad hoc", "add Rahul to Monday directly", "Rahul already agreed for Monday"]) {
      expect(curateReads(t), t).toBe(true);
      expect(side(t), t).toBe("curate");
    }
  });
});
