// The Never read list from the app's side: read and change `settings.neverRead`. The worker watches it live.
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { addNeverRead, compileNeverRead, comicsOnNeverRead, defaultCountryCode, linkedGroups, matchesNeverRead, pruneLinkedNeverRead, removeNeverRead, type NeverReadEntry, type Settings, type Show, type WatchedGroup } from "@spot/shared";
import { useApp } from "./app";
import { useCollection } from "./data";

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
    /** Empty the whole list (people and groups). */
    clear: () => saveSettings({ neverRead: [] }),
    /** "Never read any group": every group except your show groups and Comedy's watched groups. */
    allGroups: !!settings.neverReadAllGroups,
    setAllGroups: (on: boolean) => saveSettings({ neverReadAllGroups: on }),
    /** Comics on your roster that these ids would silence. */
    comicsAmong: (ids: string[]) => comicsOnNeverRead(comics, ids),
  };
}

/** Groups the app needs (show groups, Comedy watched groups, host poll group), by id → why. Live. */
export function useLinkedGroups(uid: string | undefined, shows: Show[], settings: Settings) {
  const watched = useCollection<WatchedGroup>(uid, "watchedGroups");
  const hostPollGroupId = settings.hostPoll?.groupId;
  const map = useMemo(() => linkedGroups({ shows, watched: watched.data, hostPollGroupId }), [shows, watched.data, hostPollGroupId]);
  return { linked: map, loaded: !watched.loading };
}

/**
 * Linked groups always win over the Never read list: when a group on the list gets linked (a show's group is set to it, or it is
 * watched in Comedy), take it off the list and say so. Mounted once, app-wide.
 */
export function useNeverReadLinkSync(uid: string, shows: Show[], settings: Settings, save: (patch: Partial<Settings>) => Promise<void>) {
  const { linked, loaded } = useLinkedGroups(uid, shows, settings);
  const busy = useRef(false);
  useEffect(() => {
    if (!loaded || busy.current || !settings.neverRead?.length) return;
    const { list, removed } = pruneLinkedNeverRead(settings.neverRead, linked);
    if (!removed.length) return;
    busy.current = true;
    save({ neverRead: list })
      .then(() => {
        for (const r of removed.slice(0, 3)) toast(`Removed ${r.name || "a group"} from Never read because it's ${r.reason.replace(/^Linked to /, "linked to ").replace(/^Watched in Comedy$/, "watched in Comedy").replace(/^Used for the host poll$/, "used for the host poll")}`);
        if (removed.length > 3) toast(`Removed ${removed.length - 3} more linked groups from Never read`);
      })
      .catch(() => undefined)
      .finally(() => (busy.current = false));
  }, [linked, loaded, settings.neverRead, save]);
}
