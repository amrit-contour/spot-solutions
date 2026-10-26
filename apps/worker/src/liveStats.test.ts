import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLiveStats, maskPhone } from "./liveStats.ts";

const HOUR = 3600_000;
const fresh = (t = { v: 10 * HOUR + 5 }) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "spot-live-")), "live-stats.json");
  return { file, t, make: () => createLiveStats({ file, serverId: "s1", version: "abc", startedAt: 1, now: () => t.v }) };
};

describe("liveStats", () => {
  it("masks phone numbers", () => {
    expect(maskPhone("919812345612")).toBe("+91 98•••12");
    expect(maskPhone("14155550123")).toBe("+1 41•••23");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("12")).toBe("•••");
  });

  it("counts per hour, per account and since start, and never stores text", () => {
    const { make, t } = fresh();
    const s = make();
    s.recordSession("u1", { status: "ready", phone: "919812345612" });
    s.recordSession("u2", { status: "qr" });
    s.setDirectory([{ uid: "u1", email: "a@x.com", name: "Asha" }, { uid: "u2" }]);
    s.noteIn("u1"); s.noteIn("u1"); s.noteSpot("u1");
    const client = {};
    s.bindClient("u1", client);
    s.noteSent(client);
    t.v += HOUR;
    s.noteIn("u2");
    s.noteAi("ollama", 800); s.noteAi("gemini", 1200, true); s.noteAiFail();
    s.queueDelta(2); s.queueDelta(-1);
    const snap = s.snapshot();
    expect(snap.totals).toMatchObject({ in: 3, spot: 1, sent: 1, ai: 2, aiLocal: 1, aiGemini: 1, aiMs: 2000, aiFail: 1, aiFallback: 1 });
    expect(snap.hourly.map((b) => b.in)).toEqual([2, 1]);
    const u1 = snap.accounts.find((a) => a.uid === "u1")!;
    expect(u1).toMatchObject({ key: "u1:client", role: "client", phone: "+91 98•••12", email: "a@x.com", name: "Asha", in: 2, spot: 1, sent: 1 });
    expect(snap.queue.pending).toBe(1);
    expect(snap.queue.lastSendAt).not.toBeNull();
    expect(JSON.stringify(snap)).not.toContain("9198123");
    expect(s.summary()).toMatchObject({ accounts: 2, ready: 1, in24h: 3, sent24h: 1, queue: 1 });
  });

  it("keeps the 24 h history across a restart and drops hours older than that", () => {
    const { make, t, file } = fresh();
    const a = make();
    a.noteIn("u1");
    t.v += 2 * HOUR;
    a.noteIn("u1");
    a.write();
    expect(JSON.parse(readFileSync(file, "utf8")).hourly).toHaveLength(2);
    t.v += HOUR;
    const b = make(); // restart
    expect(b.snapshot().hourly.map((x) => x.in)).toEqual([1, 1, 0]); // the two hours kept, plus the new current one
    expect(b.snapshot().totals.in).toBe(0); // totals are "since start"
    t.v += 30 * HOUR;
    expect(make().snapshot().hourly.map((x) => x.in)).toEqual([0]); // only the empty current hour
  });

  it("drops accounts the server no longer holds, but not brand-new ones", () => {
    const { make, t } = fresh();
    const s = make();
    s.recordSession("old", { status: "ready" });
    t.v += 60_000;
    s.recordSession("new", { status: "starting" });
    s.setDirectory([]);
    expect(s.snapshot().accounts.map((a) => a.uid)).toEqual(["new"]);
  });

  it("writes atomically and ignores a corrupt previous file", () => {
    const { make, file } = fresh();
    writeFileSync(file, "{ not json");
    const s = make();
    s.write();
    expect(JSON.parse(readFileSync(file, "utf8")).v).toBe(1);
  });
});
