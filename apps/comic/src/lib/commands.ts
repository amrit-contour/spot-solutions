// Ask the worker to do something (it runs on the comic's own server, next to their WhatsApp) and wait for it.
import { addDoc, onSnapshot, Timestamp } from "firebase/firestore";
import { TTL_DAYS, ttlMs, type Command, type CommandType } from "@spot/shared";
import { userCol } from "./data";

/** Drop a command for the worker and resolve with its result when it finishes. */
export async function runCommand<R = unknown>(uid: string, type: CommandType, payload: Record<string, unknown> = {}, timeoutMs = 2 * 60_000) {
  const ref = await addDoc(userCol(uid, "commands"), { type, payload, status: "pending", createdAt: Date.now(), expireAt: Timestamp.fromMillis(ttlMs(TTL_DAYS.commands)) } satisfies Command);
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("Your server didn't answer. Is it running, and is your WhatsApp linked?"));
    }, timeoutMs);
    const unsub = onSnapshot(ref, (s) => {
      const d = s.data() as (Command & { result?: R }) | undefined;
      if (d?.status === "done") {
        clearTimeout(timer);
        unsub();
        resolve(d.result as R);
      } else if (d?.status === "error") {
        clearTimeout(timer);
        unsub();
        reject(new Error(/^Unknown command /.test(d.error ?? "") ? "The server running your account is on an older version that can't send asks yet. Update it, then try again." : (d.error ?? "That didn't work.")));
      }
    });
  });
}
