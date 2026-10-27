import { describe, expect, it, vi } from "vitest";
import { parseEmoji, parsePhotoPayload, reactTo, sendPhoto } from "./chatActions.ts";

const photo = { mime: "image/jpeg", data: "QUJD", caption: "  my set  ", filename: "a b?.jpg" };

describe("react_message", () => {
  it("reacts, and an empty emoji takes the reaction back", async () => {
    const react = vi.fn(async () => undefined);
    expect(await reactTo({ react }, parseEmoji("👍"))).toEqual({ emoji: "👍" });
    await reactTo({ react }, parseEmoji(""));
    expect(react.mock.calls).toEqual([["👍"], [""]]);
  });
  it("refuses text that isn't an emoji and a message that's gone", async () => {
    expect(() => parseEmoji("hello")).toThrow(/emoji/);
    expect(() => parseEmoji("👍".repeat(20))).toThrow(/emoji/);
    await expect(reactTo(undefined, "👍")).rejects.toThrow(/isn't available/);
  });
});

describe("send_media", () => {
  it("accepts a small JPEG, trims the caption and cleans the file name", () => {
    expect(parsePhotoPayload(photo)).toEqual({ mime: "image/jpeg", data: "QUJD", caption: "my set", filename: "a b.jpg" });
    expect(parsePhotoPayload({ ...photo, data: "data:image/jpeg;base64,QUJD" }).data).toBe("QUJD");
  });
  it("refuses other types, empty and oversized photos", () => {
    expect(() => parsePhotoPayload({ ...photo, mime: "video/mp4" })).toThrow(/photos/);
    expect(() => parsePhotoPayload({ ...photo, data: "" })).toThrow(/no photo/);
    expect(() => parsePhotoPayload({ ...photo, data: "A".repeat(2_000_000) })).toThrow(/too big/);
  });
  it("sends to the chat it was given, with the caption when there is one", async () => {
    const send = vi.fn(async (..._a: unknown[]) => undefined);
    const make = (mime: string, data: string, filename: string) => ({ mime, data, filename });
    await sendPhoto(send, make, "123@lid", parsePhotoPayload(photo));
    expect(send).toHaveBeenCalledWith("123@lid", { mime: "image/jpeg", data: "QUJD", filename: "a b.jpg" }, { caption: "my set" });
    await sendPhoto(send, make, "123@lid", parsePhotoPayload({ ...photo, caption: "" }));
    expect(send.mock.calls[1][2]).toEqual({});
  });
});
