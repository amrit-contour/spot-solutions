import { describe, expect, it } from "vitest";
import { groupPanel } from "./groupSync.ts";

describe("POCs in the group panel", () => {
  it("tags POCs (not also co-host), keeps them in a sync, and never marks them leaving", () => {
    const members = [
      { id: "p@c.us", name: "Poc", isAdmin: false },
      { id: "x@c.us", name: "Last week", isAdmin: false },
    ];
    const out = groupPanel({ members, lineup: [], regulars: [], protected: ["p@c.us"], pocs: ["p@c.us"] });
    expect(out.rows.find((r) => r.id === "p@c.us")?.tags).toEqual(["poc"]);
    expect(out.toRemove).toEqual(["x@c.us"]);
  });
});
