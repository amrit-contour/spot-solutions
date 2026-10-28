// Comedy's view choices (Home calendar mode, Hide empty days) are saved on the comic's own user doc, in comicSettings.prefs.
import { useCallback, useMemo, type ReactNode } from "react";
import { doc, setDoc } from "firebase/firestore";
import { ViewPrefsProvider } from "@spot/ui";
import { db } from "@spot/ui/firebase";
import { useComicSettings } from "./alerts";

export function ComicViewPrefs({ uid, children }: { uid: string; children: ReactNode }) {
  const { settings, loading } = useComicSettings(uid);
  const remote = useMemo<Record<string, unknown> | undefined>(() => (loading ? undefined : { ...settings.prefs }), [loading, settings.prefs]);
  const save = useCallback((patch: Record<string, unknown>) => setDoc(doc(db, "users", uid), { comicSettings: { prefs: patch } }, { merge: true }), [uid]);
  return (
    <ViewPrefsProvider remote={remote} save={save}>
      {children}
    </ViewPrefsProvider>
  );
}
