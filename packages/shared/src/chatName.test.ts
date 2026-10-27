import { describe, expect, it } from "vitest";
import { bestContactName, chatDisplayName, looksLikeNumber } from "./chatName.ts";

describe("chat names", () => {
  it("knows numbers", () => {
    expect(looksLikeNumber("+91 98765 43210")).toBe(true);
    expect(looksLikeNumber("Ana 2")).toBe(false);
  });
  it("orders saved, short, push, verified", () => {
    expect(bestContactName({ name: "A", pushname: "B" })).toBe("A");
    expect(bestContactName({ name: "+61 400", pushname: "B" })).toBe("B");
    expect(bestContactName({ verifiedName: "Biz" })).toBe("Biz");
    expect(bestContactName(null)).toBe("");
  });
  it("display: comic wins, number last", () => {
    expect(chatDisplayName({ comic: "C", chatName: "X" })).toBe("C");
    expect(chatDisplayName({ chatName: "+61 400", phone: "61400" })).toBe("+61400");
  });
});
