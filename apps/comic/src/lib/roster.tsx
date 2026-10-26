// The comic's rooms and curators, behind one small interface so the pages don't care where they live:
// Firestore (users/{uid}/rooms and /curators) in the app, or memory for the dev-only demo route.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { deleteDoc, setDoc, writeBatch } from "firebase/firestore";
import { db } from "@spot/ui/firebase";
import type { Curator, Room, Roster } from "@spot/shared";
import { useCollection, userDoc } from "./data";

export interface RosterStore {
  rooms: Room[];
  curators: Curator[];
  loading: boolean;
  saveRoom(room: Room): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  saveCurator(curator: Curator): Promise<void>;
  deleteCurator(id: string): Promise<void>;
  /** Make the stored roster equal `next` (only changed docs are written; ones missing from `next` are deleted). */
  replaceRoster(next: Roster): Promise<void>;
}

const Ctx = createContext<RosterStore | null>(null);
export const useRoster = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useRoster needs a RosterProvider");
  return s;
};

/** Firestore rejects undefined and NaN; this keeps only what JSON can hold. */
export const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What to write and delete to turn `from` into `to`, by id. */
export function planWrites<T extends { id: string }>(from: T[], to: T[]) {
  const before = new Map(from.map((x) => [x.id, x]));
  const write = to.filter((x) => !same(before.get(x.id), x));
  const keep = new Set(to.map((x) => x.id));
  const remove = from.filter((x) => !keep.has(x.id)).map((x) => x.id);
  return { write, remove };
}

const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T) => plain(rest);

export function RosterProvider({ store, children }: { store: RosterStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** The signed-in comic's roster, live from Firestore. */
export function useFirestoreRoster(uid: string): RosterStore {
  const rooms = useCollection<Room>(uid, "rooms");
  const curators = useCollection<Curator>(uid, "curators");
  const latest = useRef({ rooms: rooms.data, curators: curators.data });
  latest.current = { rooms: rooms.data, curators: curators.data };
  return useMemo<RosterStore>(
    () => ({
      rooms: rooms.data,
      curators: curators.data,
      loading: rooms.loading || curators.loading,
      saveRoom: (room) => setDoc(userDoc(uid, "rooms", room.id), withoutId(room)),
      deleteRoom: (id) => deleteDoc(userDoc(uid, "rooms", id)),
      saveCurator: (c) => setDoc(userDoc(uid, "curators", c.id), withoutId(c)),
      deleteCurator: (id) => deleteDoc(userDoc(uid, "curators", id)),
      async replaceRoster(next) {
        const r = planWrites(latest.current.rooms, next.rooms);
        const c = planWrites(latest.current.curators, next.curators);
        const ops: ((b: ReturnType<typeof writeBatch>) => void)[] = [
          ...r.write.map((x) => (b: ReturnType<typeof writeBatch>) => b.set(userDoc(uid, "rooms", x.id), withoutId(x))),
          ...c.write.map((x) => (b: ReturnType<typeof writeBatch>) => b.set(userDoc(uid, "curators", x.id), withoutId(x))),
          ...r.remove.map((id) => (b: ReturnType<typeof writeBatch>) => b.delete(userDoc(uid, "rooms", id))),
          ...c.remove.map((id) => (b: ReturnType<typeof writeBatch>) => b.delete(userDoc(uid, "curators", id))),
        ];
        // A batch holds 500 writes.
        for (let i = 0; i < ops.length; i += 400) {
          const batch = writeBatch(db);
          for (const op of ops.slice(i, i + 400)) op(batch);
          await batch.commit();
        }
      },
    }),
    [uid, rooms.data, rooms.loading, curators.data, curators.loading],
  );
}

/** A roster held in memory (the dev-only demo route). Nothing is saved anywhere. */
export function useMemoryRoster(initial: Roster): RosterStore {
  const [rooms, setRooms] = useState(initial.rooms);
  const [curators, setCurators] = useState(initial.curators);
  const upsert = <T extends { id: string }>(list: T[], x: T) => (list.some((y) => y.id === x.id) ? list.map((y) => (y.id === x.id ? x : y)) : [...list, x]);
  const saveRoom = useCallback(async (room: Room) => setRooms((l) => upsert(l, plain(room))), []);
  const saveCurator = useCallback(async (c: Curator) => setCurators((l) => upsert(l, plain(c))), []);
  return useMemo<RosterStore>(
    () => ({
      rooms,
      curators,
      loading: false,
      saveRoom,
      saveCurator,
      deleteRoom: async (id) => setRooms((l) => l.filter((r) => r.id !== id)),
      deleteCurator: async (id) => setCurators((l) => l.filter((c) => c.id !== id)),
      replaceRoster: async (next) => {
        setRooms(plain(next.rooms));
        setCurators(plain(next.curators));
      },
    }),
    [rooms, curators, saveRoom, saveCurator],
  );
}
