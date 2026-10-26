// The functions carry their own copy of packages/shared/src/contacts.ts. These keep the two from drifting.
import { describe, expect, it } from "vitest";
import { indexGoogleContact as sharedIndex, planContactSync as sharedPlan } from "../../packages/shared/src/contacts.ts";
import { normalizePhone as sharedNormalize } from "../../packages/shared/src/people.ts";
import { indexGoogleContact, normalizePhone, planContactSync, type GoogleIndex } from "./contactsShared";

const phones = ["9876543210", "+91 98765 43211", "098765 43212", "+65 9123 4567", "0091 9876543213", "12345", "", "@lid"];
const comics = phones.flatMap((p, i) => [{ id: `${i}@c.us`, name: i % 2 ? "Priya  Nair" : "Asha", phone: p }, { id: `${i}@lid`, name: "Hidden", phone: "" }, { id: `d${i}@c.us`, name: "  ", phone: p }]);

describe("contactsShared mirrors @spot/shared", () => {
  it("normalises phones the same way", () => {
    for (const p of phones) expect(normalizePhone(p)).toBe(sharedNormalize(p));
  });
  it("plans the same creates, updates, unchanged and skips", () => {
    const build = (idx: (m: GoogleIndex, r: { resourceName: string; etag: string; displayName: string }, p: string[]) => void) => {
      const m: GoogleIndex = new Map();
      idx(m, { resourceName: "people/c1", etag: "e1", displayName: "Asha" }, ["+91 98765 43210"]);
      idx(m, { resourceName: "people/c2", etag: "e2", displayName: "Old Name" }, ["9876543211"]);
      return m;
    };
    expect(planContactSync(comics, build(indexGoogleContact))).toEqual(sharedPlan(comics as never, build(sharedIndex)));
  });
});
