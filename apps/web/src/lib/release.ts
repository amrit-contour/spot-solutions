// The latest published server release (dl/nothing-bot-server.json, written by deploy/build-dist.sh), for the Server page.
import { useEffect, useState } from "react";

export interface Release {
  version: string;
  builtAt?: number;
}

export function useLatestRelease(): Release | null {
  const [r, setR] = useState<Release | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/dl/nothing-bot-server.json?t=${Date.now()}`, { cache: "no-store" })
        .then((x) => (x.ok ? x.json() : null))
        .then((j) => {
          if (live && j && typeof j.version === "string") setR({ version: j.version, builtAt: typeof j.builtAt === "number" ? j.builtAt : undefined });
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return r;
}

/** Releases are commit ids; a heartbeat version like "main" or "dev" is a development copy that doesn't self-update. */
export const isReleaseVersion = (v: string) => /^[0-9a-f]{6,12}(-[a-z]+)?$/.test(v);
export const shortVersion = (v: string) => (v.length > 12 ? v.slice(0, 7) : v);
