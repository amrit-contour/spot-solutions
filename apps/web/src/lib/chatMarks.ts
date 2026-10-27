// "Done" and "Needs reply" flags on chats, kept on this device only (localStorage, per user). They hold a chat id and a time, never any text.
import { useCallback, useEffect, useState } from "react";
import { clearMark, pruneMarks, setMark, toggleNeedsReply, type ChatMark, type ChatMarks, type MarkTarget } from "@spot/shared";
import { marksKey } from "./chatCache";

function load(uid: string): ChatMarks {
  try {
    const v = JSON.parse(localStorage.getItem(marksKey(uid)) ?? "{}") as ChatMarks;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function useChatMarks(uid: string) {
  const [marks, setMarks] = useState<ChatMarks>(() => load(uid));
  useEffect(() => setMarks(load(uid)), [uid]);
  const commit = useCallback(
    (next: (m: ChatMarks) => ChatMarks) =>
      setMarks((m) => {
        const n = next(m);
        try {
          localStorage.setItem(marksKey(uid), JSON.stringify(n));
        } catch {
          /* private mode: the mark lasts until the page closes */
        }
        return n;
      }),
    [uid],
  );
  return {
    marks,
    done: (id: string, t: Pick<MarkTarget, "at">) => commit((m) => setMark(m, id, "done", t)),
    needs: (id: string, t: Pick<MarkTarget, "at">) => commit((m) => setMark(m, id, "needs", t)),
    toggle: (id: string, t: MarkTarget) => commit((m) => toggleNeedsReply(m, id, t)),
    clear: (id: string) => commit((m) => clearMark(m, id)),
    /** Put a mark back as it was (Undo): `undefined` removes it. */
    restore: (id: string, mark: ChatMark | undefined) => commit((m) => (mark ? { ...m, [id]: mark } : clearMark(m, id))),
    prune: (threads: { id: string; at: number }[]) =>
      commit((m) => {
        const p = pruneMarks(m, threads);
        return Object.keys(p).length === Object.keys(m).length ? m : p;
      }),
  };
}
export type { ChatMark };
