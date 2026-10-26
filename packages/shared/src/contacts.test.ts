import { describe, expect, it } from "vitest";
import { indexGoogleContact, phoneKeys, planContactSync, splitName, type GoogleIndex } from "./contacts.ts";

const comic = (name: string, phone: string, id = `${phone}@c.us`) => ({ id, name, phone });
const index = (...rows: [string, string, string][]) => {
  const i: GoogleIndex = new Map();
  rows.forEach(([phone, displayName, rn], n) => indexGoogleContact(i, { resourceName: rn, etag: `e${n}`, displayName }, [phone]));
  return i;
};

describe("phoneKeys", () => {
  it("gives the full number and the last 10 digits", () => {
    expect(phoneKeys("+91 98765 43210")).toEqual(["919876543210", "9876543210"]);
    expect(phoneKeys("098765 43210")).toEqual(["919876543210", "9876543210"]);
    expect(phoneKeys("+65 9123 4567")).toEqual(["6591234567"]);
  });
  it("gives nothing for junk", () => expect(phoneKeys("abc")).toEqual([]));
});

describe("splitName", () => {
  it("splits on the last space", () => {
    expect(splitName("Priya")).toEqual({ givenName: "Priya" });
    expect(splitName("Priya Nair")).toEqual({ givenName: "Priya", familyName: "Nair" });
    expect(splitName("  Anna  Maria  Silva ")).toEqual({ givenName: "Anna Maria", familyName: "Silva" });
  });
});

describe("planContactSync", () => {
  const g = index(["+91 98765 43210", "Priya Nair", "people/c1"], ["09123456780", "Old Name", "people/c2"]);

  it("creates, updates, and leaves matching names alone", () => {
    const p = planContactSync([comic("Priya  nair", "919876543210"), comic("New Name", "919123456780"), comic("Fresh Face", "919000000001")], g);
    expect(p.unchanged.map((x) => x.comicId)).toEqual(["919876543210@c.us"]);
    expect(p.update).toEqual([{ comicId: "919123456780@c.us", name: "New Name", phone: "919123456780", resourceName: "people/c2", etag: "e1", from: "Old Name" }]);
    expect(p.create).toEqual([{ comicId: "919000000001@c.us", name: "Fresh Face", phone: "919000000001" }]);
    expect(p.skipped).toEqual([]);
  });

  it("skips comics without a usable phone", () => {
    const p = planContactSync([comic("A", "", "x@c.us"), comic("B", "", "123@lid"), comic("C", "12"), comic("  ", "919000000002")], g);
    expect(p.skipped.map((s) => s.reason)).toEqual(["no-phone", "hidden-number", "bad-phone", "no-name"]);
    expect(p.create).toEqual([]);
  });

  it("matches a Google number stored without country code", () => {
    const p = planContactSync([comic("Old Name", "919123456780")], g);
    expect(p.unchanged).toHaveLength(1);
  });

  it("does not create two contacts for one number", () => {
    const p = planContactSync([comic("A", "919000000003"), comic("A2", "919000000003", "919000000003@lid")], g);
    expect(p.create).toHaveLength(1);
  });

  it("is empty for an empty roster", () => {
    expect(planContactSync([], g)).toEqual({ create: [], update: [], unchanged: [], skipped: [] });
  });
});
