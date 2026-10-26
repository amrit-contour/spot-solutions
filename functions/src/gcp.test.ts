import { describe, expect, it, vi } from "vitest";
import { editPolicy } from "./gcp";
import { addBinding } from "./logic";

describe("editPolicy", () => {
  it("writes version 3 with the etag it read, keeping conditional bindings", async () => {
    const cond = { role: "roles/resourcemanager.projectIamAdmin", members: ["serviceAccount:e@x"], condition: { expression: "true" } };
    const read = vi.fn(async () => ({ etag: "E1", bindings: [cond] }));
    const write = vi.fn(async () => ({}));
    await editPolicy(read, write, (p) => addBinding(p, "roles/datastore.user", "serviceAccount:a@x"));
    expect(write).toHaveBeenCalledOnce();
    const sent = (write.mock.calls[0] as unknown[])[0] as { version: number; etag: string; bindings: unknown[] };
    expect(sent.version).toBe(3);
    expect(sent.etag).toBe("E1");
    expect(sent.bindings).toContainEqual(cond);
  });

  it("does nothing when nothing changes", async () => {
    const write = vi.fn();
    await editPolicy(async () => ({ bindings: [{ role: "r", members: ["m"] }] }), write, (p) => addBinding(p, "r", "m"));
    expect(write).not.toHaveBeenCalled();
  });

  it("re-reads and retries on an etag conflict, but not on other errors", async () => {
    let n = 0;
    const read = vi.fn(async () => ({ etag: `E${++n}`, bindings: [] }));
    const write = vi.fn().mockRejectedValueOnce({ response: { status: 409 } }).mockResolvedValueOnce({});
    await editPolicy(read, write, (p) => addBinding(p, "r", "m"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
    await expect(editPolicy(read, vi.fn().mockRejectedValue({ response: { status: 403 } }), (p) => addBinding(p, "r", "m"))).rejects.toBeDefined();
  });
});
