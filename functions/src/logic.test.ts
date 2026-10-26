import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  addBinding,
  generateCode,
  hashCode,
  isExpired,
  isManagedAccount,
  isOnline,
  normaliseCode,
  pickServiceAccountId,
  rateLimit,
  removeBinding,
  sanitiseDevice,
  serviceAccountBase,
} from "./logic";

describe("join codes", () => {
  it("generates SPOT-XXXX-XXXX from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toMatch(/^SPOT-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(c.slice(5).replace("-", "")).toSatisfy((s: string) => [...s].every((ch) => CODE_ALPHABET.includes(ch)));
      expect(c.slice(5)).not.toMatch(/[01ILO]/);
    }
    expect(new Set(Array.from({ length: 100 }, generateCode)).size).toBe(100);
  });

  it("accepts typed variants and rejects the rest", () => {
    expect(normaliseCode("spot-7k3f-q9tx")).toBe("SPOT-7K3F-Q9TX");
    expect(normaliseCode(" SPOT 7K3F Q9TX ")).toBe("SPOT-7K3F-Q9TX");
    expect(normaliseCode("7K3FQ9TX")).toBe("SPOT-7K3F-Q9TX");
    expect(normaliseCode("SPOT-7K3F-Q9T")).toBeNull();
    expect(normaliseCode("SPOT-7K3F-Q9TXX")).toBeNull();
    expect(normaliseCode("SPOT-0K3F-Q9TX")).toBeNull(); // 0 is not in the alphabet
    expect(normaliseCode("SPOT-7K3F-Q9TL")).toBeNull();
    expect(normaliseCode(undefined)).toBeNull();
    expect(normaliseCode("x".repeat(500))).toBeNull();
  });

  it("hashes the canonical form, so every spelling finds the same document", () => {
    expect(hashCode(normaliseCode("spot 7k3f q9tx")!)).toBe(hashCode("SPOT-7K3F-Q9TX"));
    expect(hashCode("SPOT-7K3F-Q9TX")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode("SPOT-7K3F-Q9TX")).not.toContain("7K3F");
  });

  it("expires at the exact moment", () => {
    expect(isExpired(1000, 999)).toBe(false);
    expect(isExpired(1000, 1000)).toBe(true);
    expect(isExpired(1000, 5000)).toBe(true);
  });
});

describe("service account names", () => {
  it("sanitises device names like the shell scripts", () => {
    expect(sanitiseDevice("Studio Mac!")).toBe("studio-mac");
    expect(sanitiseDevice("  --PC_01.local ")).toBe("pc-01-local");
    expect(sanitiseDevice("")).toBe("");
    expect(sanitiseDevice(42)).toBe("");
  });

  it("keeps ids within 6 to 30 characters", () => {
    expect(serviceAccountBase("studio-mac")).toBe("spot-studio-mac");
    expect(serviceAccountBase("")).toBe("spot-server");
    expect(serviceAccountBase("!!!")).toBe("spot-server");
    const long = serviceAccountBase("a".repeat(80));
    expect(long.length).toBe(30);
    expect(serviceAccountBase("a".repeat(24) + "-bbb")).not.toMatch(/-$/);
  });

  it("dedupes with a numeric suffix and stays within 30 characters", () => {
    const taken = new Set(["spot-studio-mac", "spot-studio-mac-2"]);
    expect(pickServiceAccountId("Studio Mac", (id) => taken.has(id))).toBe("spot-studio-mac-3");
    const base = serviceAccountBase("x".repeat(40));
    const id = pickServiceAccountId("x".repeat(40), (i) => i === base);
    expect(id.length).toBeLessThanOrEqual(30);
    expect(id.endsWith("-2")).toBe(true);
  });

  it("never picks the enroller's own name", () => {
    expect(pickServiceAccountId("enroller", () => false)).toBe("spot-enroller-2");
  });

  it("only treats spot-<device> accounts as ours to delete", () => {
    expect(isManagedAccount("spot-studio-mac@spot-solutions.iam.gserviceaccount.com")).toBe(true);
    expect(isManagedAccount("firebase-adminsdk-fbsvc@spot-solutions.iam.gserviceaccount.com")).toBe(false);
    expect(isManagedAccount("spot-enroller@spot-solutions.iam.gserviceaccount.com")).toBe(false);
    expect(isManagedAccount("spot-x@other-project.iam.gserviceaccount.com")).toBe(false);
    expect(isManagedAccount("123-compute@developer.gserviceaccount.com")).toBe(false);
  });
});

describe("online and rate limit", () => {
  it("counts a heartbeat under 75 s old as online", () => {
    expect(isOnline(1_000_000 - 74_000, 1_000_000)).toBe(true);
    expect(isOnline(1_000_000 - 75_000, 1_000_000)).toBe(false);
    expect(isOnline(undefined, 1)).toBe(false);
  });

  it("allows `limit` attempts per window, then resets", () => {
    let s: { start: number; count: number } | undefined;
    for (let i = 1; i <= 3; i++) {
      const r = rateLimit(s, 1000 + i, 3, 10_000);
      expect(r.allowed).toBe(true);
      s = r.state;
    }
    expect(rateLimit(s, 1100, 3, 10_000).allowed).toBe(false);
    expect(rateLimit(s, 11_001, 3, 10_000)).toEqual({ state: { start: 11_001, count: 1 }, allowed: true });
  });
});

describe("IAM policy edits", () => {
  const m = "serviceAccount:spot-a@spot-solutions.iam.gserviceaccount.com";
  it("adds once and removes cleanly", () => {
    const p = { bindings: [{ role: "roles/datastore.user", members: ["user:a@b.c"] }] };
    expect(addBinding(p, "roles/datastore.user", m)).toBe(true);
    expect(addBinding(p, "roles/datastore.user", m)).toBe(false);
    expect(addBinding(p, "roles/other", m)).toBe(true);
    expect(removeBinding(p, "roles/other", m)).toBe(true);
    expect(p.bindings.map((b) => b.role)).toEqual(["roles/datastore.user"]);
    expect(removeBinding(p, "roles/datastore.user", m)).toBe(true);
    expect(p.bindings[0]?.members).toEqual(["user:a@b.c"]);
    expect(removeBinding(p, "roles/datastore.user", m)).toBe(false);
  });

  it("leaves conditional bindings alone", () => {
    const cond = { role: "roles/resourcemanager.projectIamAdmin", members: [m], condition: { expression: "true" } };
    const p = { bindings: [cond] };
    expect(removeBinding(p, "roles/resourcemanager.projectIamAdmin", m)).toBe(false);
    expect(addBinding(p, "roles/resourcemanager.projectIamAdmin", m)).toBe(true);
    expect(p.bindings).toHaveLength(2);
  });
});
