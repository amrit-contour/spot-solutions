import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, type QueryConstraint } from "firebase/firestore";
import { db } from "@spot/ui/firebase";

export const userCol = (uid: string, name: string) => collection(db, "users", uid, name);
export const userDoc = (uid: string, name: string, id: string) => doc(db, "users", uid, name, id);

/** Live collection under users/{uid}. `key` re-subscribes when constraints change. */
export function useCollection<T>(uid: string | undefined, name: string, constraints: QueryConstraint[] = [], key = "") {
  const [state, setState] = useState<{ data: T[]; loading: boolean }>({ data: [], loading: true });
  useEffect(() => {
    if (!uid) return;
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      query(userCol(uid, name), ...constraints),
      (q) => setState({ data: q.docs.map((d) => ({ ...(d.data() as T), id: d.id })), loading: false }),
      (e) => {
        console.error(name, e);
        setState({ data: [], loading: false });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, name, key]);
  return state;
}
