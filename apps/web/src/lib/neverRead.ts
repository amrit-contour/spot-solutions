// The Never read list from the app's side: read and change `settings.neverRead`. The worker watches it live.
import { useMemo } from "react";
import { addNeverRead, compileNeverRead, comicsOnNeverRead, defaultCountryCode, matchesNeverRead, removeNeverRead, type NeverReadEntry } from "@spot/shared";
import { useApp } from "./app";

export type NeverReadItem = { id: string; kind: "person" | "group"; name?: string };

export function useNeverRead() {
  const { settings, saveSettings, comics } = useApp();
  const list: NeverReadEntry[] = useMemo(() => settings.neverRead ?? [], [settings.neverRead]);
  const matcher = useMemo(() => compileNeverRead(list), [list]);
  return {
    list,
    countryCode: defaultCountryCode(settings.timezone),
    /** Is this chat / number already on the list? */
    has: (...ids: (string | undefined)[]) => matchesNeverRead(matcher, ids),
    add: (items: NeverReadItem[]) => saveSettings({ neverRead: addNeverRead(list, items) }),
    remove: (id: string) => saveSettings({ neverRead: removeNeverRead(list, id) }),
    /** Comics on your roster that these ids would silence. */
    comicsAmong: (ids: string[]) => comicsOnNeverRead(comics, ids),
  };
}
